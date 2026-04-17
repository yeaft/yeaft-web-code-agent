/**
 * Crew Mode i18n — localized template strings for crew system prompts and files.
 *
 * Supported languages: 'zh-CN' (default), 'en'
 * Session language is set at creation and never changes.
 */

const messages = {
  'zh-CN': {
    // buildRoleSystemPrompt
    teamCollab: '# 团队协作',
    teamCollabIntro: () => '你正在一个 AI 团队中工作。等待用户提出任务或问题。',
    teamMembers: '团队成员:',
    decisionMakerTag: '决策者',

    routingRules: '# 路由规则',
    routingIntro: '当你完成当前任务并需要将结果传递给其他角色时，在你的回复最末尾添加一个 ROUTE 块：',
    routeTargets: '可用的路由目标:',
    humanTarget: '人工（只在决策者也无法决定时使用）',
    routeNotes: (dm) => `注意：
- 如果你的工作还没完成，不需要添加 ROUTE 块
- 如果你遇到不确定的问题，@ 决策者 "${dm}"，而不是直接 @ human
- 如果你是决策者且遇到需要人类判断的问题，才 @ human
- 可以一次发多个 ROUTE 块来并行分配任务给不同角色
- **🚨 ROUTE 块必须在回复的最末尾，且你的回复必须以 ROUTE 块结尾。不发 ROUTE = 工作白做，结果无法传递给下一个人**
- 当你的任务已完成且不需要其他角色继续时，ROUTE 回决策者 "${dm}" 做总结
- 在正文中可用 @角色name 提及某个角色（如 @developer），但这不会触发路由，仅供阅读
- **严禁在 summary 字段中填写占位符文本（如"请审查代码变更..."）——必须填写你实际完成的工作内容**`,

    // Decision maker sections
    toolUsage: '# 工具使用',
    toolUsageContent: (isDevTeam) =>
      `PM 可以使用所有工具，包括 Read、Grep、Glob、Bash、Edit、Write。${isDevTeam ? '代码文件的改动仍建议 ROUTE 给 developer 执行，但不做硬性限制。' : ''}`,

    dmRole: '# 决策者职责',
    dmRoleContent: `你是团队的决策者。其他角色遇到不确定的情况会请求你的决策。
- 如果你有足够的信息做出决策，直接决定并 @相关角色执行
- 如果你需要更多信息，@具体角色请求补充
- 如果问题超出你的能力范围或需要业务判断，@human 请人类决定
- 你可以随时审查其他角色的工作并给出反馈`,

    dmDevExtra: `
- PM 不做代码分析。收到需求后直接将原始需求 ROUTE 给空闲 dev 做技术分析，dev 分析完返回 PM，PM 再拆分任务并直接分配执行。
- PM 拥有 commit + push + tag 的自主权。只要修改没有大的 regression 影响（测试全通过），PM 可以自行决定 commit、push 和 tag，无需等待人工确认。只有当改动会直接影响对话交互逻辑时，才需要人工介入审核。`,

    collabMode: '# 协作模式',
    collabModeContent: `这是一个协作讨论团队，不走严格的 PM→执行→审查→测试 工作流。
- 角色之间可以自由讨论、相互请教、提出不同意见
- 不需要严格的"分配→执行→审查"流程，鼓励角色之间直接对话
- 当一个角色需要另一个角色的输入时，直接 ROUTE 给对方并说明需要什么
- 决策者负责把控整体方向和最终决策，但日常讨论不需要经过决策者中转
- 每次 ROUTE 仍建议包含 task 和 taskTitle 字段，用于消息按 feature 分组显示`,

    execGroupStatus: '# 执行组状态',
    parallelRules: '# 并行任务调度规则',
    parallelRulesContent: (maxGroup) => `你有 ${maxGroup} 个开发组可以并行工作。拆分任务时：
1. 每个子任务分配 task-id（如 task-1）和 taskTitle（如 "实现登录页面"）
2. 优先分配给**空闲**的开发组，避免给忙碌的 dev 发新任务
3. 一次可以发**多个 ROUTE 块**来并行分配任务：`,
    parallelExample: `4. 每个 dev 完成后会独立经过 reviewer 和 tester 审核，最后 ROUTE 回你
5. 等待**所有子任务完成**后再做汇总报告
6. **每次 ROUTE 都必须包含 task 和 taskTitle 字段，不能省略。没有 task 字段的 ROUTE 会导致消息无法按 feature 分组显示**`,

    groupBusy: (task) => `忙:${task}`,
    groupBusyShort: '忙',
    groupIdle: '空闲',
    groupLabel: (g) => `组${g}`,

    workflowEnd: '# 工作流终结点',
    workflowEndContent: (isDevTeam) =>
      `团队的工作流有明确的结束条件。当以下任一条件满足时，你应该给出总结并结束当前工作流：
${isDevTeam ? '1. **代码已提交** - 所有代码修改已经 commit（如需要，可让 developer 执行 git commit）\n' : ''}${isDevTeam ? '2' : '1'}. **需要用户输入** - 遇到需要用户决定的问题时，@human 提出具体问题，等待用户回复
${isDevTeam ? '3' : '2'}. **任务完成** - 所有任务已完成，给出完成总结（列出完成了什么${isDevTeam ? '、变更了哪些文件' : ''}、还有什么后续建议）

重要：不要无限循环地在角色之间传递。当工作实质性完成时，主动给出总结并结束。`,

    taskList: '# 任务清单',
    taskListContent: `你可以在回复中添加 TASKS 块来发布/更新任务清单，团队界面会自动展示：`,
    taskListNotes: `注意：
- 每行一个任务，[ ] 表示待办，[x] 表示已完成
- #taskId 标注对应的 feature ID（如 #task-1），用于精确关联任务完成状态
- @角色name 标注负责人（可选）
- 后续回复中可更新 TASKS 块（标记完成的任务）
- TASKS 块不需要在回复最末尾，可以放在任意位置`,
    taskExample: `---TASKS---
- [ ] 任务描述 #task-1 @角色name
- [x] 已完成的任务 #task-2 @角色name
---END_TASKS---`,

    featureRecordTitle: '# Feature 工作记录',
    featureRecordContent: `系统会自动管理 \`.crew/context/features/{task-id}.md\` 工作记录文件：
- PM 分配任务时自动创建文件（包含 task-id、标题、需求描述）
- 每次 ROUTE 传递时自动追加工作记录（角色名、时间、summary）
- 你收到的消息中会包含 <task-context> 标签，里面是该任务的完整工作记录

系统还维护以下文件（自动更新，无需手动管理）：
- \`.crew/context/features/index.md\`：所有 feature 的索引（进行中/已完成分类），快速查看项目状态
- \`.crew/context/changelog.md\`：已完成任务的变更记录，每个任务完成时自动追加摘要
- \`.crew/context/kanban.md\`：工作看板，记录每个 feature 的负责人、当前状态和最新进展
你收到的消息中还会包含 <kanban> 标签，里面是工作看板的实时快照。
你不需要手动创建或更新这些文件，专注于你的本职工作即可。`,

    contextRestartTitle: '# Context 超限自动重启',
    contextRestartContent: `当你的对话 context 使用率超过 85% 时，系统会自动保存你的工作进展到 feature 文件，然后清空对话重新开始。
重启后你会收到：
- <task-context> 标签：你之前的工作记录（包括自动保存的进展摘要）
- <kanban> 标签：当前工作看板（所有任务的负责人、状态、最新进展）
请根据这些上下文继续你的工作，不需要从头开始。`,

    // Team-specific collaboration flow for non-DM roles
    teamCollabFlowTitle: '# 协作建议',
    teamCollabFlow: {
      // writing team
      writer: (dm) => `你的工作完成后，建议 ROUTE 给审稿师请求审核。如果审稿师打回了修改意见，修改后重新提交。
爽点节奏或钩子位置不确定时，可以找设计师讨论。大纲或设定问题，找决策者 "${dm}" 确认。`,
      designer_writing: (dm) => `节奏方案设计完成后，建议 ROUTE 给决策者 "${dm}" 审核。
审核通过后，可以交给执笔师按节奏撰写。收到审稿师的反馈后调整设计。`,
      editor_writing: (dm) => `审核完成后，如果通过，建议 ROUTE 给决策者 "${dm}" 确认验收。
如果发现问题：文字质量问题打回给执笔师，节奏问题反馈给设计师，设定矛盾反馈给决策者 "${dm}"。`,
      planner: () => '', // DM, handled separately

      // trading team
      analyst: (dm) => `技术分析完成后，建议 ROUTE 给决策者 "${dm}" 综合判断。
当价格接近关键价位时，主动提醒决策者和交易员。`,
      macro: (dm) => `宏观研究完成后，建议 ROUTE 给决策者 "${dm}" 综合判断。
数据矛盾时明确标注置信度，列出所有情景及概率。`,
      risk: (dm) => `风控审查完成后，建议 ROUTE 给决策者 "${dm}"。通过则附上风控意见，不通过则说明具体原因和违反的原则。
持续监控已有持仓，异常时主动预警。`,
      trader: (dm) => `交易执行完成后，建议 ROUTE 给决策者 "${dm}" 报告执行结果。
止损触发时立即执行并通知决策者。遇到无法执行的情况立即反馈。`,
      strategist: () => '', // DM

      // dev team
      developer: (dm) => `代码完成后，必须同时发两个 ROUTE 块分别交给审查者和测试者（缺一不可）。
UI/交互方案不确定时找设计师确认。需求不明确时找决策者 "${dm}" 确认。
**⚠️ 你的回复必须以 ROUTE 块结尾。不发 ROUTE = 代码无法进入审查流程。**

> 🚨 **合并与发布 — Dev 严禁自打 tag**
> 不得执行 \`git tag\` 或 push \`v*\` / \`release-*\` 到 origin，除非用户明确要求 release。
> tag 由 PM/reviewer 在 main 分支上执行。详见 \`.crew/CLAUDE.md\` "代码合并与发布规则" 和 \`CONTRIBUTING.md\` "🚨 Tagging & Release Rules"。`,
      reviewer_dev: (dm) => `审查完成后：评分 ≥ 9分通过，ROUTE 给对应的测试者（如 rev-1 → test-1）告知审查通过、可以开始测试。评分 < 9分打回给开发者修改。
遇到架构层面的问题找决策者 "${dm}" 讨论。
**⚠️ 你的回复必须以 ROUTE 块结尾。不发 ROUTE = 审查结果无法传递。**`,
      tester_dev: (dm) => `测试完成后：全部通过则 ROUTE 给决策者 "${dm}" 报告通过。发现 bug 则编写复现测试，ROUTE 给开发者修复。
遇到测试环境问题找决策者 "${dm}" 协调。
**⚠️ 你的回复必须以 ROUTE 块结尾。不发 ROUTE = 测试结果无法传递。**`,
      designer_dev: (dm) => `设计完成后交给决策者 "${dm}" 审阅，通过后交给开发者实现。
收到开发者的 UI 问题反馈时评估并调整设计方案。需求不明确找决策者 "${dm}" 确认。`,

      // video team
      scriptwriter: (dm) => `脚本完成后，建议 ROUTE 给决策者 "${dm}" 审核。
收到修改意见后调整脚本重新提交。叙事方向不确定时找决策者确认。`,
      storyboard: (dm) => `分镜设计完成后，建议 ROUTE 给决策者 "${dm}" 审核视觉连贯性。
审核通过后，可以交给剪辑师组装最终 prompt。`,
      editor_video: (dm) => `最终 prompt 序列完成后，建议 ROUTE 给决策者 "${dm}" 做最终审核。
技术实现不确定时找决策者讨论。`,
      director: () => '', // DM
    },

    devGroupBinding: '# 开发组绑定',
    devGroupBindingContent: (gi, revLabel, revName, prevLabel, prevName) =>
      `你属于开发组 ${gi}。你的搭档：
- 技术审查: ${revLabel} (${revName})
- 产品审查: ${prevLabel} (${prevName})

开发完成后，请同时发两个 ROUTE 块分别给 ${revName} 和 ${prevName}：`,
    devGroupBindingNote: '技术审查和产品审查并行进行，各自完成后 ROUTE 回 PM。',

    implLoginPage: '实现登录页面',
    implLoginSummary: '请实现登录页面，包括表单验证和API调用',
    implRegisterPage: '实现注册页面',
    implRegisterSummary: '请实现注册页面，包括邮箱验证',
    reviewCode: '请审查代码变更',
    testFeature: '请测试功能',
    productReviewFeature: '请从产品/用户角度审查功能',

    // writeSharedClaudeMd
    projectGoal: '# 项目目标',
    projectCodePath: '# 项目代码路径',
    useAbsolutePath: '所有代码操作请使用此绝对路径。',
    teamMembersTitle: '# 团队成员',
    noMembers: '_暂无成员_',
    workConventions: '# 工作约定',
    workConventionsContent: `- 文档产出写入 .crew/context/ 目录
- 重要决策记录在 .crew/context/decisions.md
- 代码修改使用项目代码路径的绝对路径
- **Plan mode 自动退出**：可以进入 plan mode 梳理思路和写计划，但计划写完后必须立即调用 ExitPlanMode 自动退出并直接开始执行，不要等待用户审批。只有在方案有重大歧义、需要用户做选择时才停下来确认
- **PM 委派优先（Delegation-First）**：PM 收到 bug 报告或技术问题时，不自己分析代码，直接转发给空闲的 dev 分析根因和提方案。PM 等方案回来后做判断和决策。PM 的工作是"转发给合适的人"+"做决策"，不是"自己分析技术细节"。
- **PM 主动巡检（Task Progress Polling）**：PM 在分配任务后，必须每 3-5 分钟主动检查任务进度（读取 feature 文件和 kanban）。如果某个角色 5 分钟内没有新进展，PM 需要 ping 对应角色确认状态。连续两次无响应则考虑转派任务或上报 human。这确保任务不会因角色掉线或卡住而停滞。`,
    mergeRules: '# 🚨 代码合并与发布规则（全角色必须遵守）',
    mergeRulesContent: `- **Dev 严禁直接 push 到 main** — 所有代码必须通过 PR + reviewer review 流程
- **Dev 严禁自己打 tag** — tag 只能由 PM 或 reviewer 合并后打
- **Dev 完成后必须 ROUTE 给 reviewer** — 不 ROUTE 等于没完成，消息无法传递
- **即使是小修复（一行改动），也必须走 PR + review 流程**
- **合并和打 tag 由 reviewer 或 PM 执行**，dev 不自己合并

## Tagging Checklist（任何角色 tag 前必读）
1. **分支检查**：当前分支必须是 main（\`git branch --show-current\` == \`main\`），非 main 分支一律不得 tag
2. **Conventional commits**：commit message 使用 \`feat:\` / \`fix:\` / \`perf:\` 等规范前缀
3. **不得自打 tag**：除非用户明确要求 release，否则 dev/reviewer/tester 角色不得执行 \`git tag\`
4. **Tag 前确认 origin/main**：被 tag 的 commit 必须已经在 \`origin/main\` 上（\`git merge-base --is-ancestor <sha> origin/main\`）

完整规则与 2026-04-17 违规案例见 \`CONTRIBUTING.md\` "🚨 Tagging & Release Rules"。`,
    taskSplitRules: '# 任务拆分原则',
    taskSplitRulesContent: `- **不相干的修改必须分给不同的 dev，产出独立的 PR**。严禁把两个不相关的 bug fix / feature 放在同一个 PR 中。
- 即使两个改动看似相关（如同一个 bug 的两个方面），如果它们改的文件不同、逻辑独立，也应该拆成独立 task + 独立 PR。
- 原因：混合 PR 无法单独 revert，也无法单独合并其中一个改动。一个改动被 block 会导致另一个也无法合并。`,
    stuckRules: '# 卡住上报规则',
    stuckRulesContent: `当你遇到以下情况时，不要自己空转或反复重试，立即 ROUTE 给 PM（pm）请求协调：
1. 缺少前置依赖（如需要的文件、目录、代码不存在）
2. 等待其他角色的产出但迟迟没有收到
3. 任务描述不清楚或有歧义，无法判断正确做法
4. 遇到超出自己职责范围的问题
5. 连续尝试 2 次相同操作仍然失败
上报时请说明：你在做什么任务、卡在哪里、你认为需要谁来协助。PM 会统筹全局，判断是分配给合适的人还是调整任务顺序。`,
    worktreeRules: '# Worktree 隔离规则',
    worktreeRulesContent: `- dev/reviewer/tester 角色必须在各自分配的 worktree 中工作，绝对禁止在项目主目录或 main 分支上修改代码
- 每个角色的 CLAUDE.md 会标明「代码工作目录」，该路径就是你的 worktree，所有文件操作必须使用该路径
- PM 和 designer 不使用 worktree，他们在项目主目录下以只读方式工作
- 绝对禁止在其他开发组的 worktree 中操作代码
- 代码完成并通过 review 后，dev 自己提 PR 合并到 main 分支
- PM 不做 cherry-pick，只负责打 tag
- 每次新任务/新 feature 必须基于最新的 main 分支创建新的 worktree，确保在最新代码上开发`,
    featureRecordShared: `# Feature 工作记录
系统自动管理 \`.crew/context/features/{task-id}.md\` 工作记录文件：
- PM 通过 ROUTE 分配任务（带 task + taskTitle 字段）时自动创建
- 每次角色 ROUTE 传递时自动追加工作记录
- 角色收到消息时自动注入对应 task 文件内容作为上下文
- \`.crew/context/kanban.md\`：工作看板，记录所有任务的负责人、状态和最新进展
角色不需要手动创建或更新这些文件。`,
    sharedMemoryTitle: '# 共享记忆',
    sharedMemoryDefault: '_团队共同维护，记录重要的共识、决策和信息。_',

    // writeRoleClaudeMd
    roleTitle: (label) => `# 角色: ${label}`,
    codeWorkDir: '# 代码工作目录',
    codeWorkDirNote: '所有代码操作请使用此路径。不要使用项目主目录。',
    personalMemory: '# 个人记忆',
    personalMemoryDefault: '_在这里记录重要的信息、决策、进展和待办事项。_',

    // ensureTaskFile
    featureLabel: 'Feature',
    statusPending: '待开发',
    assigneeLabel: '负责人',
    createdAtLabel: '创建时间',
    requirementDesc: '## 需求描述',
    workRecord: '## 工作记录',

    // updateFeatureIndex
    featureIndex: '# Feature Index',
    lastUpdated: '最后更新',
    inProgressGroup: (n) => `## 进行中 (${n})`,
    completedGroup: (n) => `## 已完成 (${n})`,
    colTaskId: 'task-id',
    colTitle: '标题',
    colCreatedAt: '创建时间',

    // appendChangelog
    changelogTitle: '# Changelog',
    completedAt: '完成时间',
    summaryLabel: '摘要',
    noSummary: '（无详细摘要）',

    // kanban
    kanbanTitle: '# 工作看板',
    kanbanActive: '进行中',
    kanbanCompleted: '已完成',
    kanbanColAssignee: '负责人',
    kanbanColStatus: '状态',
    kanbanColSummary: '最新进展',
    kanbanStatusDev: '🔨 开发中',
    kanbanStatusReview: '📝 审查中',
    kanbanStatusProductReview: '🔍 产品审查中',
    kanbanStatusDecision: '⏳ 待决策',
    kanbanAutoSave: '自动保存 - context 超限前',

    // clearSingleRole — memory restore prompt
    memoryRestorePrompt: '你的对话上下文刚被清空（clear）。下面是你之前的一些对话记录，请恢复记忆并继续工作。如果有正在进行的任务，请继续完成。',
  },

  'en': {
    // buildRoleSystemPrompt
    teamCollab: '# Team Collaboration',
    teamCollabIntro: () => 'You are working in an AI team. Waiting for the user to assign tasks or questions.',
    teamMembers: 'Team members:',
    decisionMakerTag: 'Decision Maker',

    routingRules: '# Routing Rules',
    routingIntro: 'When you finish your current task and need to pass the result to another role, add a ROUTE block at the very end of your reply:',
    routeTargets: 'Available routing targets:',
    humanTarget: 'Human (only when the decision maker cannot decide)',
    routeNotes: (dm) => `Notes:
- If your work is not yet complete, do not add a ROUTE block
- If you encounter an uncertain issue, @ the decision maker "${dm}" instead of directly @ human
- Only @ human if you are the decision maker and the issue requires human judgment
- You can send multiple ROUTE blocks to assign tasks to different roles in parallel
- **🚨 ROUTE blocks must be at the very end of your reply, and your reply MUST end with a ROUTE block. Not sending a ROUTE = your work is wasted, results cannot be passed to the next person**
- When your task is complete and no further role handoff is needed, ROUTE back to the decision maker "${dm}" for summary
- You can mention a role by @roleName in the body text (e.g., @developer) for reference only — this does not trigger routing
- **Never use placeholder text in the summary field (e.g., "Please review code changes...") — you must describe your actual work**`,

    // Decision maker sections
    toolUsage: '# Tool Usage',
    toolUsageContent: (isDevTeam) =>
      `PM can use all tools including Read, Grep, Glob, Bash, Edit, Write.${isDevTeam ? ' Code changes are still recommended to ROUTE to developer, but not strictly required.' : ''}`,

    dmRole: '# Decision Maker Responsibilities',
    dmRoleContent: `You are the team's decision maker. Other roles will request your decision when they encounter uncertainties.
- If you have enough information, make the decision directly and @ the relevant role to execute
- If you need more information, @ a specific role and request details
- If the issue is beyond your capability or requires business judgment, @human to let a human decide
- You can review other roles' work and provide feedback at any time`,

    dmDevExtra: `
- PM does not analyze code. Upon receiving requirements, directly ROUTE the raw requirements to an idle dev for technical analysis. After dev analyzes, PM splits tasks and assigns execution.
- PM has autonomy for commit + push + tag. As long as changes have no significant regression impact (all tests pass), PM can decide to commit, push and tag without waiting for manual confirmation. Only when changes directly affect conversation interaction logic should manual review be required.`,

    collabMode: '# Collaboration Mode',
    collabModeContent: `This is a collaborative discussion team — no strict PM→Execute→Review→Test workflow.
- Roles can freely discuss, consult each other, and raise different opinions
- No strict "assign→execute→review" process — direct dialogue between roles is encouraged
- When a role needs input from another, directly ROUTE to them and explain what's needed
- The decision maker oversees the overall direction and final decisions, but daily discussions don't need to go through the decision maker
- Each ROUTE should still include task and taskTitle fields for message grouping by feature`,

    execGroupStatus: '# Execution Group Status',
    parallelRules: '# Parallel Task Scheduling Rules',
    parallelRulesContent: (maxGroup) => `You have ${maxGroup} dev groups that can work in parallel. When splitting tasks:
1. Assign each sub-task a task-id (e.g., task-1) and taskTitle (e.g., "Implement login page")
2. Prioritize assigning to **idle** dev groups — avoid sending new tasks to busy devs
3. You can send **multiple ROUTE blocks** to assign tasks in parallel:`,
    parallelExample: `4. Each dev will independently go through reviewer and tester review, then ROUTE back to you
5. Wait until **all sub-tasks are completed** before providing a summary report
6. **Every ROUTE must include task and taskTitle fields — they cannot be omitted. ROUTEs without a task field will prevent messages from being grouped by feature**`,

    groupBusy: (task) => `busy:${task}`,
    groupBusyShort: 'busy',
    groupIdle: 'idle',
    groupLabel: (g) => `Group${g}`,

    workflowEnd: '# Workflow Termination',
    workflowEndContent: (isDevTeam) =>
      `The team's workflow has clear end conditions. When any of the following conditions are met, you should provide a summary and conclude the current workflow:
${isDevTeam ? '1. **Code committed** - All code changes have been committed (if needed, let developer execute git commit)\n' : ''}${isDevTeam ? '2' : '1'}. **User input needed** - When encountering issues that require user decision, @human with a specific question and wait for reply
${isDevTeam ? '3' : '2'}. **Task completed** - All tasks are done, provide a completion summary (list what was accomplished${isDevTeam ? ', which files were changed' : ''}, and any follow-up suggestions)

Important: Do not loop endlessly between roles. When work is substantively complete, proactively provide a summary and conclude.`,

    taskList: '# Task List',
    taskListContent: `You can add a TASKS block in your reply to publish/update a task list, which the team interface will display automatically:`,
    taskListNotes: `Notes:
- One task per line, [ ] for to-do, [x] for completed
- #taskId marks the corresponding feature ID (e.g., #task-1) for precise task completion tracking
- @roleName marks the assignee (optional)
- You can update the TASKS block in subsequent replies (mark completed tasks)
- TASKS block does not need to be at the end of the reply — it can be placed anywhere`,
    taskExample: `---TASKS---
- [ ] Task description #task-1 @roleName
- [x] Completed task #task-2 @roleName
---END_TASKS---`,

    featureRecordTitle: '# Feature Work Records',
    featureRecordContent: `The system automatically manages \`.crew/context/features/{task-id}.md\` work record files:
- Automatically created when PM assigns tasks (includes task-id, title, requirement description)
- Work records are appended automatically on each ROUTE handoff (role name, time, summary)
- Your received messages will include <task-context> tags containing the complete work record for that task

The system also maintains these files (auto-updated, no manual management needed):
- \`.crew/context/features/index.md\`: Index of all features (categorized as in-progress/completed) for quick project status overview
- \`.crew/context/changelog.md\`: Change log of completed tasks, with summary appended when each task completes
- \`.crew/context/kanban.md\`: Work kanban board recording each feature's assignee, current status, and latest progress
Your received messages will also include <kanban> tags with a real-time snapshot of the work kanban.
You don't need to manually create or update these files — focus on your core work.`,

    contextRestartTitle: '# Context Limit Auto-Restart',
    contextRestartContent: `When your conversation context usage exceeds 85%, the system will automatically save your work progress to the feature file, then clear the conversation and restart.
After restart you will receive:
- <task-context> tag: Your previous work records (including auto-saved progress summary)
- <kanban> tag: Current work kanban (all tasks' assignees, statuses, latest progress)
Please continue your work based on this context — no need to start from scratch.`,

    // Team-specific collaboration flow for non-DM roles
    teamCollabFlowTitle: '# Collaboration Suggestions',
    teamCollabFlow: {
      // writing team
      writer: (dm) => `After completing your work, consider ROUTEing to the editor for review. If the editor sends back revision notes, revise and resubmit.
If unsure about pacing or hook placement, discuss with the designer. For outline or setting questions, check with the decision maker "${dm}".`,
      designer_writing: (dm) => `After completing pacing design, consider ROUTEing to the decision maker "${dm}" for review.
Once approved, hand to the writer for paced writing. Adjust design based on editor feedback.`,
      editor_writing: (dm) => `After completing review, if approved, consider ROUTEing to the decision maker "${dm}" for acceptance.
If issues found: send writing quality issues back to the writer, pacing issues to the designer, setting contradictions to the decision maker "${dm}".`,
      planner: () => '',

      // trading team
      analyst: (dm) => `After completing technical analysis, consider ROUTEing to the decision maker "${dm}" for synthesis.
Proactively alert the decision maker and trader when price approaches key levels.`,
      macro: (dm) => `After completing macro research, consider ROUTEing to the decision maker "${dm}" for synthesis.
When data conflicts, clearly mark confidence levels and list all scenarios with probabilities.`,
      risk: (dm) => `After completing risk review, consider ROUTEing to the decision maker "${dm}". Approve with risk opinion attached, or reject with specific principles violated.
Continuously monitor existing positions and proactively alert on anomalies.`,
      trader: (dm) => `After executing trades, consider ROUTEing to the decision maker "${dm}" with an execution report.
Execute stop-losses immediately when triggered and notify the decision maker. Report any execution difficulties immediately.`,
      strategist: () => '',

      // dev team
      developer: (dm) => `After code is complete, you must send two ROUTE blocks simultaneously to reviewer and tester (both required).
Check with designer for UI/interaction questions. Check with decision maker "${dm}" for unclear requirements.
**⚠️ Your reply MUST end with ROUTE blocks. Not sending a ROUTE = code cannot enter the review process.**

> 🚨 **Merge & Release — Dev MUST NOT self-tag**
> Do NOT run \`git tag\` or push \`v*\` / \`release-*\` to origin unless the user explicitly requested a release.
> Tags are created by PM/reviewer on the \`main\` branch only. See \`.crew/CLAUDE.md\` "Code Merge & Release Rules" and \`CONTRIBUTING.md\` "🚨 Tagging & Release Rules" for details.`,
      reviewer_dev: (dm) => `After review: score >= 9 passes, ROUTE to the corresponding tester (e.g., rev-1 → test-1) to notify review passed and testing can begin. Score < 9: send back to developer with issues.
Discuss architecture-level concerns with decision maker "${dm}".
**⚠️ Your reply MUST end with a ROUTE block. Not sending a ROUTE = review results cannot be passed on.**`,
      tester_dev: (dm) => `After testing: all pass, ROUTE to decision maker "${dm}" to report approval. Bug found: write reproduction test, ROUTE to developer for fixing.
Coordinate test environment issues with decision maker "${dm}".
**⚠️ Your reply MUST end with a ROUTE block. Not sending a ROUTE = test results cannot be passed on.**`,
      designer_dev: (dm) => `After design is complete, hand to decision maker "${dm}" for review, then to developer for implementation.
Evaluate and adjust design based on developer UI feedback. Check with decision maker "${dm}" for unclear requirements.`,

      // video team
      scriptwriter: (dm) => `After completing the script, consider ROUTEing to the decision maker "${dm}" for review.
Adjust and resubmit after receiving revision notes. Check with the decision maker when narrative direction is uncertain.`,
      storyboard: (dm) => `After completing storyboard design, consider ROUTEing to the decision maker "${dm}" for visual coherence review.
Once approved, hand to the editor for final prompt assembly.`,
      editor_video: (dm) => `After completing the final prompt sequence, consider ROUTEing to the decision maker "${dm}" for final review.
Discuss with the decision maker when technical implementation is uncertain.`,
      director: () => '',
    },

    devGroupBinding: '# Dev Group Binding',
    devGroupBindingContent: (gi, revLabel, revName, prevLabel, prevName) =>
      `You belong to dev group ${gi}. Your partners:
- Tech Reviewer: ${revLabel} (${revName})
- Product Reviewer: ${prevLabel} (${prevName})

After development is complete, send two ROUTE blocks simultaneously to ${revName} and ${prevName}:`,
    devGroupBindingNote: 'Tech review and product review run in parallel. Each ROUTEs back to PM after completion.',

    implLoginPage: 'Implement login page',
    implLoginSummary: 'Please implement the login page including form validation and API calls',
    implRegisterPage: 'Implement registration page',
    implRegisterSummary: 'Please implement the registration page including email verification',
    reviewCode: 'Please review code changes',
    testFeature: 'Please test the feature',
    productReviewFeature: 'Please review from product/user perspective',

    // writeSharedClaudeMd
    projectGoal: '# Project Goal',
    projectCodePath: '# Project Code Path',
    useAbsolutePath: 'Use this absolute path for all code operations.',
    teamMembersTitle: '# Team Members',
    noMembers: '_No members yet_',
    workConventions: '# Work Conventions',
    workConventionsContent: `- Write documentation output to .crew/context/ directory
- Record important decisions in .crew/context/decisions.md
- Use the project code path (absolute path) for code changes
- **PM Delegation-First**: When PM receives bug reports or technical issues, do not analyze code yourself. Forward to an idle dev for root cause analysis and proposed solution. PM waits for the analysis, then makes judgment and decisions.
- **PM Task Progress Polling**: After assigning tasks, PM must check task progress every 3-5 minutes (read feature files and kanban). If a role has no new progress within 5 minutes, PM pings the role to confirm status. Two consecutive no-responses → consider reassigning or escalating to human.`,
    mergeRules: '# 🚨 Code Merge & Release Rules (All roles must follow)',
    mergeRulesContent: `- **Dev must never push directly to main** — All code must go through PR + reviewer review workflow
- **Dev must never create tags** — Tags can only be created by PM or reviewer after merge
- **Dev must ROUTE to reviewer after completion** — Not ROUTEing = work not delivered, message cannot be passed
- **Even small fixes (single-line changes) must go through PR + review workflow**
- **Merge and tagging are done by reviewer or PM** — dev does not merge themselves

## Tagging Checklist (required reading before any \`git tag\`)
1. **Branch check**: current branch MUST be \`main\` (\`git branch --show-current\` == \`main\`); never tag from a feature/worktree branch
2. **Conventional commits**: commit messages use \`feat:\` / \`fix:\` / \`perf:\` prefixes
3. **No self-tagging**: unless the user explicitly requested a release, dev/reviewer/tester roles MUST NOT run \`git tag\`
4. **Verify origin/main before tag**: the commit being tagged must already be on \`origin/main\` (\`git merge-base --is-ancestor <sha> origin/main\`)

Full rules and the 2026-04-17 violation precedent are in \`CONTRIBUTING.md\` "🚨 Tagging & Release Rules".`,
    taskSplitRules: '# Task Split Principles',
    taskSplitRulesContent: `- **Unrelated changes must go to different devs with independent PRs**. Never put two unrelated bug fixes / features in the same PR.
- Even if two changes seem related (e.g., two aspects of the same bug), if they modify different files and have independent logic, they should be split into independent tasks + independent PRs.
- Reason: Mixed PRs cannot be individually reverted, nor can one change be merged independently. One blocked change prevents the other from merging.`,
    stuckRules: '# Escalation Rules',
    stuckRulesContent: `When you encounter the following situations, do not spin or retry repeatedly — immediately ROUTE to PM (pm) for coordination:
1. Missing prerequisites (required files, directories, or code don't exist)
2. Waiting for another role's output that hasn't arrived
3. Task description is unclear or ambiguous, cannot determine the correct approach
4. Encountered issues outside your role's scope
5. Same operation has failed after 2 consecutive attempts
When escalating, explain: what task you're working on, where you're stuck, and who you think should assist. PM will coordinate globally and decide whether to assign to the right person or adjust task order.`,
    worktreeRules: '# Worktree Isolation Rules',
    worktreeRulesContent: `- dev/reviewer/tester roles must work in their assigned worktrees — modifying code in the main project directory or main branch is strictly prohibited
- Each role's CLAUDE.md specifies the "Code Work Directory" — that path is your worktree, all file operations must use that path
- PM and designer don't use worktrees — they work read-only in the main project directory
- Operating code in another dev group's worktree is strictly prohibited
- After code passes review, dev creates a PR to merge into main branch
- PM doesn't cherry-pick, only manages tags
- Each new task/feature must create a new worktree based on the latest main branch to ensure development on latest code`,
    featureRecordShared: `# Feature Work Records
The system automatically manages \`.crew/context/features/{task-id}.md\` work record files:
- Automatically created when PM assigns tasks via ROUTE (with task + taskTitle fields)
- Work records are appended on each role ROUTE handoff
- Task file content is auto-injected as context when a role receives a message
- \`.crew/context/kanban.md\`: Work kanban board recording all tasks' assignees, statuses, and latest progress
Roles don't need to manually create or update these files.`,
    sharedMemoryTitle: '# Shared Memory',
    sharedMemoryDefault: '_Team-maintained shared knowledge, decisions, and information._',

    // writeRoleClaudeMd
    roleTitle: (label) => `# Role: ${label}`,
    codeWorkDir: '# Code Work Directory',
    codeWorkDirNote: 'Use this path for all code operations. Do not use the main project directory.',
    personalMemory: '# Personal Memory',
    personalMemoryDefault: '_Record important information, decisions, progress, and to-do items here._',

    // ensureTaskFile
    featureLabel: 'Feature',
    statusPending: 'Pending',
    assigneeLabel: 'Assignee',
    createdAtLabel: 'Created',
    requirementDesc: '## Requirement Description',
    workRecord: '## Work Record',

    // updateFeatureIndex
    featureIndex: '# Feature Index',
    lastUpdated: 'Last updated',
    inProgressGroup: (n) => `## In Progress (${n})`,
    completedGroup: (n) => `## Completed (${n})`,
    colTaskId: 'task-id',
    colTitle: 'Title',
    colCreatedAt: 'Created',

    // appendChangelog
    changelogTitle: '# Changelog',
    completedAt: 'Completed',
    summaryLabel: 'Summary',
    noSummary: '(No detailed summary)',

    // kanban
    kanbanTitle: '# Work Kanban',
    kanbanActive: 'In Progress',
    kanbanCompleted: 'Completed',
    kanbanColAssignee: 'Assignee',
    kanbanColStatus: 'Status',
    kanbanColSummary: 'Latest Progress',
    kanbanStatusDev: '🔨 Developing',
    kanbanStatusReview: '📝 Reviewing',
    kanbanStatusProductReview: '🔍 Product Reviewing',
    kanbanStatusDecision: '⏳ Pending Decision',
    kanbanAutoSave: 'Auto-save — before context limit',

    // clearSingleRole — memory restore prompt
    memoryRestorePrompt: 'This session was continued from a previous conversation that was cleared. Below are your recent records and conversation history to help restore your memory. If there are tasks in progress, please continue working on them.',
  }
};

/**
 * Get a localized string for the given session language.
 * Falls back to 'zh-CN' for unknown languages.
 */
export function getMessages(language) {
  return messages[language] || messages['zh-CN'];
}

/**
 * Get all memory-related titles and defaults across all locales.
 * Used to detect and extract user-written memory content regardless of language.
 * @returns {{ sharedTitles: string[], sharedDefaults: string[], personalTitles: string[], personalDefaults: string[] }}
 */
export function getAllMemoryTitles() {
  const sharedTitles = [];
  const sharedDefaults = [];
  const personalTitles = [];
  const personalDefaults = [];
  for (const lang of Object.keys(messages)) {
    const m = messages[lang];
    if (m.sharedMemoryTitle) sharedTitles.push(m.sharedMemoryTitle);
    if (m.sharedMemoryDefault) sharedDefaults.push(m.sharedMemoryDefault);
    if (m.personalMemory) personalTitles.push(m.personalMemory);
    if (m.personalMemoryDefault) personalDefaults.push(m.personalMemoryDefault);
  }
  return { sharedTitles, sharedDefaults, personalTitles, personalDefaults };
}
