import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, isValidConversationId, resolveBrainDir, resolvePluginDataDir } from './paths.mjs';

export const DEFAULT_COMPACTION_LIMIT = 256_000;

/**
 * Lightweight deterministic token estimator for mixed CJK / English / code text.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const str = String(text);
  let cjk = 0;
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1;
    }
  }
  const nonCjk = str.length - cjk;
  return Math.ceil(cjk / 1.55 + nonCjk / 3.8);
}

/**
 * Extract clean user prompt text from Antigravity's <USER_REQUEST> wrapper if present.
 */
export function cleanUserContent(raw) {
  const str = String(raw || '').trim();
  if (!str) return '';
  const match = str.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const body = match ? match[1].trim() : str;
  return body
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .trim();
}

export function truncateTitle(text, maxLen = 58) {
  const line = String(text || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line) return '未命名会话';
  return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

export function getTranscriptPaths(conversationId, { appDataDir = '' } = {}) {
  if (!isValidConversationId(conversationId)) return null;
  const convDir = path.join(resolveBrainDir(appDataDir), conversationId);
  const logsDir = path.join(convDir, '.system_generated', 'logs');
  return {
    convDir,
    logsDir,
    compactPath: path.join(logsDir, 'transcript.jsonl'),
    fullPath: path.join(logsDir, 'transcript_full.jsonl'),
  };
}

function unwrapMaybeJsonString(val) {
  let s = String(val || '').trim();
  if (!s) return '';
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      const inner = JSON.parse(s);
      if (typeof inner === 'string') s = inner.trim();
    } catch {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

function extractPathsFromToolCall(tc) {
  const found = [];
  if (!tc || typeof tc !== 'object') return found;
  const args = tc.arguments || tc.args || tc.input || tc.function?.arguments;
  let parsed = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      parsed = null;
    }
  }
  if (parsed && typeof parsed === 'object') {
    for (const key of ['Path', 'path', 'filePath', 'file_path', 'TargetFile', 'DirectoryPath', 'Cwd', 'cwd']) {
      if (typeof parsed[key] === 'string' && parsed[key].trim()) {
        const clean = unwrapMaybeJsonString(parsed[key]);
        if (clean) found.push(clean);
      }
    }
  }
  return found;
}

const WRITE_TOOL_RE = /^(write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|create_file|delete_file|apply_patch|patch_file)$/i;

function normalizeToolCall(tc) {
  if (!tc || typeof tc !== 'object') return null;
  const name = String(tc.name || tc.tool_name || tc.function?.name || 'tool');
  const paths = extractPathsFromToolCall(tc);
  return { name, paths, isWrite: WRITE_TOOL_RE.test(name) };
}

function readJsonlLines(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip partially written line safely
    }
  }
  return entries;
}

