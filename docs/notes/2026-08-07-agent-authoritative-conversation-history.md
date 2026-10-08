# Agent 权威 Conversation 历史、搜索与虚拟列表设计

状态：Implementation ready
Owner：Linus
日期：2026-08-07

## 1. 目标

保持现有 UI 与交互骨架不变：

- 左侧仍是 Agent-scoped Session list。
- 进入 Session 后，右侧仍显示连续的 user message 与其后所有可见 AI / VP / tool projection。
- 搜索面板只列出该 Session 的 user messages；选择结果后，主 Conversation 定位并显示该 user message 附近的连续历史。
- 正常打开 Session 只读取最新 5 个完整 user turns；向上滚动每次再读取 5 个完整 turns。
- 搜索定位窗口默认预读命中点前后各 5 个完整 turns。
- 浏览器不再持久化 Yeaft transcript，不再从 IndexedDB hydrate、revalidate、merge 或执行 500-turn retention。
- Agent transcript 仍是唯一权威数据源；Server 只做带 owner 检查的 WebSocket relay。
- Conversation 使用现有可变高度虚拟列表，限制实际 DOM 数量。

成功标准不是把一次 O(n²) merge 改快一点，而是让正常首屏、分页与搜索的工作量只和本次小窗口相关。

## 2. 非目标

- 不改变 Session list、MessageList、UserTurnBlock、VpTurnBlock 的产品外观。
- 不把 transcript 复制到 Server SQLite。
- 不把 Agent 的模型上下文历史、compact 或 memory 语义改成 UI 分页语义。
- 不删除 Agent 端 legacy transcript reader、迁移 fallback 或现有 wire alias。
- 不承诺离线浏览未加载历史。没有 Agent 连接时，只能显示本页面仍驻留的内存窗口。
- 不在本次改动中重命名现有 `turnId`。它当前主要标识 VP execution，不等于一个完整 user round-trip。

## 3. 当前实现事实

### 3.1 权威 transcript

`agent/yeaft/conversation/persist.js` 已将 Session transcript 写入：

```text
<yeaftDir>/sessions/<sessionId>/conversation/
  index.json
  lineage.json
  segments/*.jsonl
```

JSONL row 有全局单调 `seq`，`index.json` / `lineage.json` 提供 `streamId` 与 `revision`。旧 Markdown、`groups/` 等仅作 reader/migration fallback。

### 3.2 已有 Agent 历史索引

`history-index.js` / `history-index-worker.js` 已维护可重建的 per-Session SQLite 索引：

- `entries` 保存可见 entry 的稳定 anchor、seq 范围、role、speaker、snippet 文本。
- `entry_fts` 使用 FTS5 trigram 搜索。
- manifest 绑定 source revision/fingerprint；破坏性 mutation 后重建。
- query worker 与 rebuild worker 不阻塞主 query loop。
- index 是 transcript 的可删、可重建 projection，不是第二权威。

### 3.3 已有窗口与虚拟渲染

- `ConversationStore.loadVisibleWindowBySession()` 已支持 anchor 前后按 turn 读取，并有 row/byte budget。
- `yeaft_history_window` 已支持 index-generation fenced anchor load。
- `VirtualTranscript` 已支持可变高度估算、ResizeObserver 校正、binary range lookup、prepend anchor preservation 与 bottom-follow。

因此本设计不增加第三套 storage、search 或 virtual-list 实现；只收敛现有路径。

## 4. 领域模型

### 4.1 User turn

本设计中的分页单位是“一个可见、真实用户输入开始，到下一个可见、真实用户输入之前的所有可见持久化 rows”。

```text
User turn
├── user-authored user row
├── VP A assistant rows
├── VP A visible tools / AskUser projection
├── VP B assistant rows triggered by coordinator or route_forward
└── other visible rows before the next user-authored user row
```

边界必须由 Agent 从 canonical transcript 计算。浏览器不得按时间戳、VP `turnId` 或 DOM adjacency 猜测。

`route_forward` 注入使用 `userAuthored: false`，不能创建新的 user-turn 边界。现有 `causalRootId` 可用于诊断和未来更精确的归属，但本次分页不要求迁移旧 transcript。

### 4.2 Entry 与 turn 的区别

现有 history index entry 是搜索/outline 的轻量可见条目：一个 user row，或按 VP execution 聚合的 assistant entry。搜索产品需求只需要 user messages，因此 query/outline 请求必须支持并使用 `senderKey: "user"`。

选中搜索结果后，`entryStartSeq` / `anchorSeq` 只是定位锚点；实际显示仍由 Agent 返回锚点附近的完整 user-turn window。

## 5. 数据所有权

