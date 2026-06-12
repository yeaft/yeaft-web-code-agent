# Workbench 工作台

Workbench 是 Yeaft 集成在聊天界面右侧的**开发工具面板** — 终端、文件浏览器、Git、端口代理，所有跑在 Agent 机器上，**不用你打开 SSH 或 VS Code**。

适合："我在跟 Claude 讨论代码，想顺手看看输出 / 改个文件 / 跑个测试"。

## 打开 Workbench

- sidebar header 上的 **Workbench 图标**（面板布局图标）
- 折叠 sidebar 模式下也有该图标
- 打开后聊天区域右侧出现 Workbench 面板
- **最大化** — 占满除 sidebar 外的所有空间
- **折叠** — 收起来留个边
- 拖左边缘的**调整手柄**改宽度

> Workbench 的 tabs（terminal / files / git / proxy）取决于 Agent 的 capabilities（`terminal`、`file_editor` 等）。Agent 不支持的 tab 不会显示。

## Terminal 终端

完整的终端模拟器（xterm.js + PTY），连到 Agent 机器：

- **分屏** — header 上的 ─（水平）/ │（垂直）按钮，可以同时跑多个终端
- **关闭面板** — × 关闭当前活跃终端面板
- **自动创建** — Agent 执行 bash 工具调用时**自动创建**一个终端 panel 显示输出
- 点终端 panel 让它成为活跃（高亮边框）
- 字体 / 颜色跟随主题
- 支持所有终端操作：vim、tmux、htop 都能跑

## Files 文件管理

VS Code 风格的文件浏览器 + 编辑器。

### 文件树（左栏）
- 层级目录，可展开 / 折叠
- 文件 / 文件夹有类型图标
- **搜索** — 顶部输入框按名字过滤
- **Ctrl+P** — 快速打开文件搜索（fuzzy match）
- **+ 新建文件** / **新建文件夹** — 工具栏按钮
- **🗑 删除** / **➡ 移动** — 选文件后操作工具栏
- **↻ 刷新** — 重新加载目录树
- **▼ 全部折叠** — 收起所有展开的目录
- **📂 打开文件夹** — 用文件夹选择器换根目录
- **拖放上传** — 从桌面拖文件到文件树

### 编辑器（右栏，CodeMirror）
- **多 tab** — 多个文件同时编辑
- **语法高亮** — 主流语言全支持
- **查找 / 替换** — Ctrl+F / Ctrl+H
- **Ctrl+S** 保存（文件写到 Agent 机器）
- **Office 文档** — doc/docx/xls/xlsx/ppt 可选本地预览或 Office Online 预览（设置里配）
- **图片预览** — png/jpg/gif/webp 直接预览
- **PDF 预览** — 内嵌渲染

**字体大小** — Ctrl+滚轮 调整文件树字体。

## Git 版本控制

可视化 git 状态查看器：

- **分支显示** — 当前分支 + ↑N 落后 / ↓N 领先 commit 数
- **Push** — 推到远端（如有 commit 待推）
- **Pull** — 拉远端更新
- **Fetch** — 仅拉更新不合并
- **文件列表**：
  - 已 staged 改动
  - 未 staged 改动
  - Untracked 文件
  - 每条显示状态标记（M / A / D / R / ?）
- **Diff 查看器** — side-by-side 或 unified 模式
- **暂存 / 取消暂存** — 单文件 / 全部
- **Commit** — 写 commit message + 提交
- **Branch 切换** — 下拉切换 / 新建分支
- **工作目录** — 文件夹选择器选哪个 repo

> 不支持的：merge conflict 可视化解决（请用 terminal 解决）、interactive rebase

## Port Proxy 端口代理

把 Agent 机器上跑的本地服务暴露到浏览器：

- **+ 添加端口** — 填 Agent、host、port、可选标签
- **开关** — 单条规则启停
- **🌐 在浏览器打开** — 新 tab 访问代理 URL
- **📋 复制 URL** — 复制到剪贴板

典型用法：
- Agent 机器上跑 `npm run dev`（监听 :3000） → 加代理 → 浏览器访问
- Agent 机器跑 Jupyter（:8888） → 代理 → 浏览器访问
- 远程 DB 管理工具

> Port Proxy 也在 设置 → 代理 tab 里有相同界面，两边数据一致。

## 跟聊天的协同

Workbench 不是替代聊天，是辅助：

- **AI 写文件** → 你打开 Files 看 / 改
- **AI 跑命令** → 自动 spawn 一个 terminal panel
- **AI 改了 git 状态** → Git tab 实时刷新
- **AI 启服务** → 加个 Port Proxy 直接访问

## 性能建议

- 一次开太多大文件、几个长跑终端、几个 dev server 代理 — 浏览器会卡
- 关掉不用的 tab / panel 能立刻缓解
- Files 编辑器加载超大文件（>10MB）会变慢，建议用 terminal 操作

## 常见问题

**Workbench tab 缺一些**
- Agent 不支持该 capability — 升级 Agent 或检查 Agent 启动日志

**Terminal 打不开 / 一直转圈**
- Agent 端 PTY 启动失败 — 看 `yeaft-agent logs`
- 多半是 node-pty 没装好；重装 Agent

**Files 编辑器保存失败**
- Agent 端权限问题 — 确认 Agent 用户对该路径有写权限

**Port Proxy 打不开**
- 目标端口在 Agent 机器上**没在监听** — 先确认服务真的起了
- Agent 防火墙没放 — 看 server / Agent 错误日志
