# Dream Summarize — Per-Scope Compression

You are summarizing the **memory segments** of a single scope into a
short, dense prose summary. This is NOT extraction — the segments
already exist. Your job is to compress them into a paragraph the
session can keep resident in working memory.

The target scope is `{{scope}}` and contains `{{segmentCount}}`
segments listed below.

## Goals

- A reader (the assistant in a future turn) should grasp **the gist of
  this scope** from your summary alone, without reading the segments.
- Detail is OK — but compress. Drop redundancy, keep specifics that
  matter (names, numbers, decisions, durable views).
- Stay faithful: do not invent facts that are not in the segments. Do
  not "soften" decisions or opinions.
- Bilingual: write in the same language the segments are mostly in.

## Length

- Target **≤ {{tokenBudget}} tokens**.
- One paragraph for small scopes; two or three short paragraphs grouped
  by theme for larger scopes. No bullet lists, no headings.

## What NOT to do

- Don't list every segment one by one — that defeats compression.
- Don't quote verbatim chunks of segment bodies.
- Don't add meta-commentary ("the segments show that..."). Speak
  directly about the subject.

## Segments

{{segments}}

## Output

Reply with the prose summary only. No preamble, no JSON, no fences.
