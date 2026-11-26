import fs from 'node:fs';
import path from 'node:path';
import { getGitRepoInfo } from './git-ops.mjs';
import {
  readJsonSafe,
  resolveFileUri,
  resolvePluginDataDir,
  toFileUri,
  writeJsonAtomic,
} from './paths.mjs';

const DEFAULT_IGNORED = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  '__pycache__',
  '.next',
  '.nuxt',
  'dist',
  'build',
  '.turbo',
  '.cache',
]);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);
const TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.jsonc', '.md', '.mdx',
  '.html', '.htm', '.css', '.scss', '.less', '.py', '.rb', '.go', '.rs', '.java',
  '.kt', '.swift', '.c', '.cpp', '.h', '.hpp', '.sh', '.zsh', '.bash', '.ps1',
  '.yml', '.yaml', '.toml', '.ini', '.env', '.txt', '.sql', '.graphql', '.xml',
  '.vue', '.svelte', '.dockerfile', '.gitignore', '.csv', '.log',
]);

function getExplorerStatePath(pluginDataDir = '') {
  return path.join(resolvePluginDataDir(pluginDataDir), 'explorer-state.json');
}

export function loadExplorerState({ pluginDataDir = '' } = {}) {
  const data = readJsonSafe(getExplorerStatePath(pluginDataDir), { favorites: [], recentRoots: [] });
  return {
    favorites: Array.isArray(data?.favorites) ? data.favorites : [],
    recentRoots: Array.isArray(data?.recentRoots) ? data.recentRoots : [],
  };
}

export function toggleFavoritePath(targetPath, { label = '', pluginDataDir = '' } = {}) {
  const resolved = resolveFileUri(targetPath);
  if (!resolved) return { ok: false, error: '路径无效' };
  const state = loadExplorerState({ pluginDataDir });
  const idx = state.favorites.findIndex((f) => path.resolve(f.path) === resolved);
  let added = false;
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
  } else {
    state.favorites.unshift({
      path: resolved,
      label: label || path.basename(resolved) || resolved,
      addedAt: new Date().toISOString(),
    });
    state.favorites = state.favorites.slice(0, 20);
    added = true;
  }
  writeJsonAtomic(getExplorerStatePath(pluginDataDir), state);
  return { ok: true, added, favorites: state.favorites };
}

export function recordRecentRoot(rootPath, { pluginDataDir = '' } = {}) {
  const resolved = resolveFileUri(rootPath);
  if (!resolved || !fs.existsSync(resolved)) return;
  const state = loadExplorerState({ pluginDataDir });
  state.recentRoots = [resolved, ...state.recentRoots.filter((p) => path.resolve(p) !== resolved)].slice(0, 10);
  writeJsonAtomic(getExplorerStatePath(pluginDataDir), state);
}

/**
 * List entries inside a workspace directory (or perform fast recursive search when filter is set).
 */
