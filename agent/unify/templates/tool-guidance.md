<!-- lang:en -->

# Tool Usage Guidance

The `Available tools:` line above lists the tool names registered this session — the set is dynamic. Below is the catalog of what Yeaft's built-in tools do and when to reach for them. If a tool is not in the "Available tools" line, it is not registered this session — do not call it.

## When to Use Which — Quick Routing

- **"Read / find / search something in the codebase"** → `file-read`, `glob`, `grep`, `list-dir` (never `bash cat`)
- **"Change a file"** → `file-edit` (surgical) > `apply-patch` (multi-hunk) > `file-write` (only for new files or full rewrites)
- **"Run a command"** → `bash`. For long-running commands, set `run_in_background: true` and read output later.
- **"Check / recall what I know"** → `memory-query` (fuzzy semantic search) or `memory-read` (exact id / path). Do NOT grep the memory store by hand.
- **"Save something worth remembering"** → `memory-write`. Only for durable facts; see the Memory section of Unified Mode.
- **"Look up current information on the web"** → `web-search` for discovery, `web-fetch` for reading a specific URL.
- **"Delegate to a sub-agent"** → `agent` (spawn) + `send-message` + `wait-agent` + `close-agent`. Use personas (explorer / implementer / researcher / reviewer) for specialised work.
- **"Track a multi-turn piece of work"** → `task-create`, `task-update`, `task-list`, `task-get`, `task-progress`.
- **"Invoke a skill"** → `skill` (pass skill name + args). If the user asks for `/something`, treat it as a skill invocation.
- **"Ask the user a blocking question"** → `ask-user`. See Ask-User policy in Unified Mode.
- **"Work in isolation on a branch"** → `enter-worktree` / `exit-worktree`.

## Tool Catalog by Category

### Filesystem & search
- `file-read` — read a file (supports `offset`/`limit` for large files). Always read before editing.
- `file-edit` — surgical string replacement. `old_string` must be unique in the file; include enough surrounding context.
- `file-write` — create a new file or fully replace an existing one. Prefer `file-edit` for modifications.
- `apply-patch` — apply a unified-diff patch across multiple hunks / files.
- `glob` — find files by pattern (`src/**/*.ts`). Faster than `find`.
- `grep` — ripgrep-backed content search. Supports regex, type filters, context lines. Never call `rg`/`grep` via `bash`.
- `list-dir` — directory listing. Use for small exploratory listings; otherwise prefer `glob`.

### Shell & code execution
- `bash` — run shell commands. Quote paths with spaces. Set sensible timeouts. Use `run_in_background` for long jobs.
- `js-repl` — run JS snippets in a persistent REPL (state survives between calls in the same session).
- `js-repl-reset` — reset the REPL state.
- `notebook-edit` — edit a Jupyter notebook cell by index.

### Memory
- `memory-read` — read memory entries by id / scope / exact path.
- `memory-write` — save a new memory entry (kind, scope, tags, title, content).
- `memory-query` — fuzzy semantic search across the memory store. Use this for "do I know anything about X?".
- `memory-search` — file-backed memory loader (scoped lookup by path). Distinct from `memory-query`.

### Web
- `web-search` — search the web, returns titles + snippets + URLs.
- `web-fetch` — fetch a specific URL and get LLM-digested content.
- `history-search` — search prior conversations for relevant turns.

### Agents (crew)
- `agent` — spawn a sub-agent with a persona (explorer / implementer / researcher / reviewer). Returns an agent id.
- `send-message` — send a prompt to a running sub-agent.
- `wait-agent` — block until the sub-agent finishes its turn, then read its reply.
- `close-agent` — terminate a sub-agent when you're done with it. Always close when finished.
- `list-agents` — list running agents.

