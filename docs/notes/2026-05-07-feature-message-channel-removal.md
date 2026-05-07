# Design: Remove `unify_feature_message` channel + dead sidebar task list

> **Status**: Approved (2026-05-07) — ready for plan
> **Scope**: Pure cleanup PR. Removes (1) the `unify_feature_message` send/echo channel, (2) the dead `unifyActiveFeatureDetailId` state, (3) the dead `unifyActiveFeatureId` state + sidebar task list rendering — including the `task_list_updated` web inbound case which no agent code has ever emitted. Display-side feature panel + POST-turn attribution are explicitly **out of scope** (TODO).
>
> **Out of scope (do not touch)**: agent-side Feature infrastructure — `agent/unify/features/store.js`, the 9 Feature tools, `feature-arc.js`, `engine.js#currentFeatureIdAccessor`, AMS feature-scope keys, sub-agent featureId inheritance, `~/.yeaft/features/` filesystem state. These are core to group-chat operation and unrelated to the dead UI surface being removed.

---

## Why

`unify_feature_message` was introduced as a stop-gap (R6 §Δ31.6) for "user posts a message scoped to a feature." Its agent-side handler was deliberately a wire-echo only — `agent/unify/feature-message.js` validates the text and broadcasts a `feature_message` event back, with no `coord.ingest`, no `runVpTurn`, no LLM. The header comment marks persistence + ACL as deferred to a `task-334l` follow-up that never landed.

The current state is broken in a way users cannot work around:
- `unifyActiveFeatureDetailId` mode hides the paperclip (`ChatInput.js:163-168`), so attachments are unreachable.
- Even if we forced attachments through, the LLM never sees the message, because feature_message is echo-only.
- The display surface (`UnifyFeatureDetailView`) was deleted in H2.f.6 — there's no panel that renders feature-scoped history. The whole channel is invisible to the user except as "input box randomly behaves differently when I clicked a sidebar task."

Beyond the broken channel, the audit also turned up two layers of dead state:

- **`unifyActiveFeatureId`** (note: WITHOUT "Detail") — the only output is a `selected` CSS class on the sidebar task row. The clicked row gets a darker background. Nothing else. No detail panel, no filtering, no jump, no edit.
- **The sidebar task list itself** is populated from a `task_list_updated` web inbound event that **no agent code has ever emitted** (grep confirms: only the consumer exists, no producer). `unifyFeatures` is permanently the empty array; the rendered list is permanently empty. The sidebar has been displaying nothing for an unknown amount of time.

The right semantic — *"feature is a filter view over the group's loop, post-classified per turn"* — needs design work we are not ready to commit to. Pulling out the broken stop-gap and the dead UI scaffolding unblocks that future work and removes ~700 lines of plumbing that today serves nothing.

---

## What we delete

### Frontend (`web/`)

| File | What goes |
|---|---|
| `web/components/ChatInput.js` | `attachmentsAllowed` feature-mode short-circuit (L163-168); placeholder/disabled feature branches (L235); `taskReplyKey` reply-to scoping (L293); the entire `if (store.unifyActiveFeatureDetailId && trimmed)` send branch (L613-644). Result: ChatInput is single-branch (group). |
| `web/stores/chat.js` | State `featureMessagesMap` (L384), `featureMessageRejects`, `unifyFeatures`, `unifyActiveFeatureDetailId` (L354), `unifyActiveFeatureId`; getters `unifyFeatureDetailMessages` (L553, returns EMPTY_ARRAY today), `unifyActiveFeatureMeta` (L558, no consumer); actions `sendUnifyFeatureMessage`, `enterTaskDetailView`, `leaveTaskDetailView`, `setActiveTaskUi` (L1738, zero callers), `dismissFeatureMessageReject`; inbound case handlers `'feature_message'` (L1432-1468), `'feature_message_rejected'` (L1474), and the never-emitted `'task_list_updated'` (L1394-1396); all clear-sites for the deleted state (L736, 1719, 1761, 1920, 1927, 1929-1930). |
| `web/components/MessageList.js` | `<FeatureMessageItem>` render branch (L125-130); `onFeatureMessageReply` handler (L1297-1308). |
| `web/components/FeaturePill.js` | `FeatureMessageItem` render branch (L108-111) — folded-pill body case for `'feature-message'` row type. |
| `web/components/FeatureMessageItem.js` | Whole file. |
| `web/components/FeatureMessageRejectToast.js` | Whole file. |
| `web/components/UnifySidebar.js` | Sidebar task list section (L243-273) — task rows + child rows + status colors; `activeTaskId` computed (L432-435); `onSelectTask` emit (L630). The status-color classes `us-task-status-*` and the `selected` class binding go with it. |
| `web/components/UnifyPage.js` | `<FeatureMessageRejectToast />` mount (L240); `onSelectTaskV2` handler (L292-298) — entire function, since the only event source (sidebar `select-task`) is also being removed. |
| `web/utils/featureMessageRejectCodes.js` | Whole file. |

### Server (`server/`)

| File | What goes |
|---|---|
| `server/handlers/client-conversation.js` | `if (rest.type === 'unify_feature_message')` STOP-GAP short-circuit + comment block (L729-755). Falls back to the standard else-arm — but with no agent-side router case (see below) the relay never fires regardless. |

### Agent (`agent/`)

| File | What goes |
|---|---|
| `agent/connection/message-router.js` | `case 'unify_feature_message'` (L459-464). |
| `agent/unify/web-bridge.js` | `export function handleUnifyFeatureMessage` wrapper (L616-618). |
| `agent/unify/feature-message.js` | Whole file. |

