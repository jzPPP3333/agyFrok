import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  claimNextReadyRelayJob,
  completeRelayJob,
  confirmRelayJob,
  dismissRelayJob,
  listRelaySnapshot,
  loadPluginSettings,
  queueManualRelay,
  savePluginSettings,
} from '../../lib/auto-relay.mjs';
import { createCdpBridge } from '../../lib/cdp-bridge.mjs';
import { buildForkTreeView, executeFork, extractConversationIdDeep, FORK_MODES, updateBranchMeta } from '../../lib/fork-engine.mjs';
import {
  createSafetySnapshot,
  getGitRepoInfo,
  getSnapshotDiff,
  listSafetySnapshots,
  listWorktrees,
  removeForkWorktree,
  restoreSnapshotFile,
} from '../../lib/git-ops.mjs';
import {
  discoverExternalApps,
  getRecentExplorerOps,
  openInExternalApp,
  openWithDefaultApp,
  revealInExplorer,
} from '../../lib/os-explorer.mjs';
import {
  isValidConversationId,
  resolveAppDataDir,
  resolveFileUri,
  resolvePluginDataDir,
} from '../../lib/paths.mjs';
import {
  DEFAULT_COMPACTION_LIMIT,
  exportConversation,
  listLocalSessions,
  parseConversationTranscript,
  searchLocalSessions,
} from '../../lib/transcript-parser.mjs';
import {
  listWorkspaceTree,
  loadExplorerState,
  readFilePreview,
  recordRecentRoot,
  toggleFavoritePath,
} from '../../lib/workspace-tree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadSettings(pluginDataDir = '') {
  return loadPluginSettings(pluginDataDir);
}

function saveSettings(patch = {}, pluginDataDir = '') {
  return savePluginSettings(patch, pluginDataDir);
}

/**
 * Pure business handlers shared by SidecarApp, standalone dev server, and automated tests.
 */
