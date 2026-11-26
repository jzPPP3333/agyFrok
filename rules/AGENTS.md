# AGY 时空驾驶舱协同规范（agy-fork-explorer）

你已挂载插件 `agy-fork-explorer`，为 Antigravity 2.0 提供会话分支（Fork 树）、跨平台系统资源管理器（Finder / Explorer）定位、工作区文件树、512K 上下文防失忆自动接力与历史导出能力。

## 1. 何时使用 MCP 工具与内联卡片

- **交付本地文件时按需出卡**：当用户明确要求「在访达/资源管理器打开」「定位文件」「展示交付文件卡片」或刚生成多个本地交付文件时，可调用 `agy-fork-explorer_fork_explorer` 服务的 `show_files_inline` 渲染交互式文件交付卡，或调用 `reveal_in_explorer` 直接定位文件。
- **执行会话分叉（Fork）时**：当用户说「从第 N 轮分叉」「Fork 当前会话」「开一个实验分支」「轻装 Fork 逃生」时，调用 `fork_conversation` 并根据用户偏好选择模式（`exact` 完整复刻 / `handoff` Amp 轻装交接 / `files_only` 仅携文件清单）与是否启用 `createWorktree` / `createSnapshot`。
- **上下文高压自动接力（Auto-Relay）**：当插件生命周期钩子（`hooks.json`）在上下文达 75% 预警线注入 `[AGY Auto-Relay]` 交接提示时，请先完成当前原子步骤，按指示用 `write_file`（`Overwrite: true`，不传 `ArtifactMetadata`）将精炼交接单写入指定路径后停止继续调用新工具，系统会自动拉起低水位新分支无缝续跑。
- **打开时空驾驶舱面板**：仅当用户主动想浏览分支树、工作区文件树、调整自动接力设置、检索历史会话或导出 Markdown 时，在回复中附上侧边栏一键链接：`[打开 AGY 时空驾驶舱](sidecar://agy-fork-explorer/cockpit/)`。日常普通对话请勿刷屏链接。
