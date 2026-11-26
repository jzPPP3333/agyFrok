import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFileUri } from './paths.mjs';

const MAX_RECENT = 25;
const recentOps = [];

function recordOp(entry) {
  recentOps.unshift({ ...entry, ts: entry.ts || Date.now() });
  if (recentOps.length > MAX_RECENT) recentOps.length = MAX_RECENT;
}

export function getRecentExplorerOps() {
  return recentOps.slice();
}

function spawnDetached(exe, args, { windowsVerbatimArguments = false } = {}) {
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    ...(process.platform === 'win32' && windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  child.on('error', () => {
    // Prevent unhandled spawn error crash
  });
  child.unref();
}

export function findExistingAncestorDir(targetPath) {
  let current = path.dirname(targetPath);
  while (current) {
    try {
      if (fs.existsSync(current) && fs.statSync(current).isDirectory()) {
        return current;
      }
    } catch {
      // Keep climbing
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Reveal a file or folder in the native OS file manager (macOS Finder / Windows Explorer / Linux file manager).
 * If the target file has been deleted, automatically falls back to opening the nearest existing parent directory.
 */
export function revealInExplorer(rawInput, { dryRun = false } = {}) {
  const target = resolveFileUri(rawInput);
  if (!target) {
    const res = { ok: false, error: '无法解析目标路径', input: rawInput };
    recordOp({ action: 'reveal', input: rawInput, status: 'error', message: res.error });
    return res;
  }

  let exists = false;
  let isDir = false;
  try {
    if (fs.existsSync(target)) {
      exists = true;
      isDir = fs.statSync(target).isDirectory();
    }
  } catch (err) {
    const res = { ok: false, path: target, error: `读取文件状态失败: ${err?.message || err}` };
    recordOp({ action: 'reveal', path: target, status: 'error', message: res.error });
    return res;
  }

  if (exists) {
    const cmdSpec = buildRevealCommand(target, isDir);
    if (!dryRun) {
      spawnDetached(cmdSpec.exe, cmdSpec.args, { windowsVerbatimArguments: cmdSpec.verbatim });
    }
    const res = {
      ok: true,
      kind: isDir ? 'dir' : 'file',
      path: target,
      command: cmdSpec,
    };
    recordOp({ action: 'reveal', path: target, kind: res.kind, status: 'ok' });
    return res;
  }

  const ancestor = findExistingAncestorDir(target);
  if (ancestor) {
    const cmdSpec = buildRevealCommand(ancestor, true);
    if (!dryRun) {
      spawnDetached(cmdSpec.exe, cmdSpec.args, { windowsVerbatimArguments: cmdSpec.verbatim });
    }
    const res = {
      ok: true,
      fallback: 'parent',
      path: ancestor,
      originalPath: target,
      message: '原文件已不存在，已自动打开最近的上级目录',
      command: cmdSpec,
    };
    recordOp({ action: 'reveal', path: ancestor, originalPath: target, status: 'fallback', message: res.message });
    return res;
  }

  const res = { ok: false, path: target, error: '目标文件及其上级目录均不存在' };
  recordOp({ action: 'reveal', path: target, status: 'error', message: res.error });
  return res;
}

export function buildRevealCommand(targetPath, isDir) {
  if (process.platform === 'darwin') {
    return isDir
      ? { exe: 'open', args: [targetPath], verbatim: false }
      : { exe: 'open', args: ['-R', targetPath], verbatim: false };
  }
  if (process.platform === 'win32') {
    const safe = targetPath.replace(/"/g, '');
    return isDir
      ? { exe: 'explorer.exe', args: [`"${safe}"`], verbatim: true }
      : { exe: 'explorer.exe', args: [`/select,"${safe}"`], verbatim: true };
  }
  return {
    exe: 'xdg-open',
    args: [isDir ? targetPath : path.dirname(targetPath)],
    verbatim: false,
  };
}

/**
 * Open a local file or folder using the OS default associated application.
 */
export function openWithDefaultApp(rawInput, { dryRun = false } = {}) {
  const target = resolveFileUri(rawInput);
  if (!target || !fs.existsSync(target)) {
    const res = { ok: false, path: target || '', error: '目标路径不存在，无法用默认应用打开' };
    recordOp({ action: 'open-default', path: target || rawInput, status: 'error', message: res.error });
    return res;
  }

  let cmdSpec;
  if (process.platform === 'darwin') {
    cmdSpec = { exe: 'open', args: [target], verbatim: false };
  } else if (process.platform === 'win32') {
    cmdSpec = { exe: 'cmd.exe', args: ['/c', 'start', '""', target], verbatim: false };
  } else {
    cmdSpec = { exe: 'xdg-open', args: [target], verbatim: false };
  }

  if (!dryRun) {
    spawnDetached(cmdSpec.exe, cmdSpec.args, { windowsVerbatimArguments: cmdSpec.verbatim });
  }
  recordOp({ action: 'open-default', path: target, status: 'ok' });
  return { ok: true, path: target, command: cmdSpec };
}

let cachedApps = null;
let cachedAt = 0;

/**
 * Discover common external IDEs and terminal apps available on this machine.
 */
export function discoverExternalApps() {
  const now = Date.now();
  if (cachedApps && now - cachedAt < 60_000) return cachedApps;

  const apps = [];
  if (process.platform === 'darwin') {
    const candidates = [
      { id: 'vscode', label: 'VS Code', kind: 'editor', appPath: '/Applications/Visual Studio Code.app', bundle: 'Visual Studio Code' },
      { id: 'cursor', label: 'Cursor', kind: 'editor', appPath: '/Applications/Cursor.app', bundle: 'Cursor' },
      { id: 'zed', label: 'Zed', kind: 'editor', appPath: '/Applications/Zed.app', bundle: 'Zed' },
      { id: 'windsurf', label: 'Windsurf', kind: 'editor', appPath: '/Applications/Windsurf.app', bundle: 'Windsurf' },
      { id: 'iterm', label: 'iTerm2', kind: 'terminal', appPath: '/Applications/iTerm.app', bundle: 'iTerm' },
      { id: 'warp', label: 'Warp', kind: 'terminal', appPath: '/Applications/Warp.app', bundle: 'Warp' },
      { id: 'terminal', label: 'Terminal', kind: 'terminal', appPath: '/System/Applications/Utilities/Terminal.app', bundle: 'Terminal' },
    ];
    for (const c of candidates) {
      const userPath = path.join(os.homedir(), 'Applications', path.basename(c.appPath));
      if (fs.existsSync(c.appPath) || fs.existsSync(userPath)) {
        apps.push({ id: c.id, label: c.label, kind: c.kind, bundle: c.bundle });
      }
    }
  } else if (process.platform === 'win32') {
    const candidates = [
      { id: 'vscode', label: 'VS Code', kind: 'editor', cli: 'code' },
      { id: 'cursor', label: 'Cursor', kind: 'editor', cli: 'cursor' },
      { id: 'wt', label: 'Windows Terminal', kind: 'terminal', cli: 'wt' },
    ];
    apps.push(...candidates);
  } else {
    apps.push(
      { id: 'vscode', label: 'VS Code', kind: 'editor', cli: 'code' },
      { id: 'cursor', label: 'Cursor', kind: 'editor', cli: 'cursor' },
      { id: 'zed', label: 'Zed', kind: 'editor', cli: 'zed' },
    );
  }

  cachedApps = apps;
  cachedAt = now;
  return apps;
}

export function openInExternalApp(appId, rawInput, { dryRun = false } = {}) {
  const target = resolveFileUri(rawInput);
  if (!target || !fs.existsSync(target)) {
    return { ok: false, error: '目标路径不存在' };
  }
  const apps = discoverExternalApps();
  const app = apps.find((a) => a.id === appId);
  if (!app) {
    return { ok: false, error: `未在本机检测到应用: ${appId}` };
  }

  const effectiveTarget =
    app.kind === 'terminal' && fs.statSync(target).isFile() ? path.dirname(target) : target;

  let cmdSpec;
  if (process.platform === 'darwin') {
    cmdSpec = { exe: 'open', args: ['-a', app.bundle, effectiveTarget], verbatim: false };
  } else if (process.platform === 'win32' && app.id === 'wt') {
    cmdSpec = { exe: 'wt.exe', args: ['-d', effectiveTarget], verbatim: false };
  } else {
    cmdSpec = { exe: app.cli, args: [effectiveTarget], verbatim: false };
  }

  if (!dryRun) {
    spawnDetached(cmdSpec.exe, cmdSpec.args, { windowsVerbatimArguments: cmdSpec.verbatim });
  }
  recordOp({ action: `open-${app.id}`, path: effectiveTarget, status: 'ok' });
  return { ok: true, app: app.label, path: effectiveTarget, command: cmdSpec };
}
