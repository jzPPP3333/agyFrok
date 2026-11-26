import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.AGY_TEST_NO_START = '1';

import {
  CONFIRM_MODES,
  dismissRelayJob,
  evaluateRelayHook,
  getHandoffFilePath,
  getRelayChainDepth,
  listRelaySnapshot,
  savePluginSettings,
} from '../lib/auto-relay.mjs';
import { isAntigravityHubTarget, readDevToolsPort } from '../lib/cdp-bridge.mjs';
import { buildForkTreeView, executeFork, extractConversationIdDeep, FORK_MODES, updateBranchMeta, upsertForkNode } from '../lib/fork-engine.mjs';
import {
  createForkWorktree,
  createSafetySnapshot,
  getGitRepoInfo,
  getSnapshotDiff,
  listWorktrees,
  removeForkWorktree,
  restoreSnapshotFile,
} from '../lib/git-ops.mjs';
import { buildNativeOverlaySource } from '../lib/native-overlay.js';
import { buildRevealCommand, openWithDefaultApp, revealInExplorer } from '../lib/os-explorer.mjs';
import { resolveFileUri, toFileUri } from '../lib/paths.mjs';
import {
  cleanUserContent,
  estimateTokens,
  exportConversation,
  listLocalSessions,
  parseConversationTranscript,
  readLiveContextMetrics,
  searchLocalSessions,
} from '../lib/transcript-parser.mjs';
import { listWorkspaceTree, readFilePreview, toggleFavoritePath } from '../lib/workspace-tree.mjs';
import { createMcpToolRegistry } from '../server/mcp-server.mjs';
import { createCockpitHandlers, loadSidecarSdk } from '../sidecars/cockpit/main.mjs';

function makeTempFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fe-test-'));
  const appDataDir = path.join(root, 'app_data');
  const pluginDataDir = path.join(root, 'plugin_data');
  const repoDir = path.join(root, 'demo-repo');
  fs.mkdirSync(repoDir, { recursive: true });

  // Initialize a real local Git repo
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'index.js'), 'export const version = 1;\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Demo Repo\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

  // Create one modified tracked file + one untracked file
  fs.writeFileSync(path.join(repoDir, 'src', 'index.js'), 'export const version = 2;\n// modified\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'src', 'new-feature.js'), 'export const fresh = true;\n', 'utf8');

  // Create two fake Antigravity conversations in brain/
  const convMain = '11111111-2222-3333-4444-555555555555';
  const convScratch = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const writeTranscript = (convId, lines, artifacts = {}) => {
    const convDir = path.join(appDataDir, 'brain', convId);
    const logsDir = path.join(convDir, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      'utf8',
    );
    for (const [name, content] of Object.entries(artifacts)) {
      fs.writeFileSync(path.join(convDir, name), content, 'utf8');
    }
  };

  writeTranscript(
    convMain,
    [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T02:00:00Z',
        content: '<USER_REQUEST>\n实现会话分叉与工作区文件树\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T02:00:10Z',
        thinking: '先检查 demo-repo 的核心结构并规划分支引擎。',
        content: '已完成架构设计与初版接口梳理。',
        tool_calls: [{ name: 'read_file', arguments: { Path: JSON.stringify(path.join(repoDir, 'src', 'index.js')) } }],
      },
      {
        step_index: 2,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T02:05:00Z',
        content: '<USER_REQUEST>\n加上 Git Worktree 隔离和 256K 上下文预警\n</USER_REQUEST>',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T02:05:25Z',
        thinking: '通过临时 GIT_INDEX_FILE 打安全快照。',
        content: '已加入 Git Worktree 隔离、无侵入安全快照和上下文水位条。',
        tool_calls: [{ name: 'write_file', arguments: { Path: path.join(repoDir, 'src', 'new-feature.js') } }],
      },
    ],
    {
      'design_plan.md': '# Design Plan\nFork + Explorer\n',
      'design_plan.md.metadata.json': '{"summary":"ignore me"}',
    },
  );

  writeTranscript(convScratch, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-25T10:00:00Z',
      content: '<USER_REQUEST>\n临时问答：Antigravity 256K 压缩机制是什么？\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-25T10:00:08Z',
      content: '当上下文接近 256K tokens 时会触发自动压缩，建议提前轻装 Fork。',
    },
  ]);

  return {
    root,
    appDataDir,
    pluginDataDir,
    repoDir,
    convMain,
    convScratch,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('paths & URI normalization strip line anchors and decode UTF-8 Chinese paths', () => {
  const samplePath = path.join(os.tmpdir(), '测试目录', '设计 方案.md');
  const uri = `${toFileUri(samplePath)}#L12-L30`;
  const resolved = resolveFileUri(uri);
  assert.equal(resolved, path.resolve(samplePath));
});

test('transcript parser extracts turns, workspace root, scratch flag, search & export', () => {
  const fx = makeTempFixture();
  try {
    assert.equal(cleanUserContent('<USER_REQUEST>\n你好\n</USER_REQUEST>'), '你好');
    assert.ok(estimateTokens('Hello 世界 12345') > 0);

    const parsed = parseConversationTranscript(fx.convMain, { appDataDir: fx.appDataDir });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.turns.length, 2);
    assert.equal(parsed.turns[0].userTitle, '实现会话分叉与工作区文件树');
    assert.equal(parsed.artifacts.length, 1);
    assert.equal(path.resolve(parsed.workspaceRoot), path.resolve(fx.repoDir));
    assert.equal(parsed.isScratch, false);
    // Read-only files should NOT pollute modifiedFiles
    assert.equal(parsed.modifiedFiles.length, 1);
    assert.match(parsed.modifiedFiles[0], /new-feature\.js$/);

    const scratch = parseConversationTranscript(fx.convScratch, { appDataDir: fx.appDataDir });
    assert.equal(scratch.isScratch, true);

    const sessions = listLocalSessions({ appDataDir: fx.appDataDir });
    assert.equal(sessions.length, 2);

    const hits = searchLocalSessions('256K 压缩', { appDataDir: fx.appDataDir });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].conversationId, fx.convScratch);

    const expMd = exportConversation(fx.convMain, {
      appDataDir: fx.appDataDir,
      pluginDataDir: fx.pluginDataDir,
      format: 'md',
      includeThinking: true,
    });
    assert.equal(expMd.ok, true);
    const mdText = fs.readFileSync(expMd.path, 'utf8');
    assert.match(mdText, /Turn #1/);
    assert.match(mdText, /Thinking 摘要/);

    const expJson = exportConversation(fx.convMain, {
      appDataDir: fx.appDataDir,
      pluginDataDir: fx.pluginDataDir,
      format: 'json',
      upToTurn: 1,
    });
    assert.equal(expJson.ok, true);
    const jsonData = JSON.parse(fs.readFileSync(expJson.path, 'utf8'));
    assert.equal(jsonData.turns.length, 1);
  } finally {
    fx.cleanup();
  }
});