export async function listWorkspaceTree(
  rootDir,
  { relDir = '', showHidden = false, filter = '', maxItems = 250 } = {},
) {
  const resolvedRoot = resolveFileUri(rootDir);
  if (!resolvedRoot || !fs.existsSync(resolvedRoot)) {
    return { ok: false, error: '工作区目录不存在', root: resolvedRoot || '' };
  }

  const gitInfo = await getGitRepoInfo(resolvedRoot);
  const query = String(filter || '').trim().toLowerCase();

  const safeRealpath = (p) => {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  };
  const realGitRoot = gitInfo.isRepo ? safeRealpath(gitInfo.repoRoot) : '';

  const resolveGitFlag = (absPath, isDir) => {
    if (!gitInfo.isRepo || !realGitRoot) return '';
    const rel = path.relative(realGitRoot, safeRealpath(absPath)).split(path.sep).join('/');
    if (!isDir) return gitInfo.statusMap[rel] || '';
    const prefix = rel ? `${rel}/` : '';
    for (const key of Object.keys(gitInfo.statusMap)) {
      if (key.startsWith(prefix)) return '•';
    }
    return '';
  };

  if (query) {
    const matches = [];
    const walk = (dir, depth) => {
      if (depth > 6 || matches.length >= maxItems) return;
      let dirents = [];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of dirents) {
        if (matches.length >= maxItems) break;
        if (!showHidden && (ent.name.startsWith('.') || DEFAULT_IGNORED.has(ent.name))) continue;
        const full = path.join(dir, ent.name);
        const rel = path.relative(resolvedRoot, full).split(path.sep).join('/');
        const isDir = ent.isDirectory();
        if (rel.toLowerCase().includes(query) || ent.name.toLowerCase().includes(query)) {
          let size = 0;
          let mtimeMs = 0;
          try {
            const st = fs.statSync(full);
            size = st.size;
            mtimeMs = st.mtimeMs;
          } catch {}
          matches.push({
            name: ent.name,
            path: full,
            relPath: rel,
            uri: toFileUri(full),
            isDirectory: isDir,
            ext: path.extname(ent.name).toLowerCase(),
            size,
            mtimeMs,
            gitFlag: resolveGitFlag(full, isDir),
          });
        }
        if (isDir && !DEFAULT_IGNORED.has(ent.name)) {
          walk(full, depth + 1);
        }
      }
    };
    walk(resolvedRoot, 0);
    return {
      ok: true,
      root: resolvedRoot,
      currentDir: resolvedRoot,
      relDir: '',
      isSearch: true,
      git: {
        isRepo: gitInfo.isRepo,
        branch: gitInfo.branch,
        dirtyCount: gitInfo.dirtyCount,
      },
      entries: matches,
    };
  }

  const targetDir = relDir ? path.resolve(resolvedRoot, relDir) : resolvedRoot;
  if (!targetDir.startsWith(resolvedRoot)) {
    return { ok: false, error: '路径超出当前工作区范围' };
  }
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return { ok: false, error: '目标目录不存在' };
  }

  let dirents = [];
  try {
    dirents = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: `读取目录失败: ${err?.message || err}` };
  }

  const entries = [];
  for (const ent of dirents) {
    if (!showHidden && (ent.name.startsWith('.') || DEFAULT_IGNORED.has(ent.name))) continue;
    const full = path.join(targetDir, ent.name);
    const rel = path.relative(resolvedRoot, full).split(path.sep).join('/');
    const isDir = ent.isDirectory();
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {}
    entries.push({
      name: ent.name,
      path: full,
      relPath: rel,
      uri: toFileUri(full),
      isDirectory: isDir,
      ext: path.extname(ent.name).toLowerCase(),
      size,
      mtimeMs,
      gitFlag: resolveGitFlag(full, isDir),
    });
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  return {
    ok: true,
    root: resolvedRoot,
    currentDir: targetDir,
    relDir: path.relative(resolvedRoot, targetDir).split(path.sep).join('/'),
    isSearch: false,
    git: {
      isRepo: gitInfo.isRepo,
      branch: gitInfo.branch,
      dirtyCount: gitInfo.dirtyCount,
    },
    entries: entries.slice(0, maxItems),
  };
}

/**
 * Lightweight code / text / image preview for the Explorer dual-pane drawer.
 */
export function readFilePreview(rawPath, { maxTextBytes = 120_000, maxImageBytes = 4_000_000 } = {}) {
  const target = resolveFileUri(rawPath);
  if (!target || !fs.existsSync(target)) {
    return { ok: false, error: '文件不存在' };
  }
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    return { ok: true, kind: 'dir', path: target, name: path.basename(target), size: 0 };
  }
  const ext = path.extname(target).toLowerCase();
  const baseName = path.basename(target);

  if (IMAGE_EXTS.has(ext)) {
    if (st.size > maxImageBytes) {
      return {
        ok: true,
        kind: 'binary',
        path: target,
        name: baseName,
        ext,
        size: st.size,
        message: '图片超过 4MB，请点击「在访达中显示」或「用默认应用打开」查看。',
      };
    }
    const mimeMap = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.bmp': 'image/bmp',
    };
    const b64 = fs.readFileSync(target).toString('base64');
    return {
      ok: true,
      kind: 'image',
      path: target,
      name: baseName,
      ext,
      size: st.size,
      dataUrl: `data:${mimeMap[ext] || 'application/octet-stream'};base64,${b64}`,
    };
  }

  const isKnownText = TEXT_EXTS.has(ext) || !ext || baseName.startsWith('.');
  if (!isKnownText && st.size > 0) {
    // Sniff first 512 bytes for NUL byte
    const fd = fs.openSync(target, 'r');
    const probe = Buffer.alloc(Math.min(512, st.size));
    fs.readSync(fd, probe, 0, probe.length, 0);
    fs.closeSync(fd);
    if (probe.includes(0)) {
      return {
        ok: true,
        kind: 'binary',
        path: target,
        name: baseName,
        ext,
        size: st.size,
        message: '二进制文件不支持文本预览，可使用默认应用打开或在访达定位。',
      };
    }
  }

  const readLen = Math.min(st.size, maxTextBytes);
  const buf = Buffer.alloc(readLen);
  if (readLen > 0) {
    const fd = fs.openSync(target, 'r');
    fs.readSync(fd, buf, 0, readLen, 0);
    fs.closeSync(fd);
  }
  const text = buf.toString('utf8');
  return {
    ok: true,
    kind: 'text',
    path: target,
    name: baseName,
    ext,
    size: st.size,
    truncated: st.size > maxTextBytes,
    lineCount: text ? text.split(/\r?\n/).length : 0,
    content: text,
  };
}
