import fs from 'node:fs';
import path from 'node:path';
import { FORK_MODES, loadForkGraph } from './fork-engine.mjs';
import {
  ensureDir,
  isValidConversationId,
  readJsonSafe,
  resolveAppDataDir,
  resolvePluginDataDir,
  writeJsonAtomic,
} from './paths.mjs';
import {
  DEFAULT_COMPACTION_LIMIT,
  parseConversationTranscript,
  readLiveContextMetrics,
  truncateTitle,
} from './transcript-parser.mjs';

export const CONFIRM_MODES = Object.freeze({
  COUNTDOWN: 'countdown',
  SILENT: 'silent',
});

export const DEFAULT_PLUGIN_SETTINGS = Object.freeze({
  compactionLimit: DEFAULT_COMPACTION_LIMIT,
  defaultForkMode: FORK_MODES.EXACT,
  autoSnapshot: true,
  defaultWorktree: false,
  zeroTokenLazy: false,
  showHidden: false,
  cdpEnabled: true,
  // Scheme B + C Hybrid Auto-Relay settings
  autoRelayEnabled: true,
  autoRelaySoftPercent: 75,
  autoRelayHardPercent: 90,
  autoRelayConfirmMode: CONFIRM_MODES.COUNTDOWN,
  autoRelayCountdownSec: 5,
  autoRelayModel: 'pro',
  autoRelayMaxChain: 3,
});

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizePluginSettings(raw = {}) {
  const base = { ...DEFAULT_PLUGIN_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const soft = clampInt(base.autoRelaySoftPercent, 55, 90, DEFAULT_PLUGIN_SETTINGS.autoRelaySoftPercent);
  const hard = Math.max(
    soft + 5,
    clampInt(base.autoRelayHardPercent, 65, 98, DEFAULT_PLUGIN_SETTINGS.autoRelayHardPercent),
  );
  return {
    compactionLimit: clampInt(base.compactionLimit, 32_000, 2_000_000, DEFAULT_COMPACTION_LIMIT),
    defaultForkMode: Object.values(FORK_MODES).includes(base.defaultForkMode)
      ? base.defaultForkMode
      : FORK_MODES.EXACT,
    autoSnapshot: Boolean(base.autoSnapshot),
    defaultWorktree: Boolean(base.defaultWorktree),
    zeroTokenLazy: Boolean(base.zeroTokenLazy),
    showHidden: Boolean(base.showHidden),
    cdpEnabled: Boolean(base.cdpEnabled),
    autoRelayEnabled: Boolean(base.autoRelayEnabled),
    autoRelaySoftPercent: soft,
    autoRelayHardPercent: Math.min(98, hard),
    autoRelayConfirmMode:
      base.autoRelayConfirmMode === CONFIRM_MODES.SILENT ? CONFIRM_MODES.SILENT : CONFIRM_MODES.COUNTDOWN,
    autoRelayCountdownSec: clampInt(base.autoRelayCountdownSec, 3, 15, DEFAULT_PLUGIN_SETTINGS.autoRelayCountdownSec),
    autoRelayModel: base.autoRelayModel === 'flash' ? 'flash' : 'pro',
    autoRelayMaxChain: clampInt(base.autoRelayMaxChain, 1, 10, DEFAULT_PLUGIN_SETTINGS.autoRelayMaxChain),
  };
}

export function loadPluginSettings(pluginDataDir = '') {
  const file = path.join(resolvePluginDataDir(pluginDataDir), 'settings.json');
  return normalizePluginSettings(readJsonSafe(file, {}) || {});
}

export function savePluginSettings(patch = {}, pluginDataDir = '') {
  const current = loadPluginSettings(pluginDataDir);
  const merged = normalizePluginSettings({
    ...current,
    ...(patch && typeof patch === 'object' ? patch : {}),
  });
  writeJsonAtomic(path.join(resolvePluginDataDir(pluginDataDir), 'settings.json'), merged);
  return merged;
}

function getRelayStatePath(pluginDataDir = '') {
  return path.join(resolvePluginDataDir(pluginDataDir), 'relay-state.json');
}

export function getHandoffFilePath(conversationId, pluginDataDir = '') {
  const dir = ensureDir(path.join(resolvePluginDataDir(pluginDataDir), 'handoffs'));
  return path.join(dir, `${conversationId}.md`);
}

export function loadRelayState(pluginDataDir = '') {
  const raw = readJsonSafe(getRelayStatePath(pluginDataDir), null);
  if (!raw || typeof raw !== 'object') {
    return { version: 1, conversations: {}, pendingJobs: {} };
  }
  return {
    version: 1,
    conversations: raw.conversations && typeof raw.conversations === 'object' ? raw.conversations : {},
    pendingJobs: raw.pendingJobs && typeof raw.pendingJobs === 'object' ? raw.pendingJobs : {},
  };
}

export function saveRelayState(state, pluginDataDir = '') {
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    conversations: state?.conversations || {},
    pendingJobs: state?.pendingJobs || {},
  };
  writeJsonAtomic(getRelayStatePath(pluginDataDir), next);
  return next;
}

