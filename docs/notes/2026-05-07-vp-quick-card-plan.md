# VP Quick Card + Detail Drawer 实现计划

> **给代理执行者：** 推荐使用 `yeaft:subagent-development` skill 按任务执行此计划。步骤使用 checkbox (`- [ ]`) 语法跟踪进度。

**目标：** 把 Unify 群聊里 `intent === 'feature'` 的 VP turn 从主消息流的 `AssistantTurn` 完整展开，改成紧凑的 `VpQuickCard` 卡片；点卡片在右侧滑出 `VpTurnDetailDrawer`，里面复用 `AssistantTurn` 渲染完整 messages + tools。

**架构：**
- `MessageList.turnGroups` 在已有的 turn 对象上派生 `intent`（`store.unifyQuickPreviews[vpId:turnId]?.intent || 'quick'`）。模板按 `intent` 分流：feature → 新组件 `VpQuickCard`，其他 → 现有 `AssistantTurn`（不动）。
- 新增 store state `unifyOpenVpTurnDetail: { vpId, turnId } | null` + 两个 action。`UnifyPage.js` 监听这个 state 渲染 `VpTurnDetailDrawer`。drawer 主体直接挂 `<AssistantTurn :turn="targetTurn" />`，零内容重写。
- info button 是 drawer 内部一个 popover（CSS 浮层），点开显示 persona / dream，**不切换 store 也不动 router**。

**技术栈：** Vue 3 Options API（无 SFC，CDN 加载），Pinia store，Vitest。

**关键已知前提（不动）：**
- Track-A wire 协议、`store.unifyQuickPreviews` 的写入、`injectQuickPreviews` 的调用都已在跑。本计划不动 backend，不改 wire。
- `AssistantTurn` 接收 `:turn` 一个 prop（看 `web/components/AssistantTurn.js:9-18`），可以无包装直接复用为 drawer body。
- Unify 当前 NOT 持久化到 SQLite `messages` 表（`server/handlers/agent-output.js:318` 是纯转发），重载 web 时不会回灌 quick preview——所以**本计划不做持久化**。重载后 feature turn 会因 `unifyQuickPreviews` 为空而 fallback 到 `intent='quick'`（设计文档已锁定的安全降级）。持久化作为独立 follow-up plan。

---

## 文件清单

### 新建
| 文件 | 职责 |
|---|---|
| `web/stores/helpers/turn-intent.js` | 纯函数 `deriveTurnIntent(turn, previewMap)`：返回 `'quick'` 或 `'feature'`。 |
| `web/components/VpQuickCard.js` | feature turn 紧凑卡片：avatar + name + Track-A preview + 实时状态指示器。点击 emit `open-detail`。 |
| `web/components/VpTurnDetailDrawer.js` | 右侧滑入 drawer：header（avatar+name+ⓘ+✕）+ body（嵌入 AssistantTurn）。内部 info popover 显示 persona/dream。 |
| `web/styles/unify-vp-card.css` | `VpQuickCard` 样式（紧凑 chip-like）+ 状态指示器配色。 |
| `web/styles/unify-detail-drawer.css` | drawer 右侧定位 + 滑入动画 + info popover 浮层样式。 |
| `test/web/stores/helpers/turn-intent.test.js` | `deriveTurnIntent` 三条路径单测。 |
| `test/web/vp-quick-card.test.js` | `VpQuickCard` 渲染：preview 文字、状态机切换、点击触发 `open-detail`。 |
| `test/web/vp-turn-detail-drawer.test.js` | drawer 显隐由 `unifyOpenVpTurnDetail` 驱动；info popover 切换。 |
| `test/web/turn-intent-injection.test.js` | turnGroups 输出在每个 `assistant-turn` 上正确写入了 `intent`（依赖 `store.unifyQuickPreviews`）。 |

### 修改
| 文件 | 改动 |
|---|---|
| `web/stores/chat.js` | 加 state `unifyOpenVpTurnDetail`；加 actions `openVpTurnDetail({vpId,turnId})` / `closeVpTurnDetail()`。 |
| `web/components/MessageList.js` | turnGroups 在 `result.push(currentTurn)` 之后给每个 `assistant-turn` 写入 `intent`；模板分流：feature → `VpQuickCard`，其他 → `AssistantTurn` 不动。新增 `onOpenVpTurnDetail(item)` handler。 |
| `web/components/UnifyPage.js` | 顶层加 `<VpTurnDetailDrawer v-if="store.unifyOpenVpTurnDetail" />`。引入 css 文件。 |
| `web/index.html` | `<link rel="stylesheet">` 引入两个新 css。 |
| `web/i18n/en.js` + `web/i18n/zh-CN.js` | 加 status 文案：`vp.status.thinking` / `vp.status.tool` / `vp.status.done` / `vp.status.aborted`，info button title。 |

---

## 自审 — 范围检查

- ✅ 与设计 doc 「组件清单」对齐除 persist/migration 行（descoped，理由见上）。
- ✅ 测试文件每个对应一个新增/修改单元。
- ✅ Build order 与设计 doc 一致：纯函数 → 卡片 → drawer → 接线 → i18n → 回归。
- ✅ 未引入设计外的重构（`AssistantTurn`、`VpDetailView`、`enterVpDetailView` 全保留）。

---

## 任务 1: turn-intent 纯函数 + 单测

**文件：**
- 创建: `web/stores/helpers/turn-intent.js`
- 测试: `test/web/stores/helpers/turn-intent.test.js`

- [ ] **步骤 1: 写失败的测试**

把整个文件写成下面这样：