### Tasks & threads
- `task-create` / `task-update` / `task-list` / `task-get` — CRUD for long-lived tasks.
- `task-progress` — append a progress note.
- `task-memory` — attach memory entries to a task.
- `followup-task` — create a task that chains from the current one.
- `update-plan` — update the plan attached to a task.
- `spawn-thread` / `switch-thread` / `list-threads` / `attach-thread-to-task` — thread management (task-299 Phase 1).
- `spawn-task` — spawn a task off the current thread.
- `read-thread-summary` / `read-thread-recent` — read thread state.

### Other
- `skill` — invoke a named skill pack. Match `/command` from the user to a skill name first.
- `ask-user` — ask the user a blocking question (with choices or free-text).
- `enter-worktree` / `exit-worktree` — switch the session into an isolated git worktree for non-trivial development.
- `image-generation` — generate an image from a prompt.
- `view-image` — describe an image the user provided.
- `tool-search` — discover tools by keyword when unsure which to use.
- `request-permissions` — request elevated permissions for a gated action.
- `write-stdin` — write to the stdin of a running background process.

## General Rules

- Always read a file before editing it — never edit blind.
- Use the most specific tool for the job. `bash grep` when `grep` exists is a smell.
- Prefer editing existing files over creating new ones.
- Avoid interactive shell commands (no `vim`, no `less`, no `git rebase -i`, no `git add -i`).
- When tool output is large, extract the relevant portion rather than dumping it all.
- If a tool returns an error, read the error carefully before retrying. Do not retry the same call unchanged.
- If a file doesn't exist where you expected, `glob` or `list-dir` to find it — do not guess.

## Anti-patterns (don't do this)

