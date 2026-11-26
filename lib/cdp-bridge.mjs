import fs from 'node:fs';
import { buildNativeOverlaySource } from './native-overlay.js';
import { discoverExternalApps, openInExternalApp, openWithDefaultApp, revealInExplorer } from './os-explorer.mjs';
import { resolveDevToolsPortFile } from './paths.mjs';

const BINDING_NAME = '__agyForkExplorerAction';

export function readDevToolsPort(portFile = '') {
  const file = resolveDevToolsPortFile(portFile);
  if (process.env.AGY_CDP_PORT) {
    const p = Number(process.env.AGY_CDP_PORT);
    if (Number.isInteger(p) && p > 0 && p < 65536) {
      return { ok: true, port: p, source: 'env' };
    }
  }
  try {
    if (!fs.existsSync(file)) return { ok: false, state: 'missing', file };
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const port = Number(lines[0]);
    if (!Number.isInteger(port) || port <= 0) {
      return { ok: false, state: 'invalid', file };
    }
    return { ok: true, port, browserPath: lines[1] || '', source: 'portfile', file };
  } catch (err) {
    return { ok: false, state: 'error', file, error: err?.message || String(err) };
  }
}

export function isAntigravityHubTarget(target) {
  if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
  try {
    const url = new URL(target.url || '');
    const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!isLoopback) return false;
    // Skip sidecar iframes or devtools themselves
    if (url.protocol === 'devtools:' || url.protocol === 'chrome-extension:') return false;
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Lightweight zero-dependency CDP session over Node's native WebSocket (>= 22, or graceful skip if absent).
 */
class CdpPageClient {
  constructor(wsUrl, { onBindingCalled, onClose }) {
    this.wsUrl = wsUrl;
    this.onBindingCalled = onBindingCalled;
    this.onClose = onClose;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async connect() {
    if (typeof globalThis.WebSocket !== 'function') {
      throw new Error('当前 Node 运行时缺少全局 WebSocket（需 Node >= 22）');
    }
    return new Promise((resolve, reject) => {
      const ws = new globalThis.WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('CDP WebSocket 连接超时'));
      }, 4000);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(this);
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket 连接失败'));
      });
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const { reject: rej } of this.pending.values()) {
          rej(new Error('CDP WebSocket 已关闭'));
        }
        this.pending.clear();
        this.onClose?.();
      });
      ws.addEventListener('message', (evt) => {
        let msg;
        try {
          msg = JSON.parse(String(evt.data || ''));
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej, t } = this.pending.get(msg.id);
          clearTimeout(t);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || 'CDP error'));
          else res(msg.result);
        } else if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === BINDING_NAME) {
          this.onBindingCalled?.(msg.params.payload, this);
        }
      });
    });
  }

  send(method, params = {}) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('CDP 连接未就绪'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, 5000);
      this.pending.set(id, { resolve, reject, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.closed = true;
    try { this.ws?.close?.(); } catch {}
  }
}

/**
 * Optional CDP bridge that mounts the agy-powertools style Shadow DOM overlay into Antigravity windows
 * whenever a local debugging port is detected. Safely degrades to inactive when CDP is not enabled.
 */