```javascript
// test/web/stores/helpers/turn-intent.test.js
import { describe, it, expect } from 'vitest';
import { deriveTurnIntent } from '../../../../web/stores/helpers/turn-intent.js';

describe('deriveTurnIntent', () => {
  it("returns 'quick' when turn has no speakerVpId or turnId", () => {
    expect(deriveTurnIntent({}, {})).toBe('quick');
    expect(deriveTurnIntent({ speakerVpId: 'jobs' }, {})).toBe('quick');
    expect(deriveTurnIntent({ turnId: 't1' }, {})).toBe('quick');
  });

  it("returns 'quick' when previewMap has no matching entry (Track-A pending or failed)", () => {
    const turn = { speakerVpId: 'jobs', turnId: 't1' };
    expect(deriveTurnIntent(turn, {})).toBe('quick');
    expect(deriveTurnIntent(turn, { 'jobs:other': { intent: 'feature' } })).toBe('quick');
  });

  it("returns the preview's intent when key matches", () => {
    const turn = { speakerVpId: 'jobs', turnId: 't1' };
    const map = { 'jobs:t1': { intent: 'feature', preview: 'building...' } };
    expect(deriveTurnIntent(turn, map)).toBe('feature');
  });

  it("returns 'quick' when matched entry has intent='quick'", () => {
    const turn = { speakerVpId: 'jobs', turnId: 't1' };
    const map = { 'jobs:t1': { intent: 'quick', preview: 'sure' } };
    expect(deriveTurnIntent(turn, map)).toBe('quick');
  });

  it("falls back to 'quick' if intent is malformed", () => {
    const turn = { speakerVpId: 'jobs', turnId: 't1' };
    const map = { 'jobs:t1': { intent: 'garbage' } };
    expect(deriveTurnIntent(turn, map)).toBe('quick');
  });

  it('handles null/undefined inputs without throwing', () => {
    expect(deriveTurnIntent(null, null)).toBe('quick');
    expect(deriveTurnIntent(undefined, undefined)).toBe('quick');
  });
});
```

- [ ] **步骤 2: 运行测试确认失败**

运行: `npx vitest run test/web/stores/helpers/turn-intent.test.js`

预期: FAIL（模块不存在）

- [ ] **步骤 3: 写最小实现**

创建 `web/stores/helpers/turn-intent.js` 写入：

```javascript
/**
 * turn-intent.js — Pure helper for the VP-card-vs-AssistantTurn render
 * branch in MessageList.
 *
 * The web store keeps a `unifyQuickPreviews` map keyed by `${vpId}:${turnId}`
 * with shape `{ vpId, turnId, intent, preview, ts, ... }`. Track-A populates
 * the entry shortly after a VP turn starts; if Track-A fails or is still
 * pending, no entry exists and we fall back to `'quick'` (= render the turn
 * inline with the existing AssistantTurn — see design doc 2026-05-07 §
 * "Track-A 失败 fallback").
 *
 * @param {object|null} turn — turnGroups item with `speakerVpId` + `turnId`
 * @param {object|null} previewMap — `store.unifyQuickPreviews`
 * @returns {'quick'|'feature'}
 */
export function deriveTurnIntent(turn, previewMap) {
  if (!turn || !turn.speakerVpId || !turn.turnId) return 'quick';
  const map = previewMap || {};
  const entry = map[turn.speakerVpId + ':' + turn.turnId];
  if (!entry) return 'quick';
  return entry.intent === 'feature' ? 'feature' : 'quick';
}
```

- [ ] **步骤 4: 运行测试确认通过**

运行: `npx vitest run test/web/stores/helpers/turn-intent.test.js`

预期: PASS（6 tests）

- [ ] **步骤 5: 提交**

```bash
git add web/stores/helpers/turn-intent.js test/web/stores/helpers/turn-intent.test.js
git commit -m "feat(unify): add deriveTurnIntent pure helper for VP card render branch"
```

---

## 任务 2: 在 turnGroups 注入 intent 字段 + 单测

**文件：**
- 修改: `web/components/MessageList.js`（在 `finishTurn` 内部、`result.push(currentTurn)` 之前赋值 `intent`，并 import `deriveTurnIntent`）
- 测试: `test/web/turn-intent-injection.test.js`

- [ ] **步骤 1: 写失败的测试**

写一个直接调用 turnGroups 计算逻辑的测试。由于 turnGroups 当前是 inline computed 不能直接 import，先验证最小路径：模拟一个 turn 对象 + previewMap 调用 `deriveTurnIntent`，并断言它返回的 `intent` 与我们要在 turnGroups 写入的字段一致。

```javascript
// test/web/turn-intent-injection.test.js
import { describe, it, expect } from 'vitest';
import { deriveTurnIntent } from '../../web/stores/helpers/turn-intent.js';

// This test pins the contract that MessageList.turnGroups will use to stamp
// `intent` onto every assistant-turn it builds. It does not mount Vue.
// When MessageList is later refactored to delegate turn building to a pure
// helper (`web/stores/helpers/turn-groups.js` already exists for the typing-
// placeholder rule), this test should be promoted to call that helper and
// assert the field is present on every output assistant-turn.
describe('turn-intent injection contract', () => {
  it('stamps feature intent on a turn whose vpId:turnId matches a feature preview', () => {
    const turn = { type: 'assistant-turn', speakerVpId: 'jobs', turnId: 't1' };
    const map = { 'jobs:t1': { intent: 'feature', preview: 'building auth...' } };
    expect(deriveTurnIntent(turn, map)).toBe('feature');
  });

  it('leaves intent at quick for a turn with no matching preview (Track-A pending/failed)', () => {
    const turn = { type: 'assistant-turn', speakerVpId: 'jobs', turnId: 't1' };
    expect(deriveTurnIntent(turn, {})).toBe('quick');
  });

  it('leaves intent at quick for chat-mode turns without VP attribution', () => {
    const turn = { type: 'assistant-turn', speakerVpId: null, turnId: null };
    const map = { 'jobs:t1': { intent: 'feature' } };
    expect(deriveTurnIntent(turn, map)).toBe('quick');
  });
});
```

