const zh = {
  Skill: {
    description: '加载、查看和搜索 Yeaft skill 库中的工作流说明。用于发现某类任务是否已有可复用 skill，或读取指定 skill 的完整内容；不要用它执行普通文件搜索。',
    parameters: {
      action: '操作类型：list 列出 skill 元数据，view/load 读取指定 skill，search 按查询词匹配相关 skill。',
      name: '要读取的 skill 名称，仅在 view/load 时需要。',
      query: '搜索 skill 时使用的查询词，描述你要解决的任务。',
      filePath: '读取目录型 skill 的关联文件路径，例如 references/style-guide.md。',
      category: 'list 时可选的分类过滤条件。',
    },
  },
  EnterWorktree: {
    description: '为代码开发创建隔离 git worktree 和专用分支。任何功能开发、修 bug、测试性改动都应先进入 worktree，避免污染 main checkout；不要用它做普通目录切换。',
    parameters: {
      name: 'worktree 名称，会用于目录名和分支名；应使用有语义的 feat-/fix- 前缀。',
      base_ref: '新分支基于的 git ref；通常使用 HEAD 或 origin/main。',
    },
  },
  ExitWorktree: {
    description: '结束一个 git worktree 会话。用于开发完成后保留或删除隔离 worktree；删除有未提交改动的 worktree 前必须确认这些改动不再需要。',
    parameters: {
      path: '要退出的 worktree 路径。',
      action: 'keep 表示保留目录和分支；remove 表示删除 worktree 目录并删除分支。',
      discard_changes: 'remove 时是否丢弃未提交改动；只有确认改动已提交/合并或明确不需要时才设为 true。',
    },
  },
  AskUser: {
    description: '向用户提出一个真正阻塞继续推进的问题并等待回答。只在缺少关键信息会导致错误或不安全操作时使用；不要把它当作普通说明或反问。',
    parameters: {
      question: '要问用户的具体问题，应说明为什么需要这个信息。',
      options: '可选答案列表；当用户只需从固定选项中选择时提供。',
    },
  },
  WebSearch: {
    description: '搜索 Web 获取最新信息。用于查当前文档、版本、新闻、API 变更等训练数据可能过期的内容；已知 URL 应直接用 WebFetch。',
    parameters: {
      query: '搜索查询词；对时效性问题应包含年份、产品名或版本号。',
      limit: '最多返回多少条搜索结果。',
    },
  },
  WebFetch: {
    description: '抓取并读取指定 URL 的页面或 API 响应。用于阅读文档、文章、PR 页面或接口返回；不要用于本地文件，本地文件请用 FileRead。',
    parameters: {
      url: '完整 URL，必须包含 http:// 或 https://。',
      max_length: '返回内容的最大字符数；页面很大时提高该值或分段读取。',
      raw: '是否返回原始响应体；读取 API/JSON 时设为 true，普通网页通常设为 false。',
    },
  },
  HistorySearch: {
    description: '搜索已持久化的历史对话消息。用于找之前的决策、用户偏好、代码片段或上下文；不要用它搜索当前工作区文件。',
    parameters: {
      keyword: '大小写不敏感的搜索关键词。',
      limit: '最多返回多少条结果。',
    },
  },
  Bash: {
    description: '在 shell 中执行非交互式命令。用于运行测试、git/gh 命令、脚本和确定性诊断；避免交互式程序，不要执行未经用户允许的破坏性命令。',
    parameters: {
      command: '要执行的 shell 命令；需要引用文件路径时正确加引号。',
      cwd: '命令运行目录；代码改动和测试应在对应 worktree 中运行。',
      timeout_ms: '超时时间毫秒；长测试或构建可适当提高但不能超过工具上限。',
    },
  },
  FileRead: {
    description: '读取文本文件并带行号返回内容。编辑前必须先读文件；已知路径时直接使用它，不要先用 shell cat。',
    parameters: {
      file_path: '要读取的文件路径，可为绝对路径或相对当前工作目录。',
      offset: '从第几行开始读取，0 基；只有大文件或明确行段时才需要。',
      limit: '最多读取多少行；普通文件默认整段读取即可。',
    },
  },
  FileWrite: {
    description: '写入完整文件内容，会创建父目录并覆盖已有文件。适合新建文件或完整重写；修改已有文件时优先用 FileEdit 做小范围替换。',
    parameters: {
      file_path: '要写入的文件路径。',
      content: '完整文件内容，不是补丁或片段。',
    },
  },
  FileEdit: {
    description: '在已有文件中做精确文本替换。使用前必须读取文件；old_string 必须和文件内容完全一致，除非明确 replace_all，否则必须唯一。',
    parameters: {
      file_path: '要编辑的文件路径。',
      old_string: '要查找并替换的精确文本，必须与文件内容完全一致，包含空格、缩进和换行。',
      new_string: '替换后的文本。',
      replace_all: '是否替换所有匹配项；默认只允许唯一匹配，避免误改。',
    },
  },
  Glob: {
    description: '按 glob 模式查找文件路径。用于只知道文件名模式或扩展名时定位文件；如果要搜内容请用 Grep。',
    parameters: {
      pattern: 'glob 模式，例如 **/*.js 或 src/**/*.ts。',
      path: '搜索起始目录。',
      limit: '最多返回多少个文件。',
    },
  },
  Grep: {
    description: '用正则搜索文件内容。用于快速定位符号、错误文本、调用点或配置项；应结合 path、glob 或 type 缩小范围。',
    parameters: {
      pattern: '要搜索的正则表达式；特殊字符需要转义。',
      path: '要搜索的文件或目录。',
      output_mode: '输出模式：content 显示匹配行，files_with_matches 只列文件，count 显示计数。',
      glob: '文件名过滤 glob，例如 *.{js,css}。',
      type: '文件类型过滤，例如 js、py、rust。',
      case_insensitive: '是否忽略大小写。',
      context: 'content 模式下每个匹配周围显示的上下文行数。',
      before: 'content 模式下每个匹配前显示的行数。',
      after: 'content 模式下每个匹配后显示的行数。',
      multiline: '是否启用多行正则匹配。',
      head_limit: '最多返回多少条匹配结果。',
    },
  },
  ListDir: {
    description: '列出目录内容和文件大小。用于了解目录结构；需要查找模式时用 Glob，需要搜内容时用 Grep。',
    parameters: {
      path: '要列出的目录路径。',
      show_hidden: '是否显示以点开头的隐藏文件。',
    },
  },
  ApplyPatch: {
    description: '应用 unified diff 补丁到文件。适合一次修改多个位置或创建新文件；补丁必须和当前文件内容匹配，简单替换优先用 FileEdit。',
    parameters: {
      patch: '标准 unified diff 内容，包含 ---、+++ 和 @@ hunk。',
    },
  },
  SpawnAgent: {
    description: '启动一个后台子 Agent 处理独立任务。用于单 VP 场景下的并行调查、测试、评审或长任务；启动后不要阻塞等待，继续主任务，并用 ListAgents 非阻塞查看状态或等待通知回灌。',
    parameters: {
      name: '子 Agent 的简短名称，便于识别。',
      task: '给子 Agent 的明确任务说明。',
      mission: '任务目标、范围和成功标准。',
      expected_output: '期望子 Agent 最终交付的结果格式。',
      persona: '可选人格或工作风格说明。',
      budget: '子 Agent 的资源预算。',
      'budget.max_tokens': '允许子 Agent 消耗的最大 token 数。',
      'budget.max_turns': '允许子 Agent 执行的最大 turn 数。',
      'budget.wall_time_ms': '最长运行时间毫秒；超时应被标记并终止，避免 running zombie。',
      cwd: '子 Agent 的工作目录。',
    },
  },
  PromptAgent: {
    description: '向已存在的子 Agent 追加消息。仅用于继续或补充一个已启动的子 Agent；不要用它替代 SpawnAgent 创建新任务。',
    parameters: {
      agent_id: '目标子 Agent id。',
      message: '发送给子 Agent 的消息。',
    },
  },
  WaitAgent: {
    description: '兼容用的短轮询工具，用于快速查看某个子 Agent 是否已有结果。不要把它当作主流程循环等待；需要状态时优先用 ListAgents，长任务应后台运行并等待通知。',
    parameters: {
      agent_id: '要检查的子 Agent id。',
      timeout_ms: '最多等待多少毫秒；应保持很短，避免阻塞父 VP。',
    },
  },
  CloseAgent: {
    description: '关闭子 Agent 并可记录最终结果。用于用户要求停止、任务已被主流程接管、或子 Agent 不再需要时；不要关闭无关 Agent。',
    parameters: {
      agent_id: '要关闭的子 Agent id。',
      result: '可选的最终结果或关闭原因。',
    },
  },
  ListAgents: {
    description: '非阻塞列出当前 VP 拥有的子 Agent 状态。用于查看后台任务是否 running、stale、completed 或 failed，以及读取结果摘要和输出文件路径。',
    parameters: {
      include_closed: '是否包含已关闭的子 Agent。',
      include_terminal: '是否包含 completed、failed、abandoned 等终态子 Agent。',
    },
  },
  RouteForward: {
    description: '把当前任务或问题明确转交给同一 Session 中的其他 VP。多 VP 场景下，只要用户点名其他 VP、任务属于其他 VP 职责、需要并行协作、或你需要另一个 VP 继续处理，就必须调用这个工具；在聊天文本里写 @名字 不会真正路由。',
    parameters: {
      to: '目标 VP id，或使用 all 广播给其他成员；不能填自己。',
      text: '要代表你转发给目标 VP 的完整任务内容，必须包含必要上下文和明确期望。',
      reason: '可选的简短转发理由，用于审计和界面展示。',
    },
  },
  TodoWrite: {
    description: '维护用户可见的多步骤任务清单。任务包含 3 个以上有意义步骤、用户给了列表、或即将做复杂多文件改动时必须使用；不要为单个琐碎动作制造清单。',
    parameters: {
      todos: '完整的当前 todo 列表；每次调用都要发送全量列表，不是增量 diff。',
      'todos[].content': '命令式步骤描述，例如“运行测试”。',
      'todos[].status': '步骤状态；任意时刻最多只能有一个 in_progress。',
      'todos[].activeForm': '该步骤执行中展示的进行时文案，例如“正在运行测试”。',
    },
  },
  StartPlan: {
    description: '进入规划模式，为非琐碎任务先形成短计划再继续执行。用户要求计划/思考、任务多步骤、范围不清或大型改动前应使用；除非第一步被用户信息阻塞，否则计划后继续推进。',
    parameters: {
      topic: '一句话说明正在规划的主题。',
      userProblem: '用户真正想解决的底层问题，可选。',
      stuckAt: '当前阻塞点或必须先决策的未知，可选。',
      expectedScale: '预估规模，例如文件数、代码量或时间范围，可选。',
      additionalContext: '影响计划的其他事实、约束或背景，可选。',
    },
  },
  JsRepl: {
    description: '在持久 JavaScript REPL 中执行代码。用于计算、数据转换和快速实验；不能访问文件系统或网络，状态会在多次调用之间保留。',
    parameters: {
      code: '要执行的 JavaScript 代码；reset=true 且只清空状态时可省略。',
      reset: '是否先重置 REPL 上下文再执行代码。',
    },
  },
  JsReplReset: {
    description: '已废弃的 JavaScript REPL 重置工具。新调用应使用 JsRepl 并设置 reset=true；仅为兼容旧调用保留。',
    parameters: {},
  },
  NotebookEdit: {
    description: '读取或编辑 Jupyter notebook 单元格。用于 .ipynb 文件的精确 cell 级修改；普通文本文件不要用它。',
    parameters: {
      notebook_path: '目标 .ipynb 文件路径。',
      action: '操作类型：read、replace、insert 或 delete。',
      cell_index: '单元格索引，0 基。',
      cell_type: '插入或替换时的单元格类型：code 或 markdown。',
      source: '插入或替换的单元格源码内容。',
    },
  },
  ImageGeneration: {
    description: '根据文本描述生成图片并保存到工作目录。用于明确要求生成图像的任务；分析已有图片应使用 ViewImage。',
    parameters: {
      prompt: '详细、具体的图片生成描述，包含风格、构图和氛围。',
      output_path: '生成图片保存路径。',
      size: '图片尺寸。',
    },
  },
  ViewImage: {
    description: '读取本地图片文件并附加到对话中供模型分析。用于用户引用本地截图、图表或设计稿时；远程图片 URL 不用它。',
    parameters: {
      file_path: '图片文件路径，必须在项目目录或允许访问的目录内。',
    },
  },
};

export const BUILTIN_TOOL_LOCALIZED_DESCRIPTIONS = Object.freeze({ zh: Object.freeze(zh) });

export function getBuiltinToolLocalization(toolName, language) {
  if (!String(language || '').toLowerCase().startsWith('zh')) return null;
  return BUILTIN_TOOL_LOCALIZED_DESCRIPTIONS.zh[toolName] || null;
}
