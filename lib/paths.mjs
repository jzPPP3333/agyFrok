import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGIN_NAME = 'agy-fork-explorer';
export const VALID_CONV_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/;

export function isValidConversationId(id) {
  return typeof id === 'string' && VALID_CONV_RE.test(id.trim());
}

export function resolveAppDataDir(overrideDir = '') {
  const candidate =
    overrideDir ||
    process.env.AGY_APP_DATA_DIR ||
    process.env.ANTIGRAVITY_APP_DATA_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity');
  return path.resolve(candidate);
}

export function resolveBrainDir(overrideAppDataDir = '') {
  return path.join(resolveAppDataDir(overrideAppDataDir), 'brain');
}

export function resolvePluginDataDir(overrideDir = '') {
  const candidate =
    overrideDir ||
    process.env.AGY_FORK_EXPLORER_DATA_DIR ||
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    path.join(resolveAppDataDir(), 'plugin_data', PLUGIN_NAME);
  return path.resolve(candidate);
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function resolveDevToolsPortFile(overridePath = '') {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.AGY_DEVTOOLS_PORT_FILE) return path.resolve(process.env.AGY_DEVTOOLS_PORT_FILE);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Antigravity', 'DevToolsActivePort');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'Antigravity', 'DevToolsActivePort');
}

/**
 * Normalize a `file://` URI (with optional `#L10-L20` / `?query` / `%3A`) or raw path
 * into a clean local filesystem path.
 */
export function resolveFileUri(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return null;

  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol.toLowerCase() !== 'file:') return null;
      url.hash = '';
      url.search = '';
      if (process.platform === 'win32') {
        url.pathname = url.pathname.replace(/^\/([a-zA-Z])%3[Aa](?=\/|$)/, '/$1:');
      }
      return path.resolve(fileURLToPath(url));
    } catch {
      try {
        let bare = trimmed.replace(/^file:\/\//i, '').split(/[?#]/)[0];
        if (!bare) return null;
        try {
          bare = decodeURIComponent(bare);
        } catch {
          // Keep raw if malformed percent encoding
        }
        if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(bare)) {
          bare = bare.slice(1);
        }
        return path.resolve(bare);
      } catch {
        return null;
      }
    }
  }

  // Strip trailing #L12-L30 anchors on plain paths too
  const stripped = trimmed.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/^~(?=\/|$)/, os.homedir());
  return path.resolve(stripped);
}

export function toFileUri(localPath) {
  const resolved = resolveFileUri(localPath);
  if (!resolved) return '';
  try {
    return pathToFileURL(resolved).href;
  } catch {
    return '';
  }
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
  return filePath;
}
