# Chat ↔ Yeaft 串话 — Bug 修复记录

**日期**: 2026-04-30
**关联 PR**: `fix(yeaft): chat-yeaft activeConversations crosstalk on re-entry`
**关联文件**:
- `web/stores/chat.js` — `enterYeaft` / `leaveYeaft`
- `web/stores/helpers/yeaft-view.js`（新增）
- `test/web/stores/helpers/yeaft-view.test.js`（新增）

## 现象

进入 Yeaft 页面、聊几句、离开回到 Chat 之后，Chat 视图里出现了 Yeaft 的内容（消息混进了 Chat 的 conversation 列表）。

用户描述："我不知道为什么在 chat 中突然有这些信息，会是因为同时开着 yeaft 模式，所以串了？"

## 根因

`web/stores/chat.js` 的 `enterYeaft` 在每次调用时都**无条件**覆盖 `_savedActiveConversations` 快照：

```js
enterYeaft(agentId = null) {
  this.currentView = 'yeaft';
  // ...
  this._savedActiveConversations = [...this.activeConversations];  // ← 问题点
  this.activeConversations = [this.yeaftConversationId];
  // ...
}
```

`leaveYeaft` 在退出时把这个快照还原回 `activeConversations`：

```js
leaveYeaft() {
  this.currentView = 'chat';
  if (this._savedActiveConversations) {
    this.activeConversations = this._savedActiveConversations;
    this._savedActiveConversations = null;
  }
}
```

正常流程（Chat → Yeaft → Chat）没问题：进入时把 Chat 的 `activeConversations`（比如 `['chat-1']`）存起来，活跃换成 `['yeaft-local-1']`；退出时还原。

**Bug 出现在二次进入**（已经在 Yeaft 内再调一次 `enterYeaft`）：
1. 用户从 Chat 进入 Yeaft → `_savedActiveConversations = ['chat-1']`，`activeConversations = ['yeaft-local-1']`
2. 二次调用 `enterYeaft`（切换 agent / 程序逻辑触发 / `session_ready` 之后某条 watcher 重新调）→ **此时 `activeConversations` 已经是 `['yeaft-local-1']`，但代码无条件把它当作"原始 Chat 状态"覆盖到 `_savedActiveConversations`**。现在 `_savedActiveConversations = ['yeaft-local-1']`。
3. 用户离开 Yeaft → `leaveYeaft` 把 `_savedActiveConversations`（已经是被污染的 `['yeaft-local-1']`）还原到 `activeConversations`。
4. Chat 视图的 `activeConversations` 现在包含 yeaft 的 conversationId。MessageList 读到 yeaft 的消息，渲染在 Chat 视图里——串了。

`enterYeaft` 的二次调用并不罕见——切换 agent、`session_ready` 回放、外部 watcher 触发的 `currentView = 'yeaft'` 都会再走一遍。

## 修复

把保存/还原逻辑提取到一个纯函数 helper（`web/stores/helpers/yeaft-view.js`），并在 `applyEnterYeaftTransition` 里加幂等性守卫：

```js
export function applyEnterYeaftTransition(store) {
  const enteringFresh = store.currentView !== 'yeaft';
  if (enteringFresh) {
    store._savedActiveConversations = [...store.activeConversations];
  }
  store.activeConversations = [store.yeaftConversationId];
  return enteringFresh;
}
```

只在 `currentView !== 'yeaft'` 的"真正 Chat → Yeaft 切换"边沿才记快照。已经在 Yeaft 里再调一次时，活跃数组照常切到 yeaft 的 ID（无副作用，本来就是它），但**快照保持不变**——保留首次切换时记下的 Chat 原始状态。

调用顺序的注意点：helper 读 `currentView` 来判断是否"首次进入"，所以**必须在 `currentView = 'yeaft'` 之前调**。`enterYeaft` 重新组织过：

```js
enterYeaft(agentId = null) {
  // ... agentId / yeaftConversationId / messagesMap 处理 ...

  // Helper 读 BEFORE 状态的 currentView
  yeaftViewHelpers.applyEnterYeaftTransition(this);
  // 然后才翻页
  this.currentView = 'yeaft';

  // ... session_ready 回放等 ...
}
```

## 为什么提取成 helper

Pinia 的 store 是 `defineStore({ state, actions, ... })` 一大坨，跟 Vue/Pinia 全局耦合，单元测试要 mock 整个上下文。把这两个小动作抽成接收 store-shape 对象的纯函数，就能直接 vitest 测，9 个 case 全覆盖：

- 首次切换：取快照、切活跃数组
- 空 chat 列表的边界情况
- 快照是拷贝（修改原数组不影响快照）
- **核心：二次进入不覆盖快照**（这个 bug 本身）
- 二次进入 + `yeaftConversationId` 也变了（session_ready 迁移场景）
- 退出还原 + 清空快照
- 冷启动直接退出：no-op
- 完整往返
- 含二次进入的完整往返还能还原原始 Chat 列表

## 影响面

- **API**: 无变化。
- **持久化**: 无变化。
- **store 接口**: `_savedActiveConversations` 字段语义和位置不变，只是它的写时机变了（首次进入才写）。
- **其它代码读取 `_savedActiveConversations`**: 没找到外部读这个字段的代码，它一直就是 `enterYeaft` / `leaveYeaft` 内部用的暂存。

## 全量测试

`npx vitest run` — 1210 / 1210 通过（新增 9 个 helper 测试）。