export function createCockpitHandlers(options = {}) {
  const getDefaultConvId = typeof options.getDefaultConvId === 'function' ? options.getDefaultConvId : () => '';
  const getDefaultWorkspace = typeof options.getDefaultWorkspace === 'function' ? options.getDefaultWorkspace : () => '';
  const appDataDir = options.appDataDir || resolveAppDataDir();
  const pluginDataDir = options.pluginDataDir || resolvePluginDataDir();
  const getCdpStatus = typeof options.getCdpStatus === 'function' ? options.getCdpStatus : () => ({ enabled: false, state: 'inactive', attachedPages: 0 });
  const setCdpEnabled = typeof options.setCdpEnabled === 'function' ? options.setCdpEnabled : async () => {};
  const dryRunOs = Boolean(options.dryRunOs);

  let activeWorkspaceRoot = '';

  function resolveActiveConvId(reqConvId = '') {
    const cleaned = String(reqConvId || '').trim();
    if (isValidConversationId(cleaned)) return cleaned;
    const hostId = String(getDefaultConvId() || '').trim();
    if (isValidConversationId(hostId)) return hostId;
    const recent = listLocalSessions({ appDataDir, limit: 1 });
    return recent[0]?.conversationId || '';
  }

  async function handleState(query = {}) {
    const settings = loadSettings(pluginDataDir);
    const sessions = listLocalSessions({
      appDataDir,
      limit: 40,
      compactionLimit: settings.compactionLimit,
    });
    const convId = resolveActiveConvId(query.conversationId);
    const parsed = convId
      ? parseConversationTranscript(convId, {
          appDataDir,
          compactionLimit: settings.compactionLimit,
        })
      : null;

    const candidateRoot =
      resolveFileUri(query.workspaceRoot || query.workspaceUri) ||
      activeWorkspaceRoot ||
      parsed?.workspaceRoot ||
      resolveFileUri(getDefaultWorkspace()) ||
      process.cwd();

    if (candidateRoot && fs.existsSync(candidateRoot)) {
      activeWorkspaceRoot = candidateRoot;
      recordRecentRoot(candidateRoot, { pluginDataDir });
    }

    const forkTree = buildForkTreeView(convId, { appDataDir, pluginDataDir });
    const git = activeWorkspaceRoot ? await getGitRepoInfo(activeWorkspaceRoot) : { isRepo: false, repoRoot: '', branch: '', dirtyCount: 0 };
    const worktrees = git.isRepo ? await listWorktrees(git.repoRoot) : [];
    const snapshots = listSafetySnapshots({ repoRoot: git.repoRoot || '', pluginDataDir });
    const explorerState = loadExplorerState({ pluginDataDir });

    return {
      ok: true,
      platform: process.platform,
      conversationId: convId,
      conversation: parsed?.ok
        ? {
            conversationId: parsed.conversationId,
            title: parsed.title,
            workspaceRoot: parsed.workspaceRoot,
            isScratch: parsed.isScratch,
            convDir: parsed.convDir,
            turnCount: parsed.turns.length,
            turns: parsed.turns.map((t) => ({
              turnIndex: t.turnIndex,
              stepStart: t.stepStart,
              stepEnd: t.stepEnd,
              createdAt: t.createdAt,
              userTitle: t.userTitle,
              assistantPreview: (t.assistantText || '').slice(0, 180),
              toolCount: t.toolCalls.length,
              touchedFiles: t.touchedFiles.slice(0, 10),
              estTokens: t.estTokens,
              cumulativeTokens: t.cumulativeTokens,
              hasError: t.hasError,
            })),
            artifacts: parsed.artifacts,
            context: parsed.context,
          }
        : null,
      sessions,
      forkTree,
      workspace: {
        root: activeWorkspaceRoot,
        git: {
          isRepo: git.isRepo,
          repoRoot: git.repoRoot,
          branch: git.branch,
          dirtyCount: git.dirtyCount,
        },
        worktrees,
        favorites: explorerState.favorites,
        recentRoots: explorerState.recentRoots,
      },
      snapshots,
      externalApps: discoverExternalApps(),
      cdp: getCdpStatus(),
      settings,
      relay: listRelaySnapshot({ pluginDataDir }),
      recentOps: getRecentExplorerOps().slice(0, 10),
    };
  }

  async function handleFork(body = {}) {
    const settings = loadSettings(pluginDataDir);
    const convId = resolveActiveConvId(body.conversationId);
    if (!convId) return { ok: false, error: '当前没有可分叉的会话' };
    return executeFork({
      conversationId: convId,
      upToTurn: Number(body.upToTurn) || 0,
      mode: body.mode || settings.defaultForkMode,
      autoSmartHandoff: Boolean(body.autoSmartHandoff),
      zeroTokenLazy: body.zeroTokenLazy !== undefined ? Boolean(body.zeroTokenLazy) : Boolean(settings.zeroTokenLazy),
      autoContinue: Boolean(body.autoContinue),
      handoffContent: String(body.handoffContent || ''),
      handoffFilePath: String(body.handoffFilePath || ''),
      model: String(body.model || ''),
      relayChainDepth: Number(body.relayChainDepth) || 0,
      branchLabel: String(body.branchLabel || '').trim(),
      nextInstruction: String(body.nextInstruction || '').trim(),
      workspaceRoot: resolveFileUri(body.workspaceRoot) || activeWorkspaceRoot || '',
      createWorktree: body.createWorktree !== undefined ? Boolean(body.createWorktree) : settings.defaultWorktree,
      createSnapshot: body.createSnapshot !== undefined ? Boolean(body.createSnapshot) : settings.autoSnapshot,
      appDataDir,
      pluginDataDir,
      customLauncher: options.customLauncher || null,
      resolveProjectId: options.resolveProjectId || null,
    });
  }

  async function processRelayQueueOnce({ now = Date.now() } = {}) {
    const job = claimNextReadyRelayJob({ pluginDataDir, now });
    if (!job) return { processed: false };
    const settings = loadSettings(pluginDataDir);
    try {
      const forkRes = await handleFork({
        conversationId: job.conversationId,
        mode: FORK_MODES.HANDOFF,
        autoContinue: true,
        zeroTokenLazy: false,
        handoffFilePath: job.handoffFile || '',
        model: job.model || settings.autoRelayModel || 'pro',
        relayChainDepth: (Number(job.chainDepth) || 0) + 1,
        workspaceRoot: job.workspaceRoot || '',
        createSnapshot: settings.autoSnapshot,
        createWorktree: false,
      });
      const completed = completeRelayJob(job.id, forkRes, { pluginDataDir, now: Date.now() });
      if (typeof options.onRelayLaunched === 'function') {
        options.onRelayLaunched(forkRes, completed);
      }
      return { processed: true, job: completed, result: forkRes };
    } catch (err) {
      const errRes = { ok: false, error: err?.message || String(err) };
      const completed = completeRelayJob(job.id, errRes, { pluginDataDir, now: Date.now() });
      if (typeof options.onRelayLaunched === 'function') {
        options.onRelayLaunched(errRes, completed);
      }
      return { processed: true, job: completed, result: errRes };
    }
  }

  async function handleRelayConfirm(body = {}) {
    const res = confirmRelayJob(String(body.jobId || ''), { pluginDataDir });
    if (!res.ok) return res;
    if (res.alreadyLaunched) return res;
    const processed = await processRelayQueueOnce();
    return {
      ok: true,
      job: processed.job || res.job,
      result: processed.result || null,
    };
  }

  function handleRelayDismiss(body = {}) {
    const res = dismissRelayJob(String(body.jobId || ''), { pluginDataDir });
    if (typeof options.onRelayDismissed === 'function') {
      options.onRelayDismissed(res);
    }
    return res;
  }

  async function handleRelayTrigger(body = {}) {
    const convId = resolveActiveConvId(body.conversationId);
    if (!convId) return { ok: false, error: '当前没有可接力的会话' };
    const settings = loadSettings(pluginDataDir);
    const confirmMode = body.confirmMode || settings.autoRelayConfirmMode;
    const queued = queueManualRelay(convId, {
      pluginDataDir,
      appDataDir,
      confirmMode,
    });
    if (!queued.ok) return queued;
    if (queued.job.status === 'queued') {
      const processed = await processRelayQueueOnce();
      return { ok: true, job: processed.job || queued.job, result: processed.result || null };
    }
    return queued;
  }

  function handleBranchMeta(body = {}) {
    if (!body?.conversationId) return { ok: false, error: '缺少 conversationId' };
    const updated = updateBranchMeta(body.conversationId, body, { pluginDataDir });
    return { ok: true, node: updated };
  }

  async function handleTree(query = {}) {
    const root = resolveFileUri(query.root || query.workspaceRoot) || activeWorkspaceRoot || process.cwd();
    if (root && fs.existsSync(root)) {
      activeWorkspaceRoot = root;
    }
    const showHidden = query.showHidden === true || query.showHidden === 'true' || query.showHidden === '1';
    const tree = await listWorkspaceTree(root, {
      relDir: String(query.relDir || ''),
      showHidden,
      filter: String(query.filter || ''),
    });
    const explorerState = loadExplorerState({ pluginDataDir });
    return {
      ...tree,
      favorites: explorerState.favorites,
      recentRoots: explorerState.recentRoots,
    };
  }

  function handlePreview(query = {}) {
    return readFilePreview(query.path || query.uri || '');
  }

  function handleReveal(body = {}) {
    return revealInExplorer(body.path || body.uri || '', { dryRun: dryRunOs });
  }

  function handleOpenDefault(body = {}) {
    return openWithDefaultApp(body.path || body.uri || '', { dryRun: dryRunOs });
  }

  function handleOpenApp(body = {}) {
    return openInExternalApp(body.appId, body.path || body.uri || '', { dryRun: dryRunOs });
  }

  function handleFavorite(body = {}) {
    return toggleFavoritePath(body.path || '', { label: body.label || '', pluginDataDir });
  }

  function handleHistorySearch(query = {}) {
    const items = searchLocalSessions(query.q || '', { appDataDir, limit: Number(query.limit) || 30 });
    return { ok: true, query: String(query.q || ''), items };
  }

  function handleHistoryExport(body = {}) {
    const convId = resolveActiveConvId(body.conversationId);
    const res = exportConversation(convId, {
      appDataDir,
      pluginDataDir,
      format: body.format === 'json' ? 'json' : 'md',
      includeThinking: body.includeThinking !== false,
      upToTurn: Number(body.upToTurn) || 0,
    });
    if (res.ok && body.reveal) {
      revealInExplorer(res.path, { dryRun: dryRunOs });
    }
    return res;
  }

  async function handleSnapshotCreate(body = {}) {
    const root = resolveFileUri(body.workspaceRoot) || activeWorkspaceRoot;
    return createSafetySnapshot(root, {
      label: String(body.label || 'manual-snapshot').trim(),
      conversationId: resolveActiveConvId(body.conversationId),
      pluginDataDir,
    });
  }

  async function handleSnapshotDiff(query = {}) {
    return getSnapshotDiff(String(query.id || ''), { pluginDataDir });
  }

  async function handleSnapshotRestoreFile(body = {}) {
    return restoreSnapshotFile(String(body.id || ''), String(body.relPath || ''), { pluginDataDir });
  }

  async function handleWorktreeRemove(body = {}) {
    const root = resolveFileUri(body.repoRoot) || activeWorkspaceRoot;
    return removeForkWorktree(root, body.worktreePath || '');
  }

  async function handleSettingsUpdate(body = {}) {
    const next = saveSettings(body, pluginDataDir);
    if (typeof body.cdpEnabled === 'boolean') {
      await setCdpEnabled(body.cdpEnabled);
    }
    return { ok: true, settings: next, cdp: getCdpStatus() };
  }

  return {
    handleState,
    handleFork,
    handleBranchMeta,
    handleTree,
    handlePreview,
    handleReveal,
    handleOpenDefault,
    handleOpenApp,
    handleFavorite,
    handleHistorySearch,
    handleHistoryExport,
    handleSnapshotCreate,
    handleSnapshotDiff,
    handleSnapshotRestoreFile,
    handleWorktreeRemove,
    handleSettingsUpdate,
    handleRelayConfirm,
    handleRelayDismiss,
    handleRelayTrigger,
    processRelayQueueOnce,
  };
}