/**
 * Count how many consecutive auto-relay hops this conversation sits behind,
 * preventing infinite self-fork chains.
 */
export function getRelayChainDepth(conversationId, { pluginDataDir = '' } = {}) {
  if (!isValidConversationId(conversationId)) return 0;
  const graph = loadForkGraph({ pluginDataDir });
  const nodes = graph?.nodes || {};
  let depth = 0;
  let cur = conversationId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = nodes[cur];
    if (!node) break;
    const isRelay = Boolean(node.isAutoRelay || (Array.isArray(node.tags) && node.tags.includes('auto-relay')));
    if (isRelay) depth += 1;
    cur = node.parentId || '';
  }
  return depth;
}

function readFreshHandoff(handoffPath, { handledMtimeMs = 0, softPromptedAt = 0 } = {}) {
  try {
    if (!handoffPath || !fs.existsSync(handoffPath)) return null;
    if (!softPromptedAt) return null;
    const st = fs.statSync(handoffPath);
    if (st.mtimeMs <= (Number(handledMtimeMs) || 0)) return null;
    if (st.mtimeMs < Number(softPromptedAt) - 2000) return null;
    const content = fs.readFileSync(handoffPath, 'utf8').trim();
    if (content.length < 20) return null;
    return { content, mtimeMs: st.mtimeMs, path: handoffPath };
  } catch {
    return null;
  }
}

/**
 * Deterministic failsafe handoff generator when hitting 90% redline or MAX_TOKEN_BUDGET_EXCEEDED
 * before the AI had a chance to author its own handoff brief.
 */
export function buildFailsafeHandoff(
  parsed,
  { lastUserInput = '', percent = 90, usedTokens = 0, limitTokens = DEFAULT_COMPACTION_LIMIT } = {},
) {
  const lines = [
    `> 注：上一分支触及 ${percent}%（${Math.round(usedTokens / 1000)}K/${Math.round(limitTokens / 1000)}K）硬红线，由 agyFrok 自动提取现场交接。`,
    '',
    `- **原始任务**：${parsed?.title || truncateTitle(lastUserInput, 80) || '继续当前开发任务'}`,
  ];
  const latestPrompt = truncateTitle(lastUserInput || parsed?.turns?.at(-1)?.userText || '', 200);
  if (latestPrompt) {
    lines.push(`- **最近指令**：${latestPrompt}`);
  }
  if (parsed?.workspaceRoot) {
    lines.push(`- **工作区**：\`${parsed.workspaceRoot}\``);
  }
  const mods = (parsed?.modifiedFiles || []).slice(-10);
  if (mods.length) {
    lines.push(`- **已修改文件**：${mods.map((f) => `\`${f}\``).join(', ')}`);
  }
  const recent = (parsed?.turns || []).slice(-3);
  if (recent.length) {
    lines.push('', '### 最近进展');
    for (const t of recent) {
      const u = truncateTitle(t.userText, 90);
      const a = truncateTitle(t.assistantText || '(工具执行中)', 180);
      lines.push(`- Turn #${t.turnIndex}：${u} → ${a}`);
    }
    const lastThought = recent.at(-1)?.thinkingSnippets?.at(-1);
    if (lastThought) {
      lines.push('', '### 截停前推理脉络', truncateTitle(lastThought, 280));
    }
  }
  return lines.join('\n');
}

