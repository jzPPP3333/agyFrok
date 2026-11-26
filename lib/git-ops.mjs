import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureDir, readJsonSafe, resolvePluginDataDir, writeJsonAtomic } from './paths.mjs';

const execFileAsync = promisify(execFile);

async function runGit(cwd, args, { env = process.env, timeout = 8000 } = {}) {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    env,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout: String(stdout || ''), stderr: String(stderr || '') };
}

export async function getGitRepoInfo(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return { isRepo: false, repoRoot: '', branch: '', dirtyCount: 0, statusMap: {} };
  }
  try {
    const { stdout: topOut } = await runGit(dirPath, ['rev-parse', '--show-toplevel']);
    const repoRoot = topOut.trim();
    let branch = 'HEAD';
    try {
      const { stdout: brOut } = await runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
      branch = brOut.trim() || 'HEAD';
    } catch {}

    const { stdout: stOut } = await runGit(repoRoot, ['status', '--porcelain=v1', '-uall']);
    const statusMap = {};
    let dirtyCount = 0;
    for (const line of stOut.split(/\r?\n/)) {
      if (!line || line.length < 4) continue;
      const xy = line.slice(0, 2);
      let rel = line.slice(3).trim();
      if (rel.includes(' -> ')) {
        rel = rel.split(' -> ').pop().trim();
      }
      rel = rel.replace(/^"(.*)"$/, '$1');
      let flag = 'M';
      if (xy.includes('?')) flag = '?';
      else if (xy.includes('A')) flag = 'A';
      else if (xy.includes('D')) flag = 'D';
      else if (xy.includes('R')) flag = 'R';
      statusMap[rel] = flag;
      dirtyCount += 1;
    }

    return { isRepo: true, repoRoot, branch, dirtyCount, statusMap };
  } catch {
    return { isRepo: false, repoRoot: '', branch: '', dirtyCount: 0, statusMap: {} };
  }
}

export function sanitizeBranchSlug(raw, fallback = 'exp') {
  const slug = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || fallback;
}

/**
 * Create an isolated Git worktree for parallel Fork exploration (Claude Code / Codex style).
 */
