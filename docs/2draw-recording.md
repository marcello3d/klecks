# Recording the drawing process in Klecks (2draw fork)

Design doc, 2026-11-13. Nothing here is implemented. Code references are to the `2draw` branch at
fc40750 (`src/app/script/...`, written below without that prefix) and to 2draw.net's `origin/beta`.

## Summary

- **Record at two levels.** Brush strokes are recorded as input: the brush's full settings plus the
  samples that reach the brush (after Klecks's own smoothing). Everything else is recorded from the
  history entry Klecks already builds for undo: layer and selection changes exactly and for free,
  pixel changes either as a named operation the player re-runs, or, when nothing can regenerate
  them, as PNG rectangles.
- **Unknown changes are safe by default.** A history entry that no recorded operation explains is
  written as its own diff. A tool somebody adds in 2030 without thinking about recording still
  replays exactly; it only costs bytes until it gets a named operation.
- **The player replays each session with the engine that recorded it.** Every engine revision is
  built once into a frozen, self-contained bundle that is never edited or deleted. Changing a brush
  means a new revision; old recordings keep loading the old bundle.
- **Hashes are strict only where pixels can match.** Canvas 2D output differs between browser
  families and between GPU and software canvases (measured, section 1.4). Each session records a
  raster fingerprint. A player with the same engine and fingerprint treats a hash mismatch as a
  bug and reports it; any other player treats hashes as advisory. Every player ends on the
  entry's own PNG.
- The container, primitives and draft handling follow `.lsa` and `.chiani`. File extension `.klr`.

## 1. How Klecks works, where it matters

### 1.1 History is state, not actions

`klecks/history/kl-history.ts` holds a list of `THistoryEntry` (`history.types.ts`). An entry is a
**diff of the document state**, not a description of what the artist did:

- `size`, `selection` (a `MultiPolygon`), `activeLayerId`, `projectId`;
- `layerMap`: per layer id, any of `name`, `opacity`, `isVisible`, `mixModeStr`, `hasClipping`,
  `index`, and `tiles`: one slot per 256 px tile (`HISTORY_TILE_SIZE`), `undefined` if unchanged,
  else an `ImageData` tile with a uuid (`image-data-tile.ts`) or a fill colour.

`KlHistory.push(entryData, replaceTop?)` appends, `composeHistoryStateData` folds the entries up to
the current index into `composed` (the whole document as tiles), and undo/redo only move the index
(`decreaseIndex` / `increaseIndex`). `KlApp` then calls `klCanvas.updateViaComposed(before, after)`
(`app/kl-app.ts:487-538`, `canvas/update-layers-via-composed.ts`), which puts the changed tiles back
with `putImageData`. Nothing is re-executed. Old entries are trimmed by memory
(`trim-oldest-entries.ts`: 200 MB always kept, 1 GB total). `pause()` suppresses pushes inside
compound operations. Listeners fire in a `setTimeout` and get no entry.

`KlTempHistory` (`kl-temp-history.ts`) holds uncommitted steps of a selection transform; they reach
`KlHistory` only on commit (`app/kl-app-select.ts`).

Consequences:

- "Record Klecks's history layer" literally means recording pixel tiles for every step. That is the
  per-op diff the format rules forbid, and it would be tens to hundreds of MB per drawing.
- But the entry is a **complete, generic description of any change**, produced by Klecks itself for
  every tool, including ones that don't exist yet. That makes it the right safety net (section 2.3).
- Tiles are immutable and `composed` is replaced, not mutated, on every change. A reference to
  `klHistory.getComposed()` is a free snapshot that can be hashed or encoded later.
- The autosave already rides on this: `embed/embed-draft.ts` saves new tiles when the pen rests.

### 1.2 Where changes come from

There is no single action dispatcher. Mutations are spread over the UI:

| Change | Call site | Reaches |
|---|---|---|
| Brush stroke | `kl-app.ts:433-457`, the `drawEventChain` out handler | `currentBrushUi.startLine / goLine / endLine`, `getBrush().drawLineSegment` (shift-lines) |
| Fill, erase, flood fill | `kl-app.ts:364, 554, 567, 681, 968` | `KlCanvas.layerFill / eraseLayer / floodFill` |
| Shape, gradient, text | `kl-app.ts:1567, 1616, 757` | `KlCanvas.drawShape / drawGradient / text` |
| Layers | `ui/tool-tabs/layers-ui/layers-ui.ts` (add, duplicate, remove, merge, move, rename, opacity, visibility, clipping, blend mode) | `KlCanvas.*`, and `kl-app.ts:1643` pushes `activeLayerId` directly |
| Filters | `ui/tool-tabs/edit-ui.ts:183`, `kl-app.ts:1766` | `FILTER_LIB[key].apply({layer, klCanvas, input, klHistory})`; `input` is a plain object |
| Selection, transform | `app/kl-app-select.ts`, `canvas/kl-canvas-transform.ts`, `kl-canvas-ffd.ts` | `KlCanvas.setSelection`, `klCanvasTransform` |
| Import, paste, new image | `app/kl-app-import-handler.ts`, `kl-app.ts:1717, 1855` | `KlCanvas.reset / addLayer / drawOperation` (an opaque closure) |

Hooking every site with a hand-written opcode is a lot of surface, and the next tool added upstream
or by us would silently be missed. The design does not depend on doing that.

### 1.3 The brush pipeline

Pointer events go `EaselBrush` → `drawEventChain` (`LineSanitizer`, then `LineSmoothing`) → the out
handler → the brush UI wrapper → the brush class (`klecks/brushes/*.ts`).

- **`LineSmoothing` (`events/line-smoothing.ts`) is timer-driven.** After a move it starts a
  `setTimeout(80)` and then a `setInterval(35)` that keep emitting catch-up moves while the pen is
  held still. The number of moves a brush sees depends on wall-clock timing. Raw pointer input
  therefore can't be replayed deterministically; what comes **out** of the chain can.
- Coordinates reaching the brush are fractional canvas pixels (the viewport transform is already
  applied). Pressure is a float 0..1.
- Brushes are stateful objects with ad-hoc setters (`setSize`, `setScatter`, `setAlpha`,
  `setPattern`, …) called by their UI (`klecks/brushes-ui/*`). There is no uniform "get all
  settings". The UI wrappers also adapt arguments: `blend-brush-ui.ts:164` always passes
  `isCoalesced=false`, `sketchy-brush-ui.ts:140` passes no premixed colour.
- A brush pushes one history entry at `endLine` (or per `drawLineSegment`), only if tiles changed
  (`pen-brush.ts:334-378`).

### 1.4 Determinism risks

**Randomness.** `Math.random()` in `pen-brush.ts:167-168` (scatter), `chemy-brush.ts:309-310`
(distort), and the `randArr` dither tables built at load in `smudge-brush.ts:160` and
`blend-brush.ts:292`. `filter-noise.ts:262` picks a seed in the dialog, but passes it on in the
filter input, so it is recordable as is. `brushes/alphas/brush-alphas.ts` uses Perlin noise with a
fixed seed (`bb/math/perlin.ts:95`); that is already deterministic.

**Rasterization.** The brushes draw through Canvas 2D: `arc()` + `fill()` with `globalAlpha`
(pen), `stroke()` (sketchy), scaled and rotated `drawImage` (pen alphas, pixel brush),
`createPattern`. Blend and smudge mix in `ImageData` but read what Canvas 2D drew. Canvas 2D output
is implementation-defined. Measured with a throwaway probe (system Chrome and Playwright WebKit on
this Mac, FNV-1a of `getImageData`; Firefox wasn't installed):

| Scene | Chrome, default canvas | Chrome, `willReadFrequently` or GPU off | WebKit, default | WebKit, `willReadFrequently` |
|---|---|---|---|---|
| antialiased arcs with alpha | 31997c08 | f6eab7bf | 1854ce63 | cb3a04b1 |
| integer-aligned rects with alpha | 789c9aa3 | ca6cd0e8 | bdab68bd | 3b421f5b |
| strokes | 9bb4484e | 454b9b46 | 5b4f0d42 | ad4e0832 |
| `multiply` rect fills | ed213e0b | a0f89ae5 | 36c9afd2 | a0f89ae5 |

- Every configuration is repeatable against itself, on the main thread and on an `OffscreenCanvas`.
- No two configurations agree, not even on axis-aligned rectangles (alpha rounding differs).
- **Chrome changes configuration mid-session.** Redrawing the same scene on one canvas with a
  `getImageData` after each pass gave 31997c08, 26bfdf47, then f6eab7bf from the third pass on:
  Chrome moves a canvas from GPU to software after a couple of readbacks. Klecks reads a layer back
  at the end of every stroke (history tiles) and never sets `willReadFrequently` (no occurrence in
  the source). So today the first strokes on a Chrome layer rasterize differently from the rest.
- `putImageData` then `getImageData` returned the same bytes in every configuration.

So pixel-exact replay is possible **within a raster class** (same browser family and canvas
backend) once the backend is pinned, and not across classes without rewriting the brushes as
software rasterizers. Differences across classes are mostly edge antialiasing and low-alpha
rounding. They matter where pixels are read back and thresholded: `floodFill`
(`kl-canvas.ts:881`, tolerance compare in `image-operations/flood-fill.ts`) can leak or not leak.

**WebGL filters.** Eleven filters run in `fx-canvas` shaders (`webGL: true` in
`filters/filters.ts`). Output varies by GPU and driver.

**Text.** `image-operations/render-text.ts` uses the browser's fonts and shaping. Not reproducible.

**Imported and pasted images.** External pixels.

**PSD round trip.** "Draw more" opens the previous version's PSD (`psdUrl`), not the last session's
in-memory state.

## 2. Recording level and format

### 2.1 Options weighed

| Option | Verdict |
|---|---|
| Raw pointer events | No. Depends on viewport, UI layout and `LineSmoothing`'s timers. |
| History entries as pixels for every step | No. Exact forever and engine-free, but it is per-op diffs: against the rules and far too big. Kept as the fallback for what can't be regenerated. |
| Brush input after the event chain, plus full brush settings | **Yes, for strokes.** Smallest, animates stroke by stroke, matches the other tools. Needs the engine at playback. |
| Named operations with parameters (fill, shape, filter…) | **Yes, where regenerable**, added one at a time. Never required for correctness. |
| Version-gated code paths in one player (`if (rev >= 4)`, as `.p95` does) | No. Klecks takes upstream merges and whole-brush rewrites; gating every change is expensive and easy to get wrong. |
| Frozen player build per engine revision | **Yes.** The build script exists; a frozen bundle costs about 1 MB of static files and no maintenance. |
| Record-time verification with pixel patches on disagreement | **No, as the robustness mechanism.** See 2.8. Used as a test-time tool. |
| Software reimplementation of the brushes for cross-browser exactness | Out of scope. It would change how Klecks draws. |

### 2.2 What is written for each kind of change

1. **Stroke.** Before the first sample: the brush id and its settings (only the keys that changed
   since the last stroke), and the target layer. Then `DOWN`, `MOVE`…, `UP`, or `LINE` for
   shift-lines, exactly as the out handler of `drawEventChain` delivers them. The history entry the
   brush pushes is *explained* by the stroke and not written.
2. **Metadata change** (layer added, removed, moved, renamed, opacity, visibility, blend mode,
   clipping, active layer, selection polygon, canvas size without pixels): written from the history
   entry as a `DIFF`. A few bytes, exact, needs no engine code per operation.
3. **Pixel change by a named operation**: `OP name args`. The player calls the same function from
   the engine's operation registry. Its history entry is explained by the op.
4. **Pixel change nothing explains**, or one flagged non-regenerable (text, import, paste): a
   `DIFF` whose changed tiles are stored as PNG rectangles. These are "the pixels that can't be
   regenerated". Tiles that already exist elsewhere in the document (duplicate layer) are written
   as references, not pixels.
5. **Undo / redo**: `UNDO` / `REDO`. The player runs the real `KlHistory`, so they are index moves
   plus `updateViaComposed`, as in the editor.

Rule 4 is the answer to "what about tools added later": the recorder observes every
`KlHistory.push`. A push outside a stroke and outside a named op is, by definition, unexplained and
gets a `DIFF`. Nobody has to remember to add a hook. A `NOTE` with the call site's name (when the
site gives one) lets us count which operations fall back most and deserve a named op.

Named ops start empty. Phase 2 ships with strokes plus `DIFF` for everything else, which is correct
and complete. Phase 3 adds named ops in order of bytes saved (4.3). An op that adds layers stays a
`DIFF` (a new empty layer is a fill colour), so layer ids never have to be predicted.

### 2.3 Container

Same framing as `.lsa` and `.chiani`, big-endian, built on a copy of Lascaux's
`web/src/anim/bytes.ts` (`ByteWriter` / `ByteReader`: `u8`, `u32`, `varint` LEB128, `svarint`
zigzag, `f64`, `blob`, `string`).

```
magic  89 4B 4C 52 0D 0A 1A 0A            ("\x89KLR\r\n\x1a\n")
chunk  [u32 length][4 ASCII type][payload][u32 CRC-32 of type+payload]

KLRH                      header
( SESS  BLOB* EVTS* ... SEND )+           one group per session, BLOB and EVTS interleaved
KLRE                      end, empty
```

- A reader **skips chunk types it doesn't know**. A bad CRC or a `KLRH` version above its own is an
  error.
- Every chunk stands alone, so a file is any run of whole chunks. That is what makes the draft
  pieces append-only (3.2).
- A reader ignores trailing bytes after the fields it knows in `KLRH`, `SESS` and `SEND`. New fields
  go at the end.

**KLRH**: `varint version = 1`, `varint n`, n × (`string`, `string`) metadata.

**SESS**, one per page load of the editor:

| Field | Type | Notes |
|---|---|---|
| index | varint | 0, 1, 2… |
| engine | string | engine revision id, e.g. `r3` (2.6) |
| api | varint | engine interface version, 1 |
| raster | u32 | raster fingerprint (2.7) |
| seed | u32 | PRNG seed for the session |
| width, height | varint | |
| start kind | u8 | 0 blank, 1 continue, 2 reference, 3 embedded |
| start hash | u32 | document hash (2.7) of the start state |
| start data | by kind | below |
| layers | varint n, then per layer: `varint id`, `string name`, `varint opacity×10000`, `u8 flags` (visible, clipping), `string mixMode`, `u8 has fill` + `string fill` | the layer table at start |
| metadata | (string, string) pairs | recorder build, user-agent family, reason (`new`, `reload`, `revise`) |

Start kinds:

- **0 blank**: every layer is a fill colour from the table.
- **1 continue**: the state at the previous session's end in this file, i.e. a draft reopened after
  a reload or crash. Start data: the previous layer id for each layer in the table (ids restart
  with each page load).
- **2 reference**: start data is `u8 type` (0 PSD, 1 PNG), `string url`, `u32 picture hash`. The
  immutable versioned S3 object the editor opened (`…/<id>-v<ver>.psd`). Used for "draw more".
- **3 embedded**: one `BLOB` per layer. Only when nothing else can describe the start: a draft
  whose recording was lost or predates recording. Exceptional.

**BLOB**: `varint id`, then PNG bytes (RGBA 8-bit, not interlaced). Ids count up across the file. A
blob precedes the `EVTS` chunk that uses it.

**EVTS**: `varint event count`, `varint duration ms`, `u8 compression` (0 none, 1 deflate-raw),
`varint raw length`, body. The count and duration let the player build its timeline without
decoding. Body, as `.lsa` / `.chiani`: `[varint n][n × varint length][streams]`, streams in the
order `op, dt, x, y, p, arg`. A missing stream reads as empty; extra streams are ignored. Delta
state resets at each chunk.

**SEND**: `varint event count`, `varint duration ms`, `u32 document hash`, `u32 picture hash`,
`varint width`, `varint height`, `u8 flags` (bit 0 truncated, bit 1 finished by submit rather than
by a later session). The picture hash is the owner's rule as written: FNV-1a 32 over w, h and the
flattened picture's RGBA little-endian u32 words, the same value `.p95` and `.chiani` store, taken
from the canvas `getPNG()` encodes.

### 2.4 Events

One byte in `op`, one `varint` of milliseconds since the previous event in `dt`.

Fixed-layout events, 0x01–0x0F. An unknown code in this range is an error.

| Code | Event | Streams |
|---|---|---|
| 1 | DOWN | `x`, `y`: svarint delta in 1/32 px; `p`: u8 pressure |
| 2 | MOVE | same |
| 3 | MOVE, coalesced | same (the `isCoalesced` flag the brushes receive) |
| 4 | UP | none |
| 5 | LINE | `x`, `y` twice: from, to (`drawLineSegment`) |

Length-prefixed events, 0x10 and up: `arg` holds `[varint length][payload]`. **A reader skips an
unknown code in this range** and marks the state as possibly stale, like `GAP`.

| Code | Event | Payload |
|---|---|---|
| 0x10 | BRUSH | `string id`, value map of changed settings |
| 0x11 | TARGET | `varint layer id` |
| 0x12 | OP | `string name`, value (the arguments) |
| 0x13 | DIFF | below |
| 0x14 | UNDO | `varint count` |
| 0x15 | REDO | `varint count` |
| 0x16 | CHECK | `u32 document hash` |
| 0x17 | GAP | `string reason`: the recorder could not describe a change; the state after it is unknown |
| 0x18 | NOTE | `string key`, value: diagnostics and presentation only, never affects pixels |

Values use `.p95`'s tags, in binary: 0 null, 1 false, 2 true, 3 +varint, 4 −varint, 5 f64, 6 string,
7 array, 8 object, plus 9 blob id (varint) and 10 back-reference to the n-th string of this chunk.
No JSON.

**DIFF** mirrors `THistoryEntryData`: `u8 flags` (replaceTop, has size, has selection, has active
layer), then the present fields, then `varint n` layers: `varint id`, `u8 attribute mask`, the
attributes present, and for tiles a list of items: fill (`varint first tile, varint count, string
colour`), reference (`varint first tile, varint count, varint source layer id, varint source first
tile`, read from the state before the diff), or pixels (`varint tile x, y, w, h, varint blob id`: a
PNG covering that block of tiles, written with copy semantics). A layer absent from a diff that
lists layer order was removed.

**Vocabulary.** The container and the table above are meant to stay as they are. Brush ids, setting
names, op names and their arguments are strings and values that only the session's own engine
interprets. A new brush, a renamed setting or a new filter changes the vocabulary of new sessions
and nothing else.

### 2.5 Input quantization

The recorder quantizes at the out handler, **before** the brush sees the sample: x and y to 1/32 px
(`Math.round(v * 32) / 32`), pressure to 1/255. The live stroke and the replay then get bit-identical
input, and the stored integers are exact. 1/32 px is below what any brush resolves; u8 pressure is
a size step of at most 0.4 px on the largest pen. The player does the same division.

### 2.6 Engine revisions and frozen builds

**The engine** is everything that turns recorded events into pixels: `klecks/brushes`, `canvas`,
`history`, `filters`, `image-operations`, `transform`, `select-tool`, `events`, `fx-canvas`,
`bb/math`, `bb/multi-polygon`, and the new `klecks/rec` replay code.

- `klecks/rec/engine-rev.ts` exports `ENGINE_REV` (an integer; the id is `r<n>`).
- `klecks/rec/engine.lock` holds a hash of the engine's source files. A test recomputes it. If the
  sources changed and `ENGINE_REV` didn't, the test fails. The fix is always to bump the revision
  and update the lock. No judgement about whether a change "affects pixels" is asked of anyone.
- `scripts/build-2draw.mjs` gains a second Parcel entry, `src/replay-engine.ts`, built as an ES
  module into `dist-2draw/engine/r<n>/`. It contains the engine, the event decoder and no UI.
- 2draw serves it from `/applet/klecks/engine/r<n>/`. **Engine directories are append-only**: never
  edited, never deleted. A 2draw test compares the directory list with a committed list.
- A recording's `SESS` names the revision. The player imports that bundle. Two revisions can be
  loaded in one page, since ES modules don't share globals.

Each bundle exports one stable interface (`api = 1`):

```ts
create(opts: { state: ReplayState; seed: number }): ReplayEngine
interface ReplayEngine {
    canvas: HTMLCanvasElement;                 // the composite, for display
    load(evts: Uint8Array, blob: (id: number) => Promise<Uint8Array>): Promise<void>;
    step(untilMs: number, budgetMs: number): { timeMs: number; done: boolean; stale: boolean };
    documentHash(): number;
    pictureHash(): number;
    rasterId(): number;
    exportState(): ReplayState;
    destroy(): void;
}
type ReplayState = { width; height; activeLayerId; selection;
    layers: { id; name; opacity; isVisible; mixModeStr; hasClipping; image: ImageData }[] };
```

`ReplayState` is deliberately plain. It is how a session hands over to the next one when their
engines differ, how seek checkpoints are kept in memory, and how a reference start is loaded. A
session boundary is a page load in the editor, where the undo history is empty anyway, so no
history crosses engines.

What this buys: a recording made on `r3` is replayed by `r3`'s brush math forever. What it doesn't:
the browser's rasterizer is not frozen (2.7), and a bundle can in principle stop working in a
future browser. It only uses Canvas 2D, `ImageData` and (for filters) WebGL 1, which have been
stable for fifteen years. If a bundle fails to load or throws, the player shows the entry's PNG.

Cost: about 0.8 MB per revision (the embed's main bundle with all UI is 794 KB), plus a lazy 376 KB
PSD reader chunk used only for reference starts. A revision bump is needed roughly whenever engine
code changes, so a handful per year.

### 2.7 Hashes and drift

**Tile hash**: FNV-1a 32 over the tile's w, h and RGBA LE u32 words, the rule's function applied to
one tile. A fill tile hashes as if expanded. Cached per tile object (tiles are immutable).

**Document hash**: FNV-1a 32 over width, height, layer count, and per layer in order: opacity×10000,
visible, clipping, the blend mode's characters, and its tile hashes. The selection is left out
(float polygons). After a stroke only the tiles it touched need hashing.

**CHECK** is written when the draft saves (the pen has rested 300 ms), at most once per 50 events
or 2 s. It is the hash of the `composed` snapshot at that point in the stream. `SEND` carries the
last one plus the picture hash.

**Raster fingerprint**: at engine start, draw a fixed scene (antialiased arcs with alpha, a stroke,
a scaled `drawImage`, a `multiply` fill) on a canvas created exactly like a layer canvas, read it
back twice with a redraw in between, and FNV-1a the result. It names the raster class.

**Pin the backend.** In Chromium, create every engine canvas with `willReadFrequently: true`. It is
where Chrome ends up after two strokes anyway, and it makes the per-stroke tile readback cheaper.
In WebKit the default did not switch in the probe; keep the default unless Phase 0 shows otherwise.
The fingerprint, not the user agent, is what the player compares.

Player policy:

| Situation | CHECK / SEND hash mismatch | End of playback |
|---|---|---|
| Same engine revision and same raster fingerprint (**strict**) | A real bug. `onDrift` once, reported through `reportClientError`. Keep playing. | Show the entry's PNG. |
| Same engine, different fingerprint (**loose**) | Expected. Not reported. | Compare the composite with the entry's PNG; if the mean difference is above a threshold, log a soft drift. Cross-fade to the PNG. |
| Engine bundle missing or failing, or `GAP` / skipped event seen | Ignored. | Show the entry's PNG. |

Drift is detected by hash only; no pixels are stored to correct it. Strict mode localizes a
regression to the events between two CHECKs.

**Flood fill** is the one place where loose-mode differences can become large. Its named op (phase
3) carries the filled mask as a blob: a 1-channel-content PNG of the fill's bounds, typically a few
hundred bytes. A strict player computes the fill itself and the hash proves the engine; a loose
player uses the mask. Until then, flood fill is a `DIFF`, which is exact in every player.

### 2.8 Why not verify at record time and patch

The idea: replay each action in a worker right after it happens and store a pixel patch when the
replay disagrees, so playback is exact by construction.

- A replay in the same browser with the same code agrees, once randomness is seeded and the canvas
  backend is pinned. It finds nothing in production that a test wouldn't find.
- It can't see the future. A patch can only be written when a disagreement is observed, and the
  disagreements that matter (another browser, a later engine) happen after the recording is sealed.
  Patches "whenever the version differs" would have to exist for every step: per-op diffs.
- It doubles memory (a second document plus its history) and competes for the CPU the artist is
  using.

What covers those cases instead: frozen engines for future code, strict/loose hashes for other
browsers, `DIFF` for anything that can't be regenerated. Shadow replay is still valuable as a
**test** (5, phase 0): a debug flag runs a second engine in the page and compares document hashes
after every event.

### 2.9 Operation by operation

| Operation | Phase 2 | Phase 3 |
|---|---|---|
| Brush strokes, shift-lines (all seven brushes) | input | |
| Layer add, duplicate, remove, move, rename, opacity, visibility, clipping, blend mode, select | `DIFF`, metadata and tile references only | |
| Selection set, clear, invert | `DIFF` (polygon) | |
| Layer fill, erase layer | `DIFF`, fill tiles when uniform | `OP` when clipped to a selection |
| Flood fill | `DIFF` pixels | `OP` + mask |
| Shape, gradient | `DIFF` pixels | `OP` |
| Merge down, merge all | `DIFF` pixels | `OP` |
| Flip, rotate, resize, crop/extend | `DIFF` pixels (all layers) | `OP` |
| Selection transform, free-form deform | `DIFF` pixels on commit; the temp steps are never recorded | `OP` (matrix or grid) |
| Filters without WebGL (flip, to-alpha, pattern, noise, grid…) | `DIFF` pixels | `OP name input` |
| WebGL filters | `DIFF` pixels | `OP`; replay through the engine's own WebGL, loose by nature |
| Text | `DIFF` pixels (changed tiles) | stays |
| Image import, paste, drop | `DIFF` pixels | stays |
| New image / reset | `DIFF` with size and every layer | stays |
| Undo, redo | `UNDO` / `REDO` | |
| View (zoom, pan, rotate, flip view), colour picking, UI | not recorded | |
| Anything else, now or later | `DIFF` | named when worth it |

Undo inside the player needs the same history the editor had. The engine uses `KlHistory`
unchanged, with the same trimming, so an undo the editor could do is one the player can do.

### 2.10 Limits

- A recording stops growing at 16 MiB or 2 million events: the recorder writes `GAP "limit"`, sets
  `truncated`, and records nothing more. The player plays to there and shows the PNG.
- `DIFF` pixels are budgeted at 8 MiB per session. Past that a pixel diff becomes `GAP "budget"`
  (metadata diffs continue). The player goes loose and ends on the PNG.
- Expected size: about 6 raw bytes per sample, 2–3 after the stream split and deflate. A long
  drawing of 500k samples is 1–1.5 MB.

## 3. Integration

### 3.1 In Klecks

New directory `src/app/script/klecks/rec/`:

| File | Role |
|---|---|
| `bytes.ts` | Lascaux's `bytes.ts`, copied |
| `format.ts` | chunks, CRC, event encode/decode, values, DIFF |
| `png.ts` | minimal RGBA PNG encode/decode over `CompressionStream` (exact bytes in and out, runs in a worker, no canvas round trip) |
| `hash.ts` | tile, document, picture hashes; raster fingerprint |
| `prng.ts` | mulberry32, reseeded per stroke from (session seed, stroke number) |
| `recorder.ts` | `KlRecorder` |
| `brush-adapters.ts` | per brush: `getState`, `setState`, `start`, `go`, `end`, `line` |
| `ops.ts` | registry of named ops (empty in phase 2) |
| `replay.ts` | the engine side of `api = 1` |
| `engine-rev.ts`, `engine.lock` | 2.6 |

Hooks:

1. **`KlHistory`** (`history/kl-history.ts`): `setObserver({ onPush(entryData, replaceTop), onUndo(),
   onRedo() })`, called synchronously from `push`, `decreaseIndex`, `increaseIndex`. The observer
   only stores references.
2. **Strokes** (`kl-app.ts:437-457`): the out handler quantizes the sample, calls
   `recorder.down / move / up / line`, then the brush. The recorder sets `inStroke` around the
   brush call so the brush's push is explained. At `down` it asks the adapter for the brush state
   and the current layer.
3. **Brushes**: add `getRecState()` / `setRecState()` to each brush class, returning every setting
   as plain values (including the pixel brush's custom pattern). Move the argument adapting that
   lives in `brushes-ui/*` (`isCoalesced`, premixed colour) into `brush-adapters.ts` and call it
   from both the UI wrapper and the replay, so they can't diverge.
4. **Randomness**: replace the four `Math.random()` uses with `rec/prng.ts`. The smudge and blend
   tables get a fixed seed.
5. **Named ops** (phase 3): `recorder.run(name, args, fn)` at the call site; the same `name` is
   registered in `ops.ts`. Pushes inside `run` are explained.
6. **Canvas creation**: route the engine's `getContext('2d')` calls through `BB.ctx` with the
   pinned options (2.7).
7. **Embed API** (`main-embed.ts`, `embed/bootstrap/embed-wrapper.ts`): option
   `recording: { previous?: Uint8Array | Promise<Uint8Array>; reference?: { type, url } }`, method
   `getRecording(): Promise<Blob | null>`, and `features.recording = 1`. Without the option nothing
   is recorded and input isn't quantized.

### 3.2 Through the draft store

The recording rides in the `klecks-tiles-1` draft that `EmbedDraft` (`embed/embed-draft.ts`) already
writes: same head, same format string, pieces stay opaque to 2draw, so the cloud layout `kleki-1`
needs no change.

- `EmbedDraft.save()` reads `composed` at its start. At the same point it calls `recorder.cut()`,
  which encodes the events buffered since the last save. The picture and the recording in one save
  describe the same moment, and `store.save` commits them together.
- The tail JSON gains `rec: { v: 1, pieces: number[], open: string }`. `pieces` are the indexes of
  pieces holding whole recording chunks, in order. `open` is the current, not yet sealed `EVTS`
  chunk, base64. An older build ignores the field.
- The open chunk is sealed into a piece of its own at 64 KiB raw or 60 s. `BLOB` chunks are sealed
  at once. Most saves therefore append no recording piece, only a slightly longer tail. This stays
  far inside `KLEKI_LIMITS` (piece 1 MiB, tail 512 KiB, 16,000 pieces).
- `TTileRef` gains a seventh element, the tile hash, so a restored draft knows its document hash
  without rehashing.
- Compaction (`fresh: true`) re-appends the recording's sealed chunks, coalesced into pieces of up
  to 1 MiB, before the tiles. The recorder keeps them in memory for the submit anyway.
- **Reopen** (`restoreDraft`): the recorder takes the chunks back from `saved.pieces` and
  `tail.rec`, closes the interrupted session with a `SEND` built from the last CHECK, and opens a
  new `SESS` with start kind 1. Strokes drawn after the last save are missing from both the picture
  and the recording, so the two still agree. The artist sees nothing.
- A draft with tiles and no readable recording starts a session with kind 3 (embedded layers) and
  a `NOTE`. The drawing is never held up by the recording.

### 3.3 Submit and storage

- `html/applet/klecks/kleki-2draw.js`: `form.append("klr", await k.getRecording())` when
  `Kleki.features.recording`, next to `png` and `psd`. `getRecording()` cuts, writes `SEND` with
  the picture hash and `KLRE`, and returns the Blob. A failure to build it must not block the
  submit: send without it.
- `worker/src/lib/applet.ts`: the Kleki decoder (around line 2610) accepts optional `klr`, checks
  the magic as ChickenPaint's does, and stores it as `<id>-v<ver>.klr`. Extra types become
  `{ psd: true, klr: false }`: the PSD is kept because recordings reference it. Add
  `kleki: "klr"` to `ANIMATION_FORMATS`, and Kleki to `replayRecordingURL`,
  `appletHasInlineAnimation` and `replayFinalImageURL`. No migration: there is no animation column.
- **Draw more** (`appletWriteReviseApplet`): pass the previous `.klr` URL beside `psdUrl`. The
  wrapper fetches it in the background and hands it to `recording.previous`. The new file is the
  previous file's chunks, then a `SESS` with start kind 2 pointing at the PSD. If the fetch fails,
  the file starts at that `SESS`. The latest file holds the whole history, as with the other tools.

### 3.4 Playback

2draw has a shared shell: `worker/src/client/anim-strip.ts` (play, speed, seek, keyboard) and
`worker/src/client/applet-player.ts`, which lazily loads a tool's player class and drives the
`LascauxClassicPlayer` interface (`domRoot, lsaUrl, finalImageUrl, width, height, speed, onDrift,
onEnd…`; `ready, duration, currentTime, play, pause, seek, setSpeed`). Reuse both. Needed:

- `KlecksPlayer` in `html/applet/klecks/player.js` (source in the fork, `src/player.ts`, built by
  `build-2draw.mjs`). It is small and engine-independent: fetch the `.klr`, parse the container,
  build the timeline from the `EVTS` headers, and for each session import
  `/applet/klecks/engine/<id>/engine.js`, create the engine from the start state, feed it chunks
  and call `step` from `requestAnimationFrame` with a time budget.
- One more branch in `worker/src/skin/base/view/image.ts` (around line 255) to emit the `#replay`
  box for Kleki.
- Start state per kind: blank from the layer table; continue from the previous engine's
  `exportState()`; reference by loading the PSD (the engine's own reader) when the previous
  session's end hash isn't the start hash, or always after a revision; embedded from blobs.
- Seeking: checkpoints from `exportState()` kept in memory every few seconds of replay, replay
  forward from the nearest. Never stored in the file. Idle gaps are capped, as in the other players.
- Drift handling as in 2.7. The final picture is `finalImageUrl`.

## 4. Performance: nothing interrupts drawing

| Moment | Work on the main thread |
|---|---|
| Each sample | Two `Math.round`s, five numbers written into a preallocated `Int32Array`. No allocation, no encoding, no hashing. The buffer grows only at pen-up; a spare block is kept ready in case a stroke outruns it. |
| Pen down | One `getRecState()`: a small object of the brush's settings. Comparison with the previous state happens later. |
| Pen up | Nothing beyond what the brush already does. |
| `KlHistory.push` | Store a reference to the entry and to `composed`. No copy: tiles are immutable. |
| Between fast strokes | Nothing. Everything below waits for `EmbedDraft`'s quiet gate (`isBusy()`: not drawing and 300 ms since the last input) and aborts at `giveWay()` when the artist starts again. |
| Quiet gap | Encode buffered events (microseconds each). Diff brush states. Decide explained / unexplained. |
| Quiet gap, worker | Tile hashes: computed in the existing deflate worker job, which already receives each new tile's bytes. PNG encoding of `DIFF` rectangles: assembled from history tiles and encoded in the worker. Deflate of sealed `EVTS` chunks. |
| Submit | Final cut, picture hash over the composite `getPNG()` already renders, concatenate. |

- Without a draft store (recording on, drafts off), the recorder runs the same cut on its own quiet
  timer using the same gate.
- On `flush()` (page hide), the cut is synchronous and unsealed: events go into `open` raw, pending
  PNG rectangles are written as stored (uncompressed) PNGs, hashes not yet computed are skipped.
- Memory: the sample buffer, the sealed chunks (the file so far) and references to entries not yet
  encoded. No second copy of the document.
- Phase 0 measures the `willReadFrequently` change on a large canvas with a large soft brush, on
  the owner's iPad and in Chrome, before it is adopted.

## 5. Plan

Each phase leaves beta working. Recording stays behind `features.recording` and a 2draw beta flag
until phase 4.

### Phase 0: determinism groundwork (fork only, no recording)

- Seeded PRNG in the four places; input quantization behind a flag; `getRecState` / `setRecState`
  and `brush-adapters.ts`; `KlHistory.setObserver`; hashes and the raster fingerprint; canvas
  options through `BB.ctx`; `src/replay-engine.ts` building headless; `ENGINE_REV` and the lock test.
- Tests:
  - Unit (Vitest or node:test in the fork): `bytes`, `png` (round trip is byte-exact), hashes
    against known vectors shared with `.p95`'s FNV.
  - Browser, a Playwright script like 2draw's `worker/scripts/klecks-e2e.mjs`: a synthetic stroke
    script for every brush and setting family, run twice in one page and in a fresh page. Document
    hashes must match within the browser, including after 20 readbacks (the Chrome switch).
  - The same script in Chromium, WebKit and Firefox (`npx playwright install firefox`; 2draw has no
    Firefox runs today). Expected result: three fingerprints, three sets of hashes, each stable.
    The run writes the per-class hashes to a golden file; a later change in them without an
    `ENGINE_REV` bump fails the test.
  - Shadow replay: a debug flag feeds every event to a second engine in the page and compares
    hashes after each. Draw by hand for a while with it on.

### Phase 1: recorder and drafts

- `format.ts`, `recorder.ts`, `EmbedDraft` integration, `getRecording()`.
- Tests: encode/decode round trip of every event type; a fuzz of random DIFFs applied to a model
  document; the draft e2e (`worker/scripts/klecks-tiles-e2e.mjs`) extended: draw, reload mid-way,
  draw, kill the page without a flush, reopen, submit, and check the file has three sessions whose
  start hashes chain. A long-task observer during a scripted fast-stroke burst shows no recorder
  work between strokes.

### Phase 2: player on beta

- `replay.ts`, the engine bundle, `KlecksPlayer`, the 2draw upload field, storage and view page.
- Tests: record in each browser, replay in each (a 3×3 grid). Same-browser cells must be strict and
  clean; cross-browser cells must end within the loose threshold. A corpus of real `.klr` files from
  beta is kept (outside the scratchpad) and replayed in CI-style scripts against every engine
  revision that exists. An unknown event code, an unknown chunk and a truncated file each degrade as
  specified.

### Phase 3: named ops and draw more

- Named ops in order of fallback bytes seen on beta (the `NOTE` counts): flood fill with mask,
  shape, gradient, merge, flip/rotate/resize/crop, filters, transform.
- Draw more: previous `.klr`, reference start, PSD kept.
- Tests: each op replays to the same document hash as its `DIFF` did (record both in a debug mode
  and compare); revise an entry twice and play the three-session file.

### Phase 4: hardening and production

- Limits and `GAP`, drift telemetry, seek checkpoints under a memory cap, mobile player memory
  (history trimming by lookahead: pre-scan how deep the recording ever undoes).
- The engine-directory append-only test in 2draw. Production rollout with the Klecks build.

## 6. Open questions

### Product

1. Playback in a different browser family from the one the drawing was made in will be very close
   but not pixel-identical, and ends with a cross-fade to the posted picture. Is that acceptable?
   The alternative is rewriting Klecks's brushes as software rasterizers.
2. Non-stroke steps (fill, filter, text, paste) appear in one frame. Fine, or should the player
   hold on them briefly?

### Technical

1. Pinning Chromium canvases to software (`willReadFrequently`) is proposed; WebKit is left at its
   default. If the Phase 0 iPad measurement shows WebKit also needs pinning for stable hashes, is a
   slower large brush on iPad acceptable, or do we accept loose mode there?
2. Frozen engine bundles (about 1 MB per revision, a handful per year) are proposed to live in the
   2draw repo under `html/applet/klecks/engine/`. The alternative is S3, which is put-only and so
   immutable by policy, at the cost of loading player code from another origin.

### Cost

1. Caps: 16 MiB per recording and 8 MiB of non-regenerable pixels per session are proposed. Kleki
   drawings are larger than the other tools'; the PSD upload is already several MB.
2. Phase 3 is optional work that only saves bytes. Until it lands, a drawing that uses filters or
   transforms heavily stores those results as PNG rectangles, which bends the "no per-op diffs"
   rule for those steps. Decide after seeing beta's numbers how far to take it.

## Appendix: corrections to the brief

- Lascaux is at `.lsa` v4 and hashes with a 64-bit murmur-style function, written once per session.
  FNV-1a 32 over w, h and RGBA words is `.p95`'s and `.chiani`'s hash; this design uses that one.
- Lascaux Pocket has its own byte writer and range coder (`worker/src/pocket/lsp-format.ts`); it
  doesn't share Lascaux's `bytes.ts`. `.chiani` does follow `.lsa`'s primitives, and so does this.
- Hash cadence in `.p95` and `.chiani` is every 300 events at a pen-up. Here it is tied to the
  draft's quiet gate instead, so hashing never lands between fast strokes.
