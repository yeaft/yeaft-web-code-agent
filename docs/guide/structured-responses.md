# Structured responses

Native Yeaft Sessions and digital Persons can optionally use `PresentResponse` to present verified results as cards, metrics, comparison tables, bar/line charts, timelines, relationship diagrams, images, links, and coordinate sketches. Simple replies stay plain text. This is not a separate model call to beautify every answer.

## Shared content, separate ownership

Both paths use one versioned content contract and one display component. Session transcript identity and Person episode storage keep their existing ownership and lifecycle. Existing plain-text messages are unchanged; no transcript migration is required.

The client controls layout and drawing. Model-generated HTML, CSS, JavaScript, and arbitrary SVG are not accepted. Charts need real data; rendering does not verify its truth. Maps are explicitly labelled **coordinate sketches**, not navigation maps, and fetch no map tiles. Images are external HTTP(S) references that load automatically without a referrer, with manual retry on failure; links and images cannot contain URL credentials. The Agent and Server do not fetch those resources. Existing local artifact delivery remains separate; arbitrary local paths are not accepted by this tool.

## One tool, ten block types

A single `PresentResponse` call can combine multiple `blocks`. Separate rendering tools are not needed.

| Type | Display | Limit / boundary |
| --- | --- | --- |
| `markdown` | Headings, prose, lists, code and links | No executable HTML or inline image loading |
| `cards` | Grouped options or items | 8 cards |
| `metrics` | Key values and details | 8 metrics |
| `table` | Comparisons and data | 8 columns, 50 rows |
| `chart` | Bar / line chart with accessible data table | 4 series, 40 labels |
| `timeline` | Ordered events or steps | 16 items |
| `diagram` | Nodes and relationships | 12 nodes, 24 edges |
| `image` | Automatic image preview, retry and expansion | Existing images, not image generation |
| `link` | Sources, reports and artifact references | Owning in-app browser by default |
| `map` | Coordinate sketch and place list | 20 points; no navigation or tiles |

Ordinary clicks open the owning Workbench browser in Sessions and Work Center. Persons reuse the same browser component in their own output sidebar, never a different Session route. Choose the adjacent `↗`, the browser's **Open in new tab** action, or a native modifier/middle click to open externally. An unavailable in-app browser shows a notice rather than silently opening a tab. Sites may refuse embedding; this does not weaken iframe isolation or introduce a remote proxy.

In the compact Person reader, Tab / Shift+Tab can enter and leave embedded page controls. Escape inside a cross-origin page cannot reach the reader; use **Return to reader controls** or **Close reader** instead.

## In the loop

The tool validates the whole response before publishing. Invalid types, excessive size, inconsistent tables/charts, missing relationship endpoints, and unsafe URLs publish nothing. The model can correct the payload or answer in text.

`phase: "progress"` communicates partial results. `phase: "final"` expresses delivery intent, **not task success or automatic turn termination**. Native Sessions retain their engine terminal boundary; Persons still commit through the cognitive proposal with `next:null`. Cancellation or failure preserves already-delivered content without treating the run as successful. After publishing a complete response, the model does not need to repeat the same answer in prose.

## Example

Native tool arguments and Person capability `args` use the same structure:

```json
{
  "title": "Compare two options",
  "summary": "Start with option A because validation costs less. Costs are estimates and exclude external services.",
  "phase": "final",
  "blocks": [
    {
      "type": "cards",
      "items": [
        { "title": "Option A", "label": "Recommended", "text": "Reuse existing behavior and validate the complete path." },
        { "title": "Option B", "text": "Build separately, with higher maintenance costs." }
      ]
    },
    {
      "type": "table",
      "columns": ["Option", "Scope", "Validation"],
      "rows": [["A", "Local", "Focused tests and browser"], ["B", "Cross-module", "End-to-end and recovery"]]
    }
  ]
}
```

`summary` must be independently understandable for copying, search, model history, and older clients. Each response is limited to 48 KiB and 12 blocks, with additional per-block item and dimension limits. The native tool schema and the full Person capability contract describe supported fields.

## Compatibility

- Native Sessions: optional built-in tool, live display, and persisted history replay.
- Persons: capability discovery/preparation/call, with existing same-episode reply grouping.
- Claude Code/Copilot CLI Chat: the display component is reusable, but registering a native tool does not add it to those CLI protocols.
- Unknown versions fall back to a readable summary. Existing messages retain their normal rendering.

[中文说明](/zh-CN/guide/structured-responses)
