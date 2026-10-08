# Digital Person：附件与候选模型后端契约

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

Server 的 pending upload 原始 TTL 为 `CONFIG.fileCleanupInterval`（默认 10 分钟）。Person 不消费或延长引用：即便成功、超时、断开连接、响应丢失，原引用在 TTL 内可再次发送。重试必须保留 `clientMessageId`、正文、附件顺序与内容。所有附件 metadata/content hash 都参与 Agent 请求摘要；相同输入只 admission 一次，改变内容返回 `idempotency_conflict`。TTL 后需重传；相同文件名、MIME 与字节可配合原 `clientMessageId` 对账。Server 重启会丢失未过期 pending uploads，但已 admission 的 Agent 数据不会丢失。

## 文件格式与持久化

- 图片：PNG / JPEG / WebP / GIF，验证相应签名；以原生 `image` content block 交给支持图片的 adapter，而非把 base64 塞进 JSON。图片解码由 provider 完成，签名验证不是完整图片解码或安全扫描。
- 文本：UTF-8 text、JSON、Markdown、CSV、代码等；严格 UTF-8 解码，拒绝二进制控制字符。PDF 明确不支持，不能伪装文本或假装已经读取。
- 原始字节与 SHA-256 保存在当前 Person SQLite `attachments` 表或 Mongo `person_attachments` collection，由 `(namespace, ownerId, personId, id)` 隔离。附件与 episode、用户消息原子 admission，无 Session/workdir 文件落盘。
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

每次调用保留原有整体 64 KiB 文本上下文上限，并为每幅图片预留 8192 input tokens，计入模型 context window 检查；不足时明确 `CONTEXT_LIMIT`。图片可能按 provider 自身规则产生不同 token 计费，预留值不是 provider 的精确计费预测。

## Owner-scoped 候选模型

```json
{ "op": "settings", "payload": { "modelCandidates": ["provider/model"] } }
```

- `[]` 重置为 Agent 的默认允许候选集，不更改实例全局配置。
- 只允许完整 native catalog 中的 provider-qualified refs，拒绝未知、重复、非字符串和 bare IDs；原有部署级 `allowedModels` 是更外层限制。
- 状态返回 `models:[{id,efforts,maxOutput,contextWindow,supportsImages}]` 与 `modelCandidates:[...]`；`models` 是所有允许且可用的已配置候选，不再截到前 8 个，不含 endpoint/key 等秘密。
- settings 写入既有 Person owner settings。busy 时禁止更改；episode admission 保存列表副本与 controlVersion，runtime 只使用该副本与本次 provider 配置快照。调用中的模型选择和后继 proposal 都不能逃离这个子集。
- 已保存候选从 Agent catalog 移除后，episode 明确失败，不自动扩权使用其他模型。仍可用 `[]` 重置。
- 图片能力优先读取原生 model/provider `supportsImages` 显式值；已知 Claude 3/4、GPT-4o/4.1/5、o1/o3/o4、Gemini 命名作为默认推断，未知别名保守不支持。需要图片时，只能在 owner 子集中选择图片候选；没有则 `IMAGE_MODEL`，不把图片默默丢掉。

## 验证范围

聚焦测试覆盖 SQLite 真数据库的 attachment-only send/think、原件重启保留、owner/namespace fence、哈希冲突、实际 image block 与无 base64 trace、完整候选 catalog、跨 service busy settings 和 proposal 越界拒绝。Server 测试覆盖全量引用解析、未归属/跨 owner/过期/超限拒绝与 lost-response 重试。Mongo 测试仅在显式隔离 replica-set 环境 `PERSON_TEST_MONGO_URI` 下运行；不得指向线上数据库。