- [ ] **步骤 2: 运行测试确认 PASS（红 → 直接绿；任务 1 已实现）**

运行: `npx vitest run test/web/turn-intent-injection.test.js`

预期: PASS。此测试本质是固化合约——任务 3 / 4 实际接线 turnGroups 之前先固定预期。

- [ ] **步骤 3: 修改 MessageList.js — 在 turnGroups 里写入 intent**

用 Edit 工具，在 `web/components/MessageList.js` 顶部 import 块（约第 10 行旁边）追加：

```javascript
import { deriveTurnIntent } from '../stores/helpers/turn-intent.js';
```

然后在 `finishTurn` 函数体里，找到这两行（约 537-538）：

```javascript
            currentTurn.showSpeakerHeader = !!currentTurn.speakerVpId;
            result.push(currentTurn);
```

在它们之间插入一行：

```javascript
            currentTurn.showSpeakerHeader = !!currentTurn.speakerVpId;
            currentTurn.intent = deriveTurnIntent(currentTurn, store.unifyQuickPreviews);
            result.push(currentTurn);
```

- [ ] **步骤 4: 运行回归测试**

运行: `npx vitest run`

预期: 所有现有 test 仍 PASS，包括 `test/web/group-chat-tool-order.test.js`。

- [ ] **步骤 5: 提交**

```bash
git add web/components/MessageList.js test/web/turn-intent-injection.test.js
git commit -m "feat(unify): stamp intent on every assistant-turn in turnGroups"
```

---

## 任务 3: VpQuickCard 组件 + 状态指示器 + 单测

**文件：**
- 创建: `web/components/VpQuickCard.js`
- 创建: `web/styles/unify-vp-card.css`
- 修改: `web/i18n/en.js`, `web/i18n/zh-CN.js`（加 4 个 key）
- 测试: `test/web/vp-quick-card.test.js`

- [ ] **步骤 1: 写失败的测试**

```javascript
// test/web/vp-quick-card.test.js
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import VpQuickCard from '../../web/components/VpQuickCard.js';

function makeTurn(overrides = {}) {
  return {
    type: 'assistant-turn',
    id: 'turn_1',
    speakerVpId: 'jobs',
    turnId: 't1',
    isStreaming: false,
    toolMsgs: [],
    speakerTimestamp: 0,
    intent: 'feature',
    ...overrides,
  };
}

describe('VpQuickCard', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('renders the Track-A preview when present', () => {
    const wrapper = mount(VpQuickCard, {
      props: {
        turn: makeTurn(),
        preview: { intent: 'feature', preview: 'Refactoring auth module' },
      },
    });
    expect(wrapper.text()).toContain('Refactoring auth module');
  });

  it('shows "thinking" status while streaming with no tools', () => {
    const wrapper = mount(VpQuickCard, {
      props: {
        turn: makeTurn({ isStreaming: true }),
        preview: { intent: 'feature', preview: 'p' },
      },
    });
    expect(wrapper.find('.vp-card-status').classes()).toContain('status-thinking');
  });

  it('shows "tool" status with tool name when last toolMsg has no result', () => {
    const wrapper = mount(VpQuickCard, {
      props: {
        turn: makeTurn({
          isStreaming: true,
          toolMsgs: [{ toolName: 'web_search', hasResult: false }],
        }),
        preview: { intent: 'feature', preview: 'p' },
      },
    });
    expect(wrapper.find('.vp-card-status').classes()).toContain('status-tool');
    expect(wrapper.text()).toContain('web_search');
  });

  it('shows "done" status with tool count when not streaming', () => {
    const wrapper = mount(VpQuickCard, {
      props: {
        turn: makeTurn({
          toolMsgs: [
            { toolName: 'web_search', hasResult: true },
            { toolName: 'bash', hasResult: true },
          ],
        }),
        preview: { intent: 'feature', preview: 'p' },
      },
    });
    expect(wrapper.find('.vp-card-status').classes()).toContain('status-done');
    expect(wrapper.text()).toContain('2');
  });

  it('shows "aborted" when turn carries speakerStateCause === "vp_typing_aborted"', () => {
    const wrapper = mount(VpQuickCard, {
      props: {
        turn: makeTurn({ speakerStateCause: 'vp_typing_aborted' }),
        preview: { intent: 'feature', preview: 'p' },
      },
    });
    expect(wrapper.find('.vp-card-status').classes()).toContain('status-aborted');
  });

  it('emits open-detail with vpId+turnId when clicked', async () => {
    const wrapper = mount(VpQuickCard, {
      props: {
        turn: makeTurn(),
        preview: { intent: 'feature', preview: 'p' },
      },
    });
    await wrapper.find('.vp-quick-card').trigger('click');
    const events = wrapper.emitted('open-detail');
    expect(events).toBeTruthy();
    expect(events[0][0]).toEqual({ vpId: 'jobs', turnId: 't1' });
  });
});
```

- [ ] **步骤 2: 运行测试确认失败**

运行: `npx vitest run test/web/vp-quick-card.test.js`

预期: FAIL（VpQuickCard 不存在）

- [ ] **步骤 3: 写最小实现**

创建 `web/components/VpQuickCard.js`：

