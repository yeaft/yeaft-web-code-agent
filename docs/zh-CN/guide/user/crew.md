# Crew 团队协作

Crew 模式让多个 Claude Code Agent 角色（PM、Dev、Reviewer、Tester、Designer 等）作为一个**团队**协同工作 — PM 拆任务、Dev 写代码、Reviewer 审、Tester 测，角色之间通过 ROUTE 协议自动流转。

> Crew 是基于 **Claude Code CLI** 的多角色协作模式。每个角色 = 一个独立的 Claude Code 进程，跑在独立 worktree。所以 Crew 需要 Agent 机器装好 Claude Code CLI，并且每个角色都消耗一份 token。

## 创建 Crew Session

1. sidebar 点 **Crew Sessions** 旁的 **+**
2. 弹出 Crew Session 配置向导：

### Step 1 — 选 Agent
- 列表只显示**在线** + 有 `crew` capability 的 Agent
- Crew 比单个 chat 资源消耗大（多角色 + 多 worktree），挑机器配置好点的

### Step 2 — 设置工作区
- 选项目根目录（`.crew/` 会创建在这里）
- 如果该目录已有 `.crew/`，会弹出选项：
  - **恢复上次 session** — 加载 `.crew/state.json`、所有角色、kanban
  - **删除并重置** — 清干净从头开始

### Step 3 — 配置团队
- **团队名**（可选，≤30 字符）
- **团队模板** — 选预置模板或从空开始
- **角色列表** — 可以加 / 删 / 调每个角色

### Step 4 — 启动
- 点 **启动**
- 状态条显示初始化进度："准备角色..." → "设置工作区..." → 完成

## 团队模板

| 模板 | 描述 | 角色 |
| --- | --- | --- |
| **开发团队** | 软件开发 | PM、Dev、Reviewer、Tester、Designer |
| **写作团队** | 创意写作 | 编辑、撰稿、校对 |
| **交易团队** | 金融交易 | 策略师、风控、执行 |
| **短视频团队** | 视频制作 | 编剧、剪辑、制作 |
| **自定义** | 空白模板 | 无预定义角色 |

模板有中英双语版本，跟界面语言走。

## 角色配置

每个角色有以下属性：

| 属性 | 描述 |
| --- | --- |
| **图标** | Emoji / 短文本（≤4 字符），头像显示 |
| **显示名** | UI 中的名字 |
| **描述** | 一句话职责说明 |
| **决策者** | ★ 星标 — 每个团队**仅一个**决策者，统一协调 |
| **自定义 Prompt** | 高级 — 给这个角色附加额外的 `CLAUDE.md` 指令 |
| **并发数** | Dev / Reviewer / Tester 可设 1–3 并行实例 |

**添加角色：**
- 点 **添加角色** 打开预设选择器
- 预设：PM、Dev、Reviewer、Tester、Designer、Architect、Ops、Researcher
- 有的角色有捆绑关系（加 Dev 会同时加 Reviewer + Tester）
- 自定义角色 — 从零开始

**移除角色：**
- 卡片右上角 **×**
- 移除决策者时，第一个剩余角色自动接任

## 使用 Crew

### 发消息
- 底部输入框输入文本
- **@** 提及指定角色（如 `@pm 拆一下这个 feature`）
  - 自动补全菜单显示可选角色
  - **↑** / **↓** 导航，**Enter** 选中
- **Enter** 发送，**Shift+Enter** 换行
- **不写 @** — 默认走决策者，由 PM 路由给具体角色

### 消息展示
- 消息按 **Feature 线程**分组（可折叠区块）
- 每条 Feature 线程显示：
  - 任务标题作 header
  - 状态：⏳ 进行中 / ✓ 完成
  - 正在处理的角色头像
  - **查看历史** toggle — 看旧消息
  - 最新消息始终展开
- **全局消息**（没绑 feature）直接显示在 Feature 区块外
- **Round 分隔线**标记新一轮对话
- 底部 **Latest** 区域显示任意角色的最近一条消息

### 状态栏
输入框上方显示：
- **Round 编号**（R0、R1、R2...）
- **费用**（USD）
- **Token 总数**

## Feature 与任务管理

**Feature 面板**（右栏）= 看板风格的任务板。

### 总进度
顶部进度条："3 / 5 — 60%"

### 进行中
每个活跃 feature / task 一张卡，包含：
- 任务标题
- 进度条
- 正在处理的角色头像
- 创建以来的时长
- 可展开的 todo 列表
- 点击卡片标题展开 / 折叠
- 双击卡片跳到消息流中对应 feature

### 已完成
默认折叠，点头部展开 — 显示完成的 feature 和总耗时

## 面板布局

### 桌面端（>768px）
- **三栏**：角色面板（左）| 消息区（中）| Feature 面板（右）
- 两个侧面板可通过 header 按钮切换显隐（👤 = 角色，📊 = Feature）
- 隐藏侧面板时，消息区自动撑满

### 移动端（≤768px）
- **单栏** — 默认只显示消息区
- header 上的 **角色** / **Feature** 按钮打开抽屉
- 点暗色遮罩或抽屉内 **关闭** 按钮关掉

## Session 控制

### 角色面板底部
- **+ 添加角色** — 给运行中 session 加新角色
- **× 清空 session** — 清所有消息 + 重置 session（需确认）
- **⏹ 停止全部** — 终止所有角色进程

### 单个角色卡片
- **⏹ 中止** — 停这个角色当前任务（仅活跃时显示）
- **🗑 清除** — 清这个角色的聊天记录

### Crew 设置（header 齿轮）
- 改团队名
- 增 / 删角色
- **应用更改** — 实时生效

## 跟 Yeaft 会话 的区别

|  | Crew | Yeaft 会话 |
| --- | --- | --- |
| 引擎 | Claude Code CLI（每角色一进程） | Yeaft 自有引擎 |
| 模型 | 仅 Claude（CLI 决定） | 每 VP 独立选 provider/model |
| 记忆 | session 内 | 跨 session H2-AMS 持久 |
| 路由 | ROUTE 协议自动（PM 调度） | @mention + `route_forward` 显式 |
| 工具 | Claude Code 完整 skill / MCP 生态 | Yeaft 自带 40+ 工具 |
| 资源 | 每角色一进程，多 worktree | 共享 engine，VP 是逻辑实体 |

**用 Crew**：你已经在 Claude Code 生态，要做一个具体 feature 的完整流水线（拆 → 写 → 审 → 测）
**用 Yeaft 会话**：你需要长期记忆 + 多 provider 自由组合 + 多 VP 并行讨论

详细对比看 [选择会话后端](./choose-backend.md)。
