import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createForkWorktree, createSafetySnapshot, sanitizeBranchSlug } from './git-ops.mjs';
import {
  ensureDir,
  isValidConversationId,
  readJsonSafe,
  resolvePluginDataDir,
  writeJsonAtomic,
} from './paths.mjs';
import { estimateTokens, parseConversationTranscript, truncateTitle } from './transcript-parser.mjs';

const execFileAsync = promisify(execFile);

export const FORK_MODES = Object.freeze({
  EXACT: 'exact',
  HANDOFF: 'handoff',
  FILES_ONLY: 'files_only',
});

function getGraphPath(pluginDataDir = '') {
  return path.join(resolvePluginDataDir(pluginDataDir), 'fork-graph.json');
}

export function loadForkGraph({ pluginDataDir = '' } = {}) {
  const data = readJsonSafe(getGraphPath(pluginDataDir), { version: 1, nodes: {} });
  if (!data || typeof data !== 'object' || typeof data.nodes !== 'object') {
    return { version: 1, nodes: {} };
  }
  return data;
}

export function saveForkGraph(graph, { pluginDataDir = '' } = {}) {
  return writeJsonAtomic(getGraphPath(pluginDataDir), {
    version: 1,
    updatedAt: new Date().toISOString(),
    nodes: graph?.nodes || {},
  });
}

export function upsertForkNode(node, { pluginDataDir = '' } = {}) {
  if (!node?.conversationId) return null;
  const graph = loadForkGraph({ pluginDataDir });
  const prev = graph.nodes[node.conversationId] || {};
  const merged = {
    ...prev,
    ...node,
    updatedAt: new Date().toISOString(),
    createdAt: prev.createdAt || node.createdAt || new Date().toISOString(),
  };
  graph.nodes[node.conversationId] = merged;
  saveForkGraph(graph, { pluginDataDir });
  return merged;
}

export function updateBranchMeta(conversationId, patch = {}, { pluginDataDir = '' } = {}) {
  const graph = loadForkGraph({ pluginDataDir });
  const existing = graph.nodes[conversationId];
  if (!existing) {
    return upsertForkNode({ conversationId, ...patch }, { pluginDataDir });
  }
  const updated = {
    ...existing,
    ...(patch.branchLabel !== undefined ? { branchLabel: String(patch.branchLabel).trim() || existing.branchLabel } : {}),
    ...(patch.title !== undefined ? { title: String(patch.title).trim() || existing.title } : {}),
    ...(Array.isArray(patch.tags) ? { tags: patch.tags.map(String).filter(Boolean).slice(0, 8) } : {}),
    updatedAt: new Date().toISOString(),
  };
  graph.nodes[conversationId] = updated;
  saveForkGraph(graph, { pluginDataDir });
  return updated;
}

/**
 * Build a visual Git-Graph DAG tree structure for the current conversation family.
 */
export function buildForkTreeView(activeConversationId, { appDataDir = '', pluginDataDir = '' } = {}) {
  const graph = loadForkGraph({ pluginDataDir });
  const nodesMap = { ...graph.nodes };

  // Ensure active conversation is represented even if never forked yet
  if (activeConversationId && isValidConversationId(activeConversationId)) {
    const parsed = parseConversationTranscript(activeConversationId, { appDataDir });
    if (parsed.ok) {
      const existing = nodesMap[activeConversationId];
      nodesMap[activeConversationId] = {
        conversationId: activeConversationId,
        title: existing?.title || parsed.title,
        branchLabel: existing?.branchLabel || 'main',
        parentId: existing?.parentId || null,
        forkedFromTurn: existing?.forkedFromTurn ?? null,
        mode: existing?.mode || 'root',
        workspaceRoot: existing?.workspaceRoot || parsed.workspaceRoot,
        worktreePath: existing?.worktreePath || '',
        worktreeBranch: existing?.worktreeBranch || '',
        snapshotId: existing?.snapshotId || '',
        tags: existing?.tags || [],
        turnCount: parsed.turns.length,
        context: parsed.context,
        updatedAt: existing?.updatedAt || new Date(parsed.updatedAt || Date.now()).toISOString(),
        createdAt: existing?.createdAt || new Date(parsed.updatedAt || Date.now()).toISOString(),
      };
    }
  }

  // Find root ancestor of activeConversationId to show the complete family tree
  const allNodes = Object.values(nodesMap);
  const findRoot = (id) => {
    let cur = id;
    const seen = new Set();
    while (cur && nodesMap[cur]?.parentId && !seen.has(cur)) {
      seen.add(cur);
      cur = nodesMap[cur].parentId;
    }
    return cur;
  };

  const activeRoot = activeConversationId ? findRoot(activeConversationId) : '';
  const family = activeRoot
    ? allNodes.filter((n) => findRoot(n.conversationId) === activeRoot)
    : allNodes;

  // Assign lanes (color columns) via DFS for crisp Git-Graph rendering
  const childrenByParent = new Map();
  for (const n of family) {
    const p = n.parentId || '__ROOT__';
    if (!childrenByParent.has(p)) childrenByParent.set(p, []);
    childrenByParent.get(p).push(n);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }

  const ordered = [];
  let nextLane = 1;
  const walk = (node, lane, depth) => {
    ordered.push({
      ...node,
      lane,
      depth,
      isActive: node.conversationId === activeConversationId,
    });
    const kids = childrenByParent.get(node.conversationId) || [];
    kids.forEach((child, idx) => {
      const childLane = idx === 0 && depth > 0 ? lane : nextLane++;
      walk(child, childLane, depth + 1);
    });
  };

  const roots = family.filter((n) => !n.parentId || !nodesMap[n.parentId]);
  roots.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  for (const r of roots) {
    walk(r, 0, 0);
  }

  return {
    rootId: activeRoot || roots[0]?.conversationId || '',
    totalBranches: family.length,
    allTrackedCount: allNodes.length,
    nodes: ordered,
  };
}