export async function createForkWorktree(repoDir, { branchSlug = '', baseDir = '' } = {}) {
  const info = await getGitRepoInfo(repoDir);
  if (!info.isRepo) {
    return { ok: false, error: '当前目录不是 Git 仓库，无法创建 Worktree' };
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const slug = sanitizeBranchSlug(branchSlug, 'branch');
  const branchName = `fork/${slug}-${stamp.slice(-6)}`;
  const worktreesBase = ensureDir(
    baseDir || path.join(path.dirname(info.repoRoot), `${path.basename(info.repoRoot)}-worktrees`),
  );
  const worktreePath = path.join(worktreesBase, `${slug}-${stamp.slice(-6)}`);

  try {
    // Ensure repo has at least one commit
    await runGit(info.repoRoot, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    return { ok: false, error: '当前 Git 仓库尚无任何 Commit，无法基于 HEAD 创建 Worktree' };
  }

  try {
    await runGit(info.repoRoot, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
    return {
      ok: true,
      repoRoot: info.repoRoot,
      worktreePath,
      branchName,
      baseBranch: info.branch,
    };
  } catch (err) {
    return { ok: false, error: `创建 Git Worktree 失败: ${err?.stderr || err?.message || err}` };
  }
}

export async function listWorktrees(repoDir) {
  const info = await getGitRepoInfo(repoDir);
  if (!info.isRepo) return [];
  try {
    const { stdout } = await runGit(info.repoRoot, ['worktree', 'list', '--porcelain']);
    const blocks = stdout.trim().split(/\r?\n\r?\n/);
    const list = [];
    for (const block of blocks) {
      const entry = { path: '', head: '', branch: '', isMain: false };
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) entry.path = line.slice(9).trim();
        else if (line.startsWith('HEAD ')) entry.head = line.slice(5).trim();
        else if (line.startsWith('branch ')) entry.branch = line.slice(7).replace(/^refs\/heads\//, '').trim();
      }
      if (entry.path) {
        entry.isMain = path.resolve(entry.path) === path.resolve(info.repoRoot);
        list.push(entry);
      }
    }
    return list;
  } catch {
    return [];
  }
}

export async function removeForkWorktree(repoDir, worktreePath) {
  const info = await getGitRepoInfo(repoDir);
  if (!info.isRepo) return { ok: false, error: '非 Git 仓库' };
  if (!worktreePath || path.resolve(worktreePath) === path.resolve(info.repoRoot)) {
    return { ok: false, error: '不允许移除主工作区目录' };
  }
  try {
    await runGit(info.repoRoot, ['worktree', 'remove', '--force', worktreePath]);
    return { ok: true, removed: worktreePath };
  } catch (err) {
    return { ok: false, error: `移除 Worktree 失败: ${err?.stderr || err?.message || err}` };
  }
}

function getSnapshotsStorePath(pluginDataDir = '') {
  return path.join(resolvePluginDataDir(pluginDataDir), 'snapshots.json');
}

/**
 * Non-destructive safety snapshot before Fork: captures BOTH tracked edits and untracked files
 * using a temporary GIT_INDEX_FILE without modifying the real index, working tree, or git stash list.
 */
export async function createSafetySnapshot(
  repoDir,
  { label = 'fork-snapshot', conversationId = '', pluginDataDir = '' } = {},
) {
  const info = await getGitRepoInfo(repoDir);
  if (!info.isRepo) {
    return { ok: false, error: '当前目录不是 Git 仓库，跳过安全快照' };
  }

  let headCommit = '';
  try {
    const { stdout } = await runGit(info.repoRoot, ['rev-parse', '--verify', 'HEAD']);
    headCommit = stdout.trim();
  } catch {
    return { ok: false, error: '当前仓库尚无初始 Commit，无法生成快照' };
  }

  const tmpIndex = path.join(os.tmpdir(), `agy-snap-idx-${process.pid}-${Date.now()}`);
  const snapEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    await runGit(info.repoRoot, ['read-tree', 'HEAD'], { env: snapEnv });
    await runGit(info.repoRoot, ['add', '-A'], { env: snapEnv });
    const { stdout: treeOut } = await runGit(info.repoRoot, ['write-tree'], { env: snapEnv });
    const treeOid = treeOut.trim();
    const { stdout: commitOut } = await runGit(
      info.repoRoot,
      ['commit-tree', treeOid, '-p', headCommit, '-m', `agy-fork-snapshot: ${label}`],
      { env: snapEnv },
    );
    const snapshotCommit = commitOut.trim();
    const snapshotId = `snap-${Date.now().toString(36)}`;
    // Pin ref so git gc does not prune it
    await runGit(info.repoRoot, ['update-ref', `refs/agy-fork-snapshots/${snapshotId}`, snapshotCommit]);

    const files = Object.keys(info.statusMap);
    const record = {
      id: snapshotId,
      label,
      conversationId,
      repoRoot: info.repoRoot,
      branch: info.branch,
      headCommit,
      snapshotCommit,
      dirtyCount: files.length,
      files: files.slice(0, 60),
      createdAt: new Date().toISOString(),
    };

    const storePath = getSnapshotsStorePath(pluginDataDir);
    const store = readJsonSafe(storePath, { snapshots: [] });
    store.snapshots = [record, ...(Array.isArray(store.snapshots) ? store.snapshots : [])].slice(0, 80);
    writeJsonAtomic(storePath, store);

    return { ok: true, snapshot: record };
  } catch (err) {
    return { ok: false, error: `生成安全快照失败: ${err?.stderr || err?.message || err}` };
  } finally {
    try {
      if (fs.existsSync(tmpIndex)) fs.unlinkSync(tmpIndex);
    } catch {}
  }
}

export function listSafetySnapshots({ repoRoot = '', pluginDataDir = '' } = {}) {
  const store = readJsonSafe(getSnapshotsStorePath(pluginDataDir), { snapshots: [] });
  const list = Array.isArray(store?.snapshots) ? store.snapshots : [];
  if (!repoRoot) return list;
  const target = path.resolve(repoRoot);
  return list.filter((s) => path.resolve(s.repoRoot || '') === target);
}

export async function getSnapshotDiff(snapshotId, { pluginDataDir = '' } = {}) {
  const list = listSafetySnapshots({ pluginDataDir });
  const snap = list.find((s) => s.id === snapshotId);
  if (!snap) return { ok: false, error: '未找到指定快照' };
  try {
    const { stdout } = await runGit(snap.repoRoot, ['diff', '--stat', snap.headCommit, snap.snapshotCommit]);
    const { stdout: patch } = await runGit(snap.repoRoot, ['diff', snap.headCommit, snap.snapshotCommit]);
    return {
      ok: true,
      snapshot: snap,
      stat: stdout.trim(),
      diff: patch.slice(0, 40_000),
    };
  } catch (err) {
    return { ok: false, error: `读取快照差异失败: ${err?.stderr || err?.message || err}` };
  }
}

export async function restoreSnapshotFile(snapshotId, relPath, { pluginDataDir = '' } = {}) {
  const list = listSafetySnapshots({ pluginDataDir });
  const snap = list.find((s) => s.id === snapshotId);
  if (!snap) return { ok: false, error: '未找到指定快照' };
  const cleanRel = String(relPath || '').replace(/^\/+/, '');
  if (!cleanRel || cleanRel.includes('..')) {
    return { ok: false, error: '非法相对路径' };
  }
  try {
    const { stdout } = await runGit(snap.repoRoot, ['show', `${snap.snapshotCommit}:${cleanRel}`]);
    const dest = path.resolve(snap.repoRoot, cleanRel);
    if (!dest.startsWith(path.resolve(snap.repoRoot))) {
      return { ok: false, error: '路径越界拦截' };
    }
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, stdout, 'utf8');
    return { ok: true, path: dest, snapshotId };
  } catch (err) {
    return { ok: false, error: `单文件恢复失败: ${err?.stderr || err?.message || err}` };
  }
}