function readLocalAsset(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

function installHotReloadWatcher() {
  const watched = [
    path.join(__dirname, 'main.mjs'),
    path.join(__dirname, '..', '..', 'lib', 'auto-relay.mjs'),
    path.join(__dirname, '..', '..', 'lib', 'fork-engine.mjs'),
    path.join(__dirname, '..', '..', 'lib', 'transcript-parser.mjs'),
    path.join(__dirname, '..', '..', 'lib', 'os-explorer.mjs'),
    path.join(__dirname, '..', '..', 'lib', 'workspace-tree.mjs'),
    path.join(__dirname, '..', '..', 'lib', 'cdp-bridge.mjs'),
    path.join(__dirname, '..', '..', 'lib', 'native-overlay.js'),
  ];
  const mtimes = new Map(
    watched.map((p) => {
      try { return [p, fs.statSync(p).mtimeMs]; } catch { return [p, 0]; }
    }),
  );
  const timer = setInterval(() => {
    for (const p of watched) {
      try {
        const cur = fs.statSync(p).mtimeMs;
        const prev = mtimes.get(p) || 0;
        if (cur && prev && cur !== prev) {
          process.exit(0);
        }
      } catch {}
    }
  }, 3000);
  timer.unref?.();
}

async function startStandalone(port = 4173) {
  const handlers = createCockpitHandlers();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const pathname = url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());

    const sendJson = (obj, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };

    const readBody = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return {};
      try { return JSON.parse(raw); } catch { return {}; }
    };

    try {
      if (pathname === '/' || pathname === '/sidebar') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(readLocalAsset('index.html'));
      } else if (pathname === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('/* standalone mode: host preload not required */\n');
      } else if (pathname === '/styles.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(readLocalAsset('styles.css'));
      } else if (pathname === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(readLocalAsset('app.js'));
      } else if (pathname === '/api/state' && req.method === 'GET') {
        sendJson(await handlers.handleState(query));
      } else if (pathname === '/api/fork' && req.method === 'POST') {
        sendJson(await handlers.handleFork(await readBody()));
      } else if (pathname === '/api/branch/meta' && req.method === 'POST') {
        sendJson(handlers.handleBranchMeta(await readBody()));
      } else if (pathname === '/api/tree' && req.method === 'GET') {
        sendJson(await handlers.handleTree(query));
      } else if (pathname === '/api/preview' && req.method === 'GET') {
        sendJson(handlers.handlePreview(query));
      } else if (pathname === '/api/explorer/reveal' && req.method === 'POST') {
        sendJson(handlers.handleReveal(await readBody()));
      } else if (pathname === '/api/explorer/open-default' && req.method === 'POST') {
        sendJson(handlers.handleOpenDefault(await readBody()));
      } else if (pathname === '/api/explorer/open-app' && req.method === 'POST') {
        sendJson(handlers.handleOpenApp(await readBody()));
      } else if (pathname === '/api/explorer/favorite' && req.method === 'POST') {
        sendJson(handlers.handleFavorite(await readBody()));
      } else if (pathname === '/api/history/search' && req.method === 'GET') {
        sendJson(handlers.handleHistorySearch(query));
      } else if (pathname === '/api/history/export' && req.method === 'POST') {
        sendJson(handlers.handleHistoryExport(await readBody()));
      } else if (pathname === '/api/snapshot/create' && req.method === 'POST') {
        sendJson(await handlers.handleSnapshotCreate(await readBody()));
      } else if (pathname === '/api/snapshot/diff' && req.method === 'GET') {
        sendJson(await handlers.handleSnapshotDiff(query));
      } else if (pathname === '/api/snapshot/restore-file' && req.method === 'POST') {
        sendJson(await handlers.handleSnapshotRestoreFile(await readBody()));
      } else if (pathname === '/api/worktree/remove' && req.method === 'POST') {
        sendJson(await handlers.handleWorktreeRemove(await readBody()));
      } else if (pathname === '/api/settings' && req.method === 'POST') {
        sendJson(await handlers.handleSettingsUpdate(await readBody()));
      } else if (pathname === '/api/relay/confirm' && req.method === 'POST') {
        sendJson(await handlers.handleRelayConfirm(await readBody()));
      } else if (pathname === '/api/relay/dismiss' && req.method === 'POST') {
        sendJson(handlers.handleRelayDismiss(await readBody()));
      } else if (pathname === '/api/relay/trigger' && req.method === 'POST') {
        sendJson(await handlers.handleRelayTrigger(await readBody()));
      } else {
        sendJson({ ok: false, error: 'Not Found' }, 404);
      }
    } catch (err) {
      sendJson({ ok: false, error: err?.message || 'Internal Error' }, 500);
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  console.log(`[agy-fork-explorer] Standalone Cockpit running at http://127.0.0.1:${port}`);
  return server;
}

