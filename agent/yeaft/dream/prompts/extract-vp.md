<!-- lang:en -->
# Dream 抽取 — VP 作用域

You are extracting **memory segments** from a session conversation. This pass focuses on a specific **session VP scope**: durable facts about one Virtual Person in this session.

The target VP id is provided as `{{vpId}}`. Only extract facts about this VP, not other VPs.

## What to extract for the VP scope

- **identity / charter** — who this VP is in the session and what it is expected to own
- **voice / style** — how this VP should think, speak, format, and decide
- **expertise** — what the VP is good at and what it should defer
- **interaction patterns** — what the user typically asks this VP to do and expected response shape
- **boundaries** — things this VP must not do, or should avoid
- **current state** — this VP's latest task, mistake, correction, review result, or handoff
- **relations** — other VPs, topics, or project areas this VP works with

## What NOT to extract here

- Generic user preferences that belong in `user`.
- Session-wide decisions that do not specifically involve this VP.
- Facts about other VPs.

## Output

Return a JSON array only. Each item must have `kind`, `body`, `tags`, `sourceMessages`, and `confidence`.

Prefer segments that make this VP behave better in the next turn.

<!-- lang:zh -->
# Dream 抽取 — 会话成员作用域

你正在从一段会话对话中抽取 **记忆段**。本轮关注特定 **会话成员作用域**：这个会话里某个会话成员 的稳定事实。

目标会话成员 id 会以 `{{vpId}}` 提供。只抽取关于这个会话成员 的事实，不要抽取其他会话成员。

## 会话成员作用域应抽取什么

- **identity / charter** — 这个会话成员 在会话中是谁，用户期待它负责什么
- **voice / style** — 这个会话成员 应如何思考、表达、排版和判断
- **expertise** — VP 擅长什么，哪些事情应交给别人
- **interaction patterns** — 用户通常让这个会话成员 做什么，期待什么输出形态
- **boundaries** — 这个会话成员 不能做或应避免的事情
- **current state** — 这个会话成员 最新任务、错误、纠正、review 结果或 handoff
- **relations** — 这个会话成员 关联的其他会话成员、topic 或项目区域

## 不要在这里抽取什么

- 应进入 `user` 的通用用户偏好。
- 与该会话成员 无关的 session-wide 决策。
- 关于其他会话成员 的事实。

## 输出

只返回 JSON 数组。每一项必须包含 `kind`、`body`、`tags`、`sourceMessages` 和 `confidence`。

优先抽取能让这个会话成员 在下一轮表现更好的 segment。