```javascript
import VpAvatar from './VpAvatar.js';

/**
 * VpQuickCard — compact card rendering for `intent === 'feature'` VP turns.
 * Replaces the full-AssistantTurn render in the main message stream;
 * clicking opens the right-side VpTurnDetailDrawer with the same turn's
 * full content.
 *
 * Props:
 *   turn    — turnGroups item: { speakerVpId, turnId, isStreaming, toolMsgs[],
 *             speakerStateCause, intent }
 *   preview — store.unifyQuickPreviews entry: { intent, preview, ... } | null
 *
 * Emits:
 *   open-detail({ vpId, turnId })
 */
export default {
  name: 'VpQuickCard',
  components: { VpAvatar },
  emits: ['open-detail'],
  props: {
    turn: { type: Object, required: true },
    preview: { type: Object, default: null },
  },
  computed: {
    previewText() {
      return (this.preview && this.preview.preview) || '';
    },
    status() {
      const t = this.turn;
      if (t.speakerStateCause === 'vp_typing_aborted') {
        return { kind: 'aborted' };
      }
      if (!t.isStreaming) {
        return { kind: 'done', toolCount: (t.toolMsgs || []).length };
      }
      const tools = t.toolMsgs || [];
      const last = tools[tools.length - 1];
      if (last && !last.hasResult) {
        return { kind: 'tool', toolName: last.toolName || 'tool' };
      }
      return { kind: 'thinking' };
    },
  },
  methods: {
    onClick() {
      this.$emit('open-detail', {
        vpId: this.turn.speakerVpId,
        turnId: this.turn.turnId,
      });
    },
  },
  template: `
    <div class="vp-quick-card" @click="onClick" role="button" tabindex="0"
         @keydown.enter.prevent="onClick" @keydown.space.prevent="onClick">
      <div class="vp-card-header">
        <VpAvatar :vp-id="turn.speakerVpId" :size="28" />
        <span class="vp-card-name">{{ turn.speakerVpId }}</span>
      </div>
      <div v-if="previewText" class="vp-card-preview">{{ previewText }}</div>
      <div class="vp-card-status" :class="'status-' + status.kind">
        <template v-if="status.kind === 'thinking'">
          <span class="vp-card-status-dot"></span>
          <span>{{ $t('vp.status.thinking') }}</span>
        </template>
        <template v-else-if="status.kind === 'tool'">
          <span class="vp-card-status-icon">🔧</span>
          <span>{{ $t('vp.status.tool', { name: status.toolName }) }}</span>
        </template>
        <template v-else-if="status.kind === 'done'">
          <span class="vp-card-status-icon">✓</span>
          <span>{{ $t('vp.status.done', { count: status.toolCount }) }}</span>
        </template>
        <template v-else-if="status.kind === 'aborted'">
          <span class="vp-card-status-icon">⊘</span>
          <span>{{ $t('vp.status.aborted') }}</span>
        </template>
      </div>
    </div>
  `,
};
```

- [ ] **步骤 4: 运行测试确认通过**

运行: `npx vitest run test/web/vp-quick-card.test.js`

预期: PASS（6 tests）。如果 `$t()` 在测试 mount 上下文里 undefined，给 mount 加 global stub：`global: { mocks: { $t: (k, p) => k + (p ? JSON.stringify(p) : '') } }`，并把每条 expect text 改成包含 i18n key 而非翻译值。

- [ ] **步骤 5: 加 i18n keys**

`web/i18n/en.js` 在 `vp:` 段落下加（如果没有 vp 段就加新顶层 key）：

```javascript
vp: {
  status: {
    thinking: 'thinking…',
    tool: 'using {name}',
    done: 'done · {count} tools',
    aborted: 'aborted',
  },
  detail: {
    info: 'Info',
    close: 'Close',
  },
},
```

`web/i18n/zh-CN.js`：

```javascript
vp: {
  status: {
    thinking: '正在思考…',
    tool: '正在使用 {name}',
    done: '完成 · {count} 个工具',
    aborted: '已中止',
  },
  detail: {
    info: '信息',
    close: '关闭',
  },
},
```

- [ ] **步骤 6: 加 css 文件**

创建 `web/styles/unify-vp-card.css`：

```css
.vp-quick-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
  margin: 6px 0;
  border-radius: 10px;
  background: var(--card-bg, #f5f5f4);
  cursor: pointer;
  transition: background 120ms ease;
  user-select: none;
}
.vp-quick-card:hover { background: var(--card-bg-hover, #ebebea); }
.vp-quick-card:focus-visible {
  outline: 2px solid var(--accent, #d97706);
  outline-offset: 2px;
}
.vp-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vp-card-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary, #1c1917);
}
.vp-card-preview {
  font-size: 13px;
  color: var(--text-secondary, #44403c);
  line-height: 1.4;
}
.vp-card-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-tertiary, #78716c);
}
.vp-card-status.status-thinking { color: var(--text-tertiary, #78716c); }
.vp-card-status.status-tool { color: var(--accent, #d97706); }
.vp-card-status.status-done { color: var(--success, #16a34a); }
.vp-card-status.status-aborted { color: var(--text-tertiary, #78716c); opacity: 0.7; }
.vp-card-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: vp-card-pulse 1.2s ease-in-out infinite;
}
@keyframes vp-card-pulse {
  0%,100% { opacity: 0.35; }
  50% { opacity: 1; }
}
```

- [ ] **步骤 7: 提交**

```bash
git add web/components/VpQuickCard.js web/styles/unify-vp-card.css \
        web/i18n/en.js web/i18n/zh-CN.js test/web/vp-quick-card.test.js
git commit -m "feat(unify): add VpQuickCard with status indicator for feature turns"
```

---

## 任务 4: chat.js store — unifyOpenVpTurnDetail state + actions

**文件：**
- 修改: `web/stores/chat.js`（state 块加 `unifyOpenVpTurnDetail: null`，actions 块加 `openVpTurnDetail` / `closeVpTurnDetail`）
- 测试: `test/web/vp-turn-detail-store.test.js`

- [ ] **步骤 1: 写失败的测试**