function pickRelevantFiles(slicedTurns, workspaceRoot = '') {
  const normWs = workspaceRoot ? path.resolve(workspaceRoot) : '';
  const isNoise = (p) =>
    !p ||
    p.includes('/.gemini/antigravity/brain/') ||
    p.includes('\\.gemini\\antigravity\\brain\\') ||
    p.includes('/builtin/skills/');

  const toRelOrShort = (p) => {
    if (normWs) {
      const abs = path.resolve(p);
      if (abs.startsWith(normWs + path.sep)) {
        return abs.slice(normWs.length + 1).split(path.sep).join('/');
      }
    }
    return p;
  };

  // Prefer actual modified (write/edit) files over read-only noise
  const modified = new Set();
  for (const t of slicedTurns) {
    for (const f of t.modifiedFiles || []) {
      if (!isNoise(f)) modified.add(toRelOrShort(f));
    }
  }
  if (modified.size > 0) {
    return Array.from(modified).slice(-10);
  }

  // Fallback to workspace touched files only if no writes occurred
  const touched = new Set();
  for (const t of slicedTurns) {
    for (const f of t.touchedFiles || []) {
      if (!isNoise(f)) touched.add(toRelOrShort(f));
    }
  }
  return Array.from(touched).slice(-6);
}

/**
 * Construct a denoised local Fork Seed File + ultra-lean initial prompt (zero-tool bootstrap).
 */
