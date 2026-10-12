# Structured responses

Native Yeaft Sessions and digital Persons can optionally use `PresentResponse` to present verified results as cards, metrics, comparison tables, bar/line charts, timelines, relationship diagrams, images, links, and maps. Simple replies stay plain text. This is not a separate model call to beautify every answer.

## Shared content, separate ownership

Both paths use one versioned content contract and one display component. Session transcript identity and Person episode storage keep their existing ownership and lifecycle. Existing plain-text messages are unchanged; no transcript migration is required.

The client controls layout and drawing. Model-generated HTML, CSS, JavaScript, and arbitrary SVG are not accepted. Charts need real data; rendering does not verify its truth. Maps without an `embed` option remain explicitly labelled **coordinate sketches**, not navigation maps, and fetch no map tiles. An optional approved third-party map loads directly in the reply; coordinates and details remain readable independently of the provider. Images are external HTTP(S) references that load automatically without a referrer, with manual retry on failure; links and images cannot contain URL credentials. The Agent and Server do not fetch those resources. Existing local artifact delivery remains separate; arbitrary local paths are not accepted by this tool.

## One tool, ten block types

A single `PresentResponse` call can combine multiple `blocks`. Separate rendering tools are not needed.

| Type | Display | Limit / boundary |
| --- | --- | --- |
| `markdown` | Headings, prose, lists, code and links | No executable HTML or inline image loading |
| `cards` | Grouped options or items, optional supplied image/source | 8 cards |
| `metrics` | Key values and details | 8 metrics |
| `table` | Comparisons and data | 8 columns, 50 rows |
| `chart` | Bar / line chart with accessible data table | 4 series, 40 labels |
| `timeline` | Ordered events or steps | 16 items |
| `diagram` | Nodes and relationships | 12 nodes, 24 edges |
| `image` | Automatic image preview, retry and expansion | Existing images, not image generation |
| `link` | Sources, reports and artifact references | Owning in-app browser by default |
| `map` | Coordinate sketch or approved provider embed, with place list | 20 points; optional OpenStreetMap / Google share embed |

Ordinary clicks open the owning Workbench browser in Sessions and Work Center. Persons reuse the same browser component in their own output sidebar, never a different Session route. Choose the adjacent `↗`, the browser's **Open in new tab** action, or a native modifier/middle click to open externally. An unavailable in-app browser shows a notice rather than silently opening a tab. Sites may refuse embedding; this does not weaken iframe isolation or introduce a remote proxy.

In the compact Person reader, Tab / Shift+Tab can enter and leave embedded page controls. Escape inside a cross-origin page cannot reach the reader; use **Return to reader controls** or **Close reader** instead.

## Optional card images and map embeds

These are additive **v1 options**, not new tools or block types; there are still one tool and ten block types.

A card may include `image: { "url": "https://…", "alt": "…", "fit": "contain" }` and a source/action `url`. URLs must be credential-free HTTP(S). Use `fit: "contain"` for supplied logos or icons; `"cover"` (the default) for photography. Images autoload without a referrer, reserve their display slot, retain accessible descriptions and offer retry on failure. Weather, NBA and other reports show imagery only when a valid reference is supplied; the renderer invents neither data nor icons.

A map may include `embed: { "provider": "openstreetmap" }`. The client generates an official `https://www.openstreetmap.org/export/embed.html` URL with a bounded `bbox`, `layer=mapnik`, and `marker=latitude,longitude`. For several points, **Map location** chooses one embedded pin at a time; the full numbered coordinates/details list is always present. Do not provide an arbitrary OSM embed URL.

Alternatively, use `embed: { "provider": "google", "url": "https://www.google.com/maps/embed?pb=…" }` only with a verified official **share embed URL**. Copy the iframe's URL from Google Maps' share/embed feature, not its HTML. Generic homepages, unknown domains, arbitrary HTML, URL credentials, API keys and the `/maps/embed/v1/…` Maps Embed API are not supported. **Google's Maps Embed API requires separately authorized API-key configuration and is not supported here.** A supplied share view can differ from listed coordinates; all point details remain visible, rather than claiming that the share view can select arbitrary pins.

Provider frames use exactly `sandbox="allow-scripts allow-same-origin"`, `referrerpolicy="no-referrer"`, an accessible title and keyboard focus. They grant no geolocation, popups or top navigation. Loading contacts the external provider. A cross-origin `load` event **cannot verify content**; network restrictions, CSP or provider policies can still leave a frame blank. Loading times out after 12 seconds when no event arrives; retry, **Show coordinates only**, provider/source links and explicit `↗` actions remain available. No failure automatically opens a tab. Without `embed`, the previous sketch UI is unchanged.

**Directions in Google Maps** links use `https://www.google.com/maps/dir/?api=1&destination=latitude,longitude`. Google may ask for a starting location there; this does **not** grant geolocation access to Yeaft. Normal source/provider/directions clicks use the owning in-app browser; `↗` is an explicit native new-tab action.

```json
{
  "type": "cards",
  "items": [{
    "title": "Verified place",
    "text": "Details from the supplied source.",
    "image": { "url": "https://example.org/place.jpg", "alt": "Supplied place photograph", "fit": "cover" },
    "url": "https://example.org/place"
  }]
}
```

```json
{
  "type": "map",
  "embed": { "provider": "openstreetmap" },
  "points": [{ "label": "Civic Center", "latitude": 37.7793, "longitude": -122.4193, "detail": "Verified coordinates; not an entrance." }]
}
```

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
