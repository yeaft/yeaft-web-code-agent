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

二进制预览和下载支持最大 20 MiB 的文件。支持 Session route 的预览地址不会因切换 Session 或 Server 的 10 分钟文件缓存回收而过期；缓存未命中时，Server 自动从原 Agent 读取，无需手动续期。地址是绑定原用户、Agent、Session 和 workspace 的访问凭据，请勿公开分享。每次访问都会检查当前权限；Agent 离线、文件删除、Session 归档或工作目录变化会导致访问失败。回源读取的是原路径的当前内容，不是永久快照。轮换 Server 的 `JWT_SECRET` 会使既有地址失效。旧版无 Session route 的预览仍使用临时缓存。

## Git

Git 显示当前 Session 所选仓库的状态：

- 分支及 ahead/behind 状态
- 已暂存、已修改和未跟踪文件
- 文件差异
- 暂存、取消暂存、丢弃、提交和推送
- 在当前 Session workspace 中选择其他仓库的文件夹选择器

合并冲突和 interactive rebase 请使用终端处理。

## 浏览器

浏览器能力会在所选 Agent 上启动一个隔离的 Chromium 进程，并通过实时 WebRTC 视频显示当前标签页。Browser Session 只保存在内存中，使用临时 profile，并受 Agent 配置的 Session 数量和空闲回收上限约束。

当前查看器是只读的。导航、键盘、鼠标和滚动控制将在下一阶段交付；本版本不会伪装这些控制已经可用。

### 启用 Browser Runtime

Viewer 数据面目前**只支持 Linux x64 Agent**。其他平台可能可以执行 CLI install/status，但不会声明 ready viewer capability。

Server 默认开放浏览器路由。所选 Agent 仍保持未启用状态，只有用户明确操作后才会下载浏览器：

1. 选择 Linux x64 Agent，打开 **Workbench → 浏览器**。浏览器未就绪时，能力卡显示**需要启用**，设置面板会显示准确的固定构建号和当前平台下载大小。仅打开面板不会开始下载。
2. 点击一次**启用浏览器**。Workbench 会显示真实字节数和百分比；Agent 下载并校验归档，只安装到该 Agent instance 的数据目录，持久化启用配置，执行本机媒体 probe，刷新 capability，然后自动开始连接 Viewer。UI 路径没有第二个启用按钮，也不需要重启 Agent。
3. 为部署配置 ICE。Agent probe 会验证 Chrome、tab capture、VP8 和同机 WebRTC 回环，但无法验证远程 Web 到 Agent 的网络路径。`BROWSER_STUN_URLS` 可用于直连；跨 NAT 或受限网络的生产部署应部署 TURN，并配置 `BROWSER_TURN_URLS` 和 `BROWSER_TURN_SECRET`。禁止直连候选时设置 `BROWSER_ICE_TRANSPORT_POLICY=relay`。多个 URL 使用英文逗号分隔。自托管模板位于仓库的 `deploy/browser-turn/` 目录。

管理员可以设置 `BROWSER_RUNTIME_ENABLED=false` 并重启 Server，从而全局关闭 Browser setup、信令和 viewer route。这是管理员停用开关，不是普通用户设置步骤。

无人值守运维可使用等价的 instance-scoped CLI。每条命令都必须选择与运行中 Agent 相同的 `--name` 或 `--yeaft-dir`：

```bash
yeaft-agent browser install --name <agent-instance>
yeaft-agent browser probe --name <agent-instance>
yeaft-agent browser enable --name <agent-instance>
yeaft-agent restart --name <agent-instance>  # managed Agent service
yeaft-agent browser status --name <agent-instance>
```

CLI `enable` 会持久化 `browserRuntime.enabled=true`，但不会刷新已经运行的 Agent 进程。CLI enable 后应重启 managed service；前台 Agent 则要停止后重新启动。`browser probe` 会实际检查固定 Chrome build、扩展、tab capture、offscreen runtime 和 WebRTC 媒体链路。`browser status` 只报告所选 instance 的配置和 managed browser 安装状态，因此仅有 `installed: true` 不代表 viewer 已 ready。

Linux tab-capture probe 成功后会声明 `browser_runtime`、`browser_webrtc` 和 `browser_capture_tab`。只有 Web 协议协商、Server 管理员停用开关和完整 Agent capability 组合都允许时，Workbench 才会启用 viewer。未声明 `browser_runtime_setup` 的旧 Agent 若已经声明 probe-ready viewer capabilities，仍保持兼容。

未配置 TURN 时可能通过 direct ICE 工作，但这只是降级的 direct-only 部署，不能保证跨 NAT 或受限网络的生产可用性。

### Session 生命周期

- 打开浏览器时会恢复该 Agent 上已有的 ready Browser Session；没有时才新建
- 关闭浏览器能力只会 detach viewer；无 viewer 后 Agent 会按空闲超时回收 Session
- 点击“结束浏览器”会立即关闭 Chromium 并删除临时 profile
- WebSocket 或 Agent transport replacement 会使旧 peer generation 失效，并 fail-closed 关闭 Agent Browser Session
- SDP、ICE candidate、TURN credential、视频和临时 profile 数据都不会写入 Chat 或 Yeaft transcript

## 常见问题

**某项能力不可用**

- Browser 应先执行 `yeaft-agent browser status --name <agent-instance>`，确认输出的 `yeaftDir` 与运行中的 Agent 相同
- 执行 `yeaft-agent browser probe --name <agent-instance>`；非零退出或 `ok: false` 都表示 Chrome/媒体链路未 ready
- 确认 Agent 是 Linux x64、Server 没有显式设置 `BROWSER_RUNTIME_ENABLED=false`，并且 Agent 声明了 `browser_runtime`、`browser_webrtc` 和 `browser_capture_tab`
- 其他能力应确认所选 Agent 声明了对应 capability；route-scoped 工具还需要 `workbench_session_routes`
- 必要时升级 Agent，并检查启动日志

**终端打不开**

- 检查 Agent 日志中的 PTY 启动错误
- 确认 Agent 安装包含受支持的 PTY 后端

**文件或 Git 指向错误项目**

- 确认当前选中的 Session 及其工作目录
- 修改 Session metadata 后，关闭并重新打开对应能力

**文件无法保存**

- 确认 Agent 进程用户对目标路径有写权限
