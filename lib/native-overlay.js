/**
 * Isolated Native UI Enhancement Overlay for Antigravity Desktop (agy-powertools style).
 * Attached optionally via local CDP when user launches Antigravity with --remote-debugging-port.
 *
 * Mounts cleanly into native Antigravity surfaces WITHOUT hijacking obfuscated webpack globals:
 *  1. Left-sidebar conversation `⋮` dropdown menu: injects pixel-matched "分支会话 (Fork)" & "在访达/资源管理器中打开"
 *  2. Native top titlebar toolbar (next to Overview / Aux Pane toggle): injects compact Context + Fork + Finder controls
 *     (falls back gracefully to a minimal corner capsule only if no titlebar anchor exists)
 *  3. Native chat file pills & `file://` links: right-click context menu & Cmd/Ctrl+Click fast reveal
 *  4. Assistant message action bar: subtle inline `🌿 Fork` button
 */
export function buildNativeOverlaySource({
  version = '1.1.0',
  ownerId = Date.now(),
  apps = [],
  platform = process.platform,
} = {}) {
  const configJson = JSON.stringify({ version, ownerId, apps, platform });

  return `(() => {
  const CFG = ${configJson};
  const prev = globalThis.__agyForkExplorerOverlay;
  if (prev && prev.ownerId > CFG.ownerId) return 'superseded';
  try { prev?.dispose?.(); } catch {}

  const HOST_ID = 'agy-fork-explorer-shadow-host';
  const STYLE_ID = 'agy-fork-explorer-native-style';
  const FILE_SELECTOR = '.inline-pill[data-uri], [data-uri^="file:"], [data-uri^="FILE:"], a[href^="file:"], a[href^="FILE:"], [data-file-path]';
  const CONV_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/;
  const isMac = CFG.platform === 'darwin';
  const isWin = CFG.platform === 'win32';
  const revealFileLabel = isMac ? '在访达 (Finder) 中显示' : isWin ? '在资源管理器中显示' : '在文件管理器中显示';
  const openExplorerLabel = isMac ? '在访达中打开' : isWin ? '在资源管理器中打开' : '在文件管理器中打开';

  // Crisp 16x16 stroke SVGs matching Antigravity's native sidebar menu icons
  const ICON_FORK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.86"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M6 8.5v7"/><path d="M18 8.5c0 4.2-4 5.2-12 5.2"/></svg>';
  const ICON_FOLDER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.86"><path d="M3 7a2 2 0 0 1 2-2h4.6l2 2.4H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';

  let disposed = false;
  let host = null;
  let shadow = null;
  let menuEl = null;
  let forkModalEl = null;
  let fallbackCapsuleEl = null;
  let relayBannerEl = null;
  let toastEl = null;
  let toastTimer = 0;
  let relayTimer = 0;
  let activeRelayJob = null;
  let lastClickedConvId = '';
  let lastClickedAt = 0;
  let modalConvId = '';
  let modalTurns = [];
  let modalTitle = '';
  let modalMode = 'exact';
  let modalSelectedTurn = 0;
  let forkInFlight = false;

  let telemetry = {
    conversationId: '',
    workspaceRoot: '',
    percent: 0,
    usedTokens: 0,
    limitTokens: 256000,
    level: 'healthy',
    turnCount: 0,
    branchCount: 1,
    artifactCount: 0,
    turns: [],
  };

  function getActiveConversationIdFromUrl() {
    const m = location.pathname.match(/\\/c\\/([a-zA-Z0-9_-]{6,128})/);
    return m ? m[1] : telemetry.conversationId || '';
  }

  function extractConvIdFromElement(startEl) {
    let cur = startEl;
    for (let depth = 0; cur && depth < 12; depth += 1) {
      // Direct href on anchor
      const href = cur.getAttribute?.('href') || '';
      const hm = href.match(/\\/c\\/([a-zA-Z0-9_-]{6,128})/);
      if (hm) return hm[1];

      // Explicit data attributes
      for (const attr of ['data-conversation-id', 'data-cascade-id', 'data-session-id', 'data-id']) {
        const val = cur.getAttribute?.(attr);
        if (val && CONV_ID_RE.test(val)) return val;
      }

      // Row container wrapping both the link and the [⋮] button
      if (cur.querySelector) {
        const link = cur.querySelector('a[href*="/c/"]');
        if (link) {
          const allLinks = cur.querySelectorAll('a[href*="/c/"]');
          if (allLinks.length === 1) {
            const lm = (link.getAttribute('href') || '').match(/\\/c\\/([a-zA-Z0-9_-]{6,128})/);
            if (lm) return lm[1];
          }
        }
      }
      cur = cur.parentElement;
    }
    return '';
  }

  function resolveMenuConversationId() {
    if (lastClickedConvId && Date.now() - lastClickedAt < 8000) {
      return lastClickedConvId;
    }
    return getActiveConversationIdFromUrl();
  }

  function isDarkTheme() {
    const root = document.documentElement;
    if (root.classList.contains('dark')) return true;
    const attr = (root.getAttribute('data-theme') || root.getAttribute('data-newux-theme') || '').toLowerCase();
    if (/dark|onyx|warm/.test(attr)) return true;
    if (/light/.test(attr)) return false;
    const bg = getComputedStyle(document.body || root).backgroundColor || '';
    const m = bg.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/i);
    if (!m) return true;
    return (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000 < 128;
  }

  function decodeFileUri(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (!/^file:/i.test(s)) return s.replace(/#L\\d+(?:-L?\\d+)?$/i, '');
    try {
      const u = new URL(s);
      u.hash = '';
      u.search = '';
      let p = decodeURIComponent(u.pathname || '');
      if (u.host && u.host !== 'localhost') p = '//' + u.host + p;
      else if (/^\\/[a-zA-Z]:\\//.test(p)) p = p.slice(1);
      if (isWin && /^[a-zA-Z]:\\//.test(p)) p = p.replace(/\\//g, '\\\\');
      return p;
    } catch {
      return s.replace(/^file:\\/\\//i, '').split(/[?#]/)[0];
    }
  }

  function extractTargetUri(el) {
    if (!el) return '';
    return el.getAttribute('data-uri') || el.getAttribute('href') || el.getAttribute('data-file-path') || '';
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function insertIntoComposer(text) {
    const composer =
      document.querySelector('[contenteditable="true"][role="textbox"]') ||
      document.querySelector('textarea[placeholder]') ||
      document.querySelector('[contenteditable="true"]');
    if (!composer) return false;
    composer.focus();
    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      const start = composer.selectionStart ?? composer.value.length;
      composer.value = composer.value.slice(0, start) + text + composer.value.slice(composer.selectionEnd ?? start);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    try {
      document.execCommand('insertText', false, text);
      return true;
    } catch {
      return false;
    }
  }

  function sendToHost(payload) {
    try {
      if (typeof globalThis.__agyForkExplorerAction === 'function') {
        globalThis.__agyForkExplorerAction(JSON.stringify(payload));
        return true;
      }
    } catch {}
    return false;
  }

  function dismissNativeMenus() {
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    } catch {}
  }

  function ensureNativeStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = \`
      [data-agy-fe-menu-item="1"] {
        display: flex; align-items: center; gap: 10px; width: 100%;
        padding: 6px 10px; border-radius: 6px; border: none; background: transparent;
        color: inherit; font: inherit; font-size: 13px; line-height: 1.4;
        cursor: pointer; text-align: left; user-select: none; outline: none;
        transition: background-color 80ms ease;
      }
      [data-agy-fe-menu-item="1"]:hover, [data-agy-fe-menu-item="1"]:focus-visible {
        background: var(--accent, rgba(127, 127, 127, 0.16));
      }
      [data-agy-fe-titlebar="1"] {
        display: inline-flex; align-items: center; gap: 4px; margin-right: 4px;
        -webkit-app-region: no-drag;
      }
      [data-agy-fe-tbtn="1"] {
        display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 7px;
        border-radius: 7px; border: 1px solid transparent; background: transparent;
        color: var(--muted-foreground, inherit); font-size: 11.5px; line-height: 1;
        cursor: pointer; transition: background-color 100ms ease, color 100ms ease, border-color 100ms ease;
        white-space: nowrap;
      }
      [data-agy-fe-tbtn="1"]:hover {
        background: var(--accent, rgba(127, 127, 127, 0.16));
        color: var(--foreground, inherit);
      }
      [data-agy-fe-tbtn="1"][data-warn="warn"] {
        color: #f59e0b; border-color: rgba(245, 158, 11, 0.35);
      }
      [data-agy-fe-tbtn="1"][data-warn="crit"] {
        color: #f87171; border-color: rgba(248, 113, 113, 0.45); background: rgba(248, 113, 113, 0.12); font-weight: 600;
      }
    \`;
    (document.head || document.documentElement).appendChild(st);
  }

  function showToast(msg, isError = false) {
    if (disposed || !msg) return;
    ensureHost();
    toastEl.dataset.theme = isDarkTheme() ? 'dark' : 'light';
    toastEl.dataset.error = isError ? 'true' : 'false';
    toastEl.textContent = String(msg);
    toastEl.dataset.visible = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.dataset.visible = 'false';
    }, 2600);
  }

  function ensureHost() {
    if (host && document.body?.contains(host)) return;
    document.getElementById(HOST_ID)?.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = \`
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif; }
        .fe-menu, .fe-modal, .fe-capsule {
          pointer-events: auto;
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
        }
        .fe-menu {
          position: fixed; min-width: 215px; max-width: 310px; padding: 5px; border-radius: 11px;
          display: none; flex-direction: column; gap: 2px; font-size: 12.5px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.34), 0 2px 8px rgba(0,0,0,0.16);
        }
        .fe-menu[data-open="true"] { display: flex; }
        .fe-menu[data-theme="dark"], .fe-modal[data-theme="dark"], .fe-capsule[data-theme="dark"] {
          background: rgba(24, 26, 32, 0.96); color: #eef2fa; border: 1px solid rgba(255,255,255,0.13);
        }
        .fe-menu[data-theme="light"], .fe-modal[data-theme="light"], .fe-capsule[data-theme="light"] {
          background: rgba(255, 255, 255, 0.97); color: #161c2c; border: 1px solid rgba(15,23,42,0.13);
        }
        .fe-item {
          display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; border: none;
          border-radius: 7px; background: transparent; color: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
        }
        .fe-menu[data-theme="dark"] .fe-item:hover { background: rgba(255,255,255,0.10); }
        .fe-menu[data-theme="light"] .fe-item:hover { background: rgba(15,23,42,0.06); }
        .fe-sep { height: 1px; margin: 3px 6px; background: rgba(127,127,127,0.22); }
        .fe-hint { padding: 3px 10px 4px; font-size: 10.5px; opacity: 0.62; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }

        .fe-capsule {
          position: fixed; right: 16px; bottom: 14px; border-radius: 999px; padding: 4px 7px;
          display: none; align-items: center; gap: 5px; font-size: 11px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.26);
        }
        .fe-capsule[data-visible="true"] { display: flex; }
        .fe-cbtn {
          border: 1px solid rgba(127,127,127,0.26); background: transparent; color: inherit;
          border-radius: 999px; padding: 3px 8px; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
        }
        .fe-cbtn:hover { background: rgba(79,140,255,0.16); border-color: #4f8cff; }

        .fe-modal {
          position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 360px; max-width: calc(100vw - 24px);
          border-radius: 14px; padding: 14px; display: none; flex-direction: column; gap: 10px; font-size: 12px;
          box-shadow: 0 20px 54px rgba(0,0,0,0.48);
        }
        .fe-modal[data-open="true"] { display: flex; }
        .fe-mhead { display: flex; justify-content: space-between; align-items: center; font-weight: 700; font-size: 13.5px; }
        .fe-msub { font-size: 11px; opacity: 0.68; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .fe-x { border: none; background: transparent; color: inherit; opacity: 0.7; cursor: pointer; font-size: 16px; padding: 0 4px; }
        .fe-field { display: flex; flex-direction: column; gap: 4px; }
        .fe-field label { font-size: 11px; opacity: 0.76; }
        .fe-select, .fe-input {
          width: 100%; border-radius: 8px; padding: 6px 9px; font-size: 12px;
          border: 1px solid rgba(127,127,127,0.32); background: rgba(127,127,127,0.10); color: inherit;
        }
        .fe-pills { display: flex; gap: 5px; }
        .fe-pill {
          flex: 1; text-align: center; padding: 5px 6px; border-radius: 7px; font-size: 11.5px; cursor: pointer;
          border: 1px solid rgba(127,127,127,0.3); background: transparent; color: inherit;
        }
        .fe-pill.on { background: rgba(79,140,255,0.22); border-color: #4f8cff; font-weight: 600; }
        .fe-checks { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; }
        .fe-checks label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
        .fe-submit {
          border: none; border-radius: 8px; padding: 8px 10px; font-size: 12.5px; font-weight: 700;
          background: linear-gradient(135deg, #3b82f6, #14b8a6); color: #fff; cursor: pointer;
        }
        .fe-submit:hover { filter: brightness(1.08); }

        .fe-toast {
          position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%) translateY(8px);
          padding: 7px 14px; border-radius: 999px; font-size: 12px; opacity: 0; pointer-events: none;
          transition: opacity 140ms ease, transform 140ms ease; box-shadow: 0 8px 24px rgba(0,0,0,0.32);
        }
        .fe-toast[data-visible="true"] { opacity: 1; transform: translateX(-50%) translateY(0); }
        .fe-toast[data-theme="dark"] { background: #1e2433; color: #f8fafc; border: 1px solid rgba(255,255,255,0.15); }
        .fe-toast[data-theme="light"] { background: #161c2c; color: #ffffff; }
        .fe-toast[data-error="true"] { background: #991b1b; color: #fef2f2; }

        .fe-relay {
          position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%) translateY(10px);
          pointer-events: auto; display: none; flex-direction: column; gap: 6px;
          width: max-content; min-width: 340px; max-width: calc(100vw - 24px);
          padding: 10px 13px 8px; border-radius: 13px; font-size: 12px;
          backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
          box-shadow: 0 14px 36px rgba(0,0,0,0.42), 0 0 0 1px rgba(139, 92, 246, 0.35);
          transition: opacity 150ms ease, transform 150ms ease;
        }
        .fe-relay[data-visible="true"] { display: flex; transform: translateX(-50%) translateY(0); }
        .fe-relay[data-theme="dark"] { background: rgba(20, 24, 34, 0.96); color: #eef2fa; border: 1px solid rgba(167, 139, 250, 0.45); }
        .fe-relay[data-theme="light"] { background: rgba(255, 255, 255, 0.98); color: #161c2c; border: 1px solid rgba(124, 58, 237, 0.35); }
        .fe-relay-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .fe-relay-meta { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1; }
        .fe-relay-tag {
          font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 999px; white-space: nowrap;
          background: rgba(139, 92, 246, 0.22); color: #c4b5fd; border: 1px solid rgba(167, 139, 250, 0.45);
        }
        .fe-relay[data-theme="light"] .fe-relay-tag { color: #6d28d9; background: rgba(124, 58, 237, 0.12); }
        .fe-relay-tag[data-hard="true"] { background: rgba(248, 113, 113, 0.2); color: #fca5a5; border-color: rgba(248, 113, 113, 0.45); }
        .fe-relay-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
        .fe-relay-ops { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
        .fe-rbtn {
          border: 1px solid rgba(127,127,127,0.34); background: transparent; color: inherit;
          border-radius: 7px; padding: 4px 9px; font-size: 11.5px; font-weight: 600; cursor: pointer;
        }
        .fe-rbtn:hover { background: rgba(127,127,127,0.16); }
        .fe-rbtn.primary { background: linear-gradient(135deg, #3b82f6, #8b5cf6); border-color: transparent; color: #fff; }
        .fe-rbtn.primary:hover { filter: brightness(1.08); }
        .fe-relay-bar { height: 3px; border-radius: 999px; background: rgba(127,127,127,0.22); overflow: hidden; }
        .fe-relay-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #38bdf8, #a78bfa); transition: width 150ms linear; }
      </style>
      <div class="fe-menu" role="menu" data-open="false"></div>
      <div class="fe-modal" data-open="false"></div>
      <div class="fe-capsule" data-visible="false"></div>
      <div class="fe-relay" data-visible="false"></div>
      <div class="fe-toast" data-visible="false"></div>
    \`;
    menuEl = shadow.querySelector('.fe-menu');
    forkModalEl = shadow.querySelector('.fe-modal');
    fallbackCapsuleEl = shadow.querySelector('.fe-capsule');
    relayBannerEl = shadow.querySelector('.fe-relay');
    toastEl = shadow.querySelector('.fe-toast');
    (document.body || document.documentElement).appendChild(host);
  }

  function hideRelayBanner() {
    clearInterval(relayTimer);
    relayTimer = 0;
    activeRelayJob = null;
    if (relayBannerEl) {
      relayBannerEl.dataset.visible = 'false';
      relayBannerEl.innerHTML = '';
    }
  }

  function showRelayBanner(job) {
    if (disposed || !job || !job.id) {
      hideRelayBanner();
      return;
    }
    if (job.status !== 'awaiting_confirm') {
      hideRelayBanner();
      return;
    }
    ensureHost();
    const sameJob = activeRelayJob && activeRelayJob.id === job.id;
    activeRelayJob = job;
    relayBannerEl.dataset.theme = isDarkTheme() ? 'dark' : 'light';
    relayBannerEl.dataset.visible = 'true';

    const totalMs = Math.max(1000, (Number(job.countdownSec) || 5) * 1000);
    const isHard = job.triggerMode === 'hard_failsafe';
    const tagText = isHard ? '🛡️ 兜底接力' : '✨ 亲笔交接单';

    if (!sameJob) {
      relayBannerEl.innerHTML = '';
      const row = document.createElement('div');
      row.className = 'fe-relay-row';
      const meta = document.createElement('div');
      meta.className = 'fe-relay-meta';
      const tag = document.createElement('span');
      tag.className = 'fe-relay-tag';
      tag.dataset.hard = isHard ? 'true' : 'false';
      tag.textContent = tagText;
      const txt = document.createElement('span');
      txt.className = 'fe-relay-text';
      meta.appendChild(tag);
      meta.appendChild(txt);

      const ops = document.createElement('div');
      ops.className = 'fe-relay-ops';
      const btnNow = document.createElement('button');
      btnNow.className = 'fe-rbtn primary';
      btnNow.textContent = '立即接力';
      btnNow.onclick = (e) => {
        e.stopPropagation();
        const jid = activeRelayJob?.id;
        hideRelayBanner();
        if (jid) sendToHost({ action: 'relayConfirm', jobId: jid });
      };
      const btnSkip = document.createElement('button');
      btnSkip.className = 'fe-rbtn';
      btnSkip.textContent = '暂不';
      btnSkip.onclick = (e) => {
        e.stopPropagation();
        const jid = activeRelayJob?.id;
        hideRelayBanner();
        if (jid) sendToHost({ action: 'relayDismiss', jobId: jid });
      };
      ops.appendChild(btnNow);
      ops.appendChild(btnSkip);
      row.appendChild(meta);
      row.appendChild(ops);

      const bar = document.createElement('div');
      bar.className = 'fe-relay-bar';
      const fill = document.createElement('div');
      fill.className = 'fe-relay-fill';
      bar.appendChild(fill);

      relayBannerEl.appendChild(row);
      relayBannerEl.appendChild(bar);
    }

    const updateTick = () => {
      if (!activeRelayJob || !relayBannerEl || relayBannerEl.dataset.visible !== 'true') {
        clearInterval(relayTimer);
        relayTimer = 0;
        return;
      }
      const remMs = Math.max(0, (Number(activeRelayJob.executeAfter) || Date.now()) - Date.now());
      const remSec = Math.ceil(remMs / 1000);
      const pct = activeRelayJob.percent || 0;
      const txtEl = relayBannerEl.querySelector('.fe-relay-text');
      const fillEl = relayBannerEl.querySelector('.fe-relay-fill');
      if (txtEl) {
        const activeUrlConv = getActiveConversationIdFromUrl();
        const bgPrefix =
          activeRelayJob.conversationId && activeUrlConv && activeRelayJob.conversationId !== activeUrlConv && activeRelayJob.title
            ? '「' + String(activeRelayJob.title).slice(0, 12) + '」'
            : '';
        txtEl.textContent =
          remSec > 0
            ? bgPrefix + pct + '% · ' + remSec + 's 后自动 Fork 续跑'
            : bgPrefix + '正在启动低水位新分支续跑…';
      }
      if (fillEl) {
        const ratio = Math.max(0, Math.min(100, (remMs / totalMs) * 100));
        fillEl.style.width = ratio + '%';
      }
      if (remMs <= 0) {
        clearInterval(relayTimer);
        relayTimer = 0;
      }
    };

    updateTick();
    if (!relayTimer) {
      relayTimer = setInterval(updateTick, 150);
    }
  }

  function closeMenu() { if (menuEl) menuEl.dataset.open = 'false'; }
  function closeForkModal() { if (forkModalEl) forkModalEl.dataset.open = 'false'; }

  function renderForkModalBody() {
    if (!forkModalEl || forkModalEl.dataset.open !== 'true') return;
    forkModalEl.dataset.theme = isDarkTheme() ? 'dark' : 'light';
    forkModalEl.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'fe-mhead';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = '🌿 分支会话 (Fork)';
    const xBtn = document.createElement('button');
    xBtn.className = 'fe-x';
    xBtn.textContent = '×';
    xBtn.onclick = closeForkModal;
    head.append(titleSpan, xBtn);
    forkModalEl.appendChild(head);

    if (modalTitle) {
      const sub = document.createElement('div');
      sub.className = 'fe-msub';
      sub.textContent = '源会话：' + modalTitle;
      forkModalEl.appendChild(sub);
    }

    const turnField = document.createElement('div');
    turnField.className = 'fe-field';
    const turnLbl = document.createElement('label');
    turnLbl.textContent = '选择分叉起点轮次（保留 1..N 轮，截断后续走偏内容）';
    const turnSel = document.createElement('select');
    turnSel.className = 'fe-select';
    if (modalTurns.length) {
      const targetTurn = modalSelectedTurn > 0 && modalSelectedTurn <= modalTurns.length
        ? modalSelectedTurn
        : modalTurns.length;
      modalSelectedTurn = targetTurn;
      for (let i = modalTurns.length - 1; i >= 0; i -= 1) {
        const t = modalTurns[i];
        const opt = document.createElement('option');
        opt.value = String(t.turnIndex);
        opt.textContent = \`Turn #\${t.turnIndex} · \${t.userTitle || ''}\`;
        if (t.turnIndex === targetTurn) opt.selected = true;
        turnSel.appendChild(opt);
      }
    } else {
      const opt = document.createElement('option');
      opt.value = '0';
      opt.textContent = '当前最新轮次 (HEAD)';
      turnSel.appendChild(opt);
    }
    turnSel.onchange = () => { modalSelectedTurn = Number(turnSel.value) || 0; };
    turnField.append(turnLbl, turnSel);
    forkModalEl.appendChild(turnField);

    const modeField = document.createElement('div');
    modeField.className = 'fe-field';
    const modeLbl = document.createElement('label');
    modeLbl.textContent = '上下文继承模式';
    const pills = document.createElement('div');
    pills.className = 'fe-pills';
    const modes = [
      ['exact', '完整复刻'],
      ['handoff', 'Amp 轻装交接'],
      ['files_only', '仅携文件'],
    ];
    const pillEls = modes.map(([id, label]) => {
      const p = document.createElement('button');
      p.type = 'button';
      p.className = 'fe-pill' + (id === modalMode ? ' on' : '');
      p.textContent = label;
      p.onclick = () => {
        modalMode = id;
        pillEls.forEach((el, idx) => el.classList.toggle('on', modes[idx][0] === modalMode));
      };
      pills.appendChild(p);
      return p;
    });
    modeField.append(modeLbl, pills);
    forkModalEl.appendChild(modeField);

    const nameField = document.createElement('div');
    nameField.className = 'fe-field';
    const nameLbl = document.createElement('label');
    nameLbl.textContent = '分支名称（可选）';
    const nameInput = document.createElement('input');
    nameInput.className = 'fe-input';
    nameInput.placeholder = modalMode === 'handoff' ? '例如：clean-handoff' : '例如：exp-refactor';
    nameField.append(nameLbl, nameInput);
    forkModalEl.appendChild(nameField);

    const checks = document.createElement('div');
    checks.className = 'fe-checks';
    const wtCb = document.createElement('input');
    wtCb.type = 'checkbox';
    const wtLbl = document.createElement('label');
    wtLbl.append(wtCb, document.createTextNode('同时创建独立 Git Worktree 目录（防文件冲突）'));
    const snapCb = document.createElement('input');
    snapCb.type = 'checkbox';
    snapCb.checked = true;
    const snapLbl = document.createElement('label');
    snapLbl.append(snapCb, document.createTextNode('分叉前自动保存 Git 安全快照'));
    checks.append(wtLbl, snapLbl);
    forkModalEl.appendChild(checks);

    const submit = document.createElement('button');
    submit.className = 'fe-submit';
    submit.textContent = '🌿 创建新分支会话';
    submit.onclick = () => {
      if (!modalConvId) {
        showToast('未识别目标会话 ID，请先进入一个对话', true);
        return;
      }
      submit.disabled = true;
      submit.textContent = '正在创建分支...';
      sendToHost({
        action: 'forkTurn',
        conversationId: modalConvId,
        upToTurn: modalSelectedTurn,
        mode: modalMode,
        branchLabel: nameInput.value.trim(),
        createWorktree: wtCb.checked,
        createSnapshot: snapCb.checked,
      });
      closeForkModal();
    };
    forkModalEl.appendChild(submit);
  }

  function triggerSilentFork({ conversationId = '', upToTurn = 0, mode = '', autoSmartHandoff = true } = {}) {
    const convId = conversationId || getActiveConversationIdFromUrl();
    if (!convId) {
      showToast('未识别目标会话 ID，请先进入一个对话', true);
      return;
    }
    if (forkInFlight) {
      showToast('🌿 分支正在创建中，请稍候…');
      return;
    }
    forkInFlight = true;
    closeMenu();
    closeForkModal();
    const hint =
      mode === 'handoff'
        ? '⚡ 正在静默轻装 Fork（防失忆）…'
        : upToTurn > 0
          ? \`🌿 正在从第 \${upToTurn} 轮静默分支…\`
          : '🌿 正在静默创建分支会话…';
    showToast(hint);
    sendToHost({
      action: 'forkTurn',
      silent: true,
      conversationId: convId,
      upToTurn,
      ...(mode ? { mode } : {}),
      autoSmartHandoff,
    });
    setTimeout(() => { forkInFlight = false; }, 12000);
  }

  function openForkModal(defaultMode = 'exact', preselectedTurn = 0, explicitConvId = '') {
    ensureHost();
    closeMenu();
    modalConvId = explicitConvId || getActiveConversationIdFromUrl();
    modalMode = defaultMode;
    modalSelectedTurn = preselectedTurn;
    if (modalConvId && modalConvId === telemetry.conversationId) {
      modalTurns = Array.isArray(telemetry.turns) ? telemetry.turns : [];
      modalTitle = modalTurns[0]?.userTitle || '';
    } else {
      modalTurns = [];
      modalTitle = '正在读取会话轮次…';
      if (modalConvId) {
        sendToHost({ action: 'fetchTurns', conversationId: modalConvId });
      }
    }
    forkModalEl.dataset.open = 'true';
    renderForkModalBody();
  }

  function openFileContextMenu(x, y, rawUri) {
    ensureHost();
    closeForkModal();
    const displayPath = decodeFileUri(rawUri);
    menuEl.dataset.theme = isDarkTheme() ? 'dark' : 'light';
    menuEl.innerHTML = '';

    const addItem = (icon, label, onClick) => {
      const btn = document.createElement('button');
      btn.className = 'fe-item';
      btn.textContent = icon + '  ' + label;
      btn.onclick = (e) => {
        e.stopPropagation();
        closeMenu();
        onClick();
      };
      menuEl.appendChild(btn);
    };

    addItem('📂', revealFileLabel, () => sendToHost({ action: 'reveal', uri: rawUri }));
    addItem('🚀', '用默认应用打开', () => sendToHost({ action: 'openDefault', uri: rawUri }));

    for (const app of (CFG.apps || []).slice(0, 3)) {
      addItem(app.kind === 'terminal' ? '⌨️' : '💻', '在 ' + app.label + ' 中打开', () => {
        sendToHost({ action: 'openApp', appId: app.id, uri: rawUri });
      });
    }

    const sep = document.createElement('div');
    sep.className = 'fe-sep';
    menuEl.appendChild(sep);

    addItem('📎', '引用到输入框 (@)', () => {
      const inserted = insertIntoComposer('@' + displayPath + ' ');
      if (inserted) showToast('已引用到输入框');
      else copyText(displayPath).then(() => showToast('已复制路径（可粘贴至输入框）'));
    });
    addItem('📋', '复制完整路径', () => {
      copyText(displayPath).then(() => showToast('已复制路径：' + displayPath));
    });

    const hint = document.createElement('div');
    hint.className = 'fe-hint';
    hint.textContent = displayPath;
    menuEl.appendChild(hint);

    menuEl.dataset.open = 'true';
    const rect = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 10)) + 'px';
    menuEl.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 10)) + 'px';
  }

  // ---------------------------------------------------------------------------
  // 1. Mount natively into Antigravity's left-sidebar conversation [⋮] menu!
  //    Matches both Radix [role="menu"] and Floating-UI/custom popovers containing
  //    Rename/重命名, Pin/置顶, Split/分屏, Archive/归档, Delete/删除
  // ---------------------------------------------------------------------------
  const CONV_MENU_ANCHOR_RE = /^(重命名|Rename|置顶|取消置顶|Pin|Unpin|标记为未读|标记为已读|Mark as unread|Mark as read|复制|Copy|分屏|Split|归档|Archive|删除|Delete)(\s|$)/i;
  const SPLIT_OR_ARCHIVE_RE = /^(分屏|Split|归档|Archive)(\s|$)/i;

  function buildNativeMenuItem(refItem, iconSvg, label, onClick) {
    const tag = refItem && refItem.tagName === 'BUTTON' ? 'button' : 'div';
    const item = document.createElement(tag);
    if (tag === 'button') item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '-1');
    item.setAttribute('data-agy-fe-menu-item', '1');
    if (refItem && refItem.className) {
      item.className = refItem.className;
    }
    item.innerHTML = iconSvg + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label + '</span>';
    item.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismissNativeMenus();
      onClick(e);
    });
    return item;
  }

  function enhanceNativeConversationMenus() {
    if (disposed) return;
    ensureNativeStyle();
    const candidates = new Set(
      document.querySelectorAll(
        '[role="menu"], [data-radix-menu-content], [data-slot="dropdown-menu-content"], [data-radix-popper-content-wrapper] > div, [data-floating-ui-portal] div',
      ),
    );
    for (const menu of candidates) {
      if (!menu || menu.querySelector('[data-agy-fe-menu-item="1"]')) continue;
      // Avoid matching huge ancestor containers
      if (menu.children.length > 24) continue;
      const items = Array.from(menu.querySelectorAll('[role="menuitem"], button')).filter(
        (el) => el.closest('[role="menu"], [data-radix-menu-content], [data-slot="dropdown-menu-content"]') === menu || el.parentElement === menu || el.parentElement?.parentElement === menu,
      );
      if (items.length < 3 || items.length > 18) continue;

      let matchCount = 0;
      let hasDeleteOrArchive = false;
      let insertBeforeEl = null;
      let refItem = null;
      for (const it of items) {
        const txt = (it.textContent || '').replace(/[›>]/g, '').trim();
        if (CONV_MENU_ANCHOR_RE.test(txt)) {
          matchCount += 1;
          if (!refItem) refItem = it;
          if (/^(归档|Archive|删除|Delete)(\s|$)/i.test(txt)) hasDeleteOrArchive = true;
        }
        if (!insertBeforeEl && SPLIT_OR_ARCHIVE_RE.test(txt)) {
          insertBeforeEl = it;
          refItem = it;
        }
      }
      if (matchCount < 3 || !hasDeleteOrArchive) continue;

      const convId = resolveMenuConversationId();
      const targetParent = insertBeforeEl?.parentElement || refItem?.parentElement || menu;
      const anchor = insertBeforeEl && insertBeforeEl.parentElement === targetParent ? insertBeforeEl : null;

      const forkItem = buildNativeMenuItem(refItem, ICON_FORK, '分支会话 (Fork)', (e) => {
        // Silent 1-click fork like Cursor / Claude Code / Codex / agy-powertools;
        // hold Alt/Shift while clicking only if you want custom turn/worktree options.
        if (e?.altKey || e?.shiftKey) {
          openForkModal('exact', 0, convId);
        } else {
          triggerSilentFork({ conversationId: convId, upToTurn: 0, autoSmartHandoff: true });
        }
      });
      const explorerItem = buildNativeMenuItem(refItem, ICON_FOLDER, openExplorerLabel, () => {
        sendToHost({ action: 'openWorkspaceFinder', conversationId: convId });
      });

      if (anchor) {
        targetParent.insertBefore(forkItem, anchor);
        targetParent.insertBefore(explorerItem, anchor);
      } else {
        targetParent.appendChild(forkItem);
        targetParent.appendChild(explorerItem);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Mount compact controls natively into Antigravity's top titlebar toolbar
  //    (gracefully falls back to minimal corner capsule only if anchor absent)
  // ---------------------------------------------------------------------------
  function mountNativeTitlebarTools() {
    if (disposed) return;
    ensureNativeStyle();
    const anchor =
      document.querySelector('[data-testid="toggle-overview-panel"]') ||
      document.querySelector('[data-testid="toggle-aux-sidebar"]') ||
      document.querySelector('[data-testid="titlebar-more-actions"]');

    const pct = telemetry.percent || 0;
    const kUsed = Math.round((telemetry.usedTokens || 0) / 1000);
    const kLim = Math.round((telemetry.limitTokens || 256000) / 1000);
    const warnLevel = pct >= 82 ? 'crit' : pct >= 65 ? 'warn' : '';

    if (anchor && anchor.parentElement) {
      if (fallbackCapsuleEl) fallbackCapsuleEl.dataset.visible = 'false';
      let bar = anchor.parentElement.querySelector('[data-agy-fe-titlebar="1"]');
      if (!bar) {
        bar = document.createElement('div');
        bar.setAttribute('data-agy-fe-titlebar', '1');
        anchor.parentElement.insertBefore(bar, anchor);
      }
      bar.innerHTML = '';

      const mk = (html, title, warn, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-agy-fe-tbtn', '1');
        if (warn) b.setAttribute('data-warn', warn);
        b.title = title;
        b.innerHTML = html;
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick(e);
        });
        return b;
      };

      const ctxTxt = pct >= 70 ? \`⚡ \${pct}%\` : \`\${pct}%\`;
      bar.appendChild(
        mk(
          \`<span>\${ctxTxt}</span>\`,
          \`Context \${kUsed}K / \${kLim}K — 点击静默轻装 Fork（按住 Alt/Option 点击打开高级选项）\`,
          warnLevel,
          (e) => {
            const cid = getActiveConversationIdFromUrl();
            if (e?.altKey || e?.shiftKey) {
              openForkModal('handoff', 0, cid);
            } else {
              triggerSilentFork({ conversationId: cid, mode: 'handoff', autoSmartHandoff: true });
            }
          },
        ),
      );
      bar.appendChild(
        mk(
          ICON_FORK + '<span>Fork</span>',
          '一键静默分支当前会话（按住 Alt/Option 点击可自选轮次与 Git Worktree）',
          '',
          (e) => {
            const cid = getActiveConversationIdFromUrl();
            if (e?.altKey || e?.shiftKey) {
              openForkModal('exact', 0, cid);
            } else {
              triggerSilentFork({ conversationId: cid, upToTurn: 0, autoSmartHandoff: true });
            }
          },
        ),
      );
      bar.appendChild(
        mk(
          ICON_FOLDER,
          openExplorerLabel + '当前项目工作区',
          '',
          () => sendToHost({ action: 'openWorkspaceFinder', conversationId: getActiveConversationIdFromUrl() }),
        ),
      );
      return;
    }

    // Fallback minimal capsule if native titlebar anchor wasn't found
    if (fallbackCapsuleEl) {
      fallbackCapsuleEl.dataset.theme = isDarkTheme() ? 'dark' : 'light';
      fallbackCapsuleEl.dataset.visible = 'true';
      fallbackCapsuleEl.innerHTML = '';
      const addFb = (text, onClick) => {
        const b = document.createElement('button');
        b.className = 'fe-cbtn';
        b.textContent = text;
        b.onclick = (e) => { e.stopPropagation(); onClick(e); };
        fallbackCapsuleEl.appendChild(b);
      };
      addFb('🌿 Fork', (e) => {
        const cid = getActiveConversationIdFromUrl();
        if (e?.altKey || e?.shiftKey) openForkModal('exact', 0, cid);
        else triggerSilentFork({ conversationId: cid, upToTurn: 0, autoSmartHandoff: true });
      });
      addFb('📂 ' + (isMac ? '访达' : '资源管理器'), () => {
        sendToHost({ action: 'openWorkspaceFinder', conversationId: getActiveConversationIdFromUrl() });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Subtle inline turn Fork button on assistant action toolbars
  // ---------------------------------------------------------------------------
  function injectTurnForkButtons() {
    if (disposed) return;
    const candidates = document.querySelectorAll(
      '[data-testid="message-actions"], [data-testid*="response-actions"], [data-message-author="assistant"] [role="toolbar"]',
    );
    let idx = 0;
    for (const bar of candidates) {
      idx += 1;
      if (bar.querySelector('[data-agy-fe-turn-fork="1"]')) continue;
      const turnIdx = idx;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-agy-fe-turn-fork', '1');
      btn.title = '从本轮静默分叉到新会话（按住 Alt/Option 点击可选模式/Worktree）';
      btn.innerHTML = ICON_FORK;
      btn.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;margin-left:2px;border-radius:6px;border:none;background:transparent;color:inherit;cursor:pointer;opacity:0.72;';
      btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; btn.style.background = 'rgba(127,127,127,0.16)'; });
      btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.72'; btn.style.background = 'transparent'; });
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const cid = getActiveConversationIdFromUrl();
        if (ev.altKey || ev.shiftKey) {
          openForkModal('exact', turnIdx, cid);
        } else {
          triggerSilentFork({ conversationId: cid, upToTurn: turnIdx, autoSmartHandoff: true });
        }
      });
      bar.appendChild(btn);
    }
  }

  const onPointerTrack = (e) => {
    const cid = extractConvIdFromElement(e.target);
    if (cid) {
      lastClickedConvId = cid;
      lastClickedAt = Date.now();
    }
  };

  const onContextMenu = (e) => {
    onPointerTrack(e);
    const target = e.target?.closest?.(FILE_SELECTOR);
    if (!target) return;
    const uri = extractTargetUri(target);
    if (!uri) return;
    e.preventDefault();
    e.stopPropagation();
    openFileContextMenu(e.clientX, e.clientY, uri);
  };

  const onClick = (e) => {
    onPointerTrack(e);
    if (host && e.composedPath().includes(host)) return;
    closeMenu();
    const modifier = isMac ? e.metaKey : e.ctrlKey;
    if (modifier) {
      const target = e.target?.closest?.(FILE_SELECTOR);
      const uri = extractTargetUri(target);
      if (uri) {
        e.preventDefault();
        e.stopPropagation();
        sendToHost({ action: 'reveal', uri });
      }
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      closeForkModal();
    }
  };

  document.addEventListener('pointerdown', onPointerTrack, true);
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);

  let scanTimer = 0;
  function runDomScan() {
    if (disposed) return;
    enhanceNativeConversationMenus();
    mountNativeTitlebarTools();
    injectTurnForkButtons();
  }

  const domObserver = new MutationObserver(() => {
    // Immediate fast-path for popup menus so zero visual flicker occurs when opening [⋮]
    enhanceNativeConversationMenus();
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      mountNativeTitlebarTools();
      injectTurnForkButtons();
    }, 250);
  });
  if (document.body) {
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  ensureHost();
  runDomScan();

  function findSpaRouter() {
    const anchors = [
      document.querySelector('[aria-label="Message input"]'),
      document.querySelector('a[href="/customizations"]'),
      document.querySelector('#root')?.firstElementChild,
      document.body?.firstElementChild,
    ].filter(Boolean);

    for (const el of anchors) {
      const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      if (!fk) continue;
      let node = el[fk];
      for (let i = 0; node && i < 200; i += 1, node = node.return) {
        const val = node.memoizedProps?.value;
        if (val && typeof val.navigate === 'function' && typeof val.buildRouteTree === 'function') {
          return val;
        }
      }
    }
    return null;
  }

  async function navigateWithoutReload(convId, projectId = '') {
    if (!convId) return false;
    const suffix = projectId ? '?project=' + encodeURIComponent(projectId) : '';
    const targetUrl = '/c/' + encodeURIComponent(convId) + suffix;

    // 1. Native TanStack Router SPA transition (0ms, zero page reload!)
    try {
      const r = findSpaRouter();
      if (r) {
        await r.navigate({
          to: '/c/$cascadeId',
          params: { cascadeId: convId },
          ...(projectId ? { search: { project: projectId } } : {}),
        });
        return true;
      }
    } catch {}

    // 2. Click newly rendered sidebar conversation link directly (zero page reload!)
    const trySidebarClick = () => {
      const link = document.querySelector('a[href*="/c/' + CSS.escape(convId) + '"]');
      if (link) {
        link.click();
        return true;
      }
      return false;
    };
    if (trySidebarClick()) return true;

    // 3. Standard SPA History pushState + popstate (zero page reload!)
    try {
      const nextState = { ...(history.state || {}), __TSR_index: ((history.state?.__TSR_index) || 0) + 1 };
      history.pushState(nextState, '', targetUrl);
      window.dispatchEvent(new PopStateEvent('popstate', { state: nextState }));
      return true;
    } catch {}

    // Stay strictly in-page SPA — never trigger a full Electron page reload!
    setTimeout(() => { trySidebarClick(); }, 600);
    return false;
  }

  globalThis.__agyForkExplorerOverlay = {
    version: CFG.version,
    ownerId: CFG.ownerId,
    updateTelemetry(next) {
      if (!next || typeof next !== 'object') return;
      telemetry = { ...telemetry, ...next };
      mountNativeTitlebarTools();
      if (next.relay?.activeJob && next.relay.activeJob.status === 'awaiting_confirm') {
        showRelayBanner(next.relay.activeJob);
      } else if (activeRelayJob) {
        hideRelayBanner();
      }
    },
    showRelayBanner(job) {
      showRelayBanner(job);
    },
    hideRelayBanner() {
      hideRelayBanner();
    },
    receiveConversationTurns(payload) {
      if (!payload || payload.conversationId !== modalConvId) return;
      modalTurns = Array.isArray(payload.turns) ? payload.turns : [];
      modalTitle = payload.title || '';
      renderForkModalBody();
    },
    notify(msg, isError = false) {
      forkInFlight = false;
      showToast(msg, isError);
    },
    navigateConversation(convId, projectId = '') {
      forkInFlight = false;
      void navigateWithoutReload(convId, projectId);
    },
    startLazyFork(prefillPrompt, projectId = '', branchLabel = 'fork') {
      forkInFlight = false;
      // 0-Token Lazy Fork: open a brand-new conversation via SPA (no page reload, 0 LLM turns!)
      // and prefill the ultra-lean seed context into the composer.
      const openNewConv = async () => {
        try {
          const newBtn =
            document.querySelector('[data-testid="new-conversation-button"]') ||
            document.querySelector('[data-testid*="new-chat"]') ||
            document.querySelector('a[href="/"]');
          if (newBtn) {
            newBtn.click();
          } else {
            const r = findSpaRouter();
            if (r) {
              await r.navigate({
                to: '/',
                ...(projectId ? { search: { project: projectId } } : {}),
              });
            }
          }
        } catch {}

        // Poll briefly for the fresh composer to mount and fill it
        let filled = false;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await new Promise((res) => setTimeout(res, 100));
          if (insertIntoComposer(prefillPrompt)) {
            filled = true;
            break;
          }
        }
        await copyText(prefillPrompt);
        showToast(
          filled
            ? '⚡ 零 Token 懒分叉「' + branchLabel + '」已填入输入框（0 消耗），输入需求直接发送！'
            : '⚡ 零 Token 懒分叉「' + branchLabel + '」已复制（0 消耗），在新对话粘贴即可！',
        );
      };
      void openNewConv();
    },
    dispose() {
      disposed = true;
      clearTimeout(scanTimer);
      try { domObserver.disconnect(); } catch {}
      document.querySelectorAll('[data-agy-fe-menu-item="1"], [data-agy-fe-titlebar="1"], [data-agy-fe-turn-fork="1"]').forEach((n) => n.remove());
      document.getElementById(STYLE_ID)?.remove();
      document.removeEventListener('pointerdown', onPointerTrack, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      clearTimeout(toastTimer);
      clearInterval(relayTimer);
      host?.remove?.();
      host = null;
    },
  };
  return 'installed';
})();`;
}