```javascript
// test/web/vp-turn-detail-store.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useChatStore } from '../../web/stores/chat.js';

describe('chat.js — unifyOpenVpTurnDetail', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('starts at null', () => {
    const store = useChatStore();
    expect(store.unifyOpenVpTurnDetail).toBeNull();
  });

  it('openVpTurnDetail sets the descriptor', () => {
    const store = useChatStore();
    store.openVpTurnDetail({ vpId: 'jobs', turnId: 't1' });
    expect(store.unifyOpenVpTurnDetail).toEqual({ vpId: 'jobs', turnId: 't1' });
  });

  it('closeVpTurnDetail resets to null', () => {
    const store = useChatStore();
    store.openVpTurnDetail({ vpId: 'jobs', turnId: 't1' });
    store.closeVpTurnDetail();
    expect(store.unifyOpenVpTurnDetail).toBeNull();
  });

  it('openVpTurnDetail with another vpId/turnId switches detail target', () => {
    const store = useChatStore();
    store.openVpTurnDetail({ vpId: 'jobs', turnId: 't1' });
    store.openVpTurnDetail({ vpId: 'wozniak', turnId: 't2' });
    expect(store.unifyOpenVpTurnDetail).toEqual({ vpId: 'wozniak', turnId: 't2' });
  });

  it('openVpTurnDetail ignores calls missing vpId or turnId', () => {
    const store = useChatStore();
    store.openVpTurnDetail({ vpId: 'jobs' });
    expect(store.unifyOpenVpTurnDetail).toBeNull();
    store.openVpTurnDetail({ turnId: 't1' });
    expect(store.unifyOpenVpTurnDetail).toBeNull();
    store.openVpTurnDetail(null);
    expect(store.unifyOpenVpTurnDetail).toBeNull();
  });
});
```

- [ ] **步骤 2: 运行测试确认失败**

运行: `npx vitest run test/web/vp-turn-detail-store.test.js`

预期: FAIL（state / actions 不存在）

- [ ] **步骤 3: 改 chat.js — 加 state**

打开 `web/stores/chat.js`，在 state 块里 `unifyQuickPreviews: {},`（约 311 行）下面找 `// Active VP turns`（约 313 行）。在那里、相同区域追加：

```javascript
    // Right-side detail drawer target — populated when the user clicks a
    // VpQuickCard in the main feed; cleared on close. Coexists with
    // `unifyActiveVpDetailId` (the older center-column persona view) —
    // the two are different dimensions (turn-scoped vs vp-scoped).
    unifyOpenVpTurnDetail: null,  // { vpId, turnId } | null
```

- [ ] **步骤 4: 改 chat.js — 加 actions**

在 actions 块（找 `enterUnify(agentId = null)` 旁边的兄弟 actions），追加两个新 action（位置随便选个语义相近的；`enterUnify` 之前/之后都可以）：

```javascript
    /**
     * Open the right-side VP-turn detail drawer for a single VP turn.
     * Idempotent: switching to a different vpId+turnId replaces the
     * descriptor; the drawer keeps its DOM instance.
     * No-op if vpId or turnId is missing.
     */
    openVpTurnDetail(payload) {
      if (!payload || !payload.vpId || !payload.turnId) return;
      this.unifyOpenVpTurnDetail = { vpId: payload.vpId, turnId: payload.turnId };
    },

    closeVpTurnDetail() {
      this.unifyOpenVpTurnDetail = null;
    },
```

- [ ] **步骤 5: 运行测试确认通过**

运行: `npx vitest run test/web/vp-turn-detail-store.test.js`

预期: PASS（5 tests）

- [ ] **步骤 6: 提交**

```bash
git add web/stores/chat.js test/web/vp-turn-detail-store.test.js
git commit -m "feat(unify): add unifyOpenVpTurnDetail state + open/close actions"
```

---

## 任务 5: VpTurnDetailDrawer 组件（含 info popover）+ 单测

**文件：**
- 创建: `web/components/VpTurnDetailDrawer.js`
- 创建: `web/styles/unify-detail-drawer.css`
- 测试: `test/web/vp-turn-detail-drawer.test.js`

- [ ] **步骤 1: 写失败的测试**

```javascript
// test/web/vp-turn-detail-drawer.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useChatStore } from '../../web/stores/chat.js';
import VpTurnDetailDrawer from '../../web/components/VpTurnDetailDrawer.js';

describe('VpTurnDetailDrawer', () => {
  beforeEach(() => setActivePinia(createPinia()));

  function mountWithStore({ openTarget, messages }) {
    const store = useChatStore();
    if (openTarget) store.openVpTurnDetail(openTarget);
    if (messages && store.unifyConversationId) {
      store.messagesMap[store.unifyConversationId] = messages;
    } else if (messages) {
      store.unifyConversationId = 'unify-test';
      store.messagesMap['unify-test'] = messages;
    }
    return { store, wrapper: mount(VpTurnDetailDrawer, {
      global: { mocks: { $t: (k) => k } },
    }) };
  }

  it('renders nothing when unifyOpenVpTurnDetail is null', () => {
    const { wrapper } = mountWithStore({});
    expect(wrapper.find('.vp-turn-detail-drawer').exists()).toBe(false);
  });

  it('renders drawer with header when target set', () => {
    const { wrapper } = mountWithStore({
      openTarget: { vpId: 'jobs', turnId: 't1' },
      messages: [{ type: 'assistant', content: 'hi', vpId: 'jobs', turnId: 't1', speakerVpId: 'jobs' }],
    });
    expect(wrapper.find('.vp-turn-detail-drawer').exists()).toBe(true);
    expect(wrapper.find('.drawer-header').text()).toContain('jobs');
  });

  it('close button calls closeVpTurnDetail', async () => {
    const { store, wrapper } = mountWithStore({
      openTarget: { vpId: 'jobs', turnId: 't1' },
      messages: [{ type: 'assistant', content: 'hi', vpId: 'jobs', turnId: 't1', speakerVpId: 'jobs' }],
    });
    await wrapper.find('.drawer-close').trigger('click');
    expect(store.unifyOpenVpTurnDetail).toBeNull();
  });

  it('info button toggles a popover overlay', async () => {
    const { wrapper } = mountWithStore({
      openTarget: { vpId: 'jobs', turnId: 't1' },
      messages: [{ type: 'assistant', content: 'hi', vpId: 'jobs', turnId: 't1', speakerVpId: 'jobs' }],
    });
    expect(wrapper.find('.drawer-info-popover').exists()).toBe(false);
    await wrapper.find('.drawer-info-btn').trigger('click');
    expect(wrapper.find('.drawer-info-popover').exists()).toBe(true);
    await wrapper.find('.drawer-info-btn').trigger('click');
    expect(wrapper.find('.drawer-info-popover').exists()).toBe(false);
  });

  it('switching open target without close-then-reopen still updates header', async () => {
    const { store, wrapper } = mountWithStore({
      openTarget: { vpId: 'jobs', turnId: 't1' },
      messages: [
        { type: 'assistant', content: 'a', vpId: 'jobs', turnId: 't1', speakerVpId: 'jobs' },
        { type: 'user', content: 'next' },
        { type: 'assistant', content: 'b', vpId: 'wozniak', turnId: 't2', speakerVpId: 'wozniak' },
      ],
    });
    expect(wrapper.find('.drawer-header').text()).toContain('jobs');
    store.openVpTurnDetail({ vpId: 'wozniak', turnId: 't2' });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.drawer-header').text()).toContain('wozniak');
  });
});
```

