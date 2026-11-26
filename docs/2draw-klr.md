# `.klr`: Klecks input recording (2draw fork)

Phases 1 and 2 of 2draw.net's `worker/KLECKS-RECORDING-PLAN.md`: the recorder, the coder, a
headless player, and drafts as tile checkpoints carrying the recording (`klecks-tiles-2`), in the
embed behind `recording: 'klr'`. 2draw's upload and `KlecksPlayer` are phase 3. The format is not
frozen: nothing has been recorded with it yet, so no reader for older codings is kept. The MP4 timelapse
(`recording: true`, `docs/2draw-recording.md`) is still there.

A `.klr` is for playback only. Nothing is ever restored from it: replay is exact in the browser
that drew it (same build), not across browsers (the canvas 2D and WebGL output differ), so the
player checks a hash per chunk and a viewer always ends on the entry's PNG.

## Files

| | |
|---|---|
| `src/app/script/klr/klr-format.ts` | the coder (pure; `node --test scripts/test-klr-unit.mjs`), with Lascaux's byte writer |
| `src/app/script/klr/klr-hooks.ts` | what the app calls; passes through without a recorder |
| `src/app/script/klr/klr-recorder.ts` | the live recorder, the catch-all, chunk sealing |
| `src/app/script/klr/klr-brushes.ts` | brush settings read and restored, how a stroke reaches each brush |
| `src/app/script/klr/klr-player.ts` | the headless player (KlHistory + KlCanvas + brushes + filters) |
| `src/app/script/klr/klr-paste.ts` | paste as a layer, shared by the app and the player |
| `src/app/script/klecks/utils/kl-random.ts` | the brushes' seeded PRNG (replaces `Math.random`) |
| `scripts/test-klr.mjs`, `scripts/test-klr.html` | Chrome and WebKit: record everything, replay in a fresh page |

## Container

```
magic   89 4B 4C 52                          "\x89KLR"
chunk*  u8 type | varint length | payload    unknown types are skipped
```

