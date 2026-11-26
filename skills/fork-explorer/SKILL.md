---
name: fork-explorer
description: >-
  可视化管理 Antigravity 会话分支树（Fork 任意轮次、支持完整复刻/Amp 轻装交接/Git Worktree 隔离）、打开跨平台工作区与系统资源管理器（Finder / Explorer 定位）、查看 512K 上下文水位并自动/手动 Fork 接力、以及全文检索与高保真导出历史会话。当用户提到「fork」「分支对话」「打开资源管理器」「在访达中显示」「打开文件夹」「导出对话」「找回历史」时使用。
---

# AGY 时空驾驶舱（`/fork-explorer`）

本技能指导你调用 `agy-fork-explorer` 插件的 MCP 工具与右侧时空驾驶舱面板。

## 可用工具（MCP 服务：`agy-fork-explorer_fork_explorer`）

1. **`fork_conversation`**：从当前或指定会话的任意轮次分叉新会话。
   - 参数：`conversationId`（取 `<user_information>` 中的 Conversation ID）、`upToTurn`（可选，截止轮次号，默认最后一轮）、`mode`（`exact` | `handoff` | `files_only`）、`branchLabel`（可选分支名）、`workspaceRoot`（可选）、`createWorktree`（bool，是否同步创建 Git Worktree 隔离目录）、`createSnapshot`（bool，分叉前保存无侵入 Git 快照）。
2. **`show_files_inline`**：在聊天流中渲染 Codex 风格交互式文件交付卡，用户可直接点击「在访达/资源管理器显示」「默认应用打开」「原生 Tab 打开」「`@` 注入上下文」或「复制路径」。
3. **`reveal_in_explorer`**：跨平台在系统文件管理器高亮选中指定路径（macOS `open -R` / Windows `explorer.exe /select,` / Linux `xdg-open`；文件不存在时自动回退打开最近存在的上级目录）。
4. **`list_fork_tree`**：查看当前项目的会话分支谱系树与 Worktree 状态。
5. **`export_session`**：将指定会话高保真导出为 Markdown 或 JSON（含轮次时间、可选思考链、工具调用与改动文件清单），并返回导出文件路径。
6. **`search_sessions`**：只读检索 `~/.gemini/antigravity/brain/` 下全部本地会话（含侧栏消失的临时 Scratch 会话）。

## 打开右侧时空驾驶舱

当用户希望在侧栏图形化查看分支 DAG 图、浏览工作区文件树、切换收藏目录或管理历史与快照时，在回复中附带一键胶囊链接：

`[打开 AGY 时空驾驶舱](sidecar://agy-fork-explorer/cockpit/)`

## 原生增强模式（类 `agy-powertools` 体验）

若用户希望在 Antigravity 原生界面上直接获得「聊天气泡悬停 Fork」「原生 `file://` 胶囊右键在访达/资源管理器打开」「输入框旁微型 Context 水位环」，告知用户使用插件自带的零侵入脚本启动即可自动挂载，无需修改应用本体：
- macOS / Linux：`~/.gemini/config/plugins/agy-fork-explorer/scripts/launch-with-cdp.sh`
- Windows：`%USERPROFILE%\.gemini\config\plugins\agy-fork-explorer\scripts\launch-with-cdp.ps1`
