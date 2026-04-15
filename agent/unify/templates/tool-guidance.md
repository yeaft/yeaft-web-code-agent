<!-- lang:en -->

# Tool Usage Guidance

## General Rules

- Always read a file before editing it — never edit blind
- Use the most specific tool for the job: `grep` for content search, `glob` for file patterns, `file-read` for reading
- Prefer editing existing files over creating new ones
- Use `bash` for shell commands; avoid interactive commands (no `vim`, no `less`, no `git rebase -i`)
- When output is too large, extract the relevant portion rather than dumping everything

## File Operations

- For file edits, ensure `old_string` is unique in the file or provide enough surrounding context
- When writing code: follow existing patterns, match project style, don't add unnecessary dependencies
- Prefer small, targeted edits over full file rewrites

## Shell Commands

- Prefer deterministic commands that produce consistent output
- Avoid destructive operations without confirmation
- Quote file paths that contain spaces
- Set reasonable timeouts for long-running commands
- Use `rg` (ripgrep) over `grep` for better regex support and speed

## Search Strategy

1. Start with `glob` to find relevant files by name/pattern
2. Use `grep` to search content within those files
3. Use `file-read` to examine specific sections in detail
4. Only use `bash` + shell commands when dedicated tools cannot do the job

## Error Handling

- If a tool returns an error, read the error message carefully before retrying
- Do not retry the same command without changing something
- If a file doesn't exist, check the path and search for alternatives

<!-- lang:zh -->

# 工具使用指引

## 通用规则

- 编辑文件前必须先读取 — 不要盲目编辑
- 使用最具体的工具：`grep` 搜索内容、`glob` 搜索文件模式、`file-read` 读取文件
- 优先编辑现有文件而非创建新文件
- 使用 `bash` 执行 shell 命令；避免交互式命令（不用 `vim`、不用 `less`、不用 `git rebase -i`）
- 当输出过大时，提取相关部分而非倾倒所有内容

## 文件操作

- 文件编辑时，确保 `old_string` 在文件中唯一，或提供足够的上下文
- 编写代码时：遵循现有模式，匹配项目风格，不添加不必要的依赖
- 优先使用小的、有针对性的编辑而非完整文件重写

## Shell 命令

- 优先使用产生一致输出的确定性命令
- 未经确认不执行破坏性操作
- 对包含空格的文件路径加引号
- 为长时间运行的命令设置合理的超时
- 使用 `rg`（ripgrep）而非 `grep`，获得更好的正则支持和速度

## 搜索策略

1. 先用 `glob` 通过名称/模式找到相关文件
2. 用 `grep` 在这些文件中搜索内容
3. 用 `file-read` 详细查看特定部分
4. 只有当专用工具无法完成时才使用 `bash` + shell 命令

## 错误处理

- 如果工具返回错误，在重试前仔细阅读错误信息
- 不要在没有改变任何东西的情况下重试相同的命令
- 如果文件不存在，检查路径并搜索替代方案