- Calling `bash cat file.js` when `file-read` exists.
- Calling `bash grep -r 'foo' .` when `grep` exists.
- Calling `bash ls dir/` when `list-dir` or `glob` exists.
- Serializing independent reads (read file A, wait, read file B, wait…) when they could be batched in one turn.
- Saving volatile state to memory (CWD, PID, today's date).
- Spawning a sub-agent for a 10-second task you could do yourself.

<!-- lang:zh -->

# 工具使用指引

上面那行 `可用工具：` 列的是本会话实际注册的工具名 — 集合是动态的。下面是 Yeaft 内建工具的目录和使用场景。如果某工具没出现在"可用工具"里，说明本会话未注册，不要调用它。

## 快速选型 — 什么时候用什么

- **"读 / 找 / 搜索代码里的东西"** → `file-read`、`glob`、`grep`、`list-dir`（不要 `bash cat`）
- **"改一个文件"** → `file-edit`（精确改）> `apply-patch`（跨段改）> `file-write`（仅用于新建或整文件重写）
- **"跑一条命令"** → `bash`。长任务设 `run_in_background: true`，稍后读输出。
- **"查我知道什么"** → `memory-query`（模糊语义搜索）或 `memory-read`（精确 id/路径）。不要手动 grep 记忆库。
- **"保存值得记住的东西"** → `memory-write`。只存持久事实；详见 Unified Mode 的 Memory 部分。
- **"查网上最新信息"** → `web-search` 做发现，`web-fetch` 读某个具体 URL。
- **"派给子 agent"** → `agent`（启动）+ `send-message` + `wait-agent` + `close-agent`。专项工作用 persona（explorer / implementer / researcher / reviewer）。
- **"追踪跨轮次的工作"** → `task-create`、`task-update`、`task-list`、`task-get`、`task-progress`。
- **"调用技能"** → `skill`（传技能名 + 参数）。用户说 `/something` 时优先当成技能调用。
- **"向用户提阻塞性问题"** → `ask-user`。遵循 Unified Mode 的 ask-user 策略。
- **"在独立分支上工作"** → `enter-worktree` / `exit-worktree`。

## 按类别的工具目录

### 文件系统与搜索
- `file-read` — 读文件（大文件支持 `offset`/`limit`）。编辑前必须先读。
- `file-edit` — 精确字符串替换。`old_string` 必须在文件中唯一，带足够上下文。
- `file-write` — 新建或整文件重写。修改优先用 `file-edit`。
- `apply-patch` — 跨多段/多文件的 unified-diff 补丁应用。
- `glob` — 按模式找文件（`src/**/*.ts`）。比 `find` 快。
- `grep` — ripgrep 驱动的内容搜索，支持正则、类型过滤、上下文行。不要走 `bash` 的 `rg`/`grep`。
- `list-dir` — 目录列出。小范围探索用它，大范围用 `glob`。

### Shell 与代码执行
- `bash` — 跑 shell 命令。含空格路径加引号。设合理超时。长任务用 `run_in_background`。
- `js-repl` — 在持久化 REPL 跑 JS 片段（同会话内 state 跨调用保留）。
- `js-repl-reset` — 重置 REPL state。
- `notebook-edit` — 按 index 编辑 Jupyter notebook cell。

### 记忆
- `memory-read` — 按 id / scope / 精确路径读取记忆条目。
- `memory-write` — 保存新记忆条目（kind、scope、tags、title、content）。
- `memory-query` — 对记忆库做模糊语义搜索。"我是否知道关于 X 的事"用这个。
- `memory-search` — 基于文件的记忆加载器（按路径 scoped 查找）。与 `memory-query` 不同。

### Web
- `web-search` — 搜索网页，返回标题 + 摘要 + URL。
- `web-fetch` — 拉取某个 URL 并获得 LLM 消化过的内容。
- `history-search` — 在历史会话中搜索相关轮次。

### Agents（团队）
- `agent` — 启动一个带 persona（explorer / implementer / researcher / reviewer）的子 agent，返回 agent id。
- `send-message` — 向运行中的子 agent 发消息。
- `wait-agent` — 阻塞等待子 agent 完成当前轮次，读回复。
- `close-agent` — 用完之后关闭子 agent。做完必须关。
- `list-agents` — 列出运行中的 agent。

### 任务与 thread
- `task-create` / `task-update` / `task-list` / `task-get` — 长任务的 CRUD。
- `task-progress` — 追加进度记录。
- `task-memory` — 挂接记忆到任务。
- `followup-task` — 从当前任务派生一个后续任务。
- `update-plan` — 更新挂在任务上的计划。
- `spawn-thread` / `switch-thread` / `list-threads` / `attach-thread-to-task` — thread 管理（task-299 Phase 1）。
- `spawn-task` — 在当前 thread 上派生任务。
- `read-thread-summary` / `read-thread-recent` — 读 thread 状态。

### 其他
- `skill` — 调用一个命名的 skill pack。用户的 `/command` 先映射到 skill 名。
- `ask-user` — 向用户提阻塞性问题（选项或自由输入）。
- `enter-worktree` / `exit-worktree` — 非 trivial 开发切到独立 git worktree。
- `image-generation` — 按 prompt 生成图片。
- `view-image` — 描述用户提供的图片。
- `tool-search` — 不确定用哪个工具时按关键字查。
- `request-permissions` — 为受限操作申请权限。
- `write-stdin` — 向后台进程的 stdin 写入。

## 通用规则

- 编辑文件前必须先读 — 不要盲改。
- 使用最具体的工具。`grep` 工具存在时还走 `bash grep` 是 smell。
- 优先编辑现有文件，不要动辄新建。
- 避免交互式 shell 命令（不用 `vim`、`less`、`git rebase -i`、`git add -i`）。
- 工具输出过大时，提取相关部分，不要全倾倒。
- 工具返回错误时先仔细看错误信息再重试。不要不变更地重复调用同一条。
- 预期文件不在预期路径，用 `glob` 或 `list-dir` 找 — 不要猜。

## 反模式（不要这么做）

- `file-read` 存在时还 `bash cat file.js`。
- `grep` 存在时还 `bash grep -r 'foo' .`。
- `list-dir`/`glob` 存在时还 `bash ls dir/`。
- 把彼此独立的读操作串行化（读 A 等 B 等 C），应该一轮批量发起。
- 把易变状态存进记忆（CWD、PID、今天日期）。
- 10 秒就能自己做完的事去启动一个子 agent。