- [ ] **步骤 2: 运行测试确认失败**

运行: `npx vitest run test/web/vp-turn-detail-drawer.test.js`

预期: FAIL

- [ ] **步骤 3: 写最小实现**

创建 `web/components/VpTurnDetailDrawer.js`：

```javascript
import AssistantTurn from './AssistantTurn.js';
import VpAvatar from './VpAvatar.js';
import { useChatStore } from '../stores/chat.js';

/**
 * VpTurnDetailDrawer — right-side slide-in drawer for a single VP turn.
 *
 * Activation: store.unifyOpenVpTurnDetail = { vpId, turnId } | null.
 * Body: reuses <AssistantTurn :turn="targetTurn" /> verbatim — same
 * rendering as before the redesign, just relocated. Header has an info
 * button that toggles an in-drawer popover with persona/dream metadata
 * (no router change, no store swap).
 *
 * Reconstruction of the target turn: walks store.messages once and
 * collects all messages whose (vpId, turnId) match the descriptor, then
 * shapes them into the same `assistant-turn` object literal that
 * MessageList.turnGroups produces. We deliberately rebuild here rather
 * than reach into MessageList's computed because turnGroups is private
 * to that component; this keeps the drawer decoupled.
 */
export default {
  name: 'VpTurnDetailDrawer',
  components: { AssistantTurn, VpAvatar },
  setup() {
    const store = useChatStore();
    return { store };
  },
  data() {
    return { showInfo: false };
  },
  computed: {
    target() {
      return this.store.unifyOpenVpTurnDetail;
    },
    targetTurn() {
      const t = this.target;
      if (!t) return null;
      const msgs = (this.store.messages || []).filter(
        (m) => m.vpId === t.vpId && m.turnId === t.turnId
      );
      if (msgs.length === 0) return null;
      // Mirror turnGroups' assistant-turn shape: textContent, toolMsgs,
      // todoMsg, askMsg, imageMsgs, messages, speakerVpId, turnId.
      const turn = {
        type: 'assistant-turn',
        id: 'detail_' + t.vpId + '_' + t.turnId,
        textContent: '',
        isStreaming: false,
        todoMsg: null,
        toolMsgs: [],
        imageMsgs: [],
        askMsg: null,
        messages: msgs.slice(),
        speakerVpId: t.vpId,
        turnId: t.turnId,
        speakerTimestamp: 0,
        speakerStateCause: '',
        showSpeakerHeader: false,  // header rendered by drawer itself
        handoffHints: [],
        intent: 'feature',
        atMessageId: null,
      };
      for (const m of msgs) {
        if (m.type === 'assistant') {
          if (m.content) turn.textContent += m.content;
          if (m.isStreaming) turn.isStreaming = true;
        } else if (m.type === 'tool-use') {
          if (m.toolName === 'TodoWrite') turn.todoMsg = m;
          else if (m.toolName === 'AskUserQuestion') turn.askMsg = m;
          else turn.toolMsgs.push(m);
        } else if (m.type === 'chat-image') {
          turn.imageMsgs.push(m);
        }
      }
      return turn;
    },
  },
  watch: {
    target() {
      // Switching to a different (vpId,turnId) collapses the info popover
      // — its content depends on which VP we're showing.
      this.showInfo = false;
    },
  },
  methods: {
    onClose() { this.store.closeVpTurnDetail(); },
    toggleInfo() { this.showInfo = !this.showInfo; },
  },
  template: `
    <transition name="drawer-slide">
      <aside v-if="target" class="vp-turn-detail-drawer" role="dialog" aria-modal="false">
        <header class="drawer-header">
          <VpAvatar :vp-id="target.vpId" :size="32" />
          <span class="drawer-vp-name">{{ target.vpId }}</span>
          <span class="drawer-spacer"></span>
          <button class="drawer-info-btn" :title="$t('vp.detail.info')"
                  @click="toggleInfo" aria-label="Info">ⓘ</button>
          <button class="drawer-close" :title="$t('vp.detail.close')"
                  @click="onClose" aria-label="Close">✕</button>
        </header>

        <div v-if="showInfo" class="drawer-info-popover">
          <div class="info-row"><strong>vpId:</strong> {{ target.vpId }}</div>
          <div class="info-row"><strong>turnId:</strong> {{ target.turnId }}</div>
          <!--
            Persona / dream rendering will reuse VpDetailView's lower-half
            content blocks in a follow-up. For now we surface the routing
            descriptor so the popover is functional and testable; the
            contract — info button → in-drawer overlay, no navigation —
            is what this PR locks down.
          -->
        </div>

        <div class="drawer-body">
          <AssistantTurn v-if="targetTurn" :turn="targetTurn" />
          <div v-else class="drawer-empty">
            <!-- Either the target descriptor is stale or the messages
                 haven't streamed in yet. Empty state is intentional and
                 minimal — there's no useful action here. -->
          </div>
        </div>
      </aside>
    </transition>
  `,
};
```

