# Design: Group-Chat VP Card + Right-Side Detail Panel

> **Status**: Approved (2026-05-07) — open points resolved, ready for plan
> **Scope**: Yeaft group-chat UI redesign — replace the inline "expanded VP turn" pattern with a card-based main feed and a right-side detail drawer for `feature` turns. `quick` turns stay rendered inline as today.

---

## 目标

把 Yeaft 群聊里 VP turn 的展示方式从「主消息流里把每个 VP 的全部内容（文字 + tool use + 图片）都展开渲染」改成：

| Intent | 主消息流表现 | Detail 来源 |
|---|---|---|
| `quick`（闲聊/简单问答） | 完整文本（同今天的 AssistantTurn） | 不需要 detail |
| `feature`（复杂任务/带工具调用） | **VpQuickCard 卡片**：avatar + name + Track-A preview + 实时状态 | 点击 → **右侧 detail drawer** 显示完整 messages + tool use |

Detail drawer 默认隐藏，从右侧滑入，主消息流仍占满宽度（drawer 浮在上面或推开主流，待设计阶段确定细节）。Detail 顶部有个 info button，点击在面板内部 popover 形式展开 persona/role/dream 元信息（不跳走）。

---

## 现有基础设施（不动）

经过 Explore agent 确认，所有数据通路都已就绪：

- **Track-A 引擎**：`agent/yeaft/quick-response.js` + `agent/yeaft/feature-arc.js`。每个 VP turn 都 fire-and-forget 一次 LLM call，140 字内的 preview 文字，8s 超时，最多 1 次重试。返回 `{intent: "quick"|"feature", preview}`。
- **Wire 格式**：`sendYeaftEvent({type:'quick_preview', vpId, turnId, intent, preview}, envelope)`。已经在跑。
- **Web 状态**：`store.yeaftQuickPreviews[vpId:turnId] = {intent, preview, ts, ...}`。`MessageList.turnGroups` 已经在调 `injectQuickPreviews(items, previewMap)`。
- **VP detail view**：`enterVpDetailView(vpId)` + `VpDetailView.js` 已存在，但目前是中间列全屏，渲染 persona / dream，**不渲染 messages + tool use**。

> 关键洞察：架构已经搭好了，这次主要是**UI 渲染分流 + detail panel 重定向**。Track-A 不用动。

---

## 架构

### 渲染分流（主消息流）

`MessageList.turnGroups` 计算结果里给 `assistant-turn` 加一个 `intent` 字段，由该 turn 对应的 quickPreview 决定：

```
intent = store.yeaftQuickPreviews[vpId:turnId]?.intent || 'quick'
```

> **缺省值是 `quick`**：Track-A 还在跑（preview 没回来）或失败的情况下，turn 走老路渲染（不收起）。这等于"feature 是显式收起，quick 是默认行为"——失败时降级为可见，比降级为不可见要安全。

模板渲染分流：

```html
<template v-for="item in turnGroups" :key="item.id">
  <UserMessage v-if="item.type === 'user'" ... />
  <VpQuickCard
    v-else-if="item.type === 'assistant-turn' && item.intent === 'feature'"
    :turn="item"
    @open-detail="onOpenVpTurnDetail(item)"
  />
  <AssistantTurn v-else-if="item.type === 'assistant-turn'" :turn="item" />
  ...
</template>
```

### Track-A 失败/超时的卡片表现

**决策（2026-05-07）：fallback to quick mode。**

Track-A 失败时 web 不会收到 `quick_preview` 事件——`store.yeaftQuickPreviews[key]` 永远是空。`intent` fallback 到 `'quick'`，turn 走老路完整渲染（`AssistantTurn` 完整展开）。

理由：(1) Track-A 失败是异常路径，用户更想直接看到内容；(2) 转圈卡片下方藏着完整内容会很怪；(3) "VP is responding" generic 文字本身没信息量。这条路径不需要专门写 fallback 分支，是 turnGroups intent 默认值的天然产物。

### 实时状态指示器（高精度）

VpQuickCard 上 "正在使用 web_search" 这种实时文字，需要订阅当前 turn 的 tool 流。已有数据：每个 turn 的 `messages` 数组里包含 `tool-use` 条目（最后一个就是当前正在跑的）。新增一个 computed：