| 数据 | Owner | 生命周期 |
| --- | --- | --- |
| JSONL transcript + segment index/lineage | Agent instance | 权威、持久 |
| history SQLite/FTS index | Agent instance | 可重建 projection |
| WebSocket relay frame | Server | 短暂、owner-scoped |
| 当前 recent/history window | Browser memory | 页面生命周期 |
| virtual height cache | Browser component | 当前 mounted transcript identity |
| Yeaft transcript IndexedDB | 删除 | 不再存在 |

浏览器仍可使用普通 auth/session storage 和 Work Center 自己的 browser state；删除范围只限 `yeaft-history-cache` transcript database。

## 6. Agent API 与 wire

所有请求必须带 `(agentId, sessionId)`；Server 继续验证用户对 Agent 的访问权，再 relay。`requestId` 与前端 generation 必须过滤乱序回复。

### 6.1 最新窗口

现有：

```js
{
  type: 'yeaft_load_history',
  agentId,
  sessionId,
  requestId,
  limit: 5
}
```

返回 `yeaft_history_chunk { mode: "recent" }`：

```js
{
  messages,          // 已投影、按 seq 升序、完整 user-turn 边界
  oldestSeq,
  latestSeq,
  nextBeforeSeq,
  hasMore,
  streamId,
  revision
}
```

正常进入或重新选择 Session 时，浏览器直接请求该窗口。没有 IndexedDB freshness 分支，也没有 delta revalidation 分支。

### 6.2 向上分页

现有：

```js
{
  type: 'yeaft_load_more_history',
  agentId,
  sessionId,
  requestId,
  beforeSeq,         // exclusive stable cursor
  turns: 5
}
```

Agent 返回升序 rows。浏览器只把新页 prepend 到同一连续区间；重叠 rows 用稳定 persisted message identity 幂等处理，不重新排序完整 transcript。

### 6.3 User-message list/search

复用 `yeaft_load_history_outline` 与 `yeaft_search_history`，但 Conversation 搜索面板固定请求：

```js
senderKey: 'user'
```

无 query 时列出最新 user messages；有 query 时只在 user message text 上搜索。结果字段保持轻量：

```js
{
  indexGeneration,
  entryId,
  messageId,
  entryStartSeq,
  entryEndSeq,
  anchorSeq,
  timestamp,
  snippet,
  role: 'user'
}
```

列表分页使用 generation-fenced cursor；搜索不依赖当前浏览器已加载 messages。

### 6.4 点击搜索结果

复用 `yeaft_load_history_window`：

```js
{
  agentId,
  sessionId,
  requestId,
  indexGeneration,
  entryId,
  entryStartSeq,
  anchorMessageId,
  anchorSeq,
  beforeTurns: 5,
  afterTurns: 5,
  maxRows,
  maxBytes
}
```

Agent 在一次 source fingerprint fence 内校验 locator 并读取窗口。索引 generation 或 transcript source 改变时返回 `stale_result`；浏览器只允许刷新搜索 locator 一次，不能用陈旧 seq 猜测。

### 6.5 搜索窗口中的滚动

浏览器维护两类互不伪装成连续的窗口：

- `live-tail`：最新窗口，允许 WebSocket event append。
- `anchored-history`：搜索命中附近的连续窗口，不与远处 live tail 拼接。

在 anchored-history 中：

- 向上到边界：按当前 `oldestSeq` 请求 earlier page。
- 向下到边界：后续实现使用稳定 `afterSeq` 请求 newer page；第一阶段可保留明确“回到最新”入口，不允许把远端 latest event直接拼到历史窗口末尾。
- 点击“回到最新”：丢弃 active focus window，重新请求最新 5 turns，切回 live-tail。
- 当 newer pagination 确认已覆盖 `latestSeq`，自动切回 live-tail。

本次实现优先复用现有 detached focus-window 机制。任何两个连续区间发生 overlap 时，以 persisted message identity 去重并合并区间；没有 overlap 时继续保持两个窗口，不能生成假的连续 timeline。

## 7. WebSocket 实时状态机

### 7.1 live-tail

```text
new event
→ 校验 Agent + Session + conversation generation
→ reconcile optimistic/live row
→ append/update 当前 latest turn
→ 保持 bottom follow（仅当用户原本在底部）
```

不写 IndexedDB。

### 7.2 anchored-history

```text
new event
→ 更新 latest watermark / unread state
→ 若 event 属于当前窗口中已存在的持久化/运行 turn，则可按稳定 identity 更新
→ 否则不追加到可见历史窗口
```

用户的滚动锚点不能因为远处的新消息跳动。

### 7.3 gap / destructive mutation

- WebSocket sequence gap：废弃不可信 live-tail window并重新请求最新 5 turns；不做全历史 catch-up。
- `streamId` 变化：清理该 Session 的 browser-memory rows/focus window，重新请求 recent。
- `revision` 变化：当前实现的 revision 会在 append 时变化，不能把任意 revision 变化都当 destructive reset。destructive identity 必须以 `streamId`、明确 mutation event或 Agent 返回的 stale fence为准。