export function buildForkPromptAndSeed(
  parsed,
  {
    upToTurn = 0,
    mode = FORK_MODES.EXACT,
    branchLabel = '',
    nextInstruction = '',
    zeroTokenLazy = false,
    worktreePath = '',
    worktreeBranch = '',
    snapshotId = '',
    pluginDataDir = '',
  } = {},
) {
  const maxTurn =
    Number.isInteger(upToTurn) && upToTurn > 0 && upToTurn <= parsed.turns.length
      ? upToTurn
      : parsed.turns.length;
  const slicedTurns = parsed.turns.slice(0, maxTurn);
  const label = branchLabel || `${mode}-t${maxTurn}`;
  const effectiveWs = worktreePath || parsed.workspaceRoot || '';
  const keyFiles = pickRelevantFiles(slicedTurns, parsed.workspaceRoot || '');

  // Persist denoised historical slice on disk (0 token cost unless user asks AI to read it later)
  const seedsDir = ensureDir(path.join(resolvePluginDataDir(pluginDataDir), 'seeds'));
  const seedFileName = `fork-${parsed.conversationId.slice(0, 8)}-t${maxTurn}-${Date.now().toString(36)}.md`;
  const seedFilePath = path.join(seedsDir, seedFileName);

  const seedLines = [
    `# Fork Context Seed · ${label}`,
    '',
    `- Parent: \`${parsed.conversationId}\` (${parsed.title})`,
    `- Fork Point: Turn #${maxTurn} / ${parsed.turns.length} (${mode})`,
    `- Workspace: \`${effectiveWs || '(未指定)'}\``,
    ...(worktreeBranch ? [`- Git Worktree Branch: \`${worktreeBranch}\``] : []),
    ...(snapshotId ? [`- Pre-Fork Snapshot: \`${snapshotId}\``] : []),
    '',
  ];

  if (keyFiles.length) {
    seedLines.push('## 修改/关键文件', '', ...keyFiles.map((f) => `- \`${f}\``), '');
  }

  seedLines.push('## 分叉点历史轮次（已去噪）', '');
  for (const t of slicedTurns) {
    seedLines.push(`### Turn #${t.turnIndex}`);
    seedLines.push(`- User: ${truncateTitle(t.userText, 320)}`);
    const replyLimit = mode === FORK_MODES.EXACT ? 900 : 320;
    const reply = (t.assistantText || '(工具执行轮)').replace(/\n{3,}/g, '\n\n').slice(0, replyLimit);
    seedLines.push(`- Assistant: ${reply}${t.assistantText.length > replyLimit ? '…' : ''}`, '');
  }
  fs.writeFileSync(seedFilePath, `${seedLines.join('\n')}\n`, 'utf8');

  // Build ultra-lean prompt (~350-650 chars) so Turn 1 never bloats every subsequent turn
  const shortParent = parsed.conversationId.slice(0, 8);
  const promptLines = [
    `[AGY Fork · ${label} ← ${shortParent}#${maxTurn}] 主题：${parsed.title}`,
  ];
  if (worktreePath) {
    promptLines.push(`工作区（隔离 Git Worktree，分支 ${worktreeBranch}）：${worktreePath}`);
  } else if (effectiveWs) {
    promptLines.push(`工作区：${effectiveWs}`);
  }

  if (mode === FORK_MODES.FILES_ONLY) {
    if (keyFiles.length) promptLines.push(`改动文件：${keyFiles.join(', ')}`);
  } else {
    const windowSize = mode === FORK_MODES.HANDOFF ? 3 : 2;
    const recent = slicedTurns.slice(-windowSize);
    if (recent.length) {
      promptLines.push('近期脉络：');
      for (const t of recent) {
        const u = truncateTitle(t.userText, 72);
        const a = truncateTitle(t.assistantText || '完成操作', 110);
        promptLines.push(`- #${t.turnIndex} ${u} → ${a}`);
      }
    }
    if (keyFiles.length) {
      promptLines.push(`改动文件：${keyFiles.join(', ')}`);
    }
  }

  promptLines.push(`历史切片（仅当我问及细节时按需读，平时勿读）：${seedFilePath}`);

  if (zeroTokenLazy) {
    promptLines.push('', '---', '');
  } else if (nextInstruction && nextInstruction.trim()) {
    promptLines.push('', `本分支指令：${nextInstruction.trim()}`);
  } else {
    // Hard zero-tool bootstrap constraint: prevents wasteful read_file/run_command loops on Turn 1!
    promptLines.push(
      `【规则】仅作上下文初始化：严禁调用任何工具（禁止 read_file/run_command/search），严禁复述，仅回复「✅ 已接手分支 ${label}」。`,
    );
  }

  const prompt = promptLines.join('\n');
  return {
    label,
    maxTurn,
    seedFilePath,
    touchedFiles: keyFiles,
    prompt,
    promptEstTokens: estimateTokens(prompt),
  };
}

/**
 * Attempt to spawn a new conversation via official `agentapi new-conversation` when available.
 */
async function launchViaAgentApi(prompt) {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const cmd = exe || 'agentapi';
  const args = exe ? ['agentapi', 'new-conversation', prompt] : ['new-conversation', prompt];
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: 'utf8',
      timeout: 12_000,
    });
    const text = String(stdout || '').trim();
    let newId = '';
    try {
      const parsed = JSON.parse(text);
      newId =
        parsed.conversationId ||
        parsed.conversation_id ||
        parsed.id ||
        parsed.cascadeId ||
        '';
    } catch {
      const match = text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (match) newId = match[1];
    }
    if (newId) {
      return { launched: true, channel: 'agentapi', conversationId: newId };
    }
    return { launched: true, channel: 'agentapi', conversationId: '', rawOutput: text.slice(0, 200) };
  } catch (err) {
    return { launched: false, error: err?.message || String(err) };
  }
}

