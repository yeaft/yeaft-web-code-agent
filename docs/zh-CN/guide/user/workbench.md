# Workbench 工作台

Workbench 是 Chat 和 Yeaft Session 右侧的开发工具面板。终端、Git 和文件运行在所选 Agent 上；浏览器直接使用客户端设备。工具状态绑定所属 Session 及其工作目录。

## 打开和关闭 Workbench

使用 Chat 顶栏或 Yeaft Session 操作区中的 **Workbench** 按钮。

Workbench 首先显示包含四张能力卡的选择页：

- **终端** — 在当前 Session 工作目录中运行命令
- **Git** — 查看仓库状态和代码差异
- **文件** — 浏览、预览和编辑 Agent 本地文件
- **浏览器** — 通过客户端 iframe 打开外部 HTTP/HTTPS 网页，无需配置 Agent 浏览器

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
- 预览 Markdown、图片、PDF、支持的 Office 文档，以及浏览器支持的 MP4、M4V、WebM、OGV/OGG 和 MOV 视频；视频从 Agent 流式读取，也可直接下载

HTML（`.html` / `.htm`）和 Markdown 默认打开预览，可通过 **预览 / 编辑** 切换；预览使用当前编辑内容，即使尚未保存。HTML 使用隔离的静态预览，保留内联样式及 data 图片，不执行脚本、不跳转链接、不提交表单，也不加载外部或相对路径资源；需要完整交互或多文件网页时，请使用项目的本地开发服务器。

从回复中点击文件引用时，Workbench 会直接进入当前 Session route 对应的文件能力，加载文件内容；引用带行号时定位到起始行。支持 Markdown 链接、行内代码和普通文本中的路径，例如 `src/main.js:20-35`、`src/main.js#L20-L35`、`docs/设计说明.md`。包含空格的路径请使用行内代码或 Markdown 链接。

文件引用会在流式输出期间分批识别，回复结束后再次确认。只有当前 Agent 确认存在于该 Session workspace 中的文件才显示为可点击链接；不存在、重名且无法唯一确定、或 workspace 外的路径不会自动链接。外部 HTTP/HTTPS 链接在 Workbench 浏览器中打开，不会映射成本地同名文件；Ctrl/Cmd 点击保留浏览器原生新标签页行为。

临时解析错误最多自动重试两次。已完成回复中尚未解析的路径，在当前 Session 后续工作结束时最多再检查两次，以识别稍后创建的文件，不会无限轮询。若点击后读取失败或连接中断，Files 会显示错误；连接恢复后再次点击同一引用即可重新读取，无需关闭页签。已加载的内容和未保存的编辑不会因重复点击而被覆盖。

非视频二进制预览和下载支持最大 20 MiB 的文件。视频使用有界字节范围流式传输，不受整文件传输上限影响。支持 Session route 的预览地址不会因切换 Session 或 Server 的 10 分钟文件缓存回收而过期；缓存未命中时，Server 自动从原 Agent 读取，无需手动续期。地址是绑定原用户、Agent、Session 和 workspace 的访问凭据，请勿公开分享。每次访问都会检查当前权限；Agent 离线、文件删除、Session 归档或工作目录变化会导致访问失败。回源读取的是原路径的当前内容，不是永久快照。轮换 Server 的 `JWT_SECRET` 会使既有地址失效。旧版无 Session route 的预览仍使用临时缓存。

## Git

Git 显示当前 Session 所选仓库的状态：

- 分支及 ahead/behind 状态
- 已暂存、已修改和未跟踪文件
- 文件差异
- 暂存、取消暂存、丢弃、提交和推送
- 在当前 Session workspace 中选择其他仓库的文件夹选择器

合并冲突和 interactive rebase 请使用终端处理。

## 浏览器

浏览器直接在客户端 iframe 中打开 HTTP/HTTPS 页面，不启动 Agent 浏览器、不安装 Chromium、不使用 WebRTC，也不经 Server 代理页面流量。无需 Browser Runtime 能力，Work Center 中也可使用。

- 普通点击回复、Markdown 文件预览或工作项交付物中的外链，会在这里打开；Ctrl/Cmd 点击、中键和下载链接保留原生行为。
- 支持地址输入、刷新和**新标签页打开**。地址栏保留打开时的地址；跨域重定向和页面内部导航无法可靠观测，因此不提供虚假的前进/后退按钮。
- 地址仅在所属 Agent/Session 或工作项及 workspace 内恢复，只保留到 Workbench 组件销毁。切换工具可恢复最后打开的地址；关闭浏览器标签清除地址，刷新 Yeaft 页面也会清除临时状态。
- `localhost` 和内网地址指的是**客户端设备和网络**，不是 Agent。HTTPS 的 Yeaft 页面可能阻止 HTTP 内容。
- 网站可以通过 CSP 或 `X-Frame-Options` 禁止嵌入。空白 iframe 不代表加载成功，可用**新标签页打开**；Yeaft 不绕过这些限制。
- 沙箱允许脚本和表单，不授予同源、弹窗和顶层导航权限。这保护控制面，但可能限制登录、存储和交互。拒绝包含凭据的地址及 Yeaft 同源目的地。外部网页不继承 Yeaft 的深浅主题。

旧 Agent Browser Runtime 配置和 CLI 保留兼容，当前 Workbench 视图不使用它们。打开此视图不会修改已有 Runtime 进程或实例数据。

## 常见问题

**某项能力不可用**

- 终端、Git 和文件需要所选 Agent 的对应 capability；route-scoped 工具还需要 `workbench_session_routes`。浏览器不需要 Agent 浏览器能力。
- 必要时升级 Agent，并检查启动日志

**终端打不开**

- 检查 Agent 日志中的 PTY 启动错误
- 确认 Agent 安装包含受支持的 PTY 后端

**文件或 Git 指向错误项目**

- 确认当前选中的 Session 及其工作目录
- 修改 Session metadata 后，关闭并重新打开对应能力

**文件无法保存**

- 确认 Agent 进程用户对目标路径有写权限