- [ ] **步骤 4: 加 css 文件**

创建 `web/styles/unify-detail-drawer.css`：

```css
.vp-turn-detail-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(560px, 50vw);
  background: var(--bg-primary, #fffaf5);
  box-shadow: -4px 0 24px rgba(0,0,0,0.08);
  display: flex;
  flex-direction: column;
  z-index: 50;
}

.drawer-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
}
.drawer-vp-name {
  font-weight: 600;
  font-size: 15px;
  color: var(--text-primary, #1c1917);
}
.drawer-spacer { flex: 1; }
.drawer-info-btn,
.drawer-close {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 16px;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  color: var(--text-secondary, #44403c);
}
.drawer-info-btn:hover,
.drawer-close:hover { background: var(--card-bg-hover, #ebebea); }

.drawer-info-popover {
  position: absolute;
  top: 56px;
  right: 16px;
  min-width: 240px;
  padding: 12px 14px;
  background: var(--bg-primary, #fff);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.12);
  z-index: 1;
  font-size: 13px;
}
.drawer-info-popover .info-row { padding: 3px 0; }

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 16px 24px;
}
.drawer-empty { padding: 24px 0; color: var(--text-tertiary, #78716c); font-size: 13px; }

.drawer-slide-enter-from,
.drawer-slide-leave-to { transform: translateX(100%); }
.drawer-slide-enter-active,
.drawer-slide-leave-active { transition: transform 200ms ease; }
```

- [ ] **步骤 5: 运行测试确认通过**

运行: `npx vitest run test/web/vp-turn-detail-drawer.test.js`

预期: PASS（5 tests）。如果某个测试因为找不到 `useChatStore` 中 `unifyConversationId` 的初始值，先 grep 看 store 默认值，必要时在测试 `mountWithStore` 里手动 set。

- [ ] **步骤 6: 提交**

```bash
git add web/components/VpTurnDetailDrawer.js web/styles/unify-detail-drawer.css \
        test/web/vp-turn-detail-drawer.test.js
git commit -m "feat(unify): add VpTurnDetailDrawer with in-drawer info popover"
```

---

## 任务 6: MessageList 模板分流接线

**文件：**
- 修改: `web/components/MessageList.js`（components 加 `VpQuickCard`，模板插入 `v-else-if` 分支，setup 加 `onOpenVpTurnDetail` 方法）

- [ ] **步骤 1: 改 components 注册**

打开 `web/components/MessageList.js`，找到顶部 import 块（约 1-11 行），加：

```javascript
import VpQuickCard from './VpQuickCard.js';
```

找到 `components: { MessageItem, AssistantTurn, ... }`（约 15 行），把 `VpQuickCard` 加进去。

- [ ] **步骤 2: 改模板分流**

找到模板里的这一行（约 141 行）：

```html
<AssistantTurn v-else-if="item.type === 'assistant-turn'" :turn="item" />
```

替换成两行：

```html
<VpQuickCard
  v-else-if="item.type === 'assistant-turn' && item.intent === 'feature'"
  :turn="item"
  :preview="store.unifyQuickPreviews[item.speakerVpId + ':' + item.turnId]"
  @open-detail="onOpenVpTurnDetail"
/>
<AssistantTurn v-else-if="item.type === 'assistant-turn'" :turn="item" />
```

- [ ] **步骤 3: 加 onOpenVpTurnDetail handler**

找到 `setup()` 或 `methods:` 块（grep `onOpenVpDetail` 找现成的兄弟 handler）。在它旁边加：

```javascript
const onOpenVpTurnDetail = ({ vpId, turnId }) => {
  store.openVpTurnDetail({ vpId, turnId });
};
```

并在 setup 的 return 对象里加 `onOpenVpTurnDetail`。

- [ ] **步骤 4: 写一个 smoke 测试确认整合**

把这个测试塞到 `test/web/vp-turn-detail-drawer.test.js` 末尾或新建 `test/web/message-list-vp-card-branch.test.js`：

```javascript
// test/web/message-list-vp-card-branch.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useChatStore } from '../../web/stores/chat.js';
import MessageList from '../../web/components/MessageList.js';

describe('MessageList — VpQuickCard render branch', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('renders VpQuickCard when a turn is intent=feature', async () => {
    const store = useChatStore();
    store.unifyConversationId = 'unify-test';
    store.activeConversations = ['unify-test'];
    store.messagesMap['unify-test'] = [
      { type: 'assistant', content: 'partial...', vpId: 'jobs', turnId: 't1',
        speakerVpId: 'jobs', isStreaming: true },
    ];
    store.unifyQuickPreviews = {
      'jobs:t1': { intent: 'feature', preview: 'Refactoring auth' },
    };
    const wrapper = mount(MessageList, {
      global: { mocks: { $t: (k) => k } },
    });
    expect(wrapper.find('.vp-quick-card').exists()).toBe(true);
    expect(wrapper.find('.assistant-turn').exists()).toBe(false);
  });

  it('renders AssistantTurn (not VpQuickCard) when a turn has no Track-A preview', async () => {
    const store = useChatStore();
    store.unifyConversationId = 'unify-test';
    store.activeConversations = ['unify-test'];
    store.messagesMap['unify-test'] = [
      { type: 'assistant', content: 'hello', vpId: 'jobs', turnId: 't1', speakerVpId: 'jobs' },
    ];
    const wrapper = mount(MessageList, {
      global: { mocks: { $t: (k) => k } },
    });
    expect(wrapper.find('.vp-quick-card').exists()).toBe(false);
    expect(wrapper.find('.assistant-turn').exists()).toBe(true);
  });
});
```