/**
 * Resolve Antigravity's built-in `sidecar_sdk` cleanly even when the plugin is symlinked
 * outside `~/.gemini/config/plugins/` (Node ESM resolves bare specifiers from realpath).
 */
export async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch (primaryErr) {
    const candidates = [];
    if (process.env.NODE_PATH) {
      for (const dir of process.env.NODE_PATH.split(path.delimiter)) {
        if (dir) candidates.push(path.join(dir, 'sidecar_sdk', 'index.mjs'));
      }
    }
    const appDataDir = resolveAppDataDir();
    candidates.push(
      path.join(appDataDir, 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'),
      path.join(os.homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs'),
      path.join(os.homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'),
    );
    for (const entry of candidates) {
      try {
        if (fs.existsSync(entry)) {
          return await import(pathToFileURL(entry).href);
        }
      } catch {
        // Try next candidate
      }
    }
    throw primaryErr;
  }
}

async function startSidecar() {
  const { SidecarApp, Response } = await loadSidecarSdk();
  const app = new SidecarApp();
  const pluginDataDir = resolvePluginDataDir();
  const initialSettings = loadSettings(pluginDataDir);

  let handlers = null;
  const cdpBridge = createCdpBridge({
    onForkRequest: async (payload) => handlers.handleFork(payload),
    onRelayConfirm: async (jobId) => handlers.handleRelayConfirm({ jobId }),
    onRelayDismiss: async (jobId) => handlers.handleRelayDismiss({ jobId }),
    onResolveWorkspace: async (convId) => {
      if (convId && isValidConversationId(convId)) {
        const parsed = parseConversationTranscript(convId, { appDataDir: resolveAppDataDir() });
        if (parsed?.ok) {
          if (parsed.workspaceRoot && fs.existsSync(parsed.workspaceRoot)) {
            return { path: parsed.workspaceRoot, note: `已在系统资源管理器打开工作区：${path.basename(parsed.workspaceRoot)}` };
          }
          if (parsed.convDir && fs.existsSync(parsed.convDir)) {
            return { path: parsed.convDir, note: '该会话无绑定工作区，已打开会话产物目录' };
          }
        }
      }
      const state = await handlers.handleState({ conversationId: convId });
      const root = state?.workspace?.root || '';
      return root ? { path: root, note: `已打开工作区：${path.basename(root)}` } : '';
    },
    onFetchTurns: async (convId) => {
      if (!convId || !isValidConversationId(convId)) return null;
      const parsed = parseConversationTranscript(convId, { appDataDir: resolveAppDataDir() });
      if (!parsed?.ok) return null;
      return {
        conversationId: convId,
        title: parsed.title,
        turns: parsed.turns.map((t) => ({ turnIndex: t.turnIndex, userTitle: t.userTitle })),
      };
    },
    getTelemetrySnapshot: async () => {
      const state = await handlers.handleState({});
      if (!state?.conversation) return null;
      return {
        conversationId: state.conversationId,
        workspaceRoot: state.workspace?.root || '',
        percent: state.conversation.context?.percent || 0,
        usedTokens: state.conversation.context?.usedTokens || 0,
        limitTokens: state.conversation.context?.limitTokens || DEFAULT_COMPACTION_LIMIT,
        tokenSource: state.conversation.context?.tokenSource || 'estimated',
        level: state.conversation.context?.level || 'healthy',
        turnCount: state.conversation.turnCount || 0,
        branchCount: state.forkTree?.totalBranches || 1,
        artifactCount: state.conversation.artifacts?.length || 0,
        turns: state.conversation.turns || [],
        relay: state.relay || null,
      };
    },
  });

  const resolveSourceProjectId = async (parentId) => {
    let projectId = app.config?.projectId || '';
    if (parentId) {
      try {
        const md = app.getConversationMetadata(parentId);
        const metaEvent = md?.response?.conversationMetadata || md?.response?.conversation_metadata;
        const m = metaEvent?.metadata || md?.metadata || md;
        const resolved = m?.projectId || m?.project_id || '';
        if (resolved) projectId = resolved;
      } catch {
        // Fall back to sidecar's default projectId if metadata lookup fails
      }
    }
    return projectId;
  };

  handlers = createCockpitHandlers({
    getDefaultConvId: () => app.config?.conversationId || '',
    getDefaultWorkspace: () => app.config?.workspaceUri || process.env.ANTIGRAVITY_WORKSPACE_ROOT || '',
    getCdpStatus: () => cdpBridge.status(),
    setCdpEnabled: (enabled) => cdpBridge.setEnabled(enabled),
    resolveProjectId: resolveSourceProjectId,
    onRelayLaunched: (res) => cdpBridge.broadcastRelayComplete(res),
    onRelayDismissed: () => cdpBridge.broadcastHideRelayBanner(),
    customLauncher: async (prompt, meta = {}) => {
      const projectId = await resolveSourceProjectId(meta?.parentId);
      const requestedModel = meta?.autoContinue ? meta?.model || 'pro' : 'flash';
      let usedModel = requestedModel;
      let res;
      try {
        res = app.startConversation(prompt, {
          model: requestedModel,
          ...(projectId ? { projectId } : {}),
        });
      } catch (err) {
        if (requestedModel !== 'flash') {
          usedModel = 'flash';
          res = app.startConversation(prompt, {
            model: 'flash',
            ...(projectId ? { projectId } : {}),
          });
        } else {
          throw err;
        }
      }
      const newId = extractConversationIdDeep(res);
      console.log(
        `[agy-fork-explorer] ${meta?.autoContinue ? 'Auto-Relay' : 'Fork'} launched: parent=${meta?.parentId || '?'} -> child=${newId || 'pending'} project=${projectId || '(default)'} model=${usedModel}`,
      );
      return {
        launched: Boolean(newId),
        channel: 'sidecar_sdk',
        conversationId: newId,
        projectId,
        model: usedModel,
      };
    },
  });

  if (initialSettings.cdpEnabled) {
    cdpBridge.start();
  }

  // Lightweight 1s watcher for Scheme B + C Auto-Relay jobs (countdown broadcast + zero-delay launch)
  let relayBusy = false;
  let lastBroadcastJobId = '';
  const relayTick = async () => {
    if (relayBusy) return;
    relayBusy = true;
    try {
      const snap = listRelaySnapshot({ pluginDataDir });
      if (snap.activeJob && snap.activeJob.status === 'awaiting_confirm') {
        lastBroadcastJobId = snap.activeJob.id;
        cdpBridge.broadcastRelayBanner(snap.activeJob);
      } else if (lastBroadcastJobId) {
        lastBroadcastJobId = '';
        cdpBridge.broadcastHideRelayBanner();
      }
      await handlers.processRelayQueueOnce();
    } catch (err) {
      console.error('[agy-fork-explorer] relay tick error:', err?.message || err);
    } finally {
      relayBusy = false;
    }
  };
  const relayTimer = setInterval(() => void relayTick(), 1000);
  relayTimer.unref?.();

  installHotReloadWatcher();

  const html = () => readLocalAsset('index.html');
  app.page('/', html);
  app.page('/sidebar', html);
  app.api('/styles.css', () => new Response(readLocalAsset('styles.css'), { contentType: 'text/css; charset=utf-8' }), 'GET');
  app.api('/app.js', () => new Response(readLocalAsset('app.js'), { contentType: 'application/javascript; charset=utf-8' }), 'GET');

  app.api('/api/state', (d) => handlers.handleState(d), 'GET');
  app.api('/api/fork', (d) => handlers.handleFork(d), 'POST');
  app.api('/api/branch/meta', (d) => handlers.handleBranchMeta(d), 'POST');
  app.api('/api/tree', (d) => handlers.handleTree(d), 'GET');
  app.api('/api/preview', (d) => handlers.handlePreview(d), 'GET');
  app.api('/api/explorer/reveal', (d) => handlers.handleReveal(d), 'POST');
  app.api('/api/explorer/open-default', (d) => handlers.handleOpenDefault(d), 'POST');
  app.api('/api/explorer/open-app', (d) => handlers.handleOpenApp(d), 'POST');
  app.api('/api/explorer/favorite', (d) => handlers.handleFavorite(d), 'POST');
  app.api('/api/history/search', (d) => handlers.handleHistorySearch(d), 'GET');
  app.api('/api/history/export', (d) => handlers.handleHistoryExport(d), 'POST');
  app.api('/api/snapshot/create', (d) => handlers.handleSnapshotCreate(d), 'POST');
  app.api('/api/snapshot/diff', (d) => handlers.handleSnapshotDiff(d), 'GET');
  app.api('/api/snapshot/restore-file', (d) => handlers.handleSnapshotRestoreFile(d), 'POST');
  app.api('/api/worktree/remove', (d) => handlers.handleWorktreeRemove(d), 'POST');
  app.api('/api/settings', (d) => handlers.handleSettingsUpdate(d), 'POST');
  app.api('/api/relay/confirm', (d) => handlers.handleRelayConfirm(d), 'POST');
  app.api('/api/relay/dismiss', (d) => handlers.handleRelayDismiss(d), 'POST');
  app.api('/api/relay/trigger', (d) => handlers.handleRelayTrigger(d), 'POST');

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, async () => {
      clearInterval(relayTimer);
      await cdpBridge.stop().catch(() => {});
      process.exit(0);
    });
  }

  app.run();
}

const isEntry = (() => {
  if (process.env.AGY_TEST_NO_START === '1' || !process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(path.resolve(process.argv[1])).toLowerCase() ===
      fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
    );
  } catch {
    return path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  }
})();

if (isEntry) {
  if (process.argv.includes('--standalone')) {
    const portArg = process.argv.find((a) => a.startsWith('--port='));
    const port = portArg ? Number(portArg.split('=')[1]) || 4173 : 4173;
    startStandalone(port).catch((err) => {
      console.error('[agy-fork-explorer] standalone failed:', err);
      process.exit(1);
    });
  } else {
    startSidecar().catch((err) => {
      console.error('[agy-fork-explorer] sidecar failed:', err);
      process.exit(1);
    });
  }
}