```js
turn.currentStatus = (() => {
  if (!turn.isStreaming) {
    return { kind: 'done', toolCount: turn.toolMsgs.length, durationMs: ... };
  }
  const lastTool = turn.toolMsgs[turn.toolMsgs.length - 1];
  if (lastTool && !lastTool.hasResult) {
    return { kind: 'tool', toolName: lastTool.toolName };
  }
  return { kind: 'thinking' };
})();
```

VpQuickCard 模板按 kind 渲染："🔧 正在使用 `web_search`" / "💭 正在思考..." / "✓ 完成 · 用时 12s · 3 个工具"。

中止态（vp_typing_aborted）：`{kind: 'aborted'}` → "⊘ 已中止"。

### 右侧 Detail Drawer

新组件 `VpTurnDetailDrawer.vue`（实际是 `.js`，符合本项目约定）。布局：

```
┌─────────────────────────────────────────┐
│ Steve Jobs                    [ⓘ] [✕]  │  ← header (avatar + name + info + close)
├─────────────────────────────────────────┤
│                                         │
│  [完整 textContent / markdown]          │
│                                         │
│  [ToolLine: web_search { query: ... }]  │
│  [ToolLine: bash { ... }]               │
│  [ChatImage]                            │
│  [AskCard, handoffHints, ...]           │
│                                         │
└─────────────────────────────────────────┘
```

也就是把现在 AssistantTurn.js 主流里渲染的那一坨内容 **完整搬到 drawer 里**——可以直接复用 AssistantTurn.js 作为 drawer 的 body（同一组件双场景渲染，无需重写）。

Info button (`ⓘ`) 点击 → drawer 内部叠加一层 popover/expand，显示当前的 VpDetailView 元数据内容（persona、role、dream status）。**不切换路由，不替换 drawer 内容**——drawer 的主要内容（messages+tools）保持可见，info popover 在它之上。

### 状态管理

```js
// chat.js state additions
yeaftOpenVpTurnDetail: null,  // { vpId, turnId } | null
// (replaces or coexists with the existing yeaftActiveVpDetailId — TBD)
```

```js
// chat.js actions
openVpTurnDetail({ vpId, turnId }) { this.yeaftOpenVpTurnDetail = { vpId, turnId }; }
closeVpTurnDetail() { this.yeaftOpenVpTurnDetail = null; }
```

YeaftPage 监听这个状态，drawer 显隐由它控制。点击主流另一个 feature 卡片 → 切换 detail 内容（同一 drawer 实例）。

### 与现有 VpDetailView (`yeaftActiveVpDetailId`) 的关系

这是个重要决策：现在已存在 `enterVpDetailView(vpId)` → 中间列全屏的 VpDetailView（显示 persona 元数据）。这次新加的右侧 drawer 是**针对单个 turn**的（vpId+turnId），跟旧的 `vpId-only` detail 是不同维度。两个并存：

- 旧 `enterVpDetailView` 入口（侧边栏 VP 列表点头像）→ 仍然中间列全屏 → persona/dream
- 新 `openVpTurnDetail` 入口（主流 VpQuickCard 点击）→ 右侧 drawer → messages+tool use（info button popover 显示 persona/dream）

这样两个入口、两种语义清晰分离。Drawer 内部的 info popover 与 VpDetailView 共用底层组件即可。

---

## 数据流

### Quick path（intent=quick）
```
runVpTurn → Track-A LLM → quick_preview event → store.yeaftQuickPreviews[k]={intent:"quick"}
            ↓
            完整 stream → 主流 AssistantTurn 渲染（不变）
```

### Feature path（intent=feature）
```
runVpTurn → Track-A LLM → quick_preview event → store.yeaftQuickPreviews[k]={intent:"feature", preview:"…"}
            ↓
            完整 stream → store.messagesMap[…] 持续写入 turn 的 messages
            ↓
            MessageList.turnGroups 看到 intent=feature → VpQuickCard 渲染（preview + 实时状态）
            ↓
            User 点 VpQuickCard → openVpTurnDetail({vpId, turnId})
            ↓
            VpTurnDetailDrawer 从右侧滑入 → 内部渲染 AssistantTurn(turn) 即得完整内容
```

### 持久化（决策已锁定）
- **挂载位置（2026-05-07 决定）**：挂在 turn 的第一条 assistant message 上。`(vpId, turnId)` 是查找键，写一次。不新建独立表。
- **Schema 改动**：`message-db.js` 给 messages 加 `quick_preview` + `quick_intent` 两列（文本，可空）。仅在 `runVpTurn` 完成时写一次。
- **加载路径**：`bulkAddHistory` / `formatDbMessage` 把这两列读回来填到 `yeaftQuickPreviews` map。
- **代价**：列对绝大多数 message 是 NULL（稀疏），可接受；好处是不引入新 schema 维度，加载时无 join。