function detectWorkspaceFromPaths(filePaths, brainDir) {
  const candidates = [];
  const normBrain = path.resolve(brainDir);
  for (const p of filePaths) {
    if (!p || !path.isAbsolute(p)) continue;
    const norm = path.resolve(p);
    if (norm.startsWith(normBrain)) continue;
    if (norm.includes('/.gemini/') || norm.includes('\\.gemini\\')) continue;
    candidates.push(norm);
  }
  if (!candidates.length) return '';

  // Walk up to find a .git root first
  for (const p of candidates) {
    let cur = p;
    try {
      if (fs.existsSync(cur) && fs.statSync(cur).isFile()) {
        cur = path.dirname(cur);
      }
    } catch {
      cur = path.dirname(cur);
    }
    for (let depth = 0; depth < 8; depth += 1) {
      if (fs.existsSync(path.join(cur, '.git'))) {
        return cur;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  // Fallback to common parent directory of existing candidates
  const existingDirs = candidates
    .map((p) => {
      try {
        if (fs.existsSync(p)) {
          return fs.statSync(p).isDirectory() ? p : path.dirname(p);
        }
      } catch {}
      return path.dirname(p);
    })
    .filter(Boolean);
  return existingDirs[0] || '';
}

function listBrainArtifacts(convDir) {
  if (!convDir || !fs.existsSync(convDir)) return [];
  const items = [];
  let entries = [];
  try {
    entries = fs.readdirSync(convDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.name.endsWith('.metadata.json') || /\.resolved(\.\d+)?$/i.test(ent.name)) continue;
    const fullPath = path.join(convDir, ent.name);
    try {
      const st = fs.statSync(fullPath);
      items.push({
        name: ent.name,
        path: fullPath,
        isDirectory: ent.isDirectory(),
        size: st.size,
        mtimeMs: st.mtimeMs,
        ext: path.extname(ent.name).toLowerCase(),
      });
    } catch {
      // Ignore transient unlink
    }
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items;
}

/**
 * Parse a single conversation's transcript into structured turns, context health metrics,
 * touched files, and artifacts.
 */
export function parseConversationTranscript(
  conversationId,
  { appDataDir = '', preferFull = false, compactionLimit = DEFAULT_COMPACTION_LIMIT } = {},
) {
  const paths = getTranscriptPaths(conversationId, { appDataDir });
  if (!paths) {
    return { ok: false, error: '无效的会话 ID', conversationId };
  }

  const targetFile =
    preferFull && fs.existsSync(paths.fullPath)
      ? paths.fullPath
      : fs.existsSync(paths.compactPath)
        ? paths.compactPath
        : fs.existsSync(paths.fullPath)
          ? paths.fullPath
          : '';

  const artifacts = listBrainArtifacts(paths.convDir);
  if (!targetFile) {
    return {
      ok: true,
      exists: fs.existsSync(paths.convDir),
      conversationId,
      title: artifacts.length ? `产物会话 (${artifacts.length} 份文件)` : '暂无记录',
      transcriptPath: '',
      convDir: paths.convDir,
      turns: [],
      artifacts,
      touchedFiles: [],
      modifiedFiles: [],
      workspaceRoot: '',
      isScratch: true,
      context: {
        usedTokens: 0,
        limitTokens: compactionLimit,
        percent: 0,
        level: 'healthy',
        needsRescue: false,
      },
      updatedAt: artifacts[0]?.mtimeMs || 0,
    };
  }

  const entries = readJsonlLines(targetFile);
  const turns = [];
  const allTouched = new Set();
  const allModified = new Set();
  const brainDir = resolveBrainDir(appDataDir);
  let currentTurn = null;
  let runningTokens = 1800; // Baseline system/tool prompt overhead

  const finalizeTurn = () => {
    if (!currentTurn) return;
    currentTurn.touchedFiles = Array.from(currentTurn._files);
    currentTurn.modifiedFiles = Array.from(currentTurn._modFiles);
    delete currentTurn._files;
    delete currentTurn._modFiles;
    currentTurn.cumulativeTokens = runningTokens;
    turns.push(currentTurn);
    currentTurn = null;
  };

  for (const step of entries) {
    const stepIndex = Number.isInteger(step.step_index) ? step.step_index : turns.length;
    const type = String(step.type || '');
    const source = String(step.source || '');
    const status = String(step.status || 'DONE');
    const content = String(step.content || '');
    const thinking = String(step.thinking || '');
    const createdAt = step.created_at || '';

    if (type === 'USER_INPUT' || source === 'USER_EXPLICIT') {
      finalizeTurn();
      const cleaned = cleanUserContent(content);
      const tok = estimateTokens(cleaned);
      runningTokens += tok;
      currentTurn = {
        turnIndex: turns.length + 1,
        stepStart: stepIndex,
        stepEnd: stepIndex,
        createdAt,
        userText: cleaned,
        userTitle: truncateTitle(cleaned, 54),
        assistantText: '',
        thinkingSnippets: [],
        thinkingChars: 0,
        toolCalls: [],
        _files: new Set(),
        _modFiles: new Set(),
        estTokens: tok,
        cumulativeTokens: runningTokens,
        hasError: status === 'ERROR',
      };
      continue;
    }

    if (!currentTurn) {
      currentTurn = {
        turnIndex: turns.length + 1,
        stepStart: stepIndex,
        stepEnd: stepIndex,
        createdAt,
        userText: '(系统或续接对话)',
        userTitle: '(系统或续接对话)',
        assistantText: '',
        thinkingSnippets: [],
        thinkingChars: 0,
        toolCalls: [],
        _files: new Set(),
        _modFiles: new Set(),
        estTokens: 0,
        cumulativeTokens: runningTokens,
        hasError: false,
      };
    }

    currentTurn.stepEnd = stepIndex;
    if (status === 'ERROR') currentTurn.hasError = true;

    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls.map(normalizeToolCall).filter(Boolean) : [];
    for (const tc of toolCalls) {
      currentTurn.toolCalls.push(tc);
      for (const p of tc.paths) {
        currentTurn._files.add(p);
        allTouched.add(p);
        if (tc.isWrite) {
          currentTurn._modFiles.add(p);
          allModified.add(p);
        }
      }
    }

    if (thinking) {
      currentTurn.thinkingChars += thinking.length;
      if (currentTurn.thinkingSnippets.length < 3) {
        currentTurn.thinkingSnippets.push(thinking.slice(0, 600));
      }
    }

    const stepTokens =
      estimateTokens(content) +
      Math.ceil(estimateTokens(thinking) * 0.25) +
      toolCalls.length * 140;
    currentTurn.estTokens += stepTokens;
    runningTokens += stepTokens;

    if (type === 'PLANNER_RESPONSE' && content.trim()) {
      currentTurn.assistantText = currentTurn.assistantText
        ? `${currentTurn.assistantText}\n\n${content.trim()}`
        : content.trim();
    }
  }
  finalizeTurn();

  const touchedList = Array.from(allTouched);
  const modifiedList = Array.from(allModified);
  const workspaceRoot = detectWorkspaceFromPaths(touchedList, brainDir);
  const stat = fs.statSync(targetFile);
  const pct = Math.min(100, Math.round((runningTokens / compactionLimit) * 100));
  const level = pct >= 82 ? 'critical' : pct >= 65 ? 'warning' : 'healthy';

  return {
    ok: true,
    exists: true,
    conversationId,
    title: turns[0]?.userTitle || '未命名会话',
    transcriptPath: targetFile,
    convDir: paths.convDir,
    turns,
    turnCount: turns.length,
    artifacts,
    touchedFiles: touchedList,
    modifiedFiles: modifiedList,
    workspaceRoot,
    isScratch: !workspaceRoot,
    context: {
      usedTokens: runningTokens,
      limitTokens: compactionLimit,
      percent: pct,
      level,
      needsRescue: pct >= 70,
    },
    updatedAt: stat.mtimeMs,
  };
}

/**
 * Scan all local conversations under ~/.gemini/antigravity/brain/ (including hidden scratch ones).
 */
export function listLocalSessions({ appDataDir = '', limit = 60 } = {}) {
  const brainDir = resolveBrainDir(appDataDir);
  if (!fs.existsSync(brainDir)) return [];

  let dirs = [];
  try {
    dirs = fs.readdirSync(brainDir, { withFileTypes: true }).filter((d) => d.isDirectory() && isValidConversationId(d.name));
  } catch {
    return [];
  }

  const withMtime = dirs.map((d) => {
    const convDir = path.join(brainDir, d.name);
    const compactPath = path.join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
    let mtimeMs = 0;
    try {
      mtimeMs = fs.existsSync(compactPath) ? fs.statSync(compactPath).mtimeMs : fs.statSync(convDir).mtimeMs;
    } catch {}
    return { id: d.name, mtimeMs };
  });

  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const results = [];
  for (const item of withMtime.slice(0, limit)) {
    const parsed = parseConversationTranscript(item.id, { appDataDir });
    if (!parsed.ok) continue;
    results.push({
      conversationId: parsed.conversationId,
      title: parsed.title,
      turnCount: parsed.turns.length,
      artifactCount: parsed.artifacts.length,
      workspaceRoot: parsed.workspaceRoot,
      isScratch: parsed.isScratch,
      context: parsed.context,
      updatedAt: parsed.updatedAt || item.mtimeMs,
      lastPrompt: parsed.turns.at(-1)?.userTitle || parsed.title,
      touchedCount: parsed.touchedFiles.length,
    });
  }
  return results;
}

/**
 * Full-text search across all local conversations (prompts, responses, and touched file paths).
 */
export function searchLocalSessions(query, { appDataDir = '', limit = 30 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const sessions = listLocalSessions({ appDataDir, limit: 100 });
  if (!q) return sessions.slice(0, limit);

  const matches = [];
  for (const s of sessions) {
    const parsed = parseConversationTranscript(s.conversationId, { appDataDir });
    if (!parsed.ok) continue;

    let hitSnippet = '';
    let hitTurn = 0;

    if (parsed.title.toLowerCase().includes(q) || parsed.workspaceRoot.toLowerCase().includes(q)) {
      hitSnippet = parsed.title;
      hitTurn = 1;
    }

    if (!hitSnippet) {
      for (const turn of parsed.turns) {
        const hay = `${turn.userText}\n${turn.assistantText}\n${turn.touchedFiles.join(' ')}`;
        const idx = hay.toLowerCase().indexOf(q);
        if (idx >= 0) {
          const start = Math.max(0, idx - 36);
          const end = Math.min(hay.length, idx + q.length + 72);
          hitSnippet = `${start > 0 ? '…' : ''}${hay.slice(start, end).replace(/\s+/g, ' ')}${end < hay.length ? '…' : ''}`;
          hitTurn = turn.turnIndex;
          break;
        }
      }
    }

    if (hitSnippet) {
      matches.push({
        ...s,
        hitTurn,
        hitSnippet,
      });
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

/**
 * High-fidelity export of any conversation to Markdown or JSON.
 */
export function exportConversation(
  conversationId,
  {
    appDataDir = '',
    pluginDataDir = '',
    format = 'md',
    includeThinking = true,
    upToTurn = 0,
    outputPath = '',
  } = {},
) {
  const parsed = parseConversationTranscript(conversationId, { appDataDir, preferFull: true });
  if (!parsed.ok || !parsed.exists) {
    return { ok: false, error: parsed.error || '未找到该会话的本地记录' };
  }

  const turns =
    Number.isInteger(upToTurn) && upToTurn > 0
      ? parsed.turns.filter((t) => t.turnIndex <= upToTurn)
      : parsed.turns;

  const ext = format === 'json' ? 'json' : 'md';
  const safeSlug = parsed.title
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || conversationId.slice(0, 8);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const exportsDir = ensureDir(path.join(resolvePluginDataDir(pluginDataDir), 'exports'));
  const targetPath = outputPath
    ? path.resolve(outputPath)
    : path.join(exportsDir, `${safeSlug}-${stamp}.${ext}`);
  ensureDir(path.dirname(targetPath));

  if (ext === 'json') {
    const payload = {
      exportedAt: new Date().toISOString(),
      conversationId: parsed.conversationId,
      title: parsed.title,
      workspaceRoot: parsed.workspaceRoot,
      isScratch: parsed.isScratch,
      context: parsed.context,
      artifacts: parsed.artifacts,
      turns: turns.map((t) => ({
        turnIndex: t.turnIndex,
        stepStart: t.stepStart,
        stepEnd: t.stepEnd,
        createdAt: t.createdAt,
        userText: t.userText,
        assistantText: t.assistantText,
        ...(includeThinking ? { thinkingSnippets: t.thinkingSnippets } : {}),
        toolCalls: t.toolCalls,
        touchedFiles: t.touchedFiles,
        estTokens: t.estTokens,
      })),
    };
    fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } else {
    const lines = [
      `# ${parsed.title}`,
      '',
      `- **Conversation ID**: \`${parsed.conversationId}\``,
      `- **工作区**: \`${parsed.workspaceRoot || '(Scratch 临时会话)'}\``,
      `- **轮次数**: ${turns.length} / ${parsed.turns.length}`,
      `- **估算上下文**: ~${parsed.context.usedTokens.toLocaleString()} / ${parsed.context.limitTokens.toLocaleString()} tokens (${parsed.context.percent}%)`,
      `- **导出时间**: ${new Date().toISOString()}`,
      '',
    ];

    if (parsed.artifacts.length) {
      lines.push('## 会话产物 (Artifacts)', '');
      for (const a of parsed.artifacts) {
        lines.push(`- \`${a.name}\` — \`${a.path}\``);
      }
      lines.push('');
    }

    lines.push('---', '');
    for (const t of turns) {
      lines.push(`## Turn #${t.turnIndex}${t.createdAt ? ` · ${t.createdAt}` : ''}`, '');
      lines.push('### 👤 User', '', t.userText || '*(空)*', '');
      if (includeThinking && t.thinkingSnippets?.length) {
        lines.push('<details><summary>🧠 Thinking 摘要</summary>', '', t.thinkingSnippets.join('\n\n---\n\n'), '', '</details>', '');
      }
      if (t.toolCalls.length) {
        const summary = t.toolCalls.map((c) => `\`${c.name}\``).join(', ');
        lines.push(`> 🔧 工具调用 (${t.toolCalls.length}): ${summary}`, '');
      }
      if (t.touchedFiles.length) {
        lines.push(`> 📁 涉及路径: ${t.touchedFiles.map((f) => `\`${f}\``).join(', ')}`, '');
      }
      lines.push('### 🤖 Assistant', '', t.assistantText || '*(本轮仅执行工具操作)*', '', '---', '');
    }

    fs.writeFileSync(targetPath, `${lines.join('\n')}\n`, 'utf8');
  }

  return {
    ok: true,
    path: targetPath,
    format: ext,
    turnCount: turns.length,
    bytes: fs.statSync(targetPath).size,
  };
}
