# Split Screen

Yeaft supports opening **multiple conversation panels** side by side (up to 3). Great for: talking to two project Claudes simultaneously, A/B-comparing two Copilot outputs, monitoring a long task while chatting with another VP.

## Trigger split

Hover any session in the sidebar — a **split icon** (▥) appears:

- Click it → open this session in a **new panel** (instead of replacing the current one)
- First click enters split mode (1 panel → 2 panels)
- Up to 3 panels side by side

## Panel layout

| Panels | Layout |
| --- | --- |
| 1 | Full width (default) |
| 2 | 50/50 split |
| 3 | Three equal columns |

Each panel is **fully independent**: own scroll, own input, own tool-call rendering.

## Active panel

Only one panel is the **active panel** (highlighted border):

- Click anywhere in a panel → make it active
- Clicking a session in the sidebar opens it **in the active panel** (not a new one)
- To open in a new panel, use the split icon

## Close panels

Each panel header has a **×** close button:

- Closing redistributes width evenly across remaining panels
- Closing the last secondary panel returns you to single-panel mode

## Cross-backend split

Different backends can be mixed across panels:

- Panel A: Claude Code Chat (project A)
- Panel B: Copilot session (project B)
- Panel C: Yeaft Sessions (a discussion group)

State per panel is persisted independently and the **split layout survives page refresh**.

## Relationship to Workbench

- Workbench (terminal / files / Git) is an **independent right-side tool panel**, not a chat panel slot
- You can have 3 chat panels + Workbench open simultaneously
- Workbench content tracks the **active panel's Agent** (switching active panel switches Workbench content)

## Mobile

Mobile doesn't support split — screens are too narrow, single-panel forced. Split layout is preserved but only the active panel renders.

## Common patterns

- **Comparative review** — two Copilot sessions running different models on the same task, compare outputs
- **Long-task monitoring** — one panel runs a long task (refactor), another panel keeps discussing
- **Multi-project parallel** — Project A's Crew + Project B's Yeaft Sessions + Project C's Claude Chat
- **Cross-Agent** — one panel connected to Agent X, another to Agent Y

## Performance notes

Three panels each running a long task taxes browser CPU/memory noticeably. If your machine feels slow:
- Close unused panels
- Close Workbench (especially Files editor with a large file open)
- Close other browser tabs
