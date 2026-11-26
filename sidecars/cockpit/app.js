(() => {
  const params = new URLSearchParams(window.location.search);

  const state = {
    activeTab: 'fork',
    pinnedConvId: params.get('conversationId') || '',
    workspaceRoot: params.get('workspaceRoot') || '',
    relDir: '',
    fileFilter: '',
    showHidden: false,
    selectedTurn: 0,
    forkMode: 'exact',
    previewPath: '',
    data: null,
    tree: null,
    historyItems: null,
    cdpOpen: false,
    settingsOpen: params.get('settings') === '1',
  };

  const $ = (id) => document.getElementById(id);

  function el(tag, opts = {}, children = []) {
    const node = document.createElement(tag);
    if (opts.className) node.className = opts.className;
    if (opts.text !== undefined) node.textContent = String(opts.text);
    if (opts.title) node.title = String(opts.title);
    if (opts.type) node.type = String(opts.type);
    if (opts.value !== undefined) node.value = String(opts.value);
    if (opts.checked !== undefined) node.checked = Boolean(opts.checked);
    if (opts.src) node.src = String(opts.src);
    if (opts.alt !== undefined) node.alt = String(opts.alt);
    if (opts.style) Object.assign(node.style, opts.style);
    if (opts.onClick) node.addEventListener('click', opts.onClick);
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clear(node) {
    if (node) node.replaceChildren();
  }

  let toastTimer = 0;
  function showToast(msg, isErr = false) {
    const t = $('toast');
    if (!t) return;
    t.textContent = String(msg || '');
    t.className = `toast show${isErr ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.className = 'toast';
    }, 2600);
  }

  async function apiGet(path) {
    const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await fetcher(path, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function apiPost(path, payload = {}) {
    const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await fetcher(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    return body;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function getHostConvId() {
    return String(window.sidecar?.conversationId || params.get('conversationId') || '').trim();
  }

  function getTargetConvId() {
    return state.pinnedConvId || getHostConvId();
  }

  function formatK(n) {
    const num = Number(n) || 0;
    return num >= 1000 ? `${Math.round(num / 1000)}K` : String(num);
  }

  function formatSize(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatRelTime(ts) {
    const ms = typeof ts === 'number' ? ts : Date.parse(ts || '');
    if (!ms) return '';
    const diff = Math.max(0, Date.now() - ms);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins} 分钟前`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} 小时前`;
    return `${Math.floor(hrs / 24)} 天前`;
  }

  function jumpToConversation(convId) {
    if (!convId) return;
    if (window.sidecar?.ui?.toggleConversation) {
      try {
        window.sidecar.ui.toggleConversation(convId);
        showToast('已切换目标分支会话');
        return;
      } catch {}
    }
    state.pinnedConvId = convId;
    void refreshAll();
    showToast('已切换到该会话视图');
  }

  function openInNativeTab(filePath) {
    if (!filePath) return;
    const uri = filePath.startsWith('file://') ? filePath : `file://${encodeURI(filePath)}`;
    if (window.sidecar?.ui?.toggleAuxPane) {
      try {
        window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri });
        return;
      } catch {}
    }
    void openPreview(filePath);
  }

  async function quoteFileToChat(filePath) {
    const root = state.workspaceRoot || state.data?.workspace?.root || '';
    const rel = root && filePath.startsWith(root) ? filePath.slice(root.length).replace(/^[/\\]+/, '') : filePath;
    const mention = `@${rel.includes(' ') ? `"${rel}"` : rel} `;
    if (window.sidecar?.agent?.sendMessage) {
      await copyText(mention);
      showToast(`已复制 ${mention.trim()}（可直接粘贴到输入框）`);
      return;
    }
    await copyText(mention);
    showToast(`已复制上下文引用：${mention.trim()}`);
  }

  function renderTopHeader() {
    const d = state.data;
    if (!d) return;

    // Session select
    const sel = $('sessionSelect');
    clear(sel);
    const sessions = d.sessions || [];
    const activeId = d.conversationId;
    if (!sessions.length && activeId) {
      sel.appendChild(el('option', { value: activeId, text: d.conversation?.title || '当前会话' }));
    } else {
      for (const s of sessions) {
        const prefix = s.conversationId === getHostConvId() ? '● 当前 · ' : s.isScratch ? '🔎 Scratch · ' : '';
        const opt = el('option', { value: s.conversationId, text: `${prefix}${s.title}` });
        if (s.conversationId === activeId) opt.selected = true;
        sel.appendChild(opt);
      }
    }

    // CDP status pill
    const cdp = d.cdp || {};
    const dot = $('cdpDot');
    const lbl = $('cdpLabel');
    if (cdp.state === 'connected') {
      dot.className = 'dot ok';
      lbl.textContent = `原生已连 (${cdp.attachedPages || 1})`;
    } else if (cdp.state === 'unreachable') {
      dot.className = 'dot err';
      lbl.textContent = '原生端口异常';
    } else {
      dot.className = 'dot warn';
      lbl.textContent = cdp.enabled ? '原生待启动' : '原生已关闭';
    }

    renderCdpDrawer();
    renderSettingsDrawer();
  }

  function renderCdpDrawer() {
    const box = $('cdpDrawer');
    box.classList.toggle('hidden', !state.cdpOpen);
    if (!state.cdpOpen || !state.data) return;
    clear(box);
    const cdp = state.data.cdp || {};
    const statusText =
      cdp.state === 'connected'
        ? `🟢 已连接本地调试端口 (${cdp.port})，已注入 ${cdp.attachedPages} 个窗口：支持原生 file:// 胶囊右键访达菜单、⌘/Ctrl+单击定位、悬浮 Context 水位与一键 Fork！`
        : '⚪ 当前以纯官方 Sidecar 模式运行（全部驾驶舱功能已就绪）。如需启用类 agy-powertools 的原生主界面右键菜单与悬浮气泡 Fork，可运行下方零侵入脚本启动 Antigravity：';
    box.appendChild(el('div', { text: statusText }));
    if (cdp.launchHint) {
      box.appendChild(el('div', { className: 'code-box', text: cdp.launchHint }));
    }
    const row = el('div', { className: 'quick-os-bar' }, [
      el('button', {
        className: 'btn btn-xs',
        text: '📋 复制启动命令',
        onClick: async () => {
          await copyText(cdp.launchHint || '');
          showToast('已复制 CDP 启动命令');
        },
      }),
      el('button', {
        className: 'btn btn-xs',
        text: cdp.enabled ? '暂停原生监听' : '开启原生监听',
        onClick: async () => {
          const res = await apiPost('/api/settings', { cdpEnabled: !cdp.enabled });
          state.data.cdp = res.cdp;
          state.data.settings = res.settings;
          renderTopHeader();
          showToast(res.settings.cdpEnabled ? '已开启原生增强监听' : '已关闭原生增强监听');
        },
      }),
    ]);
    box.appendChild(row);
  }

  function renderSettingsDrawer() {
    const box = $('settingsDrawer');
    box.classList.toggle('hidden', !state.settingsOpen);
    if (!state.settingsOpen || !state.data) return;
    clear(box);
    const cfg = state.data.settings || {};

    const relayEnabledCb = el('input', { type: 'checkbox', checked: cfg.autoRelayEnabled !== false });
    let confirmModeVal = cfg.autoRelayConfirmMode === 'silent' ? 'silent' : 'countdown';
    const btnCountdown = el('button', {
      type: 'button',
      className: `mode-pill${confirmModeVal === 'countdown' ? ' active' : ''}`,
      text: '⏱ 5秒倒计时胶囊',
    });
    const btnSilent = el('button', {
      type: 'button',
      className: `mode-pill${confirmModeVal === 'silent' ? ' active' : ''}`,
      text: '⚡ 0秒静默无人值守',
    });
    const syncConfirmBtns = () => {
      btnCountdown.classList.toggle('active', confirmModeVal === 'countdown');
      btnSilent.classList.toggle('active', confirmModeVal === 'silent');
    };
    btnCountdown.addEventListener('click', () => { confirmModeVal = 'countdown'; syncConfirmBtns(); });
    btnSilent.addEventListener('click', () => { confirmModeVal = 'silent'; syncConfirmBtns(); });

    const softInput = el('input', { className: 'input', type: 'number', value: cfg.autoRelaySoftPercent ?? 75 });
    const hardInput = el('input', { className: 'input', type: 'number', value: cfg.autoRelayHardPercent ?? 90 });
    const countdownInput = el('input', { className: 'input', type: 'number', value: cfg.autoRelayCountdownSec ?? 5 });
    const maxChainInput = el('input', { className: 'input', type: 'number', value: cfg.autoRelayMaxChain ?? 3 });

    const modelSel = el('select', { className: 'input' }, [
      el('option', { value: 'pro', text: 'Pro（主力续跑，推荐）' }),
      el('option', { value: 'flash', text: 'Flash（极速省 Token）' }),
    ]);
    modelSel.value = cfg.autoRelayModel === 'flash' ? 'flash' : 'pro';

    const limInput = el('input', { className: 'input', type: 'number', value: cfg.compactionLimit || 256000 });
    const lazyCb = el('input', { type: 'checkbox', checked: Boolean(cfg.zeroTokenLazy) });

    box.appendChild(el('div', { style: { fontWeight: '700' }, text: '⚙ 驾驶舱与自动接力设置（方案 B + C）' }));
    box.appendChild(
      el('label', { className: 'chk' }, [
        relayEnabledCb,
        '🤖 开启高压自动 Fork 续跑（75% 亲笔交接单 + 90% 硬红线兜底）',
      ]),
    );
    box.appendChild(el('div', { style: { fontSize: '10.5px', color: 'var(--muted)' }, text: '接力触发确认方式（一键切换）：' }));
    box.appendChild(el('div', { className: 'mode-group' }, [btnCountdown, btnSilent]));

    box.appendChild(
      el('div', { className: 'settings-grid' }, [
        el('label', { className: 'setting-field' }, ['预警线 %（自写交接单）', softInput]),
        el('label', { className: 'setting-field' }, ['硬红线 %（强制兜底）', hardInput]),
        el('label', { className: 'setting-field' }, ['倒计时秒数（3–15s）', countdownInput]),
        el('label', { className: 'setting-field' }, ['防循环熔断上限（次）', maxChainInput]),
        el('label', { className: 'setting-field' }, ['续跑默认模型', modelSel]),
        el('label', { className: 'setting-field' }, ['压缩上限 Tokens', limInput]),
      ]),
    );

    box.appendChild(el('div', { className: 'setting-sep' }));
    box.appendChild(
      el('label', { className: 'chk' }, [
        lazyCb,
        '⚡ 手动 Fork 零 Token 懒启动（不预跑首轮，直接填入新输入框）',
      ]),
    );

    box.appendChild(
      el('div', { className: 'quick-os-bar' }, [
        el('button', {
          className: 'btn btn-xs btn-primary',
          text: '保存设置',
          onClick: async () => {
            await apiPost('/api/settings', {
              autoRelayEnabled: relayEnabledCb.checked,
              autoRelayConfirmMode: confirmModeVal,
              autoRelaySoftPercent: Number(softInput.value) || 75,
              autoRelayHardPercent: Number(hardInput.value) || 90,
              autoRelayCountdownSec: Number(countdownInput.value) || 5,
              autoRelayMaxChain: Number(maxChainInput.value) || 3,
              autoRelayModel: modelSel.value,
              compactionLimit: Number(limInput.value) || 256000,
              zeroTokenLazy: lazyCb.checked,
            });
            state.settingsOpen = false;
            await refreshAll();
            const modeDesc = !relayEnabledCb.checked
              ? '已关闭自动接力'
              : confirmModeVal === 'silent'
                ? '已切换为 ⚡ 0 秒静默无人值守接力'
                : `已切换为 ⏱ ${Number(countdownInput.value) || 5} 秒倒计时确认胶囊`;
            showToast(modeDesc);
          },
        }),
        el('button', {
          className: 'btn btn-xs btn-teal',
          text: '🧪 测试倒计时接力',
          title: '在当前会话触发一次 5 秒倒计时接力演练（可随时点「暂不」取消）',
          onClick: async () => {
            const res = await apiPost('/api/relay/trigger', {
              conversationId: getTargetConvId(),
              confirmMode: 'countdown',
            });
            if (res.ok) {
              state.settingsOpen = false;
              await refreshAll();
              showToast('已弹出倒计时接力胶囊，可点击「立即接力」或「暂不」');
            } else {
              showToast(res.error || '触发失败', true);
            }
          },
        }),
        el('button', {
          className: 'btn btn-xs',
          text: '关闭',
          onClick: () => {
            state.settingsOpen = false;
            renderSettingsDrawer();
          },
        }),
      ]),
    );
  }

  let relayCountdownTimer = 0;
  function renderRelayBanner() {
    const box = $('relayBanner');
    if (!box) return;
    clearInterval(relayCountdownTimer);
    relayCountdownTimer = 0;

    const relay = state.data?.relay;
    const job = relay?.activeJob;
    if (!job) {
      // Show a subtle one-click jump strip if a recent relay just launched within the last 3 minutes
      const recentLaunched = (relay?.recentJobs || []).find(
        (j) => j.status === 'launched' && j.childConversationId && Date.now() - (j.launchedAt || 0) < 180_000,
      );
      if (recentLaunched && recentLaunched.conversationId === state.data?.conversationId) {
        box.className = 'relay-strip done';
        clear(box);
        box.appendChild(
          el('div', { className: 'relay-top' }, [
            el('span', { className: 'relay-title', text: `✨ 已自动接力至新分支「${recentLaunched.branchLabel || 'relay'}」` }),
            el('button', {
              className: 'btn btn-xs btn-teal',
              text: '打开新分支 →',
              onClick: () => jumpToConversation(recentLaunched.childConversationId),
            }),
          ]),
        );
        return;
      }
      box.className = 'relay-strip hidden';
      clear(box);
      return;
    }

    const isHard = job.triggerMode === 'hard_failsafe';
    box.className = `relay-strip${isHard ? ' hard' : ''}`;
    clear(box);

    const titleEl = el('span', { className: 'relay-title' });
    const fillEl = el('div', { className: 'relay-progress-fill', style: { width: '100%' } });
    const totalMs = Math.max(1000, (Number(job.countdownSec) || 5) * 1000);

    const ops = el('div', { className: 'row-ops' });
    if (job.status === 'awaiting_confirm') {
      ops.appendChild(
        el('button', {
          className: 'btn btn-xs btn-primary',
          text: '立即接力',
          onClick: async () => {
            const res = await apiPost('/api/relay/confirm', { jobId: job.id });
            showToast(res.ok ? '⚡ 正在切入低水位新分支续跑…' : res.error || '操作失败', !res.ok);
            await refreshAll();
            if (res?.result?.launched && res.result.newConversationId) {
              jumpToConversation(res.result.newConversationId);
            }
          },
        }),
      );
      ops.appendChild(
        el('button', {
          className: 'btn btn-xs',
          text: '暂不',
          onClick: async () => {
            const res = await apiPost('/api/relay/dismiss', { jobId: job.id });
            showToast(res.ok ? `已暂停本次接力（红线 ${res.dismissedUntilPct || 90}% 前不再打扰）` : res.error || '取消失败', !res.ok);
            await refreshAll();
          },
        }),
      );
    }

    box.appendChild(el('div', { className: 'relay-top' }, [titleEl, ops]));
    box.appendChild(el('div', { className: 'relay-progress' }, [fillEl]));

    const updateTick = () => {
      if (job.status !== 'awaiting_confirm') {
        titleEl.textContent = `⚡ 正在创建低水位接力分支（${job.percent || 0}%）…`;
        fillEl.style.width = '100%';
        return;
      }
      const remMs = Math.max(0, (Number(job.executeAfter) || Date.now()) - Date.now());
      const remSec = Math.ceil(remMs / 1000);
      const tag = isHard ? '🛡️ 兜底接力' : '✨ 亲笔交接单';
      titleEl.textContent =
        remSec > 0
          ? `${tag} · ${job.percent || 0}% · ${remSec}s 后自动 Fork 续跑`
          : `${tag} · 正在启动新分支续跑…`;
      fillEl.style.width = `${Math.max(0, Math.min(100, (remMs / totalMs) * 100))}%`;
      if (remMs <= 0) {
        clearInterval(relayCountdownTimer);
        relayCountdownTimer = 0;
        setTimeout(() => void refreshAll(), 900);
      }
    };
    updateTick();
    if (job.status === 'awaiting_confirm') {
      relayCountdownTimer = setInterval(updateTick, 150);
    }
  }

  function renderContextBar() {
    const ctx = state.data?.conversation?.context;
    const cfg = state.data?.settings || {};
    const bar = $('contextBar');
    if (!ctx) {
      bar.className = 'ctx-strip';
      $('ctxTitle').textContent = '🧠 暂无活跃会话上下文';
      $('ctxBadge').textContent = '0%';
      $('ctxFill').style.width = '0%';
      return;
    }
    const level = ctx.level || 'healthy';
    bar.className = `ctx-strip ${level === 'healthy' ? '' : level}`;
    const srcTag = ctx.tokenSource === 'api' ? '实时' : '估算';
    const relayTag = cfg.autoRelayEnabled === false
      ? ''
      : cfg.autoRelayConfirmMode === 'silent'
        ? ` · ⚡${cfg.autoRelaySoftPercent || 75}%静默`
        : ` · ⏱${cfg.autoRelaySoftPercent || 75}%接力`;
    const warnSuffix =
      level === 'critical'
        ? ' · 高压'
        : level === 'warning'
          ? ' · 预警'
          : '';
    $('ctxTitle').textContent = `🧠 ${formatK(ctx.usedTokens)}/${formatK(ctx.limitTokens)} (${srcTag})${warnSuffix}${relayTag}`;
    $('ctxBadge').textContent = `${ctx.percent}%`;
    $('ctxFill').style.width = `${Math.min(100, ctx.percent)}%`;
  }

  function renderForkTab() {
    const d = state.data;
    if (!d) return;

    // 1. Fork DAG Graph
    const tree = d.forkTree || { nodes: [], totalBranches: 0 };
    $('branchCountBadge').textContent = `${tree.totalBranches || 0} 分支`;
    const gList = $('forkGraphList');
    clear(gList);

    if (!tree.nodes.length) {
      gList.appendChild(el('div', { className: 'empty-hint', text: '尚无分支记录，选中下方任意轮次即可 Fork 第一条分支。' }));
    } else {
      for (const node of tree.nodes) {
        const indentPx = Math.min(node.depth || 0, 4) * 14;
        const laneClass = `lane-dot lane-${(node.lane || 0) % 4}`;
        const badges = [];
        if (node.isActive) badges.push(el('span', { className: 'badge', text: 'HEAD' }));
        if (node.worktreePath) badges.push(el('span', { className: 'badge wt', text: 'WT' }));
        if (node.isPendingLaunch) badges.push(el('span', { className: 'badge scratch', text: '待拉起' }));

        const subParts = [];
        if (node.forkedFromTurn) subParts.push(`from #${node.forkedFromTurn}`);
        if (node.mode && node.mode !== 'root') subParts.push(node.mode);
        if (node.worktreeBranch) subParts.push(node.worktreeBranch);
        if (!subParts.length) subParts.push('主干');

        const row = el(
          'div',
          {
            className: `graph-row${node.isActive ? ' active' : ''}`,
            onClick: () => jumpToConversation(node.conversationId),
          },
          [
            el('div', { className: 'row-main', style: { paddingLeft: `${indentPx}px` } }, [
              el('span', { className: laneClass }),
              el('div', { className: 'row-text' }, [
                el('div', { className: 'row-title', text: `${node.depth > 0 ? '↳ ' : ''}${node.branchLabel || 'main'} · ${node.title || ''}` }),
                el('div', { className: 'row-sub', text: subParts.join(' · ') }),
              ]),
            ]),
            el('div', { className: 'row-ops' }, [
              ...badges,
              node.worktreePath
                ? el('button', {
                    className: 'btn btn-xs',
                    text: '访达',
                    title: '在系统资源管理器中打开 Worktree 目录',
                    onClick: async (e) => {
                      e.stopPropagation();
                      await apiPost('/api/explorer/reveal', { path: node.worktreePath });
                      showToast('已在资源管理器打开 Worktree');
                    },
                  })
                : null,
              el('button', {
                className: 'btn btn-xs',
                text: '重命名',
                onClick: async (e) => {
                  e.stopPropagation();
                  const nextName = window.prompt('输入新的分支标签名：', node.branchLabel || '');
                  if (!nextName || !nextName.trim()) return;
                  await apiPost('/api/branch/meta', {
                    conversationId: node.conversationId,
                    branchLabel: nextName.trim(),
                  });
                  await refreshAll();
                  showToast(`已重命名分支为 ${nextName.trim()}`);
                },
              }),
            ]),
          ],
        );
        gList.appendChild(row);
      }
    }

    // 2. Turn Timeline Picker
    const turns = d.conversation?.turns || [];
    $('turnCountBadge').textContent = `${turns.length} 轮`;
    if (!state.selectedTurn || state.selectedTurn > turns.length) {
      state.selectedTurn = turns.length;
    }

    const tList = $('turnTimelineList');
    clear(tList);
    if (!turns.length) {
      tList.appendChild(el('div', { className: 'empty-hint', text: '当前会话暂无已解析轮次' }));
    } else {
      for (const turn of turns) {
        const isSel = turn.turnIndex === state.selectedTurn;
        const row = el(
          'div',
          {
            className: `turn-row${isSel ? ' selected' : ''}`,
            onClick: () => {
              state.selectedTurn = turn.turnIndex;
              renderForkTab();
            },
          },
          [
            el('div', { className: 'row-main' }, [
              el('span', { className: 'badge', text: `#${turn.turnIndex}` }),
              el('div', { className: 'row-text' }, [
                el('div', { className: 'row-title', text: turn.userTitle }),
                el('div', {
                  className: 'row-sub',
                  text: `累计 ${formatK(turn.cumulativeTokens)} tok · ${turn.toolCount} 工具 · ${turn.touchedFiles.length} 文件`,
                }),
              ]),
            ]),
            isSel ? el('span', { className: 'badge wt', text: '分叉点' }) : null,
          ],
        );
        tList.appendChild(row);
      }
    }

    const picked = turns.find((t) => t.turnIndex === state.selectedTurn);
    $('forkAnchorLabel').textContent = picked
      ? `分叉起点：Turn #${picked.turnIndex} · ${picked.userTitle}`
      : '分叉起点：当前最新轮次 (HEAD)';

    // Sync checkboxes with settings on initial load
    if (d.settings) {
      if ($('optSnapshot').dataset.touched !== '1') $('optSnapshot').checked = d.settings.autoSnapshot !== false;
      if ($('optWorktree').dataset.touched !== '1') $('optWorktree').checked = Boolean(d.settings.defaultWorktree);
    }
  }

  async function runForkAction({ overrideMode = '', overrideLabel = '' } = {}) {
    const btn = $('execForkBtn');
    const mode = overrideMode || state.forkMode;
    const branchLabel = overrideLabel || $('branchNameInput').value.trim();
    const nextInstruction = $('nextInstructionInput').value.trim();
    const createWorktree = $('optWorktree').checked;
    const createSnapshot = $('optSnapshot').checked;

    btn.disabled = true;
    btn.textContent = '⏳ 正在创建分支会话…';
    try {
      const res = await apiPost('/api/fork', {
        conversationId: getTargetConvId(),
        upToTurn: state.selectedTurn || 0,
        mode,
        branchLabel,
        nextInstruction,
        workspaceRoot: state.workspaceRoot || state.data?.workspace?.root || '',
        createWorktree,
        createSnapshot,
      });

      const box = $('forkResultBox');
      box.classList.remove('hidden');
      clear(box);

      if (!res.ok) {
        box.appendChild(el('div', { text: `❌ ${res.error || 'Fork 失败'}` }));
        showToast(res.error || 'Fork 失败', true);
        return;
      }

      box.appendChild(
        el('div', {
          style: { fontWeight: '700' },
          text: res.lazy
            ? `⚡ 零 Token 懒分叉「${res.branchLabel}」已就绪（0 消耗 · 种子 ~${res.promptEstTokens || 0} tok）`
            : res.launched
              ? `✅ 分支「${res.branchLabel}」已启动（Turn #${res.forkedFromTurn} · ~${res.promptEstTokens || 0} tok）`
              : `✅ 分支上下文包「${res.branchLabel}」已生成（~${res.promptEstTokens || 0} tok）`,
        }),
      );
      if (res.worktree?.worktreePath) {
        box.appendChild(el('div', { className: 'row-sub', text: `🌳 Worktree: ${res.worktree.worktreePath} (${res.worktree.branchName})` }));
      }
      if (res.snapshot?.id) {
        box.appendChild(el('div', { className: 'row-sub', text: `💾 分叉前快照: ${res.snapshot.id} (${res.snapshot.dirtyCount} 文件)` }));
      }
      if (res.warnings?.length) {
        box.appendChild(el('div', { className: 'row-sub', text: `⚠️ ${res.warnings.join('；')}` }));
      }

      const actions = el('div', { className: 'quick-os-bar' }, [
        res.launched && res.newConversationId
          ? el('button', {
              className: 'btn btn-xs btn-primary',
              text: '↗ 跳转到新分支',
              onClick: () => jumpToConversation(res.newConversationId),
            })
          : el('button', {
              className: 'btn btn-xs btn-primary',
              text: '📋 复制分叉种子 Prompt',
              onClick: async () => {
                await copyText(res.prompt || '');
                showToast('已复制分叉 Prompt，新建对话粘贴即可续跑');
              },
            }),
        el('button', {
          className: 'btn btn-xs',
          text: '📂 访达定位种子文件',
          onClick: async () => {
            await apiPost('/api/explorer/reveal', { path: res.seedFilePath });
            showToast('已在资源管理器中定位种子文件');
          },
        }),
        res.worktree?.worktreePath
          ? el('button', {
              className: 'btn btn-xs',
              text: '🌳 打开 Worktree',
              onClick: async () => {
                await apiPost('/api/explorer/reveal', { path: res.worktree.worktreePath });
              },
            })
          : null,
      ]);
      box.appendChild(actions);

      $('branchNameInput').value = '';
      $('nextInstructionInput').value = '';
      showToast(`🌿 分支「${res.branchLabel}」已记录到谱系树`);
      await refreshAll();
    } catch (err) {
      showToast(err.message || '执行 Fork 异常', true);
    } finally {
      btn.disabled = false;
      btn.textContent = '🌿 从选定节点创建新分支会话';
    }
  }

  function renderExplorerTab() {
    const d = state.data;
    const t = state.tree;
    if (!d) return;

    // Workspace selector (current + favorites + worktrees + recents)
    const wsSel = $('workspaceSelect');
    clear(wsSel);
    const seen = new Set();
    const addRootOpt = (p, label) => {
      if (!p || seen.has(p)) return;
      seen.add(p);
      const opt = el('option', { value: p, text: label });
      if (p === (state.workspaceRoot || d.workspace?.root)) opt.selected = true;
      wsSel.appendChild(opt);
    };
    if (d.workspace?.root) addRootOpt(d.workspace.root, `📁 当前 · ${d.workspace.root.split(/[/\\]/).pop() || d.workspace.root}`);
    for (const f of d.workspace?.favorites || []) addRootOpt(f.path, `⭐ ${f.label}`);
    for (const wt of d.workspace?.worktrees || []) {
      if (!wt.isMain) addRootOpt(wt.path, `🌳 WT · ${wt.branch || wt.path.split(/[/\\]/).pop()}`);
    }
    for (const r of d.workspace?.recentRoots || []) addRootOpt(r, `🕒 ${r.split(/[/\\]/).pop() || r}`);

    const curRoot = state.workspaceRoot || d.workspace?.root || '';
    const isFav = (d.workspace?.favorites || []).some((f) => f.path === curRoot);
    $('favRootBtn').textContent = isFav ? '★' : '☆';
    $('toggleHiddenBtn').classList.toggle('btn-teal', state.showHidden);

    // Pinned Session Artifacts (brain/)
    const aList = $('artifactsList');
    clear(aList);
    const artifacts = d.conversation?.artifacts || [];
    if (!artifacts.length) {
      aList.appendChild(el('div', { className: 'empty-hint', text: '当前会话尚无产出文件' }));
    } else {
      for (const a of artifacts) {
        aList.appendChild(
          el('div', { className: 'file-row', onClick: () => void openPreview(a.path) }, [
            el('div', { className: 'row-main' }, [
              el('span', { text: a.isDirectory ? '📁' : '📄' }),
              el('div', { className: 'row-text' }, [
                el('div', { className: 'row-title', text: a.name }),
                el('div', { className: 'row-sub', text: a.isDirectory ? '目录' : formatSize(a.size) }),
              ]),
            ]),
            el('div', { className: 'row-ops' }, [
              el('button', {
                className: 'btn btn-xs',
                text: '访达',
                onClick: async (e) => {
                  e.stopPropagation();
                  await apiPost('/api/explorer/reveal', { path: a.path });
                  showToast(`已在系统资源管理器定位 ${a.name}`);
                },
              }),
              el('button', {
                className: 'btn btn-xs',
                text: '打开',
                onClick: async (e) => {
                  e.stopPropagation();
                  await apiPost('/api/explorer/open-default', { path: a.path });
                },
              }),
            ]),
          ]),
        );
      }
    }

    // File Tree
    const fList = $('fileTreeList');
    clear(fList);
    if (!t || !t.ok) {
      $('treeBreadcrumb').textContent = curRoot || './';
      fList.appendChild(el('div', { className: 'empty-hint', text: t?.error || '正在加载文件树…' }));
      return;
    }

    $('treeBreadcrumb').textContent = t.isSearch
      ? `🔍 匹配 ${t.entries.length} 项`
      : t.relDir
        ? `./${t.relDir}`
        : t.root.split(/[/\\]/).pop() || './';
    $('gitBranchPill').textContent = t.git?.isRepo
      ? `⎇ ${t.git.branch}${t.git.dirtyCount ? ` (${t.git.dirtyCount})` : ''}`
      : '非 Git';

    if (!t.isSearch && t.relDir) {
      fList.appendChild(
        el(
          'div',
          {
            className: 'file-row',
            onClick: () => {
              const parts = t.relDir.split('/').filter(Boolean);
              parts.pop();
              state.relDir = parts.join('/');
              void refreshTree();
            },
          },
          [el('div', { className: 'row-main' }, [el('span', { text: '↩' }), el('span', { className: 'row-title', text: '.. (返回上级目录)' })])],
        ),
      );
    }

    if (!t.entries.length) {
      fList.appendChild(el('div', { className: 'empty-hint', text: '目录为空或无匹配文件' }));
      return;
    }

    for (const item of t.entries) {
      const flagClass =
        item.gitFlag === 'M'
          ? 'badge git-M'
          : item.gitFlag === 'A' || item.gitFlag === '?'
            ? 'badge git-A'
            : item.gitFlag === 'D'
              ? 'badge git-D'
              : item.gitFlag
                ? 'badge'
                : '';
      const row = el(
        'div',
        {
          className: 'file-row',
          onClick: () => {
            if (item.isDirectory) {
              state.fileFilter = '';
              $('fileFilterInput').value = '';
              state.relDir = item.relPath;
              void refreshTree();
            } else {
              void openPreview(item.path);
            }
          },
          onDblclick: () => {
            if (!item.isDirectory) openInNativeTab(item.path);
          },
        },
        [
          el('div', { className: 'row-main' }, [
            el('span', { text: item.isDirectory ? '📁' : '📄' }),
            el('div', { className: 'row-text' }, [
              el('div', { className: 'row-title', text: t.isSearch ? item.relPath : item.name }),
            ]),
            item.gitFlag ? el('span', { className: flagClass, text: item.gitFlag }) : null,
          ]),
          el('div', { className: 'row-ops' }, [
            !item.isDirectory
              ? el('button', {
                  className: 'btn btn-xs',
                  text: 'Tab',
                  title: '在原生 Tab 或抽屉中打开',
                  onClick: (e) => {
                    e.stopPropagation();
                    openInNativeTab(item.path);
                  },
                })
              : null,
            el('button', {
              className: 'btn btn-xs',
              text: '访达',
              title: '在系统文件管理器高亮定位',
              onClick: async (e) => {
                e.stopPropagation();
                const res = await apiPost('/api/explorer/reveal', { path: item.path });
                showToast(res.ok ? `已定位 ${item.name}` : res.error || '定位失败', !res.ok);
              },
            }),
            el('button', {
              className: 'btn btn-xs',
              text: '@',
              title: '引用到聊天输入框',
              onClick: async (e) => {
                e.stopPropagation();
                await quoteFileToChat(item.path);
              },
            }),
          ]),
        ],
      );
      fList.appendChild(row);
    }
  }

  async function openPreview(filePath) {
    state.previewPath = filePath;
    const card = $('previewCard');
    const body = $('previewBody');
    card.classList.remove('hidden');
    $('previewTitle').textContent = filePath.split(/[/\\]/).pop() || filePath;
    clear(body);
    body.appendChild(el('div', { className: 'empty-hint', text: '加载预览中…' }));

    try {
      const res = await apiGet(`/api/preview?path=${encodeURIComponent(filePath)}`);
      clear(body);
      if (!res.ok) {
        body.appendChild(el('div', { className: 'empty-hint', text: res.error || '预览失败' }));
        return;
      }
      if (res.kind === 'image') {
        body.appendChild(
          el('div', { className: 'preview-img-wrap' }, [
            el('img', { src: res.dataUrl, alt: res.name }),
          ]),
        );
      } else if (res.kind === 'text') {
        body.appendChild(el('pre', { className: 'preview-code', text: res.content || '(空文件)' }));
      } else {
        body.appendChild(el('div', { className: 'empty-hint', text: res.message || `${res.name} (${formatSize(res.size)})` }));
      }
    } catch (err) {
      clear(body);
      body.appendChild(el('div', { className: 'empty-hint', text: err.message }));
    }
  }

  function renderHistoryTab() {
    const d = state.data;
    if (!d) return;

    const items = state.historyItems || d.sessions || [];
    const hList = $('historyList');
    clear(hList);
    if (!items.length) {
      hList.appendChild(el('div', { className: 'empty-hint', text: '没有匹配的本地会话' }));
    } else {
      for (const s of items) {
        const row = el(
          'div',
          {
            className: 'hist-row',
            onClick: () => jumpToConversation(s.conversationId),
          },
          [
            el('div', { className: 'row-main' }, [
              el('div', { className: 'row-text' }, [
                el('div', { className: 'row-title', text: s.title }),
                el('div', {
                  className: 'row-sub',
                  text: s.hitSnippet
                    ? `命中 #${s.hitTurn}: ${s.hitSnippet}`
                    : `${s.turnCount} 轮 · ${formatK(s.context?.usedTokens || 0)} tok · ${formatRelTime(s.updatedAt)}`,
                }),
              ]),
            ]),
            el('div', { className: 'row-ops' }, [
              s.isScratch ? el('span', { className: 'badge scratch', text: 'Scratch' }) : null,
              el('button', {
                className: 'btn btn-xs',
                text: '导出MD',
                onClick: async (e) => {
                  e.stopPropagation();
                  const res = await apiPost('/api/history/export', {
                    conversationId: s.conversationId,
                    format: 'md',
                    reveal: true,
                  });
                  showToast(res.ok ? `已导出并在访达定位` : res.error || '导出失败', !res.ok);
                },
              }),
            ]),
          ],
        );
        hList.appendChild(row);
      }
    }

    // Snapshots
    const sList = $('snapshotsList');
    clear(sList);
    const snaps = d.snapshots || [];
    if (!snaps.length) {
      sList.appendChild(el('div', { className: 'empty-hint', text: '暂无安全快照；勾选分叉快照或点右上角即可创建。' }));
    } else {
      for (const snap of snaps.slice(0, 12)) {
        sList.appendChild(
          el('div', { className: 'snap-row' }, [
            el('div', { className: 'row-main' }, [
              el('div', { className: 'row-text' }, [
                el('div', { className: 'row-title', text: `💾 ${snap.label} (${snap.id})` }),
                el('div', { className: 'row-sub', text: `${snap.branch} · ${snap.dirtyCount} 文件 · ${formatRelTime(snap.createdAt)}` }),
              ]),
            ]),
            el('div', { className: 'row-ops' }, [
              el('button', {
                className: 'btn btn-xs',
                text: 'Diff',
                onClick: async (e) => {
                  e.stopPropagation();
                  const box = $('snapshotDiffBox');
                  box.classList.remove('hidden');
                  box.textContent = '加载快照差异中…';
                  const res = await apiGet(`/api/snapshot/diff?id=${encodeURIComponent(snap.id)}`);
                  if (!res.ok) {
                    box.textContent = res.error || '加载失败';
                    return;
                  }
                  box.textContent = `${res.stat || '(无变更)'}\n\n${res.diff || ''}`;
                },
              }),
            ]),
          ]),
        );
      }
    }

    // Worktrees
    const wList = $('worktreesList');
    clear(wList);
    const wts = (d.workspace?.worktrees || []).filter((w) => !w.isMain);
    if (!wts.length) {
      wList.appendChild(el('div', { className: 'empty-hint', text: '当前仓库暂无独立 Fork Worktree' }));
    } else {
      for (const wt of wts) {
        wList.appendChild(
          el('div', { className: 'snap-row' }, [
            el('div', { className: 'row-main' }, [
              el('div', { className: 'row-text' }, [
                el('div', { className: 'row-title', text: `🌳 ${wt.branch || 'detached'}` }),
                el('div', { className: 'row-sub', text: wt.path }),
              ]),
            ]),
            el('div', { className: 'row-ops' }, [
              el('button', {
                className: 'btn btn-xs',
                text: '访达',
                onClick: async () => {
                  await apiPost('/api/explorer/reveal', { path: wt.path });
                },
              }),
              el('button', {
                className: 'btn btn-xs',
                text: '清理',
                onClick: async () => {
                  const res = await apiPost('/api/worktree/remove', {
                    repoRoot: d.workspace?.git?.repoRoot,
                    worktreePath: wt.path,
                  });
                  showToast(res.ok ? '已清理 Worktree' : res.error || '清理失败', !res.ok);
                  await refreshAll();
                },
              }),
            ]),
          ]),
        );
      }
    }
  }

  async function refreshTree() {
    const root = state.workspaceRoot || state.data?.workspace?.root || '';
    if (!root) return;
    const q = new URLSearchParams({
      root,
      relDir: state.relDir,
      showHidden: String(state.showHidden),
      filter: state.fileFilter,
    });
    state.tree = await apiGet(`/api/tree?${q}`);
    renderExplorerTab();
  }

  async function refreshAll() {
    try {
      const q = new URLSearchParams();
      const targetConv = getTargetConvId();
      if (targetConv) q.set('conversationId', targetConv);
      if (state.workspaceRoot) q.set('workspaceRoot', state.workspaceRoot);

      state.data = await apiGet(`/api/state?${q}`);
      if (!state.workspaceRoot && state.data?.workspace?.root) {
        state.workspaceRoot = state.data.workspace.root;
      }
      renderTopHeader();
      renderContextBar();
      renderRelayBanner();
      renderForkTab();
      renderExplorerTab();
      renderHistoryTab();
      if (state.activeTab === 'explorer' || !state.tree) {
        await refreshTree();
      }
    } catch (err) {
      showToast(`同步状态失败: ${err.message}`, true);
    }
  }

  function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.tab').forEach((btn) => {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
    });
    ['fork', 'explorer', 'history'].forEach((t) => {
      $(`panel-${t}`).classList.toggle('hidden', t !== tab);
    });
    if (tab === 'explorer') void refreshTree();
  }

  function bindEvents() {
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    $('sessionSelect').addEventListener('change', (e) => {
      state.pinnedConvId = e.target.value;
      state.selectedTurn = 0;
      void refreshAll();
    });

    $('cdpPill').addEventListener('click', () => {
      state.cdpOpen = !state.cdpOpen;
      state.settingsOpen = false;
      renderCdpDrawer();
      renderSettingsDrawer();
    });

    $('settingsBtn').addEventListener('click', () => {
      state.settingsOpen = !state.settingsOpen;
      state.cdpOpen = false;
      renderSettingsDrawer();
      renderCdpDrawer();
    });

    $('refreshBtn').addEventListener('click', () => void refreshAll());
    $('themeBtn').addEventListener('click', () => document.body.classList.toggle('light'));

    $('rescueForkBtn').addEventListener('click', () => {
      switchTab('fork');
      void runForkAction({ overrideMode: 'handoff', overrideLabel: 'clean-handoff' });
    });

    document.querySelectorAll('#forkModeGroup .mode-pill').forEach((p) => {
      p.addEventListener('click', () => {
        state.forkMode = p.dataset.mode;
        document.querySelectorAll('#forkModeGroup .mode-pill').forEach((o) => o.classList.toggle('active', o === p));
      });
    });

    $('optWorktree').addEventListener('change', (e) => { e.target.dataset.touched = '1'; });
    $('optSnapshot').addEventListener('change', (e) => { e.target.dataset.touched = '1'; });
    $('execForkBtn').addEventListener('click', () => void runForkAction());

    // Explorer events
    $('workspaceSelect').addEventListener('change', (e) => {
      state.workspaceRoot = e.target.value;
      state.relDir = '';
      void refreshTree();
    });
    $('favRootBtn').addEventListener('click', async () => {
      const root = state.workspaceRoot || state.data?.workspace?.root;
      if (!root) return;
      const res = await apiPost('/api/explorer/favorite', { path: root });
      showToast(res.added ? '已收藏当前目录' : '已取消收藏');
      await refreshAll();
    });
    $('openRootFinderBtn').addEventListener('click', async () => {
      const root = state.workspaceRoot || state.data?.workspace?.root;
      if (!root) return;
      await apiPost('/api/explorer/reveal', { path: root });
      showToast('已在系统资源管理器打开工作区');
    });
    $('openRootIdeBtn').addEventListener('click', async () => {
      const root = state.workspaceRoot || state.data?.workspace?.root;
      const editor = (state.data?.externalApps || []).find((a) => a.kind === 'editor');
      if (!editor) {
        showToast('未检测到已安装的外部 IDE（VS Code / Cursor / Zed）', true);
        return;
      }
      await apiPost('/api/explorer/open-app', { appId: editor.id, path: root });
      showToast(`已在 ${editor.label} 中打开`);
    });
    $('openRootTermBtn').addEventListener('click', async () => {
      const root = state.workspaceRoot || state.data?.workspace?.root;
      const term = (state.data?.externalApps || []).find((a) => a.kind === 'terminal');
      if (!term) {
        showToast('未检测到外部终端应用', true);
        return;
      }
      await apiPost('/api/explorer/open-app', { appId: term.id, path: root });
      showToast(`已在 ${term.label} 中打开`);
    });
    $('toggleHiddenBtn').addEventListener('click', () => {
      state.showHidden = !state.showHidden;
      void refreshTree();
    });

    let filterTimer = 0;
    $('fileFilterInput').addEventListener('input', (e) => {
      state.fileFilter = e.target.value;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => void refreshTree(), 180);
    });

    $('openBrainFinderBtn').addEventListener('click', async () => {
      const dir = state.data?.conversation?.convDir;
      if (!dir) return;
      await apiPost('/api/explorer/reveal', { path: dir });
      showToast('已直达当前会话 Artifacts 隐藏目录');
    });

    $('previewFinderBtn').addEventListener('click', async () => {
      if (state.previewPath) await apiPost('/api/explorer/reveal', { path: state.previewPath });
    });
    $('previewDefaultBtn').addEventListener('click', async () => {
      if (state.previewPath) await apiPost('/api/explorer/open-default', { path: state.previewPath });
    });
    $('previewCloseBtn').addEventListener('click', () => $('previewCard').classList.add('hidden'));

    // History & Snapshot events
    const doSearch = async () => {
      const q = $('historySearchInput').value.trim();
      const res = await apiGet(`/api/history/search?q=${encodeURIComponent(q)}`);
      state.historyItems = res.items || [];
      renderHistoryTab();
    };
    $('historySearchBtn').addEventListener('click', () => void doSearch());
    $('historySearchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void doSearch();
    });

    $('exportActiveMdBtn').addEventListener('click', async () => {
      const res = await apiPost('/api/history/export', { conversationId: getTargetConvId(), format: 'md', reveal: true });
      showToast(res.ok ? `已导出 Markdown (${res.turnCount} 轮)` : res.error || '导出失败', !res.ok);
    });
    $('exportActiveJsonBtn').addEventListener('click', async () => {
      const res = await apiPost('/api/history/export', { conversationId: getTargetConvId(), format: 'json', reveal: true });
      showToast(res.ok ? `已导出 JSON (${res.turnCount} 轮)` : res.error || '导出失败', !res.ok);
    });
    $('createSnapBtn').addEventListener('click', async () => {
      const res = await apiPost('/api/snapshot/create', {
        conversationId: getTargetConvId(),
        workspaceRoot: state.workspaceRoot || state.data?.workspace?.root,
      });
      showToast(res.ok ? `已保存快照 ${res.snapshot.id}` : res.error || '快照失败', !res.ok);
      await refreshAll();
    });
  }

  if (params.get('theme') === 'light' || window.sidecar?.theme === 'light') {
    document.body.classList.add('light');
  }
  if (params.get('tab') && ['fork', 'explorer', 'history'].includes(params.get('tab'))) {
    state.activeTab = params.get('tab');
  }

  bindEvents();
  switchTab(state.activeTab);
  if (typeof window.sidecar?.onWorkspaceChange === 'function') {
    window.sidecar.onWorkspaceChange((uris) => {
      const first = Array.isArray(uris) && uris[0] ? String(uris[0]) : '';
      if (first && first.startsWith('file://')) {
        try {
          const decoded = decodeURIComponent(new URL(first).pathname);
          if (decoded && decoded !== state.workspaceRoot) {
            state.workspaceRoot = decoded;
            state.relDir = '';
            void refreshTree();
          }
        } catch {}
      }
    });
  }
  void refreshAll();
  setInterval(() => {
    if (!document.hidden && !state.settingsOpen && !state.cdpOpen) {
      void refreshAll();
    }
  }, 3500);
})();