function findActiveJobForConversation(state, conversationId) {
  const jobs = Object.values(state.pendingJobs || {});
  return (
    jobs.find(
      (j) =>
        j &&
        j.conversationId === conversationId &&
        ['queued', 'awaiting_confirm', 'launching'].includes(j.status),
    ) || null
  );
}

function enqueueRelayJob(
  state,
  {
    conversationId,
    title,
    reason,
    triggerMode,
    confirmMode,
    countdownSec,
    percent,
    usedTokens,
    limitTokens,
    handoffFile,
    handoffContent,
    lastUserInput,
    workspaceRoot,
    model,
    chainDepth,
    now,
  },
) {
  const existing = findActiveJobForConversation(state, conversationId);
  if (existing) return existing;

  const id = `relay-${conversationId.slice(0, 8)}-${now.toString(36)}`;
  const isSilent = confirmMode === CONFIRM_MODES.SILENT;
  const delayMs = isSilent ? 0 : Math.max(3, Number(countdownSec) || 5) * 1000;
  const job = {
    id,
    conversationId,
    title: truncateTitle(title || lastUserInput || '自动接力任务', 56),
    reason,
    triggerMode,
    confirmMode: isSilent ? CONFIRM_MODES.SILENT : CONFIRM_MODES.COUNTDOWN,
    countdownSec: isSilent ? 0 : Math.max(3, Number(countdownSec) || 5),
    percent,
    usedTokens,
    limitTokens,
    handoffFile,
    handoffPreview: truncateTitle(handoffContent || '', 180),
    lastUserInput: truncateTitle(lastUserInput || '', 260),
    workspaceRoot: workspaceRoot || '',
    model: model || 'pro',
    chainDepth: Number(chainDepth) || 0,
    status: isSilent ? 'queued' : 'awaiting_confirm',
    createdAt: now,
    executeAfter: now + delayMs,
    childConversationId: '',
    branchLabel: '',
    error: '',
  };
  state.pendingJobs[id] = job;
  return job;
}

const SUBAGENT_ROLES = new Set([
  'subagent',
  'swarm',
  'worker',
  'swarm_worker',
  'research',
  'browser',
  'image-generator',
]);

/**
 * Only top-level root user conversations should ever auto-relay.
 * Subagents / swarm workers are silently ignored.
 */
export function isRootConversationHookPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return false;
  const parentId = String(payload.parentConversationId ?? payload.parent_conversation_id ?? '').trim();
  if (parentId) return false;
  const agentName = String(payload.agentName ?? payload.agent_name ?? '').trim();
  if (agentName) return false;
  if (payload.isSubagent === true || payload.is_subagent === true || payload.subagent === true) {
    return false;
  }
  const role = String(payload.role ?? payload.agentRole ?? payload.agent_role ?? '')
    .trim()
    .toLowerCase();
  if (role && SUBAGENT_ROLES.has(role)) return false;
  const lastInput = String(payload.lastUserInput || '');
  if (/<swarm_worker\b/i.test(lastInput)) return false;
  return true;
}