### Tests (`test/`)

| File | What goes |
|---|---|
| `test/web/stores/chat-input-dispatch.test.js` | `unify_feature_message` dispatch cases (L129-147 area). Group_chat cases stay. |
| `test/web/vp-turn-detail-store.test.js` | `unifyActiveFeatureDetailId` fixture field (L100) — just stop seeding it. Assertions don't depend on it. |

Full-text search for `feature_message`, `unify_feature_message`, `featureMessagesMap`, `unifyActiveFeatureDetailId` will catch any straggler we missed.

---

## What we keep

| Layer | Why |
|---|---|
| Agent-side Feature infrastructure | `FeatureStore` (`agent/unify/features/store.js`), the 9 Feature tools (`agent/unify/tools/feature-tools.js`), `feature-arc.js` auto-attribution, `engine.js#currentFeatureIdAccessor`, AMS feature-scope keys, sub-agent featureId inheritance, `~/.yeaft/features/` filesystem state. **These are core to group-chat operation.** Removing them rips the floor out from feature-arc, AMS scoping, and cross-feature recall. The `task_list_updated` event being unemitted is irrelevant — the agent's feature system runs without telling the web UI about it, and that's the correct end state. |
| `replyToMap` infrastructure | The map itself stays (group reply-to still uses it). Only the `'task:'+featureId` keying goes. |
| Sidebar group/VP rendering | The sidebar's group list, VP list, member management — all unaffected. Only the dead "tasks" section comes out. |

---

## Risks / edges

1. **Stale clients**: a client running an older bundle could still emit `unify_feature_message`. After the agent-side router case is removed, the message lands in the router default — it will be logged and ignored. No crash, no leak (the server's stop-gap that strips `attachments` is also removed, so `pendingFiles` for that frame leaks until the 10-min TTL reaps it — acceptable for an old-client edge case during deploy rollout).
2. **No persistence to migrate**: confirmed via grep that no DB column / serialization stores `feature_message` records. No migration needed.
3. **`onSelectTaskV2` becomes nearly trivial**: just `unifyActiveFeatureId = featureId` + mobile-sidebar close. We keep the function — it's still the click handler — but its body shrinks.

---

## TODO marker (where the future work picks up)

No state survives in `chat.js` to hang a TODO comment on — both `unifyActiveFeatureId` and `unifyActiveFeatureDetailId` are gone, along with the sidebar UI that read them. The TODO lives in this design document instead:

> **Future work — POST-turn feature attribution + read-only feature panel**
>
> The eventual model: every (user-input + AI-response) turn is post-classified into a featureId (or unattached) by either rules or an LLM classifier. Selecting a task opens a right-side panel that filters the group log to turns belonging to that feature. The panel is read-only — feature-scoped sending stays gone.
>
> Open design questions: rule-based vs LLM classifier; latency budget; reclassification when a turn is later re-attributed; how to surface the "select a feature to filter" UX once the sidebar list re-emerges (driven by agent-side `FeatureStore` state, which is still alive).
>
> Implementation hint: the agent already has everything needed (FeatureStore, featureId on engine events, feature-arc auto-attribution). The web side needs (a) an inbound event/poll for "list of features" since `task_list_updated` was never emitted, (b) the panel component, (c) the filter logic in MessageList, (d) re-introduction of a single sidebar-selection state.

---

## Followup naming cleanup (NOT this PR)

After this PR lands, the naming footgun (`unifyActiveFeatureId` vs `unifyActiveFeatureDetailId`) is gone — both are deleted. No naming work remains. (Original concern about renaming the survivor is moot.)

---

## Tests

| Test file | Assertion |
|---|---|
| Existing `test/web/stores/chat-input-dispatch.test.js` | Group-chat dispatch cases stay green. `unify_feature_message` cases removed. |
| Existing `test/web/vp-turn-detail-store.test.js` | Field fixture cleanup. Existing assertions unchanged. |
| Full vitest suite | Must remain green. Suite shrinks (deleted tests are not replaced). |
| Manual smoke | (1) Open Unify, sidebar shows groups + VPs, no "tasks" section. (2) Type in ChatInput — sends to group. (3) Attach an image — paperclip is reachable in all contexts. (4) Re-load conversation — no warnings/errors about missing `featureMessagesMap` / `unifyFeatures` / `unifyActiveFeatureId`. |

No new test files. Pure deletion validates by absence — the suite shrinks by the number of unify_feature_message + sidebar-task tests, doesn't grow.

---

## Build order

1. Backend cuts (no UI dependency): agent router + web-bridge wrapper + feature-message.js + server stop-gap. Single commit.
2. Frontend store cuts: state (`featureMessagesMap`, `featureMessageRejects`, `unifyActiveFeatureDetailId`, `unifyActiveFeatureId`, `unifyFeatures`), getters, actions, inbound handlers (`feature_message`, `feature_message_rejected`, `task_list_updated`). Single commit.
3. Frontend component cuts: ChatInput branches, MessageList row + handler, FeaturePill row, UnifySidebar tasks section, UnifyPage mounts + handlers. Single commit.
4. File deletions: `FeatureMessageItem.js`, `FeatureMessageRejectToast.js`, `featureMessageRejectCodes.js`. Single commit.
5. Test cleanup. Single commit.
6. Full vitest run + manual smoke + PR.
