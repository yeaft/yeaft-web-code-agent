# Workbench 工作台

Workbench 是 Chat 和 Yeaft Session 右侧的开发工具面板。工具运行在所选 Agent 上，并严格绑定当前 Session 及其工作目录。

## 打开和关闭 Workbench

使用 Chat 顶栏或 Yeaft Session 操作区中的 **Workbench** 按钮。

Workbench 首先显示包含四张能力卡的选择页：

- **终端** — 在当前 Session 工作目录中运行命令
- **Git** — 查看仓库状态和代码差异
- **文件** — 浏览、预览和编辑 Agent 本地文件
- **浏览器** — Browser Runtime 可用时查看并控制 Agent 本地浏览器

四张卡始终可见。标记为**当前 Agent 不可用**的卡仍可打开查看可用性说明，但不会启动虚假或残缺的工具。

只有用户选择的能力才会启动。关闭当前能力会返回选择页，并把键盘焦点还给原来的能力卡；关闭 Workbench 才会收起整个面板。面板也支持最大化和拖动左侧边缘调整宽度。

Workbench 使用规范的 Session route。即使两个 Session 位于同一个 Agent，切换 Session 也会返回选择页，并隔离前一个 Session 的终端、Git 和文件状态。

## 终端

终端通过 xterm.js 连接 Agent 上的 PTY：

- 在所选 Session 的工作目录中启动
- 支持水平和垂直分屏
- 支持 `vim`、`tmux`、`htop` 等常规终端程序
- 终端状态只属于创建它的 Session route

使用终端工具栏分屏或关闭终端 pane。使用 Workbench 返回按钮可回到能力选择页，而不收起整个 Workbench。

## 文件

文件能力提供类似 VS Code 的文件树、编辑器和预览界面。

### 文件树

- 展开和折叠目录
- 使用 `Ctrl+P` 快速打开文件
- 新建、删除、移动、复制或上传文件
- 刷新目录树，或在当前 Session workspace 中选择其他文件夹

### 编辑和预览

- 多文件编辑和语法高亮
- 使用 `Ctrl+F` / `Ctrl+H` 查找和替换
- 使用 `Ctrl+S` 保存到 Agent
- 预览 Markdown、图片、PDF 和支持的 Office 文档

从聊天消息打开文件引用时，Workbench 会直接进入当前 Session route 对应的文件能力。

## Git

Git 显示当前 Session 所选仓库的状态：

- 分支及 ahead/behind 状态
- 已暂存、已修改和未跟踪文件
- 文件差异
- 暂存、取消暂存、丢弃、提交和推送
- 在当前 Session workspace 中选择其他仓库的文件夹选择器

合并冲突和 interactive rebase 请使用终端处理。

## 浏览器

浏览器保留在选择页中，让能力是否可用清晰可见。当前 Browser Runtime Phase 0 基础实现不会声明可用的 Browser capability，也没有向 Web UI 提供 signaling、查看器或用户输入链路。因此当前 Agent 显示不可用状态，而不是伪造一个嵌入式浏览器。

未来 Agent 只有声明完整的 Browser capability 组合后，Workbench 才会把浏览器标记为可用。

## 常见问题

**某项能力不可用**

- 确认所选 Agent 是否声明了对应 capability；route-scoped 工具还需要 `workbench_session_routes`
- 必要时升级 Agent，并检查启动日志

**终端打不开**

- 检查 Agent 日志中的 PTY 启动错误
- 确认 Agent 安装包含受支持的 PTY 后端

**文件或 Git 指向错误项目**

- 确认当前选中的 Session 及其工作目录
- 修改 Session metadata 后，关闭并重新打开对应能力

**文件无法保存**

- 确认 Agent 进程用户对目标路径有写权限
