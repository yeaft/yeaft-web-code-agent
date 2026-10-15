# Person：用户理解与 Dream 上下文

## 行为边界

Person 服务用户的真实利益，而不是最大化金钱、工具调用、活动或待办数量。明确承诺与对潜在结果的推测必须分开：用户谈期货，不等于想赚钱，更不等于授权交易。允许讨论更简单的手段、替代路径和原始前提，也允许角色自身的兴趣与好奇心参与探索；不能据此改写用户意愿。

`agent/yeaft/person/behavior.js` 提供 `executionBehavior(kind)`，对 `send`、`think`、`dream` 返回不同的执行入口指令。它不是每步认知协议，不要求输出隐藏推理。能在现有权限内以低成本、可逆实验取得有用证据时，应实际执行并整合结果，而不只给建议。没有强制工具、实验、替代方案或新颖概念数量；没有有用行动时可以安静休息。

父级运行时负责在工具执行之前拼接指令，并按完整执行文本和最终认知文本预留预算。本模块不创建调度器、不启用自主运行。宿主提供的触发来源与自主权限元数据是限制，不是用户新增授权；调度器文本和空 Think 不是独立的用户报告。

## 持久用户理解

可选 `state.understanding` 是最多 12 项、总计最多 8192 UTF-8 字节的数组。每项包含且只包含：

- `kind`：`goal`、`preference` 或 `constraint`。
- `statement`：非空，最多 1000 UTF-8 字节。
- `epistemicState`：`reported`、`hypothesis` 或 `uncertain`。
- `sourceRefs`：1 到 24 个已经实际读取的精确来源引用，包含版本。

`reported` 还需要独立用户报告的 lineage，不能从工具输出、助手进度或生成文本中取得。Dream 只能保留此前完全相同的 reported 项（类型、陈述、引用顺序均相同），不能独立新增或提升 reported 理解。父级调用 `validateProposal` 时必须传入 `state: snapshot.state`，否则 Dream 显式提交 reported 项会被拒绝。保留不代表重新读取旧引用；若显式重提项，仍需当前 episode 的准确 read-set，必要时先 recall。

省略字段保留此前理解，显式 `[]` 清空，`null` 不合法。`stateView` 将此字段投影到当前状态、context、提交历史；没有该字段的旧数据保持兼容，无需 schema 迁移。理解和 continuation 都是可撤回的记忆，不是权限；最新取消、纠正和禁止优先。

## 确定性、有界上下文

存储层 `context()` 的普通路径最多返回 12 条消息、12 个焦点概念和 12 个最近概念。若长助手进度串挤掉最新用户消息，将移除一条较旧消息以保留该用户消息。

Dream 改为以下组合：

- 最近 6 条用户消息。
- 从更早用户消息中跨 episode 确定性轮换最多 4 条。
- 最多 2 条非 progress 的助手回复。
- 最多 12 个焦点概念、6 个最近概念，以及按 `claim/question/method/self-model/scenario/interest` 六种类型各轮换最多 1 个较旧概念。较旧集合排除焦点和最近集合。

因此消息最多 12 条，Dream 去重前概念最多 24 条。按消息序号恢复时序；概念焦点优先，不伪造来源或 revision。轮换基于 admission 的 `inputWatermark - 1`，同一 episode 稳定，即使之前 episode 未 commit 也会前进。消息不足时不重复补足，不为满足数量制造内容。

SQL 使用 scope 内的计数与小页 offset 查询，不使用 LLM 摘要，不随机采样整个数据库，也不在 JS 中载入全量记录。角色与概念类型存在 JSON 中，计数/offset 仍可能扫描 scope 内的索引/记录；这不是常量时间查询，也不保证语义主题均匀分布。未来若实际规模需要优化，应依据测量添加对应索引，而不是引入摘要模型。

快照附带 `latestUserInstruction`（完整最新用户消息或 null）和 `contextSelection`（策略、轮换、数量上限、按实际 revision 生成的来源引用）。这些是存储层的选择元数据；不代表所有记录一定通过模型窗口预算。**父级运行时必须把最新用户指令作为 mandatory context 预算保留，或因窗口不足失败，不能静默丢弃。** 可选消息与概念仅在实际被模型读取时进入 read-set。上下文选择元数据本身不赋予来源读取或执行权限。

## 集成与验证范围

本改动不修改 `runtime.js`、service、task host、capabilities 或 execution protocol。宿主集成需完成执行入口指令拼接与预算、当前状态传入验证、新用户指令 mandatory admission，以及调度来源的独立用户报告判定。

聚焦测试覆盖字段/字节/数量/来源/lineage 拒绝、Dream 禁止新增 reported、重开持久化、投影和提交历史、省略保留与显式清空、进度洪流后的取消指令、用户及概念轮换、精确 source refs 与 owner 隔离。行为文本测试只能验证提示词契约，不证明模型一定遵循，也不是自主调度或外部效果的端到端验证。
