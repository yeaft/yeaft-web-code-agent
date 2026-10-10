# Digital Person：附件、候选与默认模型后端契约

## 按 Agent 的 UI 开关

数字人入口默认关闭。在 Agent 设置的运行页面中启用“数字人”后，侧栏才显示当前 Agent 的入口。偏好按 Agent 保存于当前浏览器，与工作中心的浏览器入口控制同类，不修改 Agent 后端配置，也不跨浏览器同步。数字人页只列出已启用的 Agent；关闭当前数字人入口返回 Session，不停止已开始的活动，也不删除消息、记忆或技能。重新启用后可继续查看原有数据。

## 浏览器与 Server

先使用已有 `POST /api/upload`（multipart `files`）上传，再发送：

```json
{
  "type": "person_request",
  "agentId": "agent-id",
  "requestId": "request-correlation-id",
  "op": "send",
  "payload": {
    "text": "",
    "clientMessageId": "stable-command-id",
    "attachments": [{ "fileId": "upload-id" }]
  }
}
```

`think` 使用相同 payload；正文可空，但 `send` 必须有正文或附件。`dream` 不接收附件。Server 将所有引用解析成功后才转发 Agent `files:[{name,mimeType,data}]`（`data` 为 canonical base64），不转发浏览器路径、URL 或浏览器自带文件内容。身份由已认证连接提供；认证模式下没有所有者的上传也拒绝，不能以“旧上传”绕过 owner 校验。Agent access 与响应时连接/owner fence 保持有效。

限制：最多 **4 个附件**；每个 **5 MiB**、总计 **10 MiB**（还受 Server 更小的上传上限约束）；正文 **8192 UTF-8 bytes**；正文加所有文本附件内容 **24 KiB**。Server 校验数量、字节数、owner 与 TTL，Agent 再校验完整 canonical envelope、文件名、base64、格式与提取内容。超限拒绝，不截断为貌似完整的输入。

Server 的 pending upload 原始 TTL 为 `CONFIG.fileCleanupInterval`（默认 10 分钟）。Person 不消费或延长引用：即便成功、超时、断开连接、响应丢失，原引用在 TTL 内可再次发送。重试必须保留 `clientMessageId`、正文、附件顺序与内容。所有附件文件名、规范 MIME 与字节 SHA-256 都参与 Agent 请求摘要；相同输入只 admission 一次，改变内容返回 `idempotency_conflict`。Server 重启会丢失未过期 pending uploads，但已 admission 的 Agent 数据不会丢失。

### 响应丢失与上传过期对账

引用过期、已被清理或 Server 重启后不存在时，`send/think` 返回 `errorCode: "attachment_expired"`，**不转发新命令，也不剥离附件重试**。客户端应先发只读查询（不需要附件或上传缓存）：

```json
{ "op": "receipt", "payload": { "clientMessageId": "stable-command-id" } }
```

- 找到时返回 `{found:true,clientMessageId,episodeId,status,kind,text,messageId,requestHash,attachments}`。`attachments` 仅含下文的显示 metadata；无 base64、provider 配置或租约凭据。客户端按原 outbox 的 ID、kind、text 和附件顺序核对（可用原文件名/MIME/字节 SHA-256 核对），恢复已 admission 的状态，不发起另一个 episode。
- 未找到返回 `{found:false,clientMessageId}`。这不排除先前请求仍在途中；重新上传**完全相同输入**后仍使用原 `clientMessageId`，由唯一 admission 约束解决竞争，不能换 ID 再启动一次。
- `requestHash` 是可选的 64 位小写 hex 校验值；提供且与已存摘要不同返回 `idempotency_conflict`。无附件摘要为 SHA-256(`JSON.stringify([kind,text])`)；有附件为 SHA-256(`JSON.stringify([kind,text,files.map(({name,mimeType,sha256})=>({name,mimeType,sha256}))])`)。MIME 先转小写、去参数并 trim；附件順序不变。
- 查询严格限定当前 authenticated owner 和 Agent namespace，不触发模型调用、admission 或 lease recovery。即使租约过期，也只返回存储中的状态（可能仍是 `running`）；随后可用 snapshot 正常刷新恢复状态。
- 无论 receipt 是否可用，使用新 `fileId` 重新上传原文件、保留原正文/文件顺序/名称/MIME/字节及 `clientMessageId`，都会命中同一 episode；不同输入明确冲突。不要在找不到原字节时自动修改或丢弃文件。