export function extractConversationIdDeep(obj, depth = 0) {
  if (!obj || depth > 5) return '';
  if (typeof obj === 'string') {
    const m = obj.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? m[1] : '';
  }
  if (typeof obj !== 'object') return '';
  for (const key of ['conversationId', 'conversation_id', 'newConversationId', 'new_conversation_id', 'cascadeId', 'cascade_id', 'newCascadeId', 'id']) {
    if (typeof obj[key] === 'string' && isValidConversationId(obj[key])) {
      return obj[key].trim();
    }
  }
  for (const val of Object.values(obj)) {
    const found = extractConversationIdDeep(val, depth + 1);
    if (found) return found;
  }
  return '';
}

function nextAutoBranchLabel(parentId, { mode, upToTurn, totalTurns, pluginDataDir = '' }) {
  const graph = loadForkGraph({ pluginDataDir });
  const siblings = Object.values(graph.nodes || {}).filter((n) => n.parentId === parentId);
  const idx = siblings.length + 1;
  if (mode === FORK_MODES.HANDOFF) return `handoff-${idx}`;
  if (mode === FORK_MODES.FILES_ONLY) return `clean-${idx}`;
  if (upToTurn > 0 && totalTurns > 0 && upToTurn < totalTurns) {
    return `fork-t${upToTurn}-${idx}`;
  }
  return `fork-${idx}`;
}

/**
 * Execute a full Fork operation: snapshot + optional Git Worktree + seed pack + new conversation + DAG persistence.
 */