## 8. 浏览器状态

每个 `(agentId, sessionId)` 只需：

```js
{
  loaded,
  loading,
  requestId,
  mode,                 // recent | older | anchored
  oldestSeq,
  latestSeq,
  nextBeforeSeq,
  hasMoreBefore,
  streamId,
  focusWindow           // optional detached anchored window
}
```

删除：

- IndexedDB owner generation/fence。
- IndexedDB hydration request tokens。
- browser cache `latestSeq` revalidation/delta chain。
- browser cache write/remove hooks。
- 500 complete-turn persistent retention。
- 为填满 persistent cache而执行的 idle 50-turn prefetch。

保留：

- stable id map/merge，用于小分页 overlap、optimistic echo和 live stream reconciliation。
- request/generation fence，用于切 Session和乱序 response。
- Agent-scoped identity。
- focus window与 search locator fence。
- 内存清理：logout、Session delete、Agent/session generation replacement时清理非权威 rows。

## 9. 虚拟列表

必须使用虚拟列表，但虚拟化解决的是 DOM/layout，不代替 Agent 分页。

现有 `VirtualTranscript` 继续作为唯一实现：

- item 单位保持现有 message block，而不是 raw streaming token。
- 可变高度由 estimate + ResizeObserver 校正。
- scroll lookup 为预计算 offsets + binary search。
- prepend 前记录首个可见 stable key 与 offset；page commit 后恢复相对位置。
- bottom follow 只在用户仍拥有 tail-follow 意图时执行；点击“最新”恢复该意图，显式滚轮、触摸、键盘滚动、滚动条拖动或历史定位暂停。布局测量暂时离底不取消跟随。
- 跟随期间虚拟窗口固定选择尾部，`VirtualTranscript` 统一负责到底与高度补偿；仅虚拟 transcript 容器关闭浏览器原生 scroll anchoring，避免重复调整。切换到阅读或定位会使已排队的到底工作失效。
- 暂停阅读时，虚拟行高度、prepend 与 transcript 上方状态节点的位移由同一滚动调度补偿。上方节点缩小时从布局变化前的位置恢复，避免浏览器边界 clamp 后重复补偿；目标定位使用最终 DOM 几何并消费待执行补偿。
- 搜索定位使用 stable key/DOM child anchor；异步 Markdown、图片和 tool 展开后的高度变化继续由 active target alignment校正。

分页默认 5 turns；virtual overscan 保持小值。5 turns 是网络/Agent读取批次，不是 DOM item数，也不是硬编码消息条数。Agent同时保留 maxRows/maxBytes，避免一个异常大 turn 无界返回。

## 10. 搜索语义

本产品的 Conversation search 是“按用户输入找到一个 Conversation位置”，不是全文 message explorer。

- 默认 outline：只列 user messages。
- query：只搜 user message text。
- 点击：显示该 user message及其附近所有可见 VP responses。
- 不在搜索列表中为每个 AI/VP response单独建顶层结果。
- 不把搜索列表变成新的 Session/sidebar。

未来若增加“搜索 AI 输出”，必须作为独立显式 scope；结果仍需映射到稳定 user-turn anchor，不能偷偷改变默认语义。

## 11. IndexedDB 删除与一次性清理

删除 `web/stores/helpers/yeaft-history-browser-cache.js` 及其 auth/chat/handler引用。

仅删除代码不会清掉用户浏览器中已经存在的 `yeaft-history-cache` database。需要一个一次性、非阻塞 cleanup：

```js
indexedDB.deleteDatabase('yeaft-history-cache')
```

该 cleanup：

- 不读取旧 plaintext rows。
- 不阻塞应用启动、登录或 Session首屏。
- `blocked` / error 只记录一次并继续；旧 tab关闭后浏览器可完成删除。
- 使用独立 migration marker，成功后不重复执行。
- marker 可放普通 localStorage；它不保存 transcript。

完成一个兼容发布周期后，可连同 cleanup marker一起删除。

## 12. 迁移与交付顺序

### Phase A：删除持久浏览器 transcript

1. 加入 legacy IndexedDB database best-effort删除。
2. 删除 hydrate/write/remove/owner fence与 auth耦合。
3. Session选择总是直接请求 Agent recent 5 turns。
4. 删除 500-turn cache ceiling和后台 cache prefetch。
5. 保留当前小页 merge与 VirtualTranscript。

### Phase B：收敛搜索为 user-message locator

1. outline/search请求固定 `senderKey: "user"`。
2. 搜索 UI删除 assistant/VP sender selector，或将其隐藏在未来显式全文模式之后。
3. 点击继续复用 index-fenced around window，默认 before/after各5 turns。
4. stale locator只刷新一次。