---

## 组件清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `web/components/VpQuickCard.js` | 新增 | feature turn 卡片：avatar + name + preview + status |
| `web/components/VpTurnDetailDrawer.js` | 新增 | 右侧 drawer 容器，内部嵌 AssistantTurn |
| `web/components/MessageList.js` | 修改 | turnGroups 标 intent；模板按 intent 分流；新增 `onOpenVpTurnDetail` |
| `web/components/YeaftPage.js` | 修改 | 加 `<VpTurnDetailDrawer v-if="store.yeaftOpenVpTurnDetail" />` |
| `web/stores/chat.js` | 修改 | 新增 `yeaftOpenVpTurnDetail` state + `openVpTurnDetail/closeVpTurnDetail` actions；handleYeaftOutput 不变 |
| `web/stores/helpers/turn-intent.js` | 新增 | 纯函数：从 (turn, quickPreviewMap) 推导 turn.intent |
| `web/styles/yeaft-vp-card.css` | 新增 | VpQuickCard 卡片样式（紧凑 chip-like）+ status indicator |
| `web/styles/yeaft-detail-drawer.css` | 新增 | drawer 滑入动画 + 右侧定位 |
| `agent/yeaft/conversation/persist.js` | 修改 | 写入 quick_preview + quick_intent |
| `server/db/message-db.js` | 修改 | schema 加列 + migration |
| `server/db/migrations/00XX-add-quick-preview.sql` | 新增 | migration 脚本 |
| `web/stores/helpers/messages.js`（formatDbMessage） | 修改 | 反向加载 quick_preview/intent 到 yeaftQuickPreviews |

---

## 测试

| 测试文件 | 验证 |
|---|---|
| `test/web/stores/helpers/turn-intent.test.js` | 纯函数推导：preview 不在 / preview 在但 intent=quick / intent=feature 三种路径 |
| `test/web/vp-quick-card.test.js` | VpQuickCard 行为：状态机切换（streaming → done / aborted），点击触发 openVpTurnDetail |
| `test/web/vp-turn-detail-drawer.test.js` | drawer 显隐由 store.yeaftOpenVpTurnDetail 驱动；内部 info popover 切换 |
| `test/server/db/quick-preview-persist.test.js` | DB 列写入 + 读回 + migration 兼容老数据 |
| `test/agent/yeaft/quick-preview-persist-roundtrip.test.js` | runVpTurn 完成时正确写入 turn 的最后 assistant message |
| `test/web/group-chat-tool-order.test.js`（已存在） | 仍然 green（这次不动 turnGroups 排序逻辑） |

---

## 范围（YAGNI 砍掉的）

- ❌ Track-A 失败时的 generic 占位卡片 + 转圈（决策：fallback to quick mode，直接展开）
- ❌ 永远可见的右侧分栏（默认隐藏，点击才弹）
- ❌ 输出中自动跟踪 feature VP（用户拒绝了）
- ❌ 在 detail drawer 里嵌入新对话输入框（这是 detail，不是 reply）
- ❌ 修改 Track-A 的触发条件（现在是always-on，保留）
- ❌ 重构 AssistantTurn.js（直接复用作为 drawer body）
- ❌ 独立 `yeaft_quick_preview` 表（决策：直接挂在 assistant message 上）

---

## 决策记录（2026-05-07 锁定）

1. **Track-A 失败 fallback**：fallback to quick mode（intent 默认 'quick' → AssistantTurn 完整展开）。无需单写 fallback 分支。
2. **持久化挂载位置**：挂在 turn 第一条 assistant message 上，加 `quick_preview` + `quick_intent` 两列。

---

## Build order（不是计划，是粗略次序，详见 writing-plans 阶段）

1. 持久化 schema + migration（最底层）
2. `turn-intent.js` 纯函数 + 单测
3. VpQuickCard 组件 + 状态指示器 + 单测
4. YeaftPage drawer 接入 + Drawer 容器 + 单测
5. MessageList 渲染分流 + onOpenVpTurnDetail 接线
6. Drawer 里 info popover
7. 全量回归 vitest（必须 1670+ 全绿）
