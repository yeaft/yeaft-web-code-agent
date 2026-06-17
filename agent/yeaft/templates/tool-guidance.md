<!-- lang:en -->

# Tool Usage Guidance

## General Rules

- Always read a file before editing it — never edit blind
- Use the most specific tool for the job: `grep` for content search, `glob` for file patterns, `file-read` for reading
- Prefer editing existing files over creating new ones
- Use `bash` for shell commands; avoid interactive commands (no `vim`, no `less`, no `git rebase -i`)
- When output is too large, extract the relevant portion rather than dumping everything
- **Batch independent tool calls in a single turn.** When the next few steps don't depend on each other's output (e.g. reading three sibling files, or running `grep` + `glob` to triangulate), emit them as parallel tool calls in one assistant turn instead of one-per-turn.

## File Operations

- For file edits, ensure `old_string` is unique in the file or provide enough surrounding context
- When writing code: follow existing patterns, match project style, don't add unnecessary dependencies
- Prefer small, targeted edits over full file rewrites
- **A file is "large" only at >3000 lines.** Below that, read it whole. Don't pre-emptively split a 500-line file into three `offset`/`limit` reads — that's three round-trips for the same content.

## Shell Commands

- Prefer deterministic commands that produce consistent output
- Avoid destructive operations without confirmation
- Quote file paths that contain spaces
- Set reasonable timeouts for long-running commands
- Use `rg` (ripgrep) over `grep` for better regex support and speed

## Search Strategy

Pick the shortest path that gets you the answer — don't always start at step 1.

1. **If you already know the file path** → go straight to `file-read` (or `grep` for a pattern within it). Skip `glob`.
2. **If you know roughly which directory but not the file** → `grep` directly with a `glob` or `type` filter; that's one tool call, not two.
3. **If you have nothing but a pattern of file names** → start with `glob`, then `grep` / `file-read`.
4. Use `bash` only when no dedicated tool can do the job.

When several of these steps are independent (e.g. reading three files you already know the paths of), issue them as **parallel tool calls in one turn**, not three sequential turns.

## Error Handling

- If a tool returns an error, read the error message carefully before retrying
- Do not retry the same command without changing something
- If a file doesn't exist, check the path and search for alternatives

## Multi-Step Task Tracking (TodoWrite)

When the task you're about to do has **3+ meaningful steps**, the user
gave you a **list** of things to do, or you're starting a **non-trivial
multi-file change** — call `TodoWrite` **first** to lay out the
checklist. The user sees the items tick off in real time as you work.

How to use it:

- First call: enumerate every step with status `"pending"`, mark
  exactly one as `"in_progress"`.
- Each subsequent call: rewrite the **full** list. Mark the
  just-finished item `"completed"` and promote the next one to
  `"in_progress"`.
- At most **one** item may be `"in_progress"` at any time.
- `content` is the imperative form (e.g. "Run tests"); `activeForm` is
  the present-continuous form shown during execution (e.g. "Running
  tests").

Do **not** use TodoWrite for single trivial edits, single command runs,
or pure conversational/question turns — the checklist becomes noise.

<!-- lang:zh -->

# 工具使用指引

## 通用规则

- 编辑文件前必须先读取 — 不要盲目编辑
- 使用最具体的工具：`grep` 搜索内容、`glob` 搜索文件模式、`file-read` 读取文件
- 优先编辑现有文件而非创建新文件
- 使用 `bash` 执行 shell 命令；避免交互式命令（不用 `vim`、不用 `less`、不用 `git rebase -i`）
- 当输出过大时，提取相关部分而非倾倒所有内容
- **同一个回合内并行调用互不依赖的工具。** 接下来几步如果彼此输出不依赖（比如读三个并列文件，或者 `grep` + `glob` 一起定位），就在一个助手回合里并行发出多个工具调用，不要一次一个回合地串行。

## 文件操作

- 文件编辑时，确保 `old_string` 在文件中唯一，或提供足够的上下文
- 编写代码时：遵循现有模式，匹配项目风格，不添加不必要的依赖
- 优先使用小的、有针对性的编辑而非完整文件重写
- **"大文件" 的标准是 > 3000 行。** 没超过就整文件读完，不要把一个 500 行的文件预先拆成三段 `offset`/`limit` 读 —— 那是三次回合读同一份内容。

## Shell 命令

- 优先使用产生一致输出的确定性命令
- 未经确认不执行破坏性操作
- 对包含空格的文件路径加引号
- 为长时间运行的命令设置合理的超时
- 使用 `rg`（ripgrep）而非 `grep`，获得更好的正则支持和速度

## 搜索策略

挑能拿到答案的最短路径，不必每次都从第 1 步开始。

1. **已经知道文件路径** → 直接 `file-read`（或在该文件里 `grep` 找模式）。跳过 `glob`。
2. **大致知道目录但不知道文件** → 直接 `grep` 配合 `glob` / `type` 过滤；这一步本身就够，不用先 `glob` 再 `grep`。
3. **只有文件名模式** → 先 `glob`，再 `grep` / `file-read`。
4. 只有当专用工具都做不到的时候才用 `bash`。

如果上面这些步骤里有几个互不依赖（比如要读三个你已经知道路径的文件），**在同一个 turn 里并行调用**，不要串成三个回合。

## 错误处理

- 如果工具返回错误，在重试前仔细阅读错误信息
- 不要在没有改变任何东西的情况下重试相同的命令
- 如果文件不存在，检查路径并搜索替代方案

## 多步骤任务追踪（TodoWrite）

当你要做的事 **≥3 个有意义的步骤**、用户给了你一组任务、或者你即将开始
**复杂的多文件改动**时——**先**调用 `TodoWrite` 列出待办清单。用户会
实时看到这些条目被勾选。

使用方式：

- 第一次调用：枚举所有步骤，状态全部 `"pending"`，仅把一项标记为
  `"in_progress"`。
- 之后每次调用：重写**完整**清单——把刚完成的项改成 `"completed"`，下
  一项改成 `"in_progress"`。
- 任何时刻最多只能有 **一个** `"in_progress"`。
- `content` 是命令式（如 "Run tests"）；`activeForm` 是执行中展示的进行
  时（如 "Running tests"）。

**不要**为单条琐碎修改、单次命令执行、纯对话/问题使用 TodoWrite——清单
反而成了噪音。