此处是后端恢复契约；浏览器需实现对应 outbox 对账和明确的过期重传提示。

## 文件格式与持久化

- 图片：PNG / JPEG / WebP / GIF，验证相应签名；以原生 `image` content block 交给支持图片的 adapter，而非把 base64 塞进 JSON。图片解码由 provider 完成，签名验证不是完整图片解码或安全扫描。
- 文本：UTF-8 text、JSON、Markdown、CSV、代码等；严格 UTF-8 解码，拒绝二进制控制字符。PDF 明确不支持，不能伪装文本或假装已经读取。
- 原始字节与 SHA-256 保存在实例 `<yeaftDir>/person/person.db` 的 SQLite `attachments` 表，由 `(namespace, ownerId, personId, id)` 隔离。附件与 episode、用户消息原子 admission，无 Session/workdir 文件落盘。
- `send` 及带附件的 `think` 都保存用户消息。`messages` / `snapshot.messages` 的附件显示字段为：

```json
{
  "attachments": [{
    "id": "content-and-metadata-hash",
    "name": "notes.md",
    "mimeType": "text/markdown",
    "size": 123,
    "sha256": "byte-content-sha256",
    "kind": "text"
  }]
}
```

`kind` 是 `text` 或 `image`。这些字段没有磁盘路径、下载 URL 或 base64；本契约不提供浏览器原件下载/预览端点。原件随数据库保留，支持备份与重启，不依赖 Server upload cache。

模型当前 trigger 带有完整但有界的文本内容，标记 `untrusted-user-content`，图片通过独立 image block 传递。来源同时关联 trigger 与持久 `message:<id>:1`；附件内容不是系统指令。历史和 Recall 的附件只有 metadata，不表示再次读取了历史文件内容；上下文明确说明这一点。本版本不自动重发历史原件，避免隐式大量图片/文字注入。trace 记录文本请求副本、图片 metadata 与预算，**不记录图片 base64**；文本附件内容和普通用户正文一样属于 owner-scoped 敏感 trace。

每次调用不再另设固定 64 KiB 文本上下文上限；文本预算取当前选定模型的上下文窗口，减去输出、图片与协议预留。窗口沿用原生配置解析（模型配置 override → models.dev cache → runtime 配置 →保守默认值），不在数字人或 UI 中硬编码 1M；切换模型后重新计算。图片预算由已审核的 **模型 ID + 实际 wire 协议** 决定，而不是文件压缩大小或单独的 vision flag；预算随每次模型选择重新计算，不足时明确 `CONTEXT_LIMIT`，不静默删图。每次请求满足 `文本 UTF-8 bytes + 图片预留 tokens + maxOutput + 1024 envelope ≤ contextWindow`。trace manifest 的 `imageBudget`、`imageTokensReserved` 与真实 content blocks 使用同一策略：

| 模型 / 协议 | 实际图片 wire | 每图预留 |
| --- | --- | --- |
| GPT-4o / 4o-mini、GPT-4.1、GPT-5 / 5.1、o1 / o1-pro / o3；`openai-responses` | 强制 `detail: "low"`，adapter 原样透传；不是默认 `auto` | 8192 tokens |
| GPT-4.1-mini、GPT-5.2 / 5.4 / 5.5；`openai-responses` | 强制 `detail: "low"`；这些 patch 模型的 low 不一定比 high 便宜 | 16384 tokens |
| Claude 3 Haiku/Sonnet/Opus、3.5 Haiku/Sonnet、3.7 Sonnet；Sonnet 4/4.5/4.6、Opus 4/4.1/4.5/4.6/4.7/4.8、Haiku 4.5；`anthropic` | 原生 image block，由 provider 有界缩放 | 8192 tokens |

已审核家族可使用日期快照后缀；Claude 同时接受 `4.5` / `4-5` 命名和 `-latest`。其他别名、未来变种、Gemini 或不匹配的协议均没有已证明的预算，保守不开放 Person 图片输入，即使配置了 `supportsImages:true`。这里只收紧 Person，不改变其他原生引擎调用的默认 detail。

