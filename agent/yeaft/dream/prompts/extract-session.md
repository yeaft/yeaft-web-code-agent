<!-- lang:en -->
# Dream Extract — Session Scope

You are extracting **memory segments** from a session conversation. This pass focuses on a specific **`sessions/<id>` scope**: durable facts about one collaboration session and its shared context.

The target session id is provided as `{{sessionId}}`.

## What to extract for `sessions/<id>` scope

- **purpose** — what this session exists to do, its charter or mission
- **members** — users, session members, roles, and what each is responsible for
- **workflow** — reusable ways this session should work: review flow, merge/tag ritual, handoff order, testing expectations
- **preferences** — user or project preferences that affect future execution in this session
- **pitfalls and corrections** — mistakes, rejected approaches, and user corrections that should prevent repeated errors
- **shared decisions** — durable agreements the session should remember
- **shared context** — domain or project knowledge the whole session relies on
- **current state** — recent PRs, reviews, blockers, next steps, or release status that matter now, but only when still actionable
- **lessons** — generalized experience that should guide future turns in this session

## What NOT to extract here

- Private user preferences that should live in `user`.
- Facts about one VP only; those belong in the session VP scope.
- Topic-specific details that should live under a session topic scope.
- One-off chatter with no future value.

## Output

Return a JSON array only. Each item must have `kind`, `body`, `tags`, `sourceMessages`, and `confidence`.

Allowed `kind` values include `workflow`, `preference`, `lesson`, `pitfall`, `correction`, `project-convention`, `decision`, `goal`, `fact`, and `context`.

Make the segment useful to a future session member who needs the big picture plus the latest actionable detail. Prefer stable, reusable memory over a chronology of completed actions. A completion record is useful only if it changes what future work should do next.

<!-- lang:zh -->
# Dream Extract — Session Scope

你正在从一段 session 对话中抽取 **memory segments**。本轮关注特定 **`sessions/<id>` scope**：一个协作 session 的稳定事实和共享上下文。

目标 session id 会以 `{{sessionId}}` 提供。

## `sessions/<id>` scope 应抽取什么

- **purpose** — 这个 session 存在的目的、charter 或 mission
- **members** — 用户、session member、角色，以及各自负责什么
- **workflow** — 之后可复用的工作方式：review 流程、merge/tag 节奏、交接顺序、测试要求
- **preferences** — 会影响后续执行的用户偏好或项目偏好
- **pitfalls and corrections** — 已犯错误、被拒绝的做法、用户纠偏，避免之后重复
- **shared decisions** — session 之后应该记住的稳定决策
- **shared context** — 整个 session 依赖的领域或项目信息
- **current state** — 当前重要的 PR、review、阻塞、下一步或 release 状态，但只保留仍会影响下一步的内容
- **lessons** — 未来 turn 应继续遵守的规则化经验

## 不要在这里抽取什么

- 应进入 `user` 的用户私人偏好。
- 只关于某个 VP 的事实；这些应进入 session VP scope。
- 应进入 session topic scope 的主题细节。
- 没有未来价值的一次性闲聊。

## 输出

只返回 JSON array。每一项必须包含 `kind`、`body`、`tags`、`sourceMessages` 和 `confidence`。

允许的 `kind` 包括 `workflow`、`preference`、`lesson`、`pitfall`、`correction`、`project-convention`、`decision`、`goal`、`fact` 和 `context`。

segment 应帮助未来的 session member 快速理解大背景和最新可执行细节。优先保留可复用经验，不要只写完成事项流水账；只有仍会改变下一步执行方式的完成记录才值得保留。
