# Cosmos 原生 Session：按需查询共享知识

在 Cosmos 的原生会话中，可以请模型查找本 Agent 其他会话留下的决策、约定或经验。具备授权来源时，此轮可调用只读工具 `SharedKnowledgeSearch`（`query`，可选 `limit`）。工具返回有界的匹配结果与来源 `sessionId / seq / messageId`，仅供参考，不是指令或已核实事实。普通发言不会自动查询或注入知识；空索引返回空结果。

- Cosmos 会话抽屉和快捷输入只发送 `cosmosDelivery: true`。Server 丢弃客户端提交的 `_knowledgeSessionIds`；通过 Agent 访问检查后，Server 为已认证账号从 SQLite 生成同账号、同 Agent 的未归档 Session ID 列表。直发还要求目标属于该账号且未归档。隐藏是界面偏好，不撤销已拥有来源的授权。
- 快捷输入的授权列表只用于分配后的原生 Session 执行，不进入候选集、评分或路由决策 prompt。若选择既有目标，则目标也须在授权列表中；若新建目标，不将其补进来源列表。若快捷输入仅回答正在等待的 AskUser，则不会新开带知识授权的 turn。
- Agent 与 Server 均协商 `session_shared_knowledge`。授权随用户输入 envelope 传递，不写入用户消息，不作为 Session 设置缓存，也不传给子 Agent 或内部交接。附加到正在执行的 query 的输入不改变该 query 的授权或历史边界。旧 Server / 旧 Agent 继续收发 Session 消息，只是不提供此查询。
- 工具使用 Agent 实例的数据根、Server 授权来源、当前 Session 和持久化用户消息的排他序号，以及当前执行的取消信号，调用 `agent/yeaft/shared-knowledge/store.js#searchSharedKnowledge`。存储层负责对全部来源再次校验和过滤已删除来源。已返回的工具内容遵循普通 Session 工具结果的持久化和历史策略；删除来源会阻止新的查找，不会改写先前对话。
- 本路径不调用 Dream、Work Center 或旧 Share，不写入知识库，也不新增浏览器搜索 API。
