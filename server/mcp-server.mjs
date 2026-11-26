import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildForkTreeView, executeFork, FORK_MODES, upsertForkNode } from '../lib/fork-engine.mjs';
import { openWithDefaultApp, revealInExplorer } from '../lib/os-explorer.mjs';
import { resolveAppDataDir, resolveFileUri, resolvePluginDataDir, toFileUri } from '../lib/paths.mjs';
import { exportConversation, searchLocalSessions } from '../lib/transcript-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URI = 'ui://agy-fork-explorer/card.html';

function parseCliDataDir(argv = process.argv) {
  const arg = argv.find((a) => a.startsWith('--data-dir='));
  return arg ? arg.slice('--data-dir='.length) : '';
}

export function createMcpToolRegistry({ appDataDir = '', pluginDataDir = '', dryRunOs = false } = {}) {
  const resolvedAppData = resolveAppDataDir(appDataDir);
  const resolvedPluginData = resolvePluginDataDir(pluginDataDir);

  const tools = [
    {
      name: 'show_files_inline',
      title: '交付交互式文件卡片',
      description: '在聊天消息流中展示 Codex 风格本地文件交付卡，支持一键在访达/资源管理器高亮定位、默认应用打开、原生 Tab 打开与 @ 上下文挂载。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '卡片标题' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '本地文件路径或 file:// URI 列表',
          },
        },
        required: ['files'],
      },
      _meta: {
        ui: { resourceUri: APP_URI },
      },
    },
    {
      name: 'fork_conversation',
      title: '分叉当前或历史会话（Fork）',
      description: '从任意历史轮次分叉新会话并渲染交互式分支卡片（支持完整复刻、Amp 轻装交接、仅携文件清单，及可选 Git Worktree 隔离与分叉前安全快照）。',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: '源会话 ID' },
          upToTurn: { type: 'integer', description: '截止轮次号（默认最新轮次）' },
          mode: { type: 'string', enum: ['exact', 'handoff', 'files_only'], description: '上下文继承模式' },
          branchLabel: { type: 'string', description: '分支名称' },
          nextInstruction: { type: 'string', description: '分叉后新分支的首条指令' },
          autoContinue: { type: 'boolean', description: '是否作为自动接力分支立即继续执行剩余任务' },
          handoffFilePath: { type: 'string', description: 'AI 亲笔交接单 Markdown 路径（用于高保真续跑）' },
          workspaceRoot: { type: 'string', description: '工作区根目录' },
          createWorktree: { type: 'boolean', description: '是否同步创建独立 Git Worktree' },
          createSnapshot: { type: 'boolean', description: '是否在分叉前保存无侵入 Git 安全快照' },
        },
        required: ['conversationId'],
      },
      _meta: {
        ui: { resourceUri: APP_URI },
      },
    },
    {
      name: 'reveal_in_explorer',
      title: '在系统资源管理器/访达中显示',
      description: '跨平台在 macOS Finder / Windows Explorer / Linux 文件管理器中高亮选中指定文件或打开目录（文件已删时自动回退上级目录）。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地路径或 file:// URI' },
        },
        required: ['path'],
      },
    },
    {
      name: 'open_file_default',
      title: '用系统默认应用打开文件',
      description: '调用系统默认关联程序打开指定文件或目录。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地路径或 file:// URI' },
        },
        required: ['path'],
      },
      _meta: {
        ui: { visibility: ['app', 'model'] },
      },
    },
    {
      name: 'register_fork_child',
      title: '登记新拉起的分支会话 ID',
      description: '供内联 MCP App 卡片在调用 target:new 启动新会话后，将宿主返回的真实 conversationId 回写到分支谱系树。',
      inputSchema: {
        type: 'object',
        properties: {
          parentConversationId: { type: 'string' },
          newConversationId: { type: 'string' },
          branchLabel: { type: 'string' },
          forkedFromTurn: { type: 'integer' },
          mode: { type: 'string' },
          worktreePath: { type: 'string' },
          worktreeBranch: { type: 'string' },
          seedFilePath: { type: 'string' },
        },
        required: ['parentConversationId', 'newConversationId'],
      },
      _meta: {
        ui: { visibility: ['app'] },
      },
    },
    {
      name: 'list_fork_tree',
      title: '查看会话分支谱系树',
      description: '返回当前会话家族的 Git-Graph 分支谱系树与 Worktree 状态。',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: '当前会话 ID（可选）' },
        },
      },
    },
    {
      name: 'export_session',
      title: '导出高保真会话记录',
      description: '将指定会话导出为 Markdown 或 JSON（含时间戳、思考链摘要、工具调用与改动文件清单）。',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          format: { type: 'string', enum: ['md', 'json'] },
          includeThinking: { type: 'boolean' },
          upToTurn: { type: 'integer' },
          reveal: { type: 'boolean' },
        },
        required: ['conversationId'],
      },
    },
    {
      name: 'search_sessions',
      title: '全文检索本地会话（含隐藏 Scratch）',
      description: '只读扫描本地所有会话记录（包含侧栏丢失或未绑定工作区的 Scratch 会话）并按关键词检索。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键字（留空则返回最近会话）' },
          limit: { type: 'integer' },
        },
      },
    },
  ];

  async function callTool(name, args = {}) {
    if (name === 'show_files_inline') {
      const list = Array.isArray(args.files) ? args.files : [];
      const items = list
        .map((raw) => {
          const resolved = resolveFileUri(raw);
          if (!resolved) return null;
          let exists = false;
          let isDir = false;
          let size = 0;
          try {
            if (fs.existsSync(resolved)) {
              exists = true;
              const st = fs.statSync(resolved);
              isDir = st.isDirectory();
              size = st.size;
            }
          } catch {}
          return {
            name: path.basename(resolved) || resolved,
            path: resolved,
            uri: toFileUri(resolved),
            exists,
            isDirectory: isDir,
            size,
          };
        })
        .filter(Boolean);

      return {
        content: [
          {
            type: 'text',
            text: `已展示 ${items.length} 个本地文件交互卡片（双击或点击按钮即可在系统资源管理器定位）：\n${items.map((i) => `- ${i.path}`).join('\n')}`,
          },
        ],
        structuredContent: {
          cardType: 'files',
          platform: process.platform,
          title: args.title || '交付文件（双击定位资源管理器）',
          items,
        },
      };
    }

    if (name === 'fork_conversation') {
      const res = await executeFork({
        conversationId: args.conversationId,
        upToTurn: Number(args.upToTurn) || 0,
        mode: args.mode || FORK_MODES.EXACT,
        branchLabel: args.branchLabel || '',
        nextInstruction: args.nextInstruction || '',
        autoContinue: Boolean(args.autoContinue),
        handoffFilePath: args.handoffFilePath || '',
        workspaceRoot: args.workspaceRoot || '',
        createWorktree: Boolean(args.createWorktree),
        createSnapshot: args.createSnapshot !== false,
        appDataDir: resolvedAppData,
        pluginDataDir: resolvedPluginData,
      });

      if (!res.ok) {
        return { isError: true, content: [{ type: 'text', text: res.error || 'Fork 失败' }] };
      }

      const summaryLines = [
        `🌿 已创建分支「${res.branchLabel}」（模式：${res.mode}，分叉自第 ${res.forkedFromTurn} 轮）`,
        res.launched ? `- 新会话链接：[打开分支会话](conversation://${res.newConversationId})` : '- 可在下方交互卡片点击「🚀 一键拉起新分支会话」直接在新对话中继续',
        `- 历史切片种子文件：${res.seedFilePath}`,
      ];
      if (res.worktree?.worktreePath) {
        summaryLines.push(`- 隔离 Worktree：${res.worktree.worktreePath}（分支 \`${res.worktree.branchName}\`）`);
      }
      if (res.snapshot?.id) {
        summaryLines.push(`- 分叉前安全快照：\`${res.snapshot.id}\``);
      }

      return {
        content: [{ type: 'text', text: summaryLines.join('\n') }],
        structuredContent: {
          cardType: 'fork',
          platform: process.platform,
          ...res,
        },
      };
    }

    if (name === 'reveal_in_explorer') {
      const res = revealInExplorer(args.path, { dryRun: dryRunOs });
      return {
        isError: !res.ok,
        content: [{ type: 'text', text: res.ok ? `已定位：${res.path}${res.message ? `（${res.message}）` : ''}` : res.error }],
        structuredContent: res,
      };
    }

    if (name === 'open_file_default') {
      const res = openWithDefaultApp(args.path, { dryRun: dryRunOs });
      return {
        isError: !res.ok,
        content: [{ type: 'text', text: res.ok ? `已用默认应用打开：${res.path}` : res.error }],
        structuredContent: res,
      };
    }

    if (name === 'register_fork_child') {
      const node = upsertForkNode(
        {
          conversationId: args.newConversationId,
          parentId: args.parentConversationId,
          branchLabel: args.branchLabel || 'fork',
          forkedFromTurn: Number(args.forkedFromTurn) || 0,
          mode: args.mode || 'exact',
          worktreePath: args.worktreePath || '',
          worktreeBranch: args.worktreeBranch || '',
          seedFilePath: args.seedFilePath || '',
          isPendingLaunch: false,
        },
        { pluginDataDir: resolvedPluginData },
      );
      return {
        content: [{ type: 'text', text: `已将新分支会话 ${args.newConversationId} 写入谱系树` }],
        structuredContent: { ok: true, node },
      };
    }

    if (name === 'list_fork_tree') {
      const tree = buildForkTreeView(args.conversationId || '', {
        appDataDir: resolvedAppData,
        pluginDataDir: resolvedPluginData,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }],
        structuredContent: tree,
      };
    }

    if (name === 'export_session') {
      const res = exportConversation(args.conversationId, {
        appDataDir: resolvedAppData,
        pluginDataDir: resolvedPluginData,
        format: args.format === 'json' ? 'json' : 'md',
        includeThinking: args.includeThinking !== false,
        upToTurn: Number(args.upToTurn) || 0,
      });
      if (res.ok && args.reveal) revealInExplorer(res.path, { dryRun: dryRunOs });
      return {
        isError: !res.ok,
        content: [{ type: 'text', text: res.ok ? `导出成功：${res.path}（共 ${res.turnCount} 轮）` : res.error }],
        structuredContent: res,
      };
    }

    if (name === 'search_sessions') {
      const items = searchLocalSessions(args.query || '', {
        appDataDir: resolvedAppData,
        limit: Number(args.limit) || 20,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
        structuredContent: { ok: true, items },
      };
    }

    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }

  function readResource(uri) {
    if (uri === APP_URI) {
      const html = fs.readFileSync(path.join(__dirname, 'inline-card.html'), 'utf8');
      return {
        contents: [
          {
            uri: APP_URI,
            mimeType: 'text/html;profile=mcp-app',
            text: html,
            _meta: { ui: { prefersBorder: false } },
          },
        ],
      };
    }
    return null;
  }

  async function handleJsonRpc(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const { id, method, params = {} } = msg;

    if (method === 'notifications/initialized') return null;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params.protocolVersion || '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: {
            name: 'agy-fork-explorer',
            version: '1.0.0',
          },
        },
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools } };
    }

    if (method === 'tools/call') {
      const result = await callTool(params.name, params.arguments || {});
      return { jsonrpc: '2.0', id, result };
    }

    if (method === 'resources/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          resources: [
            {
              uri: APP_URI,
              name: 'AGY Fork & Explorer Card',
              mimeType: 'text/html;profile=mcp-app',
            },
          ],
        },
      };
    }

    if (method === 'resources/read') {
      const res = readResource(params.uri);
      if (!res) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Resource not found: ${params.uri}` } };
      }
      return { jsonrpc: '2.0', id, result: res };
    }

    if (id === undefined || id === null) return null;
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  return { tools, callTool, readResource, handleJsonRpc };
}

function startStdioServer() {
  const dataDir = parseCliDataDir(process.argv);
  const registry = createMcpToolRegistry({ pluginDataDir: dataDir });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    try {
      const reply = await registry.handleJsonRpc(msg);
      if (reply) {
        process.stdout.write(`${JSON.stringify(reply)}\n`);
      }
    } catch (err) {
      if (msg.id !== undefined) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: err?.message || 'Internal error' },
          })}\n`,
        );
      }
    }
  });
}

const isEntry =
  process.env.AGY_TEST_NO_START !== '1' &&
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isEntry) {
  startStdioServer();
}