- [ ] **步骤 5: 运行测试**

```bash
npx vitest run test/web/message-list-vp-card-branch.test.js
```

预期: PASS（2 tests）。如果 mount 报「找不到 sub-router」之类未提供的依赖，给 `global.stubs` 或 `global.provide` 兜底——根据失败信息逐个 stub 出（VpAvatar 等）。

- [ ] **步骤 6: 跑全量回归**

```bash
npx vitest run
```

预期：所有现有测试仍 PASS（特别是 `test/web/group-chat-tool-order.test.js`）。

- [ ] **步骤 7: 提交**

```bash
git add web/components/MessageList.js test/web/message-list-vp-card-branch.test.js
git commit -m "feat(unify): branch MessageList between VpQuickCard and AssistantTurn by intent"
```

---

## 任务 7: UnifyPage 挂载 drawer + 引入 css

**文件：**
- 修改: `web/components/UnifyPage.js`（顶层模板加 `<VpTurnDetailDrawer />`，import 组件）
- 修改: `web/index.html`（`<link>` 引入两个新 css）

- [ ] **步骤 1: 修改 UnifyPage.js**

打开 `web/components/UnifyPage.js`。找顶部 import 块加：

```javascript
import VpTurnDetailDrawer from './VpTurnDetailDrawer.js';
```

找 `components: { ... }`，把 `VpTurnDetailDrawer` 加进去。

模板里找最外层 wrapper（搜 `<div class="unify-page"` 或类似根 div），紧挨着 `</template>` 之前的位置（即根 div 的最后一个子元素）插入：

```html
<VpTurnDetailDrawer />
```

drawer 自己用 `v-if="target"` 控制显隐，所以这里无条件挂载即可。

- [ ] **步骤 2: 修改 web/index.html — 引入两个新 css**

打开 `web/index.html`，在 `<head>` 已有的 `<link rel="stylesheet" href="styles/unify.css">` 等行旁边追加：

```html
<link rel="stylesheet" href="styles/unify-vp-card.css">
<link rel="stylesheet" href="styles/unify-detail-drawer.css">
```

- [ ] **步骤 3: 跑回归**

```bash
npx vitest run
```

预期：全 PASS。

- [ ] **步骤 4: 手动冒烟（不阻塞，但记录到 task notes）**

不需要重启 server。如果本地有 dev 环境：访问 Unify 页面，发 `@SomeVP 帮我做个复杂任务`，观察主流是 VpQuickCard，点击后右侧 drawer 滑出，drawer 里能看到完整 messages + tool use；点 ⓘ 出现 popover；点 ✕ 关闭 drawer；切换另一个 VP 卡片 drawer 内容更新。

发 `@SomeVP 你好` 这种简单消息，应该走老路（AssistantTurn 完整展开）。

如果手动冒烟有问题（典型：VpQuickCard 没出现，AssistantTurn 还在显示）—— 先 console.log 看 `store.unifyQuickPreviews` 是否有 entry，再核对 `intent === 'feature'` 是否被正确派生。**不要**绕过测试直接 patch；回到任务 2 / 3 加针对性测试再修。

- [ ] **步骤 5: 提交**

```bash
git add web/components/UnifyPage.js web/index.html
git commit -m "feat(unify): mount VpTurnDetailDrawer in UnifyPage; load new CSS"
```

---

## 任务 8: 全量回归 + 推 PR

- [ ] **步骤 1: 跑全量 vitest**

```bash
npx vitest run
```

预期：1670+ 测试 PASS（依赖跑此 plan 时的实际基线，以 plan 跑前的 PR #720 落地状态为准——执行者跑前先 `npx vitest run` 拿到基线数，确保完成后总数等于 基线 + 本 plan 新增测试数 - 任何被本 plan 删除的旧测试）。

- [ ] **步骤 2: 检查未跟踪的 / 漏 commit 的文件**

```bash
git status
```

应该是 clean。

- [ ] **步骤 3: 推 worktree 分支 + 开 PR**

按项目 `CLAUDE.md` 「Worktree + PR Workflow」：

```bash
git push -u origin <worktree-branch>
gh pr create --base main --head <worktree-branch> \
  --title "feat(unify): VP quick card + right-side detail drawer" \
  --body "$(cat <<'EOF'
## Summary
- 主消息流 feature turn 改用紧凑 VpQuickCard（avatar + Track-A preview + 实时状态指示器）
- 点击 VpQuickCard → 右侧 VpTurnDetailDrawer 滑入，drawer body 复用 AssistantTurn 渲染完整 messages + tools
- Drawer header 有 info button → drawer 内 popover 显示 vpId/turnId metadata（不跳走）
- Track-A 失败/超时 → fallback to quick mode（intent 默认 'quick' → 走老 AssistantTurn）

## Out of scope (follow-up plan)
- 持久化 quick_preview / quick_intent —— Unify 当前不走 SQLite messages 表，需要先建立 jsonl 重载路径，是独立工作

## Test plan
- [ ] 新增 5 个测试文件全 PASS
- [ ] `npx vitest run` 全量绿
- [ ] 手动：Unify 群聊里 `@vp 复杂任务` 出现 VpQuickCard；点开 drawer；info popover 切换；切换 VP 卡片切换 drawer 内容
- [ ] 手动：`@vp 你好` 简单消息仍按老路渲染（AssistantTurn 完整展开）
EOF
)"
```

- [ ] **步骤 4: 等审查/合并/打 tag — 走项目 Auto Review-and-Ship 流程**

如果用户授权 auto-flow，按 `CLAUDE.md` Auto Review-and-Ship 章节执行：`yeaft-skills:review-code` 两轮 → fix Critical+Important → 跑全量 vitest → 评论 PR → `gh pr merge ... --merge --delete-branch` → 切回 main checkout 打 tag → 清理 worktree。

如果用户没授权 auto-flow，**停在 PR open 状态**等 review。
