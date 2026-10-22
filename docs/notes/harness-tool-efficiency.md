# 工具执行与上下文效率

本轮改进针对无效重试、重复读取、冗长工具结果和默认子 Agent 预算误杀，不改变持久 transcript，也不增加摘要 LLM。

## 工具契约

- `GitRead` 将严格 schema 常见的空占位参数视为省略；非 `log` 操作忽略 schema 范围内的整数 `limit`（1～50），不再只兼容默认值 20。越界或非整数值、未知字段、有实际语义的跨 operation 参数及危险 revision/path 仍被拒绝。校验错误明确标注尚未执行，并给出最小调用示例。同一 query 中同参数的确定性校验错误重复两次后，Engine 提醒改正参数；网络、测试、运行时失败不被误判成参数错误。
- `GitRead` 的 Git 非零退出、超时、捕获阶段截断及退出未确认使用有界 JSON error envelope；Engine 据此标记 `tool_end.isError`，不再把文本中的失败退出码算成功。诊断包含 operation、失败阶段、实际 cwd 与 stderr；显示层裁剪已成功完成的输出仍是成功，不能与因捕获上限终止混淆。
- `GitRead show` 先通过固定 `rev-parse --verify --end-of-options <revision>^{commit}` 解析唯一 commit，再按 SHA 读取；支持 tag，拒绝范围、tree、blob 等对象。`log` 保留有界范围读取。只有 status 和默认工作区 diff 检查并覆盖内容 filter，log/show/显式 base...head diff 只读对象，不做无意义的 filter 查询。
- 主 Agent 的 `GitRead` schema 随 Git、diff、review、提交、分支等近期意图激活；未匹配时仍可通过 `DiscoverTools` 获取。reviewer 子 Agent 始终可见已授权的 GitRead，不要求 Bash，也不因使命正文缺少关键词而隐藏；激活不突破 registry/allowlist。
- `Bash` 与 `ExitWorktree` 的相对工作路径以执行上下文的 `cwd` 为基准，而不是服务进程目录。Bash 失败结果包含解析后的目录；权限、目录隔离和终止确认不因此放宽。
- `FileRead` 返回内容 hash 及当前 query 已读取的重叠范围提示。关闭跨 loop 文件内容缓存，始终读取当前内容，不抑制显式复核；提示不是缓存命中承诺，文件修改后旧版本的范围记录失效。

## 输出预算

- Bash 前台输出按流有界捕获首尾，不因为日志量达到上限就终止命令。命令仍受显式超时、取消和进程清理约束。模型侧 32 KiB 截断也保留首尾，以免丢失测试或构建的最终结论。
- 前台捕获不是完整日志存储；需要持久完整日志的命令应使用后台任务。模型投影不会改写已保存的工具记录，但无法找回捕获阶段已省略的内容。
- WebFetch 可读 HTML 输出先移除导航和页脚，再应用长度预算；不移除 `aside` 中可能重要的说明。仅有导航的页面回退保留内容；raw、JSON 和纯文本路径不受影响。

## 安全批量修改

`ApplyPatch` 对明确的实现、修改、修复和重构任务按需激活，仍可通过工具发现取得。多个文件、同文件多个 hunk 可在一次调用中提交。解析所有 patch、校验所有原上下文和删除行后才写入；路径越界、畸形 patch 和过时内容不会造成部分修改。

按行保留未修改内容的 LF/CRLF；拒绝符号链接目标和祖先，并在写入前复查身份与内容。文件句柄以非截断方式打开，确认目标后才写入。这些检查不是防御恶意并发文件系统替换的 OS sandbox。

文件系统写入不是跨文件事务：写入期间 I/O 失败仍可能留下已修改文件或部分写入。工具结果明确报告成功、失败和未执行对象，不能将“预验证全有或全无”理解为运行时事务。

## 子 Agent

默认不施加累计 token、turn、工具次数、LLM 请求或总耗时预算；调用方可显式设置所需上限。取消、工具授权、ownership、workspace 隔离和 terminal fence 保留，单个工具/provider 的超时也不取消。无默认总额上限意味着持续任务需要父级观察，不能理解为无成本或必然完成。

状态列表只投影紧凑运行状态和结果引用，不携带完整任务日志；保留显式预算、剩余额度、授权与控制 revision，以及 shell 取消中的状态。子 Agent 使用 WaitAgent/CloseAgent 收集/取消，shell 使用 ReadTaskLog/CancelTask。详细输出通过已有日志读取或结果收集接口获取。预算与进度应按实际执行、provider usage 统计，不以重复事件或字符长度冒充工具次数和 token。

## 等待与完成证据

- `WaitTask` 按 task ID 有界等待（默认 120 秒、最多 600 秒），仅返回状态、退出码、日志引用和末端位置，不读取/消费日志，不取消命令、不自动重试，也不改变 `status_only` 的唤回策略。`log.endOffset` 是文件大小，不是已消费游标；读取应使用上次 ReadTaskLog 的 offset。任务工具限定当前 Session 并沿用 VP ownership；取消等待只清理监听，不取消后台任务。
- `Bash` 非零退出、超时确认/未确认及退出未确认使用 JSON 错误信封，`errorEffect: unknown`、`replaySafe: false` 明确可能已有副作用。模型侧大输出裁剪保留可解析 JSON 和日志首尾；成功命令打印的应用层 `error` 字段不再被误认作工具失败。启动/工具异常仍走异常通道。
- 子 Agent `lifecycle` 表示是否仍在执行，`outcome` 表示结果完整性；预算截断的 `APPROVE` 只是部分证据。Wait/List/Close 与通知保留 incomplete、截断和保留报告信息；Close 不覆盖已有终态证据。
- `UpdateAgent(request_finalize: true)` 请求一次基于已有证据的无工具报告；已派发操作可先完成，新的工具派发被阻止。该控制不通过压低预算实现，reason 仅作审计记录。主动收尾仍标为 incomplete，不能自动升格为完整 review；父级必须检查未完成范围。默认无累计预算不变。