export function createCdpBridge({
  portFile = '',
  pollMs = 4000,
  onForkRequest = null,
  onResolveWorkspace = null,
  onFetchTurns = null,
  onRelayConfirm = null,
  onRelayDismiss = null,
  getTelemetrySnapshot = null,
} = {}) {
  const ownerId = Date.now();
  const attached = new Map(); // targetId -> CdpPageClient
  let timer = null;
  let stopped = false;
  let enabled = true;
  let state = 'idle'; // idle | inactive | connected | unreachable
  let lastError = '';
  let activePort = 0;

  async function handleAction(rawPayload, client) {
    let payload;
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      return;
    }
    const notify = (msg, isErr = false) =>
      client
        .send('Runtime.evaluate', {
          expression: `globalThis.__agyForkExplorerOverlay?.notify(${JSON.stringify(msg)}, ${Boolean(isErr)})`,
        })
        .catch(() => {});

    try {
      if (payload.action === 'reveal') {
        const res = revealInExplorer(payload.uri);
        notify(res.ok ? res.message || '已在系统文件管理器中定位' : res.error || '打开失败', !res.ok);
      } else if (payload.action === 'openDefault') {
        const res = openWithDefaultApp(payload.uri);
        notify(res.ok ? '已用默认应用打开' : res.error || '打开失败', !res.ok);
      } else if (payload.action === 'openApp') {
        const res = openInExternalApp(payload.appId, payload.uri);
        notify(res.ok ? `已在 ${res.app} 中打开` : res.error || '打开失败', !res.ok);
      } else if (payload.action === 'openWorkspaceFinder') {
        const resolved = typeof onResolveWorkspace === 'function' ? await onResolveWorkspace(payload.conversationId) : '';
        const targetPath = typeof resolved === 'object' ? resolved?.path || '' : resolved;
        const note = typeof resolved === 'object' ? resolved?.note || '' : '';
        if (!targetPath) {
          notify('未检测到该会话对应的工作区或产物目录', true);
          return;
        }
        const res = revealInExplorer(targetPath);
        notify(res.ok ? note || `已打开：${targetPath}` : res.error || '打开失败', !res.ok);
      } else if (payload.action === 'fetchTurns' && typeof onFetchTurns === 'function') {
        const info = await onFetchTurns(payload.conversationId);
        if (info) {
          await client
            .send('Runtime.evaluate', {
              expression: `globalThis.__agyForkExplorerOverlay?.receiveConversationTurns(${JSON.stringify(info)})`,
            })
            .catch(() => {});
        }
      } else if (payload.action === 'forkTurn' && typeof onForkRequest === 'function') {
        const res = await onForkRequest(payload);
        if (res?.ok) {
          if (res.lazy && res.prefillPrompt) {
            await client
              .send('Runtime.evaluate', {
                expression: `globalThis.__agyForkExplorerOverlay?.startLazyFork(${JSON.stringify(res.prefillPrompt)}, ${JSON.stringify(res.projectId || '')}, ${JSON.stringify(res.branchLabel || 'fork')})`,
              })
              .catch(() => {});
          } else if (res.launched && res.newConversationId) {
            const modeTag = res.mode === 'handoff' ? '轻装交接' : '极简复刻';
            notify(`🌿 已创建分支「${res.branchLabel}」(${modeTag} ~${res.promptEstTokens || 0} tok)，正在切页…`);
            await client
              .send('Runtime.evaluate', {
                expression: `globalThis.__agyForkExplorerOverlay?.navigateConversation(${JSON.stringify(res.newConversationId)}, ${JSON.stringify(res.projectId || '')})`,
              })
              .catch(() => {});
          } else {
            notify(`🌿 分支「${res.branchLabel}」上下文已就绪，请打开右侧时空驾驶舱查看`);
          }
        } else {
          notify(res?.error || '创建分支失败', true);
        }
      } else if (payload.action === 'relayConfirm' && typeof onRelayConfirm === 'function') {
        const res = await onRelayConfirm(payload.jobId);
        if (res?.ok) {
          notify('⚡ 已确认！正在创建低水位接力分支并无缝续跑…');
        } else {
          notify(res?.error || '确认接力失败', true);
        }
      } else if (payload.action === 'relayDismiss' && typeof onRelayDismiss === 'function') {
        const res = await onRelayDismiss(payload.jobId);
        if (res?.ok) {
          notify(`⏸️ 已暂停本次自动接力（水位达 ${res.dismissedUntilPct || 90}% 红线前不再打扰）`);
        } else {
          notify(res?.error || '取消接力失败', true);
        }
      }
    } catch (err) {
      notify(err?.message || '执行动作失败', true);
    }
  }

  async function injectOverlay(client) {
    await client.send('Runtime.enable');
    await client.send('Runtime.addBinding', { name: BINDING_NAME });
    const source = buildNativeOverlaySource({
      ownerId,
      apps: discoverExternalApps(),
      platform: process.platform,
    });
    await client.send('Runtime.evaluate', { expression: source });
    if (typeof getTelemetrySnapshot === 'function') {
      const snap = await getTelemetrySnapshot();
      if (snap) {
        await client.send('Runtime.evaluate', {
          expression: `globalThis.__agyForkExplorerOverlay?.updateTelemetry(${JSON.stringify(snap)})`,
        });
      }
    }
  }

  async function attachTarget(target) {
    const client = new CdpPageClient(target.webSocketDebuggerUrl, {
      onBindingCalled: (payload, c) => void handleAction(payload, c),
      onClose: () => attached.delete(target.id),
    });
    await client.connect();
    attached.set(target.id, client);
    await injectOverlay(client);
  }

  async function pollOnce() {
    if (stopped || !enabled) return;
    const portInfo = readDevToolsPort(portFile);
    const candidatePorts = portInfo.ok ? [portInfo.port] : [9222];

    let foundTargets = null;
    let foundPort = 0;
    let connectErr = '';
    for (const p of candidatePorts) {
      try {
        const res = await fetch(`http://127.0.0.1:${p}/json/list`, {
          signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const targets = await res.json();
        foundTargets = Array.isArray(targets) ? targets : [];
        foundPort = p;
        break;
      } catch (err) {
        connectErr = err?.message || '无法连接到本地调试端口';
      }
    }

    if (!foundTargets) {
      state = portInfo.ok ? 'unreachable' : 'inactive';
      activePort = 0;
      lastError = portInfo.ok ? connectErr : '';
      return;
    }

    activePort = foundPort;
    try {
      const hubTargets = foundTargets.filter(isAntigravityHubTarget);

      for (const target of hubTargets) {
        if (!attached.has(target.id)) {
          await attachTarget(target).catch(() => {});
        } else {
          // Self-heal if user manually reloaded the page (Cmd+R)
          const existing = attached.get(target.id);
          const check = await existing
            .send('Runtime.evaluate', {
              expression: `Boolean(globalThis.__agyForkExplorerOverlay && globalThis.__agyForkExplorerOverlay.ownerId === ${ownerId})`,
              returnByValue: true,
            })
            .catch(() => null);
          if (check && check.result?.value === false) {
            await injectOverlay(existing).catch(() => {});
          }
        }
      }

      if (attached.size > 0) {
        if (state !== 'connected') {
          console.log(`[agy-fork-explorer] CDP connected on 127.0.0.1:${foundPort} (${attached.size} window)`);
        }
        state = 'connected';
        lastError = '';
        if (typeof getTelemetrySnapshot === 'function') {
          const snap = await getTelemetrySnapshot();
          if (snap) {
            for (const c of attached.values()) {
              void c
                .send('Runtime.evaluate', {
                  expression: `globalThis.__agyForkExplorerOverlay?.updateTelemetry(${JSON.stringify(snap)})`,
                })
                .catch(() => {});
            }
          }
        }
      } else {
        state = 'inactive';
      }
    } catch (err) {
      state = 'unreachable';
      lastError = err?.message || '无法连接到本地调试端口';
    }
  }

  function start() {
    stopped = false;
    void pollOnce();
    timer = setInterval(() => void pollOnce(), pollMs);
    timer.unref?.();
  }

  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const client of attached.values()) {
      await client
        .send('Runtime.evaluate', { expression: 'globalThis.__agyForkExplorerOverlay?.dispose?.()' })
        .catch(() => {});
      client.close();
    }
    attached.clear();
    state = 'idle';
  }

  async function setEnabled(next) {
    enabled = Boolean(next);
    if (!enabled) {
      for (const client of attached.values()) {
        await client
          .send('Runtime.evaluate', { expression: 'globalThis.__agyForkExplorerOverlay?.dispose?.()' })
          .catch(() => {});
        client.close();
      }
      attached.clear();
      state = 'inactive';
    } else {
      await pollOnce();
    }
  }

  function evaluateAll(expression) {
    for (const client of attached.values()) {
      void client.send('Runtime.evaluate', { expression }).catch(() => {});
    }
  }

  function broadcastRelayBanner(job) {
    if (!job || attached.size === 0) return;
    evaluateAll(`globalThis.__agyForkExplorerOverlay?.showRelayBanner?.(${JSON.stringify(job)})`);
  }

  function broadcastHideRelayBanner() {
    if (attached.size === 0) return;
    evaluateAll('globalThis.__agyForkExplorerOverlay?.hideRelayBanner?.()');
  }

  function broadcastRelayComplete(res = {}) {
    if (attached.size === 0) return;
    evaluateAll('globalThis.__agyForkExplorerOverlay?.hideRelayBanner?.()');
    if (res?.ok && res?.launched && res?.newConversationId) {
      const msg = `✨ 自动接力已切入低水位分支「${res.branchLabel || 'relay'}」(~${res.promptEstTokens || 0} tok)，正在继续任务…`;
      evaluateAll(`globalThis.__agyForkExplorerOverlay?.notify?.(${JSON.stringify(msg)}, false)`);
      evaluateAll(
        `globalThis.__agyForkExplorerOverlay?.navigateConversation?.(${JSON.stringify(res.newConversationId)}, ${JSON.stringify(res.projectId || '')})`,
      );
    } else if (res && !res.ok) {
      evaluateAll(`globalThis.__agyForkExplorerOverlay?.notify?.(${JSON.stringify(res.error || '自动接力失败')}, true)`);
    }
  }

  function status() {
    return {
      enabled,
      state,
      port: activePort,
      attachedPages: attached.size,
      lastError,
      launchHint:
        process.platform === 'win32'
          ? 'powershell -ExecutionPolicy Bypass -File scripts/launch-with-cdp.ps1'
          : 'sh ~/.gemini/config/plugins/agy-fork-explorer/scripts/launch-with-cdp.sh',
    };
  }

  return {
    start,
    stop,
    pollOnce,
    setEnabled,
    status,
    broadcastRelayBanner,
    broadcastHideRelayBanner,
    broadcastRelayComplete,
  };
}
