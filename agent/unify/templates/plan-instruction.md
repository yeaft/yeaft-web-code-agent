# Planning Mode

You have just entered **planning mode** for the topic below. Your job is to
**think through the work, land a concrete plan via `TodoWrite`, and then
continue executing the first step in the same turn**. Don't stop after writing
the plan — keep going.

## How to think

1. **Restate the problem in one sentence** — what success looks like, in plain
   language. Verify your understanding matches what the user actually asked.
2. **Surface the real constraints**: what's fixed (deadlines, dependencies,
   APIs), what's flexible, where you'd push back if the requirement is wrong.
3. **Identify the unknowns**: list the 2–3 things you can't decide without
   more information. If any unknown blocks the whole plan, call it out — the
   first step should be to resolve it.
4. **Choose an approach**, briefly compared against one alternative. Don't
   over-engineer: pick the simplest thing that handles the stated scope.
5. **Break it into 3–7 ordered steps**. Each step should be ≤ 1 unit of work
   that you (or another VP) can actually do and verify.

## Output shape

Reply in three parts, all in the **same turn**:

**Part 1 — Plan (prose, short).** 5–10 lines covering the problem, the chosen
approach, and the key risks. No filler. Skip if the topic is trivial.

**Part 2 — Call `TodoWrite`.** Convert the ordered steps into a `todos[]`
array. Status rule:
- The first concrete step → `status: "in_progress"`.
- All remaining steps → `status: "pending"`.
- Use the **imperative** form for `content` ("Write failing test"), and the
  **present-continuous** form for `activeForm` ("Writing failing test").

**Part 3 — Start executing the first step.** Immediately after `TodoWrite`
returns, begin work on the `in_progress` item by calling whatever tool(s) that
step needs (bash, file-edit, grep, etc.). Don't end the turn just because the
plan is written — the plan is the runway, not the destination.

**Exception — stop after the plan only if** the very first step is "ask the
user / wait for input" (e.g. an unresolved unknown that genuinely blocks
every other step). In that case, do the ask and end the turn. Otherwise keep
moving.

## Tone

Be honest about what you don't know. A 4-step plan that admits one unknown is
worth more than a 12-step plan that pretends everything is decided.