## 当前 turn 折叠与证据归属

- T1/T2 的范围替换显式返回新摘要、保留消息和实际折叠行，不按原数组起点猜摘要位置。范围内的真实用户补充、异步通知、重复调用提示与先前摘要保留；持久化只 tombstone 被替换的 assistant/tool 行。原始行仍 append-only 保留。
- 折叠后清除当前 query 的文件已读范围提示，避免误导模型认为旧正文仍在上下文。仍然允许修改后复核，不抑制文件读取。
- 原有 reflection 请求记录 `tool_reflection` 诊断：来源 turn、T1/T2、模型、耗时、成功/失败及实际返回的 usage。没有 usage 的失败明确标记 `usageReported: false`，不能把零当作没有费用；不复制摘要正文或敏感工具内容。Adapter 仍是总量统计真源，不重复记账。本次不新增 reflection 请求，也不改变现有 T2 触发策略。
- `EnterWorktree` 只创建、不切换目录，回执显式标记 `cwdChanged: false`。`GitRead.cwd` 相对当前执行目录解析，可指定同一仓库的关联 worktree；通过 canonical common Git dir 校验身份，拒绝其他仓库（包括嵌套独立仓库）。成功与运行失败均标明 `resolvedCwd`，不继承可重定向仓库的 Git 环境字段。此限制是工具契约，不是防御恶意并发路径替换的 OS sandbox。

## 交付证据与机械重复

不新建自动相关性判断或验证缓存。审查和验证应注明工作目录、base/head SHA、命令与结果；这些身份改变时，说明原证据覆盖范围，再对实际受影响部分补验。不能因为旧 head 曾通过就声称新 head 已通过，也不因清理失败重复执行远端合并。

合并与本地清理解耦：使用 head-match 合并；若后续 worktree/branch 删除失败，先查询 PR 的 `merged` 与 `mergeCommit` 确认远端结果，然后只重试本任务清理。不要把 `gh pr merge --delete-branch` 的本地清理错误当作远端未合并。

## 失败率、规则门禁与网页证据

- 工具统计同时保留历史累计和每工具最近 100 次新调用的错误率；近期是调用数窗口，不是时间窗口。旧文件没有逐次结果时显示“暂无近期样本”，不从累计比例或延迟记录倒推。错误原因仅使用固定安全词汇，不把路径、URL 或凭据写成分类键；分类不改变 `isError` 和历史错误数。
- 项目规则复核针对工作区写入，而不是所有有副作用的工具。EnterWorktree、CloseAgent 等生命周期调用不因空路径触发虚假复核；Bash 命令文本不作为文件路径。未知扩展工具及不在精确只读白名单内的 Bash 仍保守处理，真实 FileEdit/FileWrite/ApplyPatch 写入及同批次隔离不放宽。规则选择元数据变化、但模型已看到的正文未变时，不制造一次失败重试。
- `ViewImage` 复用附件读取的 Session ownership、符号链接和大小边界，允许读取当前 Session 在实例目录下的附件，不把整个实例的 Session 根目录加入白名单。项目图片与宿主显式 allowlist 的既有契约保持；缺失文件、其他 Session 和访问拒绝仍是真实失败。
- WebSearch/WebFetch 的 deadline 同时约束请求和响应体读取，并合并调用方取消信号；搜索取消后不再尝试其他 backend。后端明确返回的零结果是成功；bot challenge、未知 HTML 和外部 HTTP 拒绝不能伪装成零结果。
- 网页证据账本仅属于当前 query，跨 loop 共享、跨用户 turn/Session/子 Engine 不复用。只复用成功结果和共享进行中的相同请求，503、取消和其他失败可在后续调用重试。搜索只 trim 首尾空白，不合并大小写、C++、site:、否定词或引号变体；相似查询只提示证据缺口，不强制阻断。WebFetch 的 URL identity 忽略 fragment，但保留查询参数、响应模式和长度预算；`polling: true` 绕过已完成结果复用。
- 401/403 提示只针对具体 URL，不封锁整台 host。重复研究给出有界收敛提示，不增加默认硬预算或新的摘要 LLM。外部访问限制仍如实返回，不绕过认证、反爬或服务商限制。
- 地图展示使用 provider-specific 契约：OSM 仅需 `{ provider: 'openstreetmap' }`，由浏览器生成官方 embed；Google 必须提供官方 `pb` share URL。合法旧 OSM embed 规范化为 provider-only，任意或携带凭据的 URL 仍拒绝。

## 验收重点

- 默认无累计预算，显式预算仍准确终止且保留有界收尾机会。
- 工具失败不制造相同参数重试链；相对路径在前台和后台执行中一致。
- 状态查询不会搬运大型日志；结果和原始日志仍可追溯。
- 过时 patch、多文件后段失败和越界不会写文件；有效 patch 保留换行语义。
- 大日志不会意外终止命令，取消/超时仍然生效，输出首尾在字节预算内且不破坏 UTF-8。

这些是机制改进，不是同任务 A/B 节省比例的证明；实际成本还需结合请求次数、未缓存输入、输出和验收质量观察。