/**
 * Pure, synchronous lifecycle hook evaluator for Antigravity `hooks.json`
 * (`PreInvocation`, `PostInvocation`, `Stop`).
 * Implements Scheme B (75% graceful AI-authored handoff + 90% hard failsafe)
 * fused with Scheme C (configurable 5s countdown capsule vs 0s silent unattended).
 *
 * NOTE: Deliberately omits `systemMessage.metadata` to stay 100% compatible with
 * Antigravity 2.34+ protojson / ScrubInternalFields (which drops responses carrying metadata).
 */
export function evaluateRelayHook(
  eventName,
  payload = {},
  { pluginDataDir = '', appDataDir = '', now = Date.now() } = {},
) {
  if (!isRootConversationHookPayload(payload)) return {};
  const event = String(eventName || payload?.hookEventName || '').trim();
  const convId = String(payload?.conversationId || '').trim();
  if (!isValidConversationId(convId)) return {};

  const resolvedPluginData = resolvePluginDataDir(pluginDataDir);
  const resolvedAppData = resolveAppDataDir(appDataDir);
  const settings = loadPluginSettings(resolvedPluginData);
  if (!settings.autoRelayEnabled) return {};

  const state = loadRelayState(resolvedPluginData);
  const convState = state.conversations[convId] || {};

  // Already relayed or currently active relay job for this conversation
  if (convState.relayedAt) {
    return {};
  }

  const termReason = String(payload?.terminationReason || '').trim();
  const isForcedBudgetStop =
    event === 'Stop' && ['MAX_TOKEN_BUDGET_EXCEEDED', 'MAX_INVOCATIONS', 'MAX_FORCED_INVOCATIONS'].includes(termReason);
  const isNormalCompletionStop =
    event === 'Stop' && ['NO_TOOL_CALL', 'INJECTED_RESPONSE', ''].includes(termReason);

  const activeJob = findActiveJobForConversation(state, convId);
  if (activeJob) {
    // If the user cancelled or the turn actually finished cleanly (NO_TOOL_CALL) while an
    // unlaunched auto hard-failsafe countdown was pending, cancel the stale countdown so we
    // never hijack a finished conversation into a redundant relay.
    const cancelReason =
      event === 'Stop' && termReason === 'USER_CANCELED'
        ? 'user_canceled'
        : event === 'Stop' && isNormalCompletionStop && activeJob.triggerMode === 'hard_failsafe'
          ? 'normal_stop_completed'
          : '';
    if (
      cancelReason &&
      activeJob.reason !== 'manual_relay' &&
      activeJob.status === 'awaiting_confirm'
    ) {
      activeJob.status = 'cancelled';
      activeJob.cancelledAt = now;
      activeJob.cancelledReason = cancelReason;
      saveRelayState(state, resolvedPluginData);
    }
    return {};
  }

  // Respect user cancel on Stop
  if (event === 'Stop' && termReason === 'USER_CANCELED') {
    return {};
  }

  // Locate transcript.jsonl (prefer exact payload.transcriptPath from host)
  const transcriptPath =
    payload?.transcriptPath && fs.existsSync(payload.transcriptPath)
      ? payload.transcriptPath
      : path.join(resolvedAppData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');

  const metrics = readLiveContextMetrics(transcriptPath, { compactionLimit: settings.compactionLimit });
  const percent = metrics.percent || 0;
  const usedTokens = metrics.usedTokens || 0;
  const limitTokens = metrics.limitTokens || settings.compactionLimit;
  const kUsed = Math.round(usedTokens / 1000);
  const kLim = Math.round(limitTokens / 1000);
  const handoffPath = convState.handoffFile || getHandoffFilePath(convId, resolvedPluginData);
  const workspaceRoot =
    (Array.isArray(payload?.workspacePaths) && payload.workspacePaths[0]) || payload?.cwd || '';
  const lastUserInput = String(payload?.lastUserInput || '').trim();

  // Anti-infinite-loop fuse
  const chainDepth = getRelayChainDepth(convId, { pluginDataDir: resolvedPluginData });
  if (chainDepth >= settings.autoRelayMaxChain) {
    if (event === 'PreInvocation' && percent >= settings.autoRelaySoftPercent && !convState.fuseNotifiedAt) {
      state.conversations[convId] = { ...convState, fuseNotifiedAt: now, chainDepth };
      saveRelayState(state, resolvedPluginData);
      return {
        injectSteps: [
          {
            systemMessage: {
              systemMessage: `[AGY Auto-Relay · 防循环熔断] 本任务链已连续自动接力 ${chainDepth}/${settings.autoRelayMaxChain} 次（当前水位 ${percent}% · ${kUsed}K/${kLim}K）。已暂停自动接力以防止死循环；请直接完成当前回复或由用户手动点击顶部 ⚡ 轻装 Fork。`,
            },
          },
        ],
      };
    }
    return {};
  }

  const freshHandoff = readFreshHandoff(handoffPath, {
    handledMtimeMs: convState.handoffHandledMtimeMs || 0,
    softPromptedAt: convState.softPromptedAt || 0,
  });
  const isAtOrAboveHard = percent >= settings.autoRelayHardPercent;
  const hitHardRedline = (event === 'PostInvocation' && isAtOrAboveHard) || isForcedBudgetStop;
  const hitSoftWarning = percent >= settings.autoRelaySoftPercent;

  // ---------------------------------------------------------------------------
  // 1. PreInvocation: Scheme B Soft Warning (75% <= pct < 90%) -> Ask AI to author handoff.md
  // ---------------------------------------------------------------------------
  if (event === 'PreInvocation') {
    if (!hitSoftWarning || isAtOrAboveHard) return {};
    if (freshHandoff) return {};
    if (convState.softPromptedAt) return {};
    if (convState.dismissedUntilPct && percent < convState.dismissedUntilPct) return {};

    state.conversations[convId] = {
      ...convState,
      softPromptedAt: now,
      softPromptPercent: percent,
      handoffFile: handoffPath,
      chainDepth,
    };
    saveRelayState(state, resolvedPluginData);

    const modeHint =
      settings.autoRelayConfirmMode === CONFIRM_MODES.SILENT
        ? '写完后系统将自动静默拉起低水位新分支无缝续跑。'
        : `写完后底部将弹出 ${settings.autoRelayCountdownSec} 秒倒计时确认胶囊，确认或倒计时结束后自动切入低水位新分支续跑。`;

    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage:
              `[AGY Auto-Relay · ${percent}% 上下文预警] 当前上下文已达 ${percent}%（${kUsed}K/${kLim}K）。` +
              `请先完成当前这一个原子步骤，然后立即调用 write_file（Overwrite: true，勿传 ArtifactMetadata）将精炼交接单（≤300字）写入：${handoffPath}\n` +
              `交接单必须包含：1. 原始目标 2. 已完成项 3. 剩余未完成步骤与下一步精确动作 4. 关键决策/踩坑 5. 涉及文件路径。\n` +
              `写完交接单后，直接简短回复「✅ 交接单已就绪，准备自动接力」并停止调用其他工具；${modeHint}`,
          },
        },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // 2. PostInvocation & Stop: Detect fresh AI-authored handoff OR 90% Hard Failsafe
  // ---------------------------------------------------------------------------
  if (event === 'PostInvocation' || event === 'Stop') {
    // Path 2A: High-fidelity AI-authored handoff.md is ready on disk (requires soft warning + >= softPercent)
    if (freshHandoff && hitSoftWarning) {
      const parsed = parseConversationTranscript(convId, { appDataDir: resolvedAppData, compactionLimit: limitTokens });
      const job = enqueueRelayJob(state, {
        conversationId: convId,
        title: parsed?.title || lastUserInput,
        reason: 'handoff_ready',
        triggerMode: 'graceful',
        confirmMode: settings.autoRelayConfirmMode,
        countdownSec: settings.autoRelayCountdownSec,
        percent,
        usedTokens,
        limitTokens,
        handoffFile: handoffPath,
        handoffContent: freshHandoff.content,
        lastUserInput,
        workspaceRoot: workspaceRoot || parsed?.workspaceRoot || '',
        model: settings.autoRelayModel,
        chainDepth,
        now,
      });

      state.conversations[convId] = {
        ...convState,
        handoffFile: handoffPath,
        handoffHandledMtimeMs: freshHandoff.mtimeMs,
        lastJobId: job.id,
        chainDepth,
      };
      saveRelayState(state, resolvedPluginData);

      if (event === 'PostInvocation') {
        const notice =
          job.confirmMode === CONFIRM_MODES.SILENT
            ? `[AGY Auto-Relay · 高保真亲笔交接单] 已落盘交接单（${percent}% · ${kUsed}K/${kLim}K），正在静默拉起低水位新分支无缝续跑，老分支已立即刹车止损。`
            : `[AGY Auto-Relay · 高保真亲笔交接单] 已落盘交接单（${percent}% · ${kUsed}K/${kLim}K），已截停老分支，${job.countdownSec} 秒后自动开启低水位新分支续跑（可在底部胶囊点「立即接力」或「暂不」）。`;
        return {
          injectSteps: [
            {
              systemMessage: {
                systemMessage: notice,
              },
            },
          ],
          terminationBehavior: 'terminate',
        };
      }
      return {};
    }

    // Never re-run a normally completed task on Stop (NO_TOOL_CALL) when no handoff was written
    if (isNormalCompletionStop) {
      return {};
    }

    // Path 2B: 90% Hard Redline Failsafe (mid-task PostInvocation) OR MAX_TOKEN_BUDGET_EXCEEDED / MAX_INVOCATIONS
    if (hitHardRedline) {
      if (convState.dismissedUntilPct && percent < convState.dismissedUntilPct && !isForcedBudgetStop) {
        return {};
      }
      const parsed = parseConversationTranscript(convId, { appDataDir: resolvedAppData, compactionLimit: limitTokens });
      const failsafeText = buildFailsafeHandoff(parsed, {
        lastUserInput,
        percent,
        usedTokens,
        limitTokens,
      });
      ensureDir(path.dirname(handoffPath));
      fs.writeFileSync(handoffPath, `${failsafeText}\n`, 'utf8');
      const mtimeMs = fs.statSync(handoffPath).mtimeMs;

      // If MAX_TOKEN_BUDGET_EXCEEDED already halted the old session, launch immediately
      const effectiveConfirm = isForcedBudgetStop ? CONFIRM_MODES.SILENT : settings.autoRelayConfirmMode;
      const job = enqueueRelayJob(state, {
        conversationId: convId,
        title: parsed?.title || lastUserInput,
        reason: isForcedBudgetStop ? 'token_budget_exceeded' : 'hard_failsafe',
        triggerMode: 'hard_failsafe',
        confirmMode: effectiveConfirm,
        countdownSec: settings.autoRelayCountdownSec,
        percent,
        usedTokens,
        limitTokens,
        handoffFile: handoffPath,
        handoffContent: failsafeText,
        lastUserInput,
        workspaceRoot: workspaceRoot || parsed?.workspaceRoot || '',
        model: settings.autoRelayModel,
        chainDepth,
        now,
      });

      state.conversations[convId] = {
        ...convState,
        handoffFile: handoffPath,
        handoffHandledMtimeMs: mtimeMs,
        lastJobId: job.id,
        chainDepth,
      };
      saveRelayState(state, resolvedPluginData);

      if (event === 'PostInvocation') {
        const notice =
          job.confirmMode === CONFIRM_MODES.SILENT
            ? `[AGY Auto-Relay · ${settings.autoRelayHardPercent}% 硬红线兜底] 当前水位已达 ${percent}%（${kUsed}K/${kLim}K），已自动刹车止损并拉起低水位新分支续跑。`
            : `[AGY Auto-Relay · ${settings.autoRelayHardPercent}% 硬红线兜底] 当前水位已达 ${percent}%（${kUsed}K/${kLim}K），已截停老分支，${job.countdownSec} 秒后自动开新分支续跑（可在底部胶囊点「立即接力」或「暂不」）。`;
        return {
          injectSteps: [
            {
              systemMessage: {
                systemMessage: notice,
              },
            },
          ],
          terminationBehavior: 'terminate',
        };
      }
      return {};
    }
  }

  return {};
}