上界依据：[OpenAI 图像 detail 与 tokenization](https://developers.openai.com/api/docs/guides/images-vision) 规定上述 tile 模型 low 只收基础 tokens，与尺寸无关，最高为 GPT-4o-mini 的 **2833**；patch 组 low 上界不超过 **6144 patches × 1.62**，向上取整后仍低于 16384。[Claude 缩放规则](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates#how-claude-resizes-and-pads-images) 同时约束边长与 visual token budget，标准/高分辨率分别不超过 **1568 / 4784**，8192 保留额外余量。这是输入上界预留，不是精确计费预测；供应商变更这些规则后需重新审核。兼容端点也必须遵守其所声明模型及协议的图像语义。

图片始终以真实 base64 多模态内容送达模型；low detail 会降低小字、密集截图、精确坐标等任务的辨识质量，不应声称已完整读出原图细节。用户可在上传前裁剪相关区域，不能通过模型输出或附件元数据请求绕过 low。provider 仍可因无效图像、尺寸、动画等自身限制拒绝请求；本修复不新增解码器或图像处理依赖。

## Owner-scoped 候选模型

```json
{ "op": "settings", "payload": { "modelCandidates": ["provider/model-a", "provider/model-b"], "defaultModel": "provider/model-b" } }
```

- `modelCandidates:[]` 重置为 Agent 的默认允许候选集（默认模型优先、最多前 8 个），不更改实例全局配置。显式列表只能有 **1–8 个**模型，超过 8 个直接拒绝，不静默截断。
- 只允许可选 native catalog 中的 provider-qualified refs，拒绝未知、重复、非字符串和 bare IDs；原有部署级 `allowedModels` 是更外层限制。
- 状态返回 `models:[{id,efforts,maxOutput,contextWindow,supportsImages,imageBudget}]`、同内容的 `availableModels` 与持久化 `modelCandidates:[...]`；浏览器可读 `availableModels ?? models`。可选目录与 episode 候选集分离，前者最多 **100 个**允许且可用的已配置模型，超过时 `availableModelsTruncated:true`，不含 endpoint/key 等秘密；第 9–100 个模型也可显式选中。后者始终最多 8 个，只有该子集进入模型上下文。
- `defaultModel` 是 provider-qualified ref，`null` 表示自动；省略字段保留之前的值。显式默认必须属于当前**有效的最多 8 个候选**且满足配置、部署 allowlist 与安全上下文预算；继承 `[]` 时也只能从隐式前 8 个中选择默认，不因设置默认而扩大候选。第 9–100 个模型要先通过显式候选纳入。无效类型、bare ID、不可用或不属于候选的默认返回 `MODEL_SELECTION`。
- settings 写入既有 Person owner settings，由实例 SQLite 持久化，重启保留。busy 时禁止更改；修改任一模型字段按**已有设置与 patch 合并后的值**验证，不能通过分别修改绕过成员关系。删掉显式默认对应的候选会拒绝；要重置，客户端同时发送 `defaultModel:null`（如 `{modelCandidates:[],defaultModel:null}`）。全自动重置在没有可用模型时仍允许。跨服务并发更新由 `controlVersion` fence 拒绝过期合并（`STALE`），重新读取后再提交。
- episode admission 在同一 SQLite 事务中保存候选列表副本、`defaultModel` 与 controlVersion；runtime 使用该副本与本次 provider 配置快照。显式默认优先于上次 `lastSelection`，作为首次调用的 bootstrap；自动 `null` 保留旧行为：可用的上次选择优先，否则 Agent 默认／首个候选。后续 proposal 仍可在候选内选择；图片输入保留既有图片候选回退策略。调用中的模型选择和后继 proposal 都不能逃离这个子集。
- status 所有返回路径都带 `defaultModelSupported:true`；`defaultModel` 为保存的 ref 或 `null`，`agentDefaultModel` 为实例所配置默认经 router 所有权解析的 ref（没有可解析默认时为 `null`，即使它不在 owner 子集中也不替换此字段）。`effectiveModelCandidates` 是本次实际有界 catalog 的 ID 数组，而非完整 `availableModels`；`effectiveDefaultModel` 是显式默认或 Agent 默认／首候选的 ref，不是上次选择的投影。无法构造有效 catalog 时为 `[]`／`null`、`modelReady:false`，保存值与完整恢复目录仍保留。
- 未保存过 `defaultModel` 的旧 Person 与 episode 按自动处理，不做数据库、实例 config 或 Session 数据迁移。status/settings 不调用模型；公开设置和 trace 只增加这个 ref，不暴露 provider 凭据。
- 已保存候选从 Agent catalog 移除后，status 返回 `modelReady:false`，仍返回完整可选目录供恢复；episode 明确失败，不自动扩权使用其他模型。仍可重选或用 `[]` 重置。
- 图片能力仅对上表具有已审核预算的模型/协议开放；原生 model/provider `supportsImages:false` 仍可显式关闭，`true` 不能为未知计费模型扩权。协议按实际 router 的 model override → provider override → ID 推断决定，managed provider 先使用相同的规范化。需要图片时，只能在 owner 子集中选择图片候选；没有则 `IMAGE_MODEL`，不把图片默默丢掉。

## 名字与等待态兼容

`settings` 接受可选 `name`，trim 后须非空且不超过 **160 UTF-8 bytes**。只改名字不需要模型可用，即使已有候选／默认已失效也原样保留，不重新验证模型设置，不启动思考，不改 Person 身份、历史、状态或未提供的持久设置；设置响应与 trace 仍只投影公开字段。

`status.renameSupported:true` 表示 Agent 支持修改名字。浏览器将缺失此字段的旧 Agent 视为不支持，禁用名字输入并提示升级，其他模型配置仍可操作。旧 Agent（如 `1.0.596`）不接受 `name` 字段，不能仅升级 Web 后直接调用重命名。Agent 升级／重启属于单独的运行操作。

对话等待时使用共享 typing loading 与 Composer 等待状态，停止操作留在 Composer；顶部不展示“处理中／取消”。消息区同时显示基于真实执行事件的简短活动提示，可展开查看本次模型请求、记忆查找、方法读取或能力执行的状态与已确认耗时。默认收起，不显示工具参数、原始输出、代码或内部推理；思考与调试仍通过独立只读面板查看。

活动提示复用现有 snapshot / traces 轮询，不新增模型调用或自主后台任务。`Skill.*` 的方法读取不描述为已执行外部操作，能力成功不等于整次活动完成；终态以 episode 的完成、失败、取消、中断或预算耗尽为准。连接中断或进展读取失败时显示暂时无法确认，而非持续伪装成正在生成；恢复连接后重新获取权威状态，不自动重发命令。查看历史分页不会阻断独立最新活动窗口的刷新；活动只保留有界最新记录，缺少起点或较早步骤时明确提示记录不完整。

## 运行与用量

数字人的“运行与用量”是 metadata-only 只读投影，不触发思考。默认摘要保留调用次数、输入、输出、可确认的总量和模型；展开每次调用可看非零推理／缓存用量、模型窗口（tokens）、本次请求大小（UTF-8 字节）和实际带入来源数量。零值主指标仍显示；未知用量不是 0，不推算缺少缓存口径的总量。供应商报出的原始输入与含缓存输入只显示可用的一种，推理包含在输出中，不再累加。统计口径、模型选择来源／理由、输出预留和保守字节预算收在折叠详情中。

上下文快照默认读取最新 12 条消息、近期 12 个概念和最多 12 个当前关注概念（概念按 ID 去重），再按模型请求预算装配；不会因大窗口自动加载全部历史。`Recall` 能按当前数字人的 owner / namespace 查历史消息或概念，返回有界整页并注入下一次调用的 `capabilityResult`，而不是普通 Session 的 history 或旧 Dream 记忆自动召回。来源数量分别表示本次装配的近期消息／概念及当前 Recall 整页；它们可能指向同一记录，不应相加作为唯一记忆总数。预算省略的记录仍在长期存储中。

新 trace manifest 增加 `contextWindowTokens` 与 `contextSources` 计数，SQLite 只投影白名单数值与召回类型，不把消息正文、概念陈述、来源 refs、prompt 或 provider 配置送到用量面板。旧 trace 缺失新字段时保持未知，不用当前模型配置回填历史窗口，也不迁移数据库。

## 验证范围

聚焦测试覆盖 SQLite 真数据库的 attachment-only send/think、原件重启保留、owner/namespace fence、哈希冲突、实际 image block 与无 base64 trace、完整候选 catalog、跨 service busy settings 和 proposal 越界拒绝。Server 测试覆盖全量引用解析、未归属/跨 owner/过期/超限拒绝与 lost-response 重试。测试使用隔离的实例数据根，不得指向线上数据库。
