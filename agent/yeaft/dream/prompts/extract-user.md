<!-- lang:en -->
# Dream 抽取 — 用户作用域

You are extracting **memory segments** from a session conversation. This pass focuses on the **`user` scope**: long-lived facts about the user themselves.

## What to extract for `user` scope

Extract segments that describe the user as a person:

- **identity** — name, role, location, languages spoken, time zone
- **preferences** — tools they use, code style, communication style, what they value
- **habits / workflow** — how they work, recurring patterns, process expectations
- **goals (long-term)** — what they are building, where they want to go
- **relations** — people, projects, or orgs they regularly mention
- **lessons / opinions** — durable views the user has formed or confirmed

## What NOT to extract here

- Anything specific to one session, feature, project, VP, or topic; those belong in narrower scopes.
- Temporary task status, transient debugging notes, or one-off implementation details.
- Facts inferred only from the assistant's guesswork.

## Output

Return a JSON array only. Each item must have:

- `kind`: short category such as `preference`, `workflow`, `goal`, `identity`, `opinion`
- `body`: one concise factual sentence, grounded in the conversation
- `tags`: short lowercase tags
- `sourceMessages`: message ids that support the segment
- `confidence`: number from 0 to 1

Prefer fewer, higher-value segments. Do not invent facts.

<!-- lang:zh -->
# Dream 抽取 — 用户作用域

你正在从一段会话对话中抽取 **记忆段**。本轮只关注 **`user` 作用域**：关于用户本人的长期事实。

## `user` 作用域应抽取什么

抽取描述用户本人的记忆段：

- **identity** — 姓名、角色、所在地、使用语言、时区
- **preferences** — 使用的工具、代码风格、沟通风格、重视什么
- **habits / workflow** — 工作方式、重复出现的习惯、流程期待
- **goals (long-term)** — 用户长期在构建什么、想达到什么
- **relations** — 经常提到的人、项目或组织
- **lessons / opinions** — 用户已经形成或确认的稳定观点

## 不要在这里抽取什么

- 只属于某个 session、feature、project、VP 或 topic 的内容；这些应进入更窄的 scope。
- 临时任务状态、短期调试记录、一次性实现细节。
- 只来自模型猜测、没有对话证据支持的事实。

## 输出

只返回 JSON 数组。每一项必须包含：

- `kind`：短类别，例如 `preference`、`workflow`、`goal`、`identity`、`opinion`
- `body`：一句简洁事实，必须基于对话证据
- `tags`：简短 lowercase tags
- `sourceMessages`：支持该 segment 的 message ids
- `confidence`：0 到 1 的数字

宁可少抽，也要抽高价值内容。不要编造事实。