export function listRelaySnapshot({ pluginDataDir = '', now = Date.now() } = {}) {
  const state = loadRelayState(pluginDataDir);
  const allJobs = Object.values(state.pendingJobs || {}).filter(Boolean);
  allJobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const awaiting = allJobs.find((j) => j.status === 'awaiting_confirm') || null;
  const launching = allJobs.find((j) => j.status === 'queued' || j.status === 'launching') || null;
  const recent = allJobs.slice(0, 6);

  return {
    activeJob: awaiting
      ? {
          ...awaiting,
          remainingMs: Math.max(0, (awaiting.executeAfter || now) - now),
        }
      : launching
        ? { ...launching, remainingMs: 0 }
        : null,
    recentJobs: recent,
  };
}

export function confirmRelayJob(jobId, { pluginDataDir = '', now = Date.now() } = {}) {
  const state = loadRelayState(pluginDataDir);
  const job = state.pendingJobs[jobId];
  if (!job) return { ok: false, error: '未找到对应的接力任务' };
  if (job.status === 'launched') return { ok: true, job, alreadyLaunched: true };
  job.status = 'queued';
  job.executeAfter = now;
  job.confirmedAt = now;
  saveRelayState(state, pluginDataDir);
  return { ok: true, job };
}

export function dismissRelayJob(jobId, { pluginDataDir = '', now = Date.now() } = {}) {
  const state = loadRelayState(pluginDataDir);
  const settings = loadPluginSettings(pluginDataDir);
  const job = state.pendingJobs[jobId];
  if (!job) return { ok: false, error: '未找到对应的接力任务' };
  job.status = 'dismissed';
  job.dismissedAt = now;

  const prev = state.conversations[job.conversationId] || {};
  const isManual = job.reason === 'manual_relay';
  const nextSuppressPct = isManual
    ? prev.dismissedUntilPct || 0
    : job.triggerMode === 'hard_failsafe'
      ? Math.min(99, (job.percent || settings.autoRelayHardPercent) + 6)
      : settings.autoRelayHardPercent;
  if (!isManual) {
    state.conversations[job.conversationId] = {
      ...prev,
      dismissedUntilPct: nextSuppressPct,
    };
  }
  saveRelayState(state, pluginDataDir);
  return { ok: true, job, dismissedUntilPct: nextSuppressPct };
}

