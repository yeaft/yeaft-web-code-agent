# Work Center

Work Center 是 Yeaft 的 Agent 级持久目标执行系统。`WorkItem` 保存目标、验收条件、交付边界与对话；`Action` 是当前需要的工作单元；`Run` 是一次带身份隔离的执行尝试。

## 当前实现与兼容边界

- WorkItem 属于 Agent，保存在 `<yeaftDir>/work-center/`；Session 只作为来源与关联入口，不共享 transcript 或生命周期。
- 新任务由 Coordinator 根据当前事实动态创建必要的 Action，不要求预建阶段、依赖图或固定数量的角色接力。`sourceActionIds` 表达结果来源。
- Runner 复用现有 Yeaft Engine；Run 必须提交结构化 outcome，turn 结束不能自动变成任务完成。
- Workspace 冲突限制实际并发；`isolated-write` 使用 Git worktree，需要集成其结果。`read` 分类不是 OS sandbox。
- 旧 workflow snapshot、依赖和 final gate 仍是兼容合同，不代表新的产品必须继续围绕 Action graph 展示。
- Session 后台作业 `agent/yeaft/tasks/` 与 WorkItem 是不同系统。

## 任务优先的用户路径

1. 从 Work Center 或 Session 创建目标，选择 workspace 与交付目标。
2. 创建时若没有单列验收条件，直接以用户目标作为最低验收条件。Coordinator 只为当前缺口创建 Action；修改目标、验收或交付边界必须来自用户的明确补充，不能在自动推进时扩大或降低标准。
3. Run 提交 outcome、证据与验收检查；Coordinator 据此继续、请求人工输入或完成任务。
4. Agent 提供 `goalProgress` 时，详情展示已验证条件数、剩余条件、阻塞与独立交付状态；浏览器不把 Action 数量当作目标完成度。旧 Agent 保留普通验收列表。
5. `response` 交付有证据支持的答复，不强制生成代码产物；`workspace_files`、`pull_request`、`merge` 分别要求对应的文件、PR、commit 证据，仍遵守权限与评审策略。
6. Agent 提供 `finalResult.responses` 时，详情显示答复及可展开的 Run 来源/证据。主对话保持主要入口，Actions 按需查看。

## 文档状态

- [用户指南（中文）](../zh-CN/guide/user/work-center.md) / [User guide](../guide/user/work-center.md)：当前交互、证据进度与兼容行为。
- [会话式执行模型设计](./conversation-model-design.md)：设计背景与演进方向，不是所有能力均已上线的声明。
- [架构与数据流](./architecture.md)、[领域合同](./domain-contract.md)、[Wire API](./wire-api.md)：含旧实现合同；动态协调与投影以当前源码为准。
- [交付阶段与验证](./delivery-plan.md)：历史分阶段计划，不是当前功能清单。

证据进度和回复展示依赖 Agent 提供相应 wire 投影。本次界面不新增自动部署、任意工具隔离或深层证据导航能力；不能把设计方向当作交付承诺。
