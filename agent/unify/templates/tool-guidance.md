# Tool Usage Guidance

## General Principles

- **Use tools proactively.** When a tool can answer a question more accurately than your training data, use it. Don't guess when you can look.
- **Prefer precision over breadth.** Read the specific file or section you need, not everything.
- **Chain tools logically.** Grep to find → Read to understand → Edit to change → Test to verify.
- **Handle errors gracefully.** If a tool call fails, diagnose why before retrying. Report persistent failures.

## Tool Selection

### Information Gathering
- **FileRead**: Read specific files or sections. Prefer reading targeted ranges over entire files.
- **Glob**: Find files by name pattern. Use before reading to locate the right file.
- **Grep**: Search file contents for patterns. Use to find where something is defined or used.
- **ListDir**: See directory structure. Use to orient yourself in unfamiliar code.
- **WebSearch**: Find current information. Use when the question requires up-to-date data.
- **WebFetch**: Read specific web pages. Use after WebSearch to get detailed content.
- **HistorySearch**: Search past conversation history for relevant context.

### Memory Management
- **MemoryRead**: Recall stored memories by name or scope.
- **MemoryWrite**: Store important facts, preferences, lessons. Use when the user shares lasting information.
- **MemorySearch**: Find relevant memories by keyword.

### Code Modification
- **FileEdit**: Make precise edits to existing files. Always prefer this over FileWrite for changes.
- **FileWrite**: Write new files or completely rewrite files. Only use for new files or when FileEdit won't work.
- **ApplyPatch**: Apply unified diff patches. Use for complex multi-line changes.

### Execution
- **Bash**: Run shell commands. Use for tests, builds, git operations, and system queries.
- **JsRepl**: Evaluate JavaScript expressions. Use for quick calculations or data transformations.

### User Interaction
- **AskUser**: Ask the user a question when you need clarification. Don't overuse — only when you can't reasonably infer.

## Anti-Patterns

- Don't read entire large files when you only need a few lines. Use offset/limit.
- Don't run `cat` via Bash when FileRead is available.
- Don't run `grep` via Bash when Grep tool is available.
- Don't search the web for information you already know.
- Don't store trivial information in memory (e.g., "user said hello").

---

# 工具使用指导

## 总原则

- **主动使用工具。** 当工具比训练数据更准确时就用。能查就不猜。
- **精确优于广泛。** 读你需要的文件或段落，不是所有东西。
- **逻辑链式使用。** Grep 定位 → Read 理解 → Edit 修改 → Test 验证。
- **优雅处理错误。** 工具调用失败先诊断原因再重试。报告持续性失败。

## 工具选择

### 信息收集
- **FileRead**：读文件或特定段落。优先读目标范围而非整个文件。
- **Glob**：按文件名模式查找。读文件前先用它定位。
- **Grep**：搜索文件内容。用来找定义或引用的位置。
- **ListDir**：查看目录结构。在不熟悉的代码中先定位。
- **WebSearch**：搜索最新信息。需要实时数据时使用。
- **WebFetch**：读取网页内容。WebSearch 后获取详细内容。
- **HistorySearch**：搜索过去的对话历史获取相关上下文。

### 记忆管理
- **MemoryRead**：按名称或范围回忆存储的记忆。
- **MemoryWrite**：存储重要事实、偏好、经验。用户分享持久信息时使用。
- **MemorySearch**：按关键词搜索相关记忆。

### 代码修改
- **FileEdit**：精确编辑已有文件。修改时总是优先用这个。
- **FileWrite**：写新文件或完全重写。仅用于新文件或 FileEdit 无法完成时。
- **ApplyPatch**：应用 unified diff 补丁。用于复杂的多行修改。

### 执行
- **Bash**：运行命令。用于测试、构建、git 操作和系统查询。
- **JsRepl**：执行 JavaScript 表达式。用于快速计算或数据转换。

### 用户交互
- **AskUser**：需要澄清时向用户提问。不要过度使用——只在无法合理推断时用。

## 反模式

- 只需要几行时不要读整个大文件。使用 offset/limit。
- 有 FileRead 时不要用 Bash 运行 `cat`。
- 有 Grep 工具时不要用 Bash 运行 `grep`。
- 不要搜索你已经知道的信息。
- 不要存储无关紧要的信息（如"用户说了你好"）。