### Phase C：完整双向 anchored pagination

1. Agent增加/收敛 `afterSeq` 的 newer complete-turn page。
2. history window向下滚动增量取相邻 turns。
3. 与 latest窗口 overlap后合并并切回 live-tail。
4. 未 overlap前保持 detached window，不接入远端 live events。

Phase A/B可在一个 PR内完成。Phase C必须有独立协议测试和滚动E2E；不能为了形式上的“一次完成”把未验证的双向窗口混进首个删除缓存PR。

## 13. 正确性不变量

1. Agent JSONL transcript始终是唯一权威。
2. Server不保存完整 transcript。
3. Browser不持久化 Yeaft transcript。
4. user-turn边界只由真实可见 user-authored row创建。
5. 每个 response必须通过 `(agentId, sessionId, requestId/generation)` fence。
6. 页面只合并已证明 overlap的连续区间。
7. Agent返回 rows已经按 durable seq排序；浏览器不全量重排。
8. 搜索 locator绑定 index generation与entry identity。
9. 新 event不能把 anchored-history与live tail伪装成连续数组。
10. virtual item key跨prepend与异步高度变化保持稳定。

## 14. 性能预算

针对包含至少 10,000 persisted rows的 Session：

- 正常打开网络响应只包含最新 5个完整 turns，并受 row/byte budget约束。
- 浏览器首屏不打开/读取 Yeaft transcript IndexedDB。
- 首屏不扫描、排序或retention处理完整历史。
- 向上分页成本与5个turns页面相关。
- 搜索列表由Agent FTS/index分页，浏览器不扫描当前messagesMap。
- DOM mounted item数量受viewport + overscan约束。
- 页面切换后旧Session的非当前窗口可清理，不以500 turns为持久缓存目标。

需要用现有 perf trace记录：Agent store read、wire bytes、browser chunk apply、next paint。性能结论以测量为准。

## 15. 测试与门禁

### Agent focused tests

- latest读取恰好按完整 user-turn边界返回5 turns。
- 多VP / route_forward rows归入同一user turn，不产生新user边界。
- outline/search使用user sender filter只返回user entries。
- anchor window返回命中点前后完整turns。
- stale generation/source mutation拒绝旧locator。
- row/byte budget不会静默拼接不连续窗口。

### Web focused tests

- Session选择不调用IndexedDB hydrate，只发recent 5-turn请求。
- history chunk不写IndexedDB。
- logout与Session delete只清browser memory，不等待transcript DB transaction。
- search/outline payload固定user scope。
- 搜索窗口与live tail保持detached；新event不错误拼接。
- prepend保持可见anchor；虚拟列表只mount窗口items。
- overlapping page按stable identity幂等合并。

### 浏览器 E2E

- 10k-row fixture打开后首屏正确且无长任务级卡顿。
- 连续向上分页、搜索定位、上下滚动、回到最新。
- 搜索定位期间收到新WebSocket消息不跳动。
- Markdown、图片、展开tool导致高度变化后搜索anchor仍稳定。
- 320px、桌面、light/dark、键盘focus。

### 必跑门禁

```bash
npm run test:focus -- <相关 focused tests>
npm test
npm run check:server-agent-syntax
npm run release:guard
npm run build
npm run test:e2e -- <相关 spec>
git diff --check
```

## 16. 风险与取舍

- **无离线历史**：删除IndexedDB后刷新页面必须连接Agent。这是用简单、一致的所有权换来的明确取舍。
- **Agent往返延迟**：首屏只读5 turns且不启动完整runtime；若测量仍慢，应优化segment/index读取，不应恢复全量browser cache。
- **超大单turn**：虚拟化不能减少一个巨大mounted item内部DOM，必须依赖maxBytes、response collapse及必要时按安全VP execution block拆分显示。
- **旧数据归属不完美**：legacy rows缺少稳定causal root时继续以可见user边界投影，不按时间戳重写历史。
- **index短暂building**：搜索面板显示building/error并允许重试；正常latest分页不依赖history index，因此主Conversation不被搜索索引启动阻塞。
- **双向pagination复杂**：先确保recent/older/search locator正确，再独立实现newer cursor；严禁把远处latest直接append到anchored window。

## 17. 决策

采用：

```text
Agent canonical transcript
+ Agent rebuildable user-message FTS/index
+ recent/before/around turn windows
+ WebSocket live tail
+ browser-memory-only projection
+ existing variable-height VirtualTranscript
```

拒绝：

- Server DB transcript副本。
- 浏览器完整IndexedDB transcript同步。
- 每次进入Session做全量merge/sort/retention。
- 按raw message count切页。
- 搜索后把不连续latest events直接拼到历史窗口。