export function queueManualRelay(
  conversationId,
  { pluginDataDir = '', appDataDir = '', confirmMode = '', now = Date.now() } = {},
) {
  if (!isValidConversationId(conversationId)) {
    return { ok: false, error: '无效的会话 ID' };
  }
  const resolvedPluginData = resolvePluginDataDir(pluginDataDir);
  const resolvedAppData = resolveAppDataDir(appDataDir);
  const settings = loadPluginSettings(resolvedPluginData);
  const parsed = parseConversationTranscript(conversationId, {
    appDataDir: resolvedAppData,
    compactionLimit: settings.compactionLimit,
  });
  if (!parsed.ok || !parsed.exists) {
    return { ok: false, error: '未在本地找到源会话记录' };
  }

  const handoffPath = getHandoffFilePath(conversationId, resolvedPluginData);
  let handoffContent = '';
  if (fs.existsSync(handoffPath)) {
    try {
      handoffContent = fs.readFileSync(handoffPath, 'utf8').trim();
    } catch {}
  }
  if (!handoffContent) {
    handoffContent = buildFailsafeHandoff(parsed, {
      lastUserInput: parsed.turns.at(-1)?.userText || '',
      percent: parsed.context?.percent || 0,
      usedTokens: parsed.context?.usedTokens || 0,
      limitTokens: parsed.context?.limitTokens || settings.compactionLimit,
    });
    ensureDir(path.dirname(handoffPath));
    fs.writeFileSync(handoffPath, `${handoffContent}\n`, 'utf8');
  }

  const state = loadRelayState(resolvedPluginData);
  const chainDepth = getRelayChainDepth(conversationId, { pluginDataDir: resolvedPluginData });
  const job = enqueueRelayJob(state, {
    conversationId,
    title: parsed.title,
    reason: 'manual_relay',
    triggerMode: 'graceful',
    confirmMode: confirmMode === CONFIRM_MODES.COUNTDOWN ? CONFIRM_MODES.COUNTDOWN : CONFIRM_MODES.SILENT,
    countdownSec: settings.autoRelayCountdownSec,
    percent: parsed.context?.percent || 0,
    usedTokens: parsed.context?.usedTokens || 0,
    limitTokens: parsed.context?.limitTokens || settings.compactionLimit,
    handoffFile: handoffPath,
    handoffContent,
    lastUserInput: parsed.turns.at(-1)?.userText || '',
    workspaceRoot: parsed.workspaceRoot || '',
    model: settings.autoRelayModel,
    chainDepth,
    now,
  });
  saveRelayState(state, resolvedPluginData);
  return { ok: true, job };
}

