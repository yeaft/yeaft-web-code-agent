<!-- lang:en -->
# Dream Extract — Topic Scope

You are extracting **memory segments** from a session conversation. This pass focuses on a specific **session topic scope**: durable facts, decisions, and viewpoints about one recurring topic.

The target topic id is provided as `{{topicId}}`.

## What to extract for the topic scope

- **core facts** — durable knowledge about the topic that the user taught or confirmed
- **viewpoints / opinions** — stable views the user or session formed on this topic
- **canonical references** — docs, files, PRs, issues, papers, or people treated as authoritative
- **patterns** — how this session usually applies the topic
- **lessons** — gotchas, mistakes, corrections, or rules learned while working on the topic
- **current state** — latest PR/review/todo/status that still matters for this topic

## What NOT to extract here

- User biography or broad preferences unrelated to the topic.
- Session-wide charter information that is not specific to this topic.
- Details about one VP unless they matter to this topic.

## Output

Return a JSON array only. Each item must have `kind`, `body`, `tags`, `sourceMessages`, and `confidence`.

Keep the topic memory sharp: enough background to orient the next turn, plus current details that should not be lost.

<!-- lang:zh -->
# Dream Extract — Topic Scope

你正在从一段 session 对话中抽取 **memory segments**。本轮关注特定 **session topic scope**：关于某个反复出现主题的稳定事实、决策和观点。

目标 topic id 会以 `{{topicId}}` 提供。

## topic scope 应抽取什么

- **core facts** — 用户教过或确认过的、关于该主题的稳定知识
- **viewpoints / opinions** — 用户或 session 对该主题形成的稳定观点
- **canonical references** — 被视为权威的文档、文件、PR、issue、论文或人员
- **patterns** — 这个 session 通常如何应用该主题
- **lessons** — 围绕该主题学到的坑、错误、纠正或规则
- **current state** — 该主题当前仍重要的 PR、review、todo 或状态

## 不要在这里抽取什么

- 与主题无关的用户履历或广泛偏好。
- 与该主题无关的 session-wide charter 信息。
- 除非影响该主题，否则不要抽取单个 VP 的细节。

## 输出

只返回 JSON array。每一项必须包含 `kind`、`body`、`tags`、`sourceMessages` 和 `confidence`。

保持 topic memory 精准：既要有下一轮需要的大背景，也要保留不该丢失的当前细节。