- **HEAD** (1): varint format version (1), varint `engineV` (1), string build
  (`Klecks 2draw@<sha>`'s sha, `KLECKS_BUILD` at build time), varint width, height, the start
  (u8 0: a blank start, its layers value-coded: name, opacity, visibility, blend mode,
  clipping, fill colour; u8 1: a reference, string URL, e.g. the previous version's PSD), varint
  layer count and a u32 FNV-1a per layer of the start picture.
- **OPS** (2): varint start ms since the recording began, then ops to the end of the payload:
  `u8 opcode | varint dt ms | arguments`. Each chunk decodes on its own: the clock and the
  coordinate deltas start at 0, the first stroke of each brush restates all of its settings,
  the first stroke restates the layer. A sealed chunk ends with **HASH** (a u32 per layer). No
  BLOB chunk: no image from outside Klecks ever gets in.

Layer hash (HASH, RESTORE, the HEAD's start): FNV-1a 32 over the FNV-1a 32 of each 256 px tile's
RGBA, row-major, each tile hash as 4 big-endian bytes (`klr-hash.ts`). A tile's hash is kept while
the history's tile object for it stays the same (tiles are immutable), so a seal reads back only
the tiles that changed: 40 tiles for 300 strokes at 1200×900, 288 to 432 at 3000×3000.

Coordinates (all through `KlrSampleCoder`, the one seam for stroke samples, which moves next onto
the range coder shared with Lascaux Pocket) are 1/32 px as zigzag varint deltas from the previous point, pressure a u8. Other
arguments use a tagged value coding (undefined, null, booleans, svarint integers, f32 where
exact, else f64, strings, arrays, objects, bytes). Quantization happens before the live brush
sees the event, so the live picture is what the player draws.

## Opcodes

| op | arguments | from |
|---|---|---|
| DOWN 01 | point, pressure, seed | chain-out (kl-app.ts), after LineSmoothing |
| MOVE 02 | point, pressure | |
| UP 03 | | |
| LINE 04 | from-last flag, [point], point, seed | shift+click line |
| TRANSFER 05 | | the easel's `onBeforeRender` flush, during a stroke (blend, pixel, chemy, smudge) |
| BRUSH 10 | u8 brush, changed settings | before a stroke whose brush or settings changed |
| LAYER 11 | layer index | before a stroke on another layer |
| CANVAS 20+i | the method's arguments | every KlCanvas method that changes the picture (`CANVAS_METHODS`: fills, shapes, gradient, text, erase, every layer op, resize, crop, rotate, flip, selection) |
| FILTER 40 | name, layer, seed, input | the Edit tab (`EditUi.applyFilter`) |
| UNDO 41, REDO 42 | | kl-app.ts `undo()` / `redo()` (not the select tool's temporary steps) |
| ACTIVE 43 | layer index | a click in the layer list (pushes the active layer) |
| SAMPLE 44 | id, layer | the select tool takes its sample (entering transform) |
| XFORM 45, FFD 46 | sample id, parameters | the select tool applies a transform or a warp |
| COPY 47 | id, mask | in-app copy |
| PASTE 48 | id, transform, pixelated, name | in-app paste as a layer |
| TILES 7E | the history entry as tiles | the catch-all |
| RESTORE 49 | u32 per layer | first op after a reload that opened the draft |
| HASH 7F | u32 per layer | end of a sealed chunk |

Seeds: the recorder reseeds `klRandom` before each stroke and filter, and stores the seed.
Sketchy keeps its own seed across strokes (`sketchySeed`, a brush setting) and connects to the
points of earlier strokes, so a player always replays from the start.

## Catch-all

`KlHistory.setPushObserver` tells the recorder about every push. An op runs at depth > 0 and
claims the pushes it makes; a push at depth 0 has no opcode and is stored as a TILES op (the
entry's tiles and layer attributes, layers by index), counted in `getKlrInfo().catchAll` and
logged with `console.warn`. It keeps a recording whole; each use is a bug to fix with an
opcode. An op whose arguments don't encode (an image, a function) runs unclaimed, so its push
goes to the catch-all too (`unencodable`).

## Outside images

`blockOutsideImages` (default on with `recording: 'klr'`, off otherwise, so upstream behaviour
stays one option away): pasting from the system clipboard, dropping a file and the Edit tab's
paste read nothing from outside; a short note says "Only what you copied in Klecks can be pasted
here." Copy (Ctrl+C, the Edit tab) puts the merged picture, masked by the selection, into an
in-memory clipboard (COPY); paste (Ctrl+V, the Edit tab) places it with the usual "import as
layer" dialog (PASTE). The embed has no image import (no File tab). Lost: tracing over a pasted
reference, and copying between two Klecks tabs.

## Software canvases

In `'klr'` mode every 2D canvas is a software one from the start (`softwareCanvases()` in
`klecks/canvas/layer-context.ts`: `willReadFrequently` on every `getContext('2d')`), in the
recording app (before Klecks makes any canvas) and in the player. Chrome starts a canvas on the
GPU and moves it off after enough readbacks, at moments that differ between the live app (frames,
timers) and a replay (one task), and the two draw and read back differently: a restored picture
read back differently 300 ms after the page started, and replays across a reload drifted. With
software canvases they match (tests below). Klecks reads its layers back after every stroke, so
they ended up in software anyway; the measured cost while drawing is nil (below). A side effect:
the PNG composite of a half-opacity layer rounds differently from a GPU composite (the tiles-1
fixtures' expected.png were made on the GPU, so they are checked without recording).

## Drafts: `klecks-tiles-2`

`embed/embed-draft.ts`. tiles-1 (still read, forever) plus, under `'klr'`, `TTail.klr`: the HEAD
(base64), the open OPS chunk up to its last op between strokes (base64; sealing at 64 kB keeps it
well under 2draw's 512 kB tailMax), the sealed chunks as pieces of their own (one each,
append-only, carried forward by compaction), and the clock, seed and id counters. Saves are
checkpoints: in a quiet gap (500 ms without input, not drawing), every `CHECKPOINT_MS` (30 s) or
`CHECKPOINT_CHANGES` (50 picture changes), whichever comes first, and on flush. Only tiles new
since the last checkpoint are appended. The tiles and the recording are taken at the same moment.

A reload opens the draft from its tiles (never by replay) with a fresh undo history. The recorder
continues the same recording: the draft's chunks stay as they are (its open chunk closes without a
HASH) and the next chunk starts with RESTORE, carrying the restored picture's hashes. The player
checks them, then starts a fresh history from its own history tiles (as the draft has them),
fresh brushes and an empty clipboard, as the reloaded page has. A tiles-1 draft (or one without
`klr`) starts a new recording from the restored picture as a reference; its video pieces are
dropped under `'klr'`, so it submits without a timelapse. The server's "kleki-1" layout is
unchanged: format, pieces and tail are opaque to it.

## Embed API

- `new Klecks({ recording: 'klr', klrStartUrl? })`
- `klecks.getKlr()`: the whole file, the open chunk sealed first.
- `klecks.getKlrChunks()`: `{ head, sealed[], open }`, each framed; concatenated in that order
  they are a `.klr`. For drafts (phase 2): sealed chunks are append-only pieces.
- `klecks.getKlrInfo()`: chunks, ops, strokes, bytes, catchAll, unencodable, hashTilesRead.
- `klecks.getDraftInfo()`: checkpoints, their main-thread ms (last, max), saved bytes, tail bytes,
  .klr pieces, restore ms.
- `Klecks.loadKlrPlayer()`: the headless `KlrPlayer` (`new KlrPlayer(bytes, { project? })`,
  `runAll()`, `step()`, `getKlCanvas()`, `getLayerHashes()`).
- `Klecks.features.klr`.

Chunks are sealed in a quiet gap (1.5 s without an op, not drawing) once the open one has 64 kB,
20,000 ops or a minute. Sealing hashes every layer (a full `getImageData` per layer).

## Limits and next steps

- The player replays from the start; seeking needs checkpoints (phase 3).
- Text depends on the fonts the browser has.

## Measured (2026-11-26, `node scripts/test-klr.mjs`, 1200×900)

127 strokes over all seven brushes plus every op type, 10 chunks: about 25.5 kB, 201 B per
stroke all in, 178 B per stroke for the stroke ops alone (strokes of 8 to 32 points, about 6 to
7 B per point with transfers and settings). Fresh-page replay with the headless player: every
layer and every chunk hash equal, in Chrome and in WebKit (each its own recording), 140 strokes/s
including the filters; the catch-all never fired.

## Measured, drafts (2026-11-27, `node scripts/test-klr-all.mjs`, Mac M3)

300 scripted strokes over all brushes, a rest every 25, then flush and reload:

| | 1200×900 Chrome | 1200×900 WebKit | 3000×3000 Chrome | 3000×3000 WebKit |
|---|---|---|---|---|
| draft (pieces + tail) | 2.8 MB + 68 kB | 2.7 MB + 69 kB | 11.5 MB + 77 kB | 11.5 MB + 79 kB |
| .klr | 50 kB | 50 kB | 52 kB | 53 kB |
| checkpoints | 6 | 6 | 6 | 6 |
| main thread per checkpoint, last / max | 2.7 / 4.3 ms | 5.0 / 6.0 ms | 8.1 / 13.2 ms | 12.0 / 14.0 ms |
| restore | 15 ms | 26 ms | 73 ms | 104 ms |

(Deflating runs in a worker and the store's own write is not counted.) Reloads right after a
checkpoint and between two restore the checkpoint's picture exactly; the final .klr, two RESTOREs
included, replays in a fresh page to the final live hashes, in both browsers.

Drawing cost of software canvases (`scripts/perf-klr-canvas.mjs`, Chrome with the GPU on, ANGLE
Metal; 30 fast real-mouse strokes, pen and blend): GPU without recording and software with
`'klr'` both ran at 16.7 ms p50 and p95 frames, max 16.8 ms, no frame over 20 ms and no long
task, at 1200×900 and at 3000×3000. Headless Chrome on a Mac; not measured on an iPad.