/**
 * Atomically claim the next relay job ready for execution (queued or countdown expired).
 */
export function claimNextReadyRelayJob({ pluginDataDir = '', now = Date.now() } = {}) {
  const state = loadRelayState(pluginDataDir);
  const jobs = Object.values(state.pendingJobs || {}).filter(Boolean);
  jobs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  for (const job of jobs) {
    // Recover stuck launching state (>60s)
    if (job.status === 'launching' && now - (job.claimedAt || job.createdAt || 0) > 60_000) {
      job.status = 'failed';
      job.error = '接力启动超时';
      saveRelayState(state, pluginDataDir);
      continue;
    }
    const ready =
      job.status === 'queued' ||
      (job.status === 'awaiting_confirm' && now >= (job.executeAfter || 0));
    if (!ready) continue;

    job.status = 'launching';
    job.claimedAt = now;
    saveRelayState(state, pluginDataDir);
    return job;
  }
  return null;
}

export function completeRelayJob(jobId, result = {}, { pluginDataDir = '', now = Date.now() } = {}) {
  const state = loadRelayState(pluginDataDir);
  const job = state.pendingJobs[jobId];
  if (!job) return null;

  if (result?.ok) {
    job.status = 'launched';
    job.launchedAt = now;
    job.childConversationId = result.newConversationId || '';
    job.branchLabel = result.branchLabel || '';
    job.projectId = result.projectId || '';
    job.error = '';

    const prev = state.conversations[job.conversationId] || {};
    state.conversations[job.conversationId] = {
      ...prev,
      ...(job.reason !== 'manual_relay' ? { relayedAt: now } : {}),
      childConversationId: result.newConversationId || '',
      branchLabel: result.branchLabel || '',
    };
  } else {
    job.status = 'failed';
    job.failedAt = now;
    job.error = String(result?.error || '自动接力启动失败');
  }

  // Prune old completed/dismissed jobs beyond latest 24 to keep file tiny
  const entries = Object.entries(state.pendingJobs);
  if (entries.length > 24) {
    entries.sort((a, b) => (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0));
    state.pendingJobs = Object.fromEntries(entries.slice(0, 24));
  }

  saveRelayState(state, pluginDataDir);
  return job;
}