test('os-explorer resolves reveal command and falls back to ancestor directory when deleted', () => {
  const fx = makeTempFixture();
  try {
    const existing = path.join(fx.repoDir, 'README.md');
    const r1 = revealInExplorer(`${toFileUri(existing)}#L1-L5`, { dryRun: true });
    assert.equal(r1.ok, true);
    assert.equal(r1.kind, 'file');
    assert.equal(r1.path, path.resolve(existing));

    const missing = path.join(fx.repoDir, 'src', 'deleted-file.js');
    const r2 = revealInExplorer(missing, { dryRun: true });
    assert.equal(r2.ok, true);
    assert.equal(r2.fallback, 'parent');
    assert.equal(r2.path, path.resolve(path.join(fx.repoDir, 'src')));

    const cmd = buildRevealCommand(existing, false);
    assert.ok(cmd.exe.length > 0 && Array.isArray(cmd.args));

    const defOpen = openWithDefaultApp(existing, { dryRun: true });
    assert.equal(defOpen.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('git-ops supports status flags, non-destructive safety snapshot + restore, and worktree lifecycle', async () => {
  const fx = makeTempFixture();
  try {
    const info = await getGitRepoInfo(fx.repoDir);
    assert.equal(info.isRepo, true);
    assert.equal(info.branch, 'main');
    assert.equal(info.statusMap['src/index.js'], 'M');
    assert.equal(info.statusMap['src/new-feature.js'], '?');

    // Non-destructive safety snapshot
    const snapRes = await createSafetySnapshot(fx.repoDir, {
      label: 'before-fork',
      conversationId: fx.convMain,
      pluginDataDir: fx.pluginDataDir,
    });
    assert.equal(snapRes.ok, true);
    assert.ok(snapRes.snapshot.snapshotCommit.length >= 7);

    // Diff & single-file restore
    const diffRes = await getSnapshotDiff(snapRes.snapshot.id, { pluginDataDir: fx.pluginDataDir });
    assert.equal(diffRes.ok, true);
    assert.match(diffRes.diff, /version = 2/);

    // Overwrite file then restore from snapshot
    const targetFile = path.join(fx.repoDir, 'src', 'index.js');
    fs.writeFileSync(targetFile, 'export const version = 999;\n', 'utf8');
    const restRes = await restoreSnapshotFile(snapRes.snapshot.id, 'src/index.js', { pluginDataDir: fx.pluginDataDir });
    assert.equal(restRes.ok, true);
    assert.match(fs.readFileSync(targetFile, 'utf8'), /version = 2/);

    // Worktree creation, list & cleanup
    const wtRes = await createForkWorktree(fx.repoDir, { branchSlug: 'exp-ui' });
    assert.equal(wtRes.ok, true);
    assert.ok(fs.existsSync(wtRes.worktreePath));

    const wts = await listWorktrees(fx.repoDir);
    assert.equal(wts.length, 2);

    const rmRes = await removeForkWorktree(fx.repoDir, wtRes.worktreePath);
    assert.equal(rmRes.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('fork-engine builds Exact & Handoff forks, persists DAG tree, and supports branch rename', async () => {
  const fx = makeTempFixture();
  try {
    const childId = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    const forkRes = await executeFork({
      conversationId: fx.convMain,
      upToTurn: 1,
      mode: FORK_MODES.HANDOFF,
      branchLabel: 'clean-handoff',
      nextInstruction: '只聚焦优化文件树性能',
      workspaceRoot: fx.repoDir,
      createWorktree: true,
      createSnapshot: true,
      appDataDir: fx.appDataDir,
      pluginDataDir: fx.pluginDataDir,
      customLauncher: async (prompt) => {
        assert.match(prompt, /近期脉络/);
        assert.match(prompt, /只聚焦优化文件树性能/);
        assert.ok(prompt.length < 1200);
        return { launched: true, channel: 'mock', conversationId: childId };
      },
    });

    assert.equal(forkRes.ok, true);
    assert.equal(forkRes.launched, true);
    assert.equal(forkRes.newConversationId, childId);
    assert.equal(forkRes.forkedFromTurn, 1);
    assert.ok(fs.existsSync(forkRes.seedFilePath));
    assert.ok(forkRes.worktree?.ok);
    assert.ok(forkRes.snapshot?.id);

    const tree = buildForkTreeView(fx.convMain, {
      appDataDir: fx.appDataDir,
      pluginDataDir: fx.pluginDataDir,
    });
    assert.equal(tree.totalBranches, 2);
    assert.equal(tree.nodes[0].conversationId, fx.convMain);
    assert.equal(tree.nodes[1].conversationId, childId);
    assert.equal(tree.nodes[1].parentId, fx.convMain);

    const renamed = updateBranchMeta(childId, { branchLabel: 'perf-branch' }, { pluginDataDir: fx.pluginDataDir });
    assert.equal(renamed.branchLabel, 'perf-branch');

    // Silent auto-naming & deep conversationId extraction
    const deepId = extractConversationIdDeep({
      response: { newConversation: { conversation_id: '12345678-1234-1234-1234-123456789abc' } },
    });
    assert.equal(deepId, '12345678-1234-1234-1234-123456789abc');

    const silentFork = await executeFork({
      conversationId: fx.convMain,
      upToTurn: 0,
      mode: FORK_MODES.EXACT,
      autoSmartHandoff: true,
      workspaceRoot: fx.repoDir,
      createWorktree: false,
      createSnapshot: false,
      appDataDir: fx.appDataDir,
      pluginDataDir: fx.pluginDataDir,
      customLauncher: async (prompt) => {
        assert.match(prompt, /严禁调用任何工具/);
        assert.ok(prompt.length < 1200);
        return {
          launched: true,
          channel: 'sidecar_sdk',
          conversationId: '22222222-3333-4444-5555-666666666666',
          projectId: 'proj-demo',
        };
      },
    });
    assert.equal(silentFork.ok, true);
    assert.equal(silentFork.branchLabel, 'fork-2');
    assert.equal(silentFork.projectId, 'proj-demo');
    assert.ok(silentFork.promptEstTokens < 450);

    // Zero-Token Lazy Fork: 0 LLM calls, returns prefillPrompt cleanly
    let launcherCalled = false;
    const lazyFork = await executeFork({
      conversationId: fx.convMain,
      zeroTokenLazy: true,
      workspaceRoot: fx.repoDir,
      appDataDir: fx.appDataDir,
      pluginDataDir: fx.pluginDataDir,
      resolveProjectId: async () => 'proj-lazy',
      customLauncher: async () => {
        launcherCalled = true;
        return { launched: true, conversationId: 'should-not-run' };
      },
    });
    assert.equal(lazyFork.ok, true);
    assert.equal(lazyFork.lazy, true);
    assert.equal(launcherCalled, false);
    assert.equal(lazyFork.projectId, 'proj-lazy');
    assert.ok(lazyFork.prefillPrompt.includes('历史切片'));
    assert.equal(lazyFork.prefillPrompt.includes('严禁调用任何工具'), false);

    // Clean up created worktree
    await removeForkWorktree(fx.repoDir, forkRes.worktree.worktreePath);
  } finally {
    fx.cleanup();
  }
});

test('workspace-tree lists files with Git flags, filters recursively, previews code, and toggles favorites', async () => {
  const fx = makeTempFixture();
  try {
    const tree = await listWorkspaceTree(fx.repoDir);
    assert.equal(tree.ok, true);
    assert.equal(tree.git.branch, 'main');
    const srcDir = tree.entries.find((e) => e.name === 'src');
    assert.ok(srcDir && srcDir.isDirectory && srcDir.gitFlag === '•');

    const search = await listWorkspaceTree(fx.repoDir, { filter: 'new-feature' });
    assert.equal(search.entries.length, 1);
    assert.equal(search.entries[0].gitFlag, '?');

    const preview = readFilePreview(path.join(fx.repoDir, 'src', 'index.js'));
    assert.equal(preview.ok, true);
    assert.equal(preview.kind, 'text');
    assert.match(preview.content, /version = 2/);

    const fav1 = toggleFavoritePath(fx.repoDir, { pluginDataDir: fx.pluginDataDir });
    assert.equal(fav1.added, true);
    const fav2 = toggleFavoritePath(fx.repoDir, { pluginDataDir: fx.pluginDataDir });
    assert.equal(fav2.added, false);
  } finally {
    fx.cleanup();
  }
});

test('MCP Server & Sidecar Cockpit handlers pass end-to-end JSON-RPC and REST contracts', async () => {
  const fx = makeTempFixture();
  try {
    // 1. MCP Server JSON-RPC
    const mcp = createMcpToolRegistry({
      appDataDir: fx.appDataDir,
      pluginDataDir: fx.pluginDataDir,
      dryRunOs: true,
    });
    const init = await mcp.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.result.serverInfo.name, 'agy-fork-explorer');

    const listTools = await mcp.handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(listTools.result.tools.some((t) => t.name === 'show_files_inline'));
    assert.ok(listTools.result.tools.some((t) => t.name === 'fork_conversation'));

    const cardRes = await mcp.handleJsonRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/read',
      params: { uri: 'ui://agy-fork-explorer/card.html' },
    });
    assert.equal(cardRes.result.contents[0].mimeType, 'text/html;profile=mcp-app');

    const filesCall = await mcp.handleJsonRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'show_files_inline', arguments: { files: [path.join(fx.repoDir, 'README.md')] } },
    });
    assert.equal(filesCall.result.structuredContent.cardType, 'files');
    assert.equal(filesCall.result.structuredContent.items.length, 1);

    // 2. Sidecar Cockpit Handlers
    const cockpit = createCockpitHandlers({
      appDataDir: fx.appDataDir,
      pluginDataDir: fx.pluginDataDir,
      getDefaultConvId: () => fx.convMain,
      getDefaultWorkspace: () => fx.repoDir,
      dryRunOs: true,
    });

    const st = await cockpit.handleState({});
    assert.equal(st.ok, true);
    assert.equal(st.conversationId, fx.convMain);
    assert.equal(st.conversation.turnCount, 2);
    assert.equal(st.workspace.git.branch, 'main');

    const rev = cockpit.handleReveal({ path: path.join(fx.repoDir, 'README.md') });
    assert.equal(rev.ok, true);

    // 3. CDP bridge helpers & overlay syntax sanity
    const portInfo = readDevToolsPort(path.join(fx.root, 'nonexistent-port-file'));
    assert.equal(portInfo.ok, false);
    assert.equal(portInfo.state, 'missing');
    assert.equal(isAntigravityHubTarget({ type: 'page', url: 'https://127.0.0.1:4433/c/abc', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/x' }), true);
    assert.equal(isAntigravityHubTarget({ type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/y' }), false);

    const overlaySrc = buildNativeOverlaySource({ version: '1.1.0', platform: 'darwin' });
    assert.doesNotThrow(() => new Function(overlaySrc));
    assert.equal(overlaySrc.includes('location.assign'), false);

    // 4. Sidecar SDK resolution across symlinks / custom NODE_PATH (CI-safe on clean runners)
    const fakeSdkDir = path.join(fx.root, 'fake_node_modules', 'sidecar_sdk');
    fs.mkdirSync(fakeSdkDir, { recursive: true });
    fs.writeFileSync(
      path.join(fakeSdkDir, 'index.mjs'),
      'export class SidecarApp {}\nexport class Response {}\n',
      'utf8',
    );
    const prevNodePath = process.env.NODE_PATH;
    process.env.NODE_PATH = path.join(fx.root, 'fake_node_modules');
    try {
      const sdk = await loadSidecarSdk();
      assert.equal(typeof sdk.SidecarApp, 'function');
      assert.equal(typeof sdk.Response, 'function');
    } finally {
      if (prevNodePath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = prevNodePath;
    }
  } finally {
    fx.cleanup();
  }
});

test('auto-relay Scheme B+C: exact API tokens, 75% graceful handoff, 5s countdown dismiss, 90% failsafe silent launch, fuse & hook CLI', async () => {
  const fx = makeTempFixture();
  try {
    const convRelay = '99999999-8888-7777-6666-555555555555';
    const logsDir = path.join(fx.appDataDir, 'brain', convRelay, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');

    const writeTranscriptSteps = (steps) => {
      fs.writeFileSync(transcriptPath, `${steps.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');
    };

    // 1. Exact API token metrics (200K / 256K = 78%) & post-compaction drop verification
    writeTranscriptSteps([
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\n重构支付模块并跑完所有单测\n</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-pro', input_tokens: 18000, cache_read_tokens: 182000, output_tokens: 420, content: '已重构第一阶段接口' },
    ]);

    const parsed78 = parseConversationTranscript(convRelay, { appDataDir: fx.appDataDir });
    assert.equal(parsed78.context.tokenSource, 'api');
    assert.equal(parsed78.context.usedTokens, 200000);
    assert.equal(parsed78.context.percent, 78);

    const live78 = readLiveContextMetrics(transcriptPath);
    assert.equal(live78.ok, true);
    assert.equal(live78.tokenSource, 'api');
    assert.equal(live78.percent, 78);

    // 2. Scheme B Soft Handoff (75% <= 78% < 90%) in default Countdown (Scheme C) mode
    savePluginSettings(
      {
        autoRelayEnabled: true,
        autoRelaySoftPercent: 75,
        autoRelayHardPercent: 90,
        autoRelayConfirmMode: CONFIRM_MODES.COUNTDOWN,
        autoRelayCountdownSec: 5,
        autoRelayModel: 'pro',
        autoRelayMaxChain: 3,
      },
      fx.pluginDataDir,
    );

    const t0 = Date.now();
    const pre1 = evaluateRelayHook(
      'PreInvocation',
      { conversationId: convRelay, transcriptPath, lastUserInput: '重构支付模块并跑完所有单测', workspacePaths: [fx.repoDir] },
      { pluginDataDir: fx.pluginDataDir, appDataDir: fx.appDataDir, now: t0 },
    );
    assert.equal(Array.isArray(pre1.injectSteps), true);
    assert.match(pre1.injectSteps[0].systemMessage.systemMessage, /write_file/);
    assert.match(pre1.injectSteps[0].systemMessage.metadata.user_markdown, /78%/);

    // Idempotent on second PreInvocation
    const pre2 = evaluateRelayHook(
      'PreInvocation',
      { conversationId: convRelay, transcriptPath },
      { pluginDataDir: fx.pluginDataDir, appDataDir: fx.appDataDir, now: t0 + 500 },
    );
    assert.deepEqual(pre2, {});

    // AI authors high-fidelity handoff.md
    const handoffPath = getHandoffFilePath(convRelay, fx.pluginDataDir);
    fs.writeFileSync(
      handoffPath,
      '# 交接单\n- 原始目标：重构支付模块并跑完单测\n- 已完成：支付网关接口拆分\n- 下一步：修复 checkout.test.mjs 断言并运行 npm test\n',
      'utf8',
    );

    // PostInvocation detects fresh handoff.md -> terminates old turn & queues 5s countdown job
    const postGraceful = evaluateRelayHook(
      'PostInvocation',
      { conversationId: convRelay, transcriptPath, lastUserInput: '重构支付模块并跑完所有单测', workspacePaths: [fx.repoDir] },
      { pluginDataDir: fx.pluginDataDir, appDataDir: fx.appDataDir, now: t0 + 1000 },
    );
    assert.equal(postGraceful.terminationBehavior, 'terminate');
    assert.match(postGraceful.injectSteps[0].systemMessage.metadata.user_markdown, /5 秒/);

    const snapAwaiting = listRelaySnapshot({ pluginDataDir: fx.pluginDataDir, now: t0 + 1500 });
    assert.ok(snapAwaiting.activeJob);
    assert.equal(snapAwaiting.activeJob.status, 'awaiting_confirm');
    assert.equal(snapAwaiting.activeJob.triggerMode, 'graceful');
    assert.equal(snapAwaiting.activeJob.executeAfter, t0 + 6000);

    // User clicks "暂不" -> dismisses and suppresses until 90% hard redline (and won't re-trigger from stale handoff.md)
    const disRes = dismissRelayJob(snapAwaiting.activeJob.id, { pluginDataDir: fx.pluginDataDir, now: t0 + 2000 });
    assert.equal(disRes.ok, true);
    assert.equal(disRes.dismissedUntilPct, 90);
    const postAfterDismiss = evaluateRelayHook(
      'PostInvocation',
      { conversationId: convRelay, transcriptPath },
      { pluginDataDir: fx.pluginDataDir, appDataDir: fx.appDataDir, now: t0 + 2500 },
    );
    assert.deepEqual(postAfterDismiss, {});

    // 3. Switch to Silent 0s mode & hit 92% Hard Failsafe -> terminates and queues immediate launch!
    savePluginSettings({ autoRelayConfirmMode: CONFIRM_MODES.SILENT }, fx.pluginDataDir);
    writeTranscriptSteps([
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\n重构支付模块并跑完所有单测\n</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-pro', input_tokens: 16000, cache_read_tokens: 220000, output_tokens: 500, content: '正在修复最后 2 个单测' },
    ]);

    const postHard = evaluateRelayHook(
      'PostInvocation',
      { conversationId: convRelay, transcriptPath, lastUserInput: '继续修完单测', workspacePaths: [fx.repoDir] },
      { pluginDataDir: fx.pluginDataDir, appDataDir: fx.appDataDir, now: t0 + 3000 },
    );
    assert.equal(postHard.terminationBehavior, 'terminate');
    assert.match(postHard.injectSteps[0].systemMessage.metadata.user_markdown, /90% 硬红线兜底/);

    // Sidecar relay processor claims & launches new continuation branch with model='pro' and NO zero-tool constraint!
    let launchedPrompt = '';
    let launchedMeta = null;
    const launchedChildId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const cockpit = createCockpitHandlers({
      appDataDir: fx.appDataDir,
      pluginDataDir: fx.pluginDataDir,
      getDefaultConvId: () => convRelay,
      getDefaultWorkspace: () => fx.repoDir,
      dryRunOs: true,
      customLauncher: async (prompt, meta) => {
        launchedPrompt = prompt;
        launchedMeta = meta;
        return { launched: true, channel: 'sidecar_sdk', conversationId: launchedChildId, projectId: 'proj-relay' };
      },
    });

    const proc = await cockpit.processRelayQueueOnce({ now: t0 + 3100 });
    assert.equal(proc.processed, true);
    assert.equal(proc.result.ok, true);
    assert.equal(proc.result.launched, true);
    assert.equal(proc.result.newConversationId, launchedChildId);
    assert.equal(launchedMeta.autoContinue, true);
    assert.equal(launchedMeta.model, 'pro');
    assert.match(launchedPrompt, /上一分支交接单/);
    assert.match(launchedPrompt, /续跑指令/);
    assert.equal(launchedPrompt.includes('严禁调用任何工具'), false);
    assert.equal(getRelayChainDepth(launchedChildId, { pluginDataDir: fx.pluginDataDir }), 1);

    // 4. Anti-infinite-loop fuse (maxChain = 3): chain depth 3 blocks further auto-relay
    const c2 = '22222222-bbbb-cccc-dddd-eeeeeeeeeeee';
    const c3 = '33333333-bbbb-cccc-dddd-eeeeeeeeeeee';
    upsertForkNode({ conversationId: c2, parentId: launchedChildId, isAutoRelay: true, tags: ['auto-relay'] }, { pluginDataDir: fx.pluginDataDir });
    upsertForkNode({ conversationId: c3, parentId: c2, isAutoRelay: true, tags: ['auto-relay'] }, { pluginDataDir: fx.pluginDataDir });
    assert.equal(getRelayChainDepth(c3, { pluginDataDir: fx.pluginDataDir }), 3);

    const fuseRes = evaluateRelayHook(
      'PreInvocation',
      { conversationId: c3, transcriptPath },
      { pluginDataDir: fx.pluginDataDir, appDataDir: fx.appDataDir, now: t0 + 5000 },
    );
    assert.match(fuseRes.injectSteps[0].systemMessage.metadata.user_markdown, /防循环熔断/);

    // 5. Normal Stop (NO_TOOL_CALL) at 95% without handoff must NOT re-run an already-finished task!
    const convDone = '44444444-bbbb-cccc-dddd-eeeeeeeeeeee';
    const doneLogs = path.join(fx.appDataDir, 'brain', convDone, '.system_generated', 'logs');
    fs.mkdirSync(doneLogs, { recursive: true });
    const doneTranscript = path.join(doneLogs, 'transcript.jsonl');
    fs.writeFileSync(
      doneTranscript,
      `${[
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\n打包 zip\n</USER_REQUEST>' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: 10000, cache_read_tokens: 235000, content: '已打包完成' },
      ].map((s) => JSON.stringify(s)).join('\n')}\n`,
      'utf8',
    );
    const stopNormal = evaluateRelayHook(
      'Stop',
      { conversationId: convDone, transcriptPath: doneTranscript, terminationReason: 'NO_TOOL_CALL' },
      { pluginDataDir: fx.pluginDataDir, appDataDir: fx.appDataDir, now: t0 + 6000 },
    );
    assert.deepEqual(stopNormal, {});
    assert.equal(listRelaySnapshot({ pluginDataDir: fx.pluginDataDir, now: t0 + 6000 }).activeJob, null);

    // Forced Stop (MAX_TOKEN_BUDGET_EXCEEDED) MUST still queue immediate failsafe relay!
    evaluateRelayHook(
      'Stop',
      { conversationId: convDone, transcriptPath: doneTranscript, terminationReason: 'MAX_TOKEN_BUDGET_EXCEEDED' },
      { pluginDataDir: fx.pluginDataDir, appDataDir: fx.appDataDir, now: t0 + 6100 },
    );
    const forcedSnap = listRelaySnapshot({ pluginDataDir: fx.pluginDataDir, now: t0 + 6100 });
    assert.ok(forcedSnap.activeJob && forcedSnap.activeJob.conversationId === convDone && forcedSnap.activeJob.status === 'queued');

    // 6. Post-compaction drop verification: appending a compacted step lowers real API usage immediately
    writeTranscriptSteps([
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\n测试压缩回落\n</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: 20000, cache_read_tokens: 200000, content: '压缩前' },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: 4000, cache_read_tokens: 31000, content: '压缩后' },
    ]);
    const liveDrop = readLiveContextMetrics(transcriptPath);
    assert.equal(liveDrop.usedTokens, 35000);
    assert.equal(liveDrop.percent, 14);

    // 6. End-to-end hook CLI stdin/stdout smoke test
    const hookScript = path.resolve(process.cwd(), 'hooks', 'on-hook.mjs');
    const cliOut = execFileSync(process.execPath, [hookScript, 'PreInvocation'], {
      input: JSON.stringify({ conversationId: c3, transcriptPath, hookEventName: 'PreInvocation' }),
      env: { ...process.env, PLUGIN_DATA: fx.pluginDataDir, AGY_APP_DATA_DIR: fx.appDataDir },
      encoding: 'utf8',
    });
    assert.doesNotThrow(() => JSON.parse(cliOut));
  } finally {
    fx.cleanup();
  }
});