export async function executeFork({
  conversationId,
  upToTurn = 0,
  mode = FORK_MODES.EXACT,
  autoSmartHandoff = false,
  zeroTokenLazy = false,
  branchLabel = '',
  nextInstruction = '',
  workspaceRoot = '',
  createWorktree = false,
  createSnapshot = false,
  appDataDir = '',
  pluginDataDir = '',
  customLauncher = null,
  resolveProjectId = null,
} = {}) {
  if (!isValidConversationId(conversationId)) {
    return { ok: false, error: '请提供有效的源会话 ID' };
  }

  const parsed = parseConversationTranscript(conversationId, { appDataDir, preferFull: true });
  if (!parsed.ok || !parsed.exists) {
    return { ok: false, error: '未在本地找到源会话记录（transcript.jsonl）' };
  }

  // Smart anti-amnesia auto-switch: if context is critically full (>=82%) during silent fork,
  // use Amp-style Smart Handoff so the forked branch starts fresh without hitting 256K compaction immediately.
  const effectiveMode =
    autoSmartHandoff && mode === FORK_MODES.EXACT && (parsed.context?.percent || 0) >= 82
      ? FORK_MODES.HANDOFF
      : mode;

  const effectiveTurn =
    Number.isInteger(upToTurn) && upToTurn > 0 && upToTurn <= parsed.turns.length
      ? upToTurn
      : parsed.turns.length;

  const resolvedLabel =
    String(branchLabel || '').trim() ||
    nextAutoBranchLabel(conversationId, {
      mode: effectiveMode,
      upToTurn: effectiveTurn,
      totalTurns: parsed.turns.length,
      pluginDataDir,
    });

  const effectiveWorkspace = workspaceRoot || parsed.workspaceRoot || '';
  const warnings = [];
  let snapshot = null;
  let worktree = null;

  // 1. Optional pre-fork non-destructive Git safety snapshot
  if (createSnapshot && effectiveWorkspace) {
    const snapRes = await createSafetySnapshot(effectiveWorkspace, {
      label: `pre-fork-${sanitizeBranchSlug(resolvedLabel)}`,
      conversationId,
      pluginDataDir,
    });
    if (snapRes.ok) {
      snapshot = snapRes.snapshot;
    } else {
      warnings.push(snapRes.error);
    }
  }

  // 2. Optional Git Worktree isolation (Claude Code / Codex style)
  if (createWorktree && effectiveWorkspace) {
    const wtRes = await createForkWorktree(effectiveWorkspace, {
      branchSlug: resolvedLabel,
    });
    if (wtRes.ok) {
      worktree = wtRes;
    } else {
      warnings.push(wtRes.error);
    }
  }

  // 3. Build seed pack & ultra-lean prompt
  const seed = buildForkPromptAndSeed(parsed, {
    upToTurn: effectiveTurn,
    mode: effectiveMode,
    branchLabel: resolvedLabel,
    nextInstruction,
    zeroTokenLazy,
    worktreePath: worktree?.worktreePath || '',
    worktreeBranch: worktree?.branchName || '',
    snapshotId: snapshot?.id || '',
    pluginDataDir,
  });

  // Ensure parent node is registered in DAG
  upsertForkNode(
    {
      conversationId,
      title: parsed.title,
      branchLabel: 'main',
      workspaceRoot: effectiveWorkspace,
      turnCount: parsed.turns.length,
    },
    { pluginDataDir },
  );

  // 4. Zero-Token Lazy Fork short-circuit (0 LLM requests, 0 tokens burned!)
  if (zeroTokenLazy) {
    const resolvedProjectId =
      typeof resolveProjectId === 'function' ? await resolveProjectId(conversationId).catch(() => '') : '';
    const lazyId = `lazy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const lazyNode = upsertForkNode(
      {
        conversationId: lazyId,
        isPendingLaunch: true,
        title: `[${seed.label}] ${parsed.title}`,
        branchLabel: seed.label,
        parentId: conversationId,
        forkedFromTurn: seed.maxTurn,
        forkedFromStep: parsed.turns[seed.maxTurn - 1]?.stepEnd ?? -1,
        mode: effectiveMode,
        workspaceRoot: effectiveWorkspace,
        worktreePath: worktree?.worktreePath || '',
        worktreeBranch: worktree?.branchName || '',
        snapshotId: snapshot?.id || '',
        seedFilePath: seed.seedFilePath,
        tags: ['lazy-0tok', effectiveMode, ...(worktree ? ['worktree'] : []), ...(snapshot ? ['snapshot'] : [])],
      },
      { pluginDataDir },
    );

    return {
      ok: true,
      lazy: true,
      launched: false,
      channel: 'zero_token_lazy',
      projectId: resolvedProjectId || '',
      parentConversationId: conversationId,
      newConversationId: lazyId,
      isPendingLaunch: true,
      forkedFromTurn: seed.maxTurn,
      mode: effectiveMode,
      branchLabel: seed.label,
      seedFilePath: seed.seedFilePath,
      prompt: seed.prompt,
      prefillPrompt: seed.prompt,
      promptEstTokens: seed.promptEstTokens,
      worktree,
      snapshot,
      node: lazyNode,
      warnings,
    };
  }

  // 5. Spawn new Antigravity conversation (1-turn Flash, zero-tool ack)
  let launchResult = { launched: false, channel: 'seed_only', conversationId: '' };
  if (typeof customLauncher === 'function') {
    try {
      launchResult = await customLauncher(seed.prompt, {
        parentId: conversationId,
        workspaceRoot: worktree?.worktreePath || effectiveWorkspace,
        branchLabel: seed.label,
        title: `[${seed.label}] ${parsed.title}`,
      });
    } catch (err) {
      warnings.push(`会话启动器返回异常: ${err?.message || err}`);
    }
  } else {
    const apiRes = await launchViaAgentApi(seed.prompt);
    if (apiRes.launched) {
      launchResult = apiRes;
    } else {
      warnings.push('当前环境未检测到 agentapi，已生成分叉上下文包。');
    }
  }

  const launchedId = extractConversationIdDeep(launchResult);
  const childConvId =
    launchedId ||
    `fork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const childNode = upsertForkNode(
    {
      conversationId: childConvId,
      isPendingLaunch: !launchedId,
      title: `[${seed.label}] ${parsed.title}`,
      branchLabel: seed.label,
      parentId: conversationId,
      forkedFromTurn: seed.maxTurn,
      forkedFromStep: parsed.turns[seed.maxTurn - 1]?.stepEnd ?? -1,
      mode: effectiveMode,
      workspaceRoot: effectiveWorkspace,
      worktreePath: worktree?.worktreePath || '',
      worktreeBranch: worktree?.branchName || '',
      snapshotId: snapshot?.id || '',
      seedFilePath: seed.seedFilePath,
      tags: [effectiveMode, ...(worktree ? ['worktree'] : []), ...(snapshot ? ['snapshot'] : [])],
    },
    { pluginDataDir },
  );

  return {
    ok: true,
    launched: Boolean(launchResult?.launched && launchedId),
    channel: launchResult?.channel || 'seed_only',
    projectId: launchResult?.projectId || '',
    parentConversationId: conversationId,
    newConversationId: childConvId,
    isPendingLaunch: !launchedId,
    forkedFromTurn: seed.maxTurn,
    mode: effectiveMode,
    branchLabel: seed.label,
    seedFilePath: seed.seedFilePath,
    prompt: seed.prompt,
    promptEstTokens: seed.promptEstTokens,
    worktree,
    snapshot,
    node: childNode,
    warnings,
  };
}
