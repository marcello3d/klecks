# `.klr`: Klecks input recording (2draw fork)

Phases 1 and 2 of 2draw.net's `worker/KLECKS-RECORDING-PLAN.md`: the recorder, the coder, a
headless player, and drafts as tile checkpoints carrying the recording (`klecks-tiles-2`), in the
embed behind `recording: 'klr'`. 2draw's upload and `KlecksPlayer` are phase 3. The format is
`.klr` v0, coded with the pen coder shared with Lascaux Pocket (below). The MP4 timelapse
(`recording: true`, `docs/2draw-recording.md`) is still there.

A `.klr` is for playback only. Nothing is ever restored from it: replay is exact in the browser
that drew it (same build), not across browsers (the canvas 2D and WebGL output differ), so the
player checks a hash per chunk and a viewer always ends on the entry's PNG.

## Files

| | |
|---|---|
| `src/app/script/klr/klr-format.ts` | the coder (pure; `node --test scripts/test-klr-unit.mjs`) |
| `src/app/script/klr/pen-coder.ts` | 2draw's pen coder, vendored byte for byte with its vectors (`node --test scripts/test-pen-coder-vendor.mjs`; README-2draw.md) |
| `src/app/script/klr/klr-hooks.ts` | what the app calls; passes through without a recorder |
| `src/app/script/klr/klr-recorder.ts` | the live recorder, the catch-all, chunk sealing |
| `src/app/script/klr/klr-brushes.ts` | brush settings read and restored, how a stroke reaches each brush |
| `src/app/script/klr/klr-player.ts` | the headless player (KlHistory + KlCanvas + brushes + filters) |
| `src/app/script/klr/klr-paste.ts` | paste as a layer, shared by the app and the player |
| `src/app/script/klecks/utils/kl-random.ts` | the brushes' seeded PRNG (replaces `Math.random`) |
| `scripts/test-klr.mjs`, `scripts/test-klr.html` | Chrome and WebKit: record everything, replay in a fresh page |
| `scripts/test-klr-draft.mjs` | Chrome and WebKit: checkpoints, reloads, the tiles-1 fixtures, a video draft |
| `scripts/test-klr-all.mjs` | all of them in one turn of the machine's browser lock |

## The format: `.klr` v0

The spec is 2draw.net's `worker/src/pocket/PEN-CODER.md`, section 8 (byte layouts, the channel
table, opcodes and fields), with the owner's decisions in `worker/KLECKS-RECORDING-PLAN.md`,
"Format decisions". `klr-format.ts` implements it; what follows is how, and where it had to
choose. `opsV 0` and `headV 0` are provisional: while `.klr` is beta-only, v0 files may be
deleted and v0 changed; v1 is frozen before production. Nothing reads the interim coding the
fork had before (an op per sample, tagged values): no file of it was kept.

```
magic   89 4B 4C 52                          "\x89KLR"
chunk*  u8 type | varint length | payload    unknown types are skipped
HEAD (1), then OPS (2) chunks in order, each followed by a TILES (3) chunk when its catch-all
TILES ops hold pixels
```

- **HEAD**: headV 0, build (`KLECKS_BUILD`), width, height, hashTile 256, the start (0 blank,
  with its layers: name, f64 opacity, visible/clipping bits, mix mode index, fill; 1 the previous
  version's PSD, which 2draw hands the player: no URL in the file), the start picture's hashes.
- **OPS**: a plain header (opsV 0, engineV, coder 0, pen flags 11, klrFlags 0, startMs,
  durationMs, opCount, restore and its hashes, the hashes at the seal), then one range-coded
  stream (`RangeSink` over the spec's channel table) of ops ending with END. Each chunk decodes
  on its own: the clock, the coder's statistics, the pen coder's last point, dt and lattice, the
  layer and every brush start over (a brush's first BRUSH op in a chunk restates all its fields).
- **TILES**: the pixels (or fills) of the chunk's catch-all ops, which index them.

A reader refuses an opsV, coder or klrFlags bit it doesn't know and pen flags the pen coder
refuses; it checks the decoded op count and duration against the header. `parseKlr` throws only
on a file that isn't a `.klr` (no magic, no HEAD); a chunk it can't read (truncated, damaged, an
unknown opcode) ends the file there, with `error` saying why, and the player replays the chunks
before it (a viewer ends on the PNG anyway). EXT ops are skipped (no codes yet; counted in
`skipped`).

Layer hash (the HEAD's start hashes, a chunk's restore and end hashes): FNV-1a 32 over the FNV-1a
32 of each 256 px tile's RGBA, row-major, each tile hash as 4 big-endian bytes (`klr-hash.ts`). A
tile's hash is kept while the history's tile object for it stays the same (tiles are immutable),
so a seal reads back only the tiles that changed.

### Ops

Flat opcodes, append only (`OPC`, `SCALAR_METHODS`, `NAMED_METHODS`): END 0, STROKE 1, LINE 2,
BRUSH 3, LAYER 4, ACTIVE 5, UNDO 6, REDO 7, COPY 8, PASTE 9, SAMPLE 10, XFORM 11, FFD 12, FILTER
13, TILES 14, EXT 15; the scalar layer ops 16-24 with typed fields (setOpacity, setLayerIsVisible,
setLayerHasClipping, moveLayer, mergeLayer, removeLayer, duplicateLayer, renameLayer,
setMixMode); the rest of KlCanvas's picture-changing methods 25-38 with named fields (addLayer,
reset, resize, cropExtend, mergeAll, rotate, flip, layerFill, floodFill, drawShape, drawGradient,
text, eraseLayer, setSelection).

| op | from |
|---|---|
| STROKE | chain-out (kl-app.ts), after LineSmoothing: held from DOWN to UP, one op; the samples `[t, x, y, p]` (ms, 1/32 px, u8) through `KlrSampleCoder`, the one seam onto the vendored pen coder (`PenStrokeEncoder`, one per chunk); the seed; the easel's `transferToCanvas` calls, each placed by how many samples the brush had been given; the UP's time |
| LINE | shift+click line |
| BRUSH, LAYER | before a stroke whose brush, settings or layer changed in this chunk (as they were at its DOWN). The fields are `BRUSH_FIELDS` (klr-format.ts) as of opsV 0, a mask bit each |
| canvas ops 16-38 | every KlCanvas method in `CANVAS_METHODS`, wrapped by the recorder; its arguments named by `CANVAS_PARAMS` (the parameter names in KlCanvas's signature), undefined ones left out; the player calls each method from its fields by name (`KlrPlayer.canvasOp`) |
| FILTER | the Edit tab (`EditUi.applyFilter`): name, layer, seed, input |
| UNDO, REDO | kl-app.ts `undo()` / `redo()` |
| ACTIVE | a click in the layer list (pushes the active layer) |
| SAMPLE, XFORM, FFD | the select tool's sample, transform and warp (named params, mapped by name) |
| COPY, PASTE | in-app copy and paste as a layer |
| TILES | the catch-all |

Seeds: the recorder reseeds `klRandom` before each stroke and filter, and stores the seed.
Sketchy keeps its own seed across strokes (`sketchySeed`, a brush setting) and connects to the
points of earlier strokes, so a player always replays from the start. Quantization happens
before the live brush sees the event, so the live picture is what the player draws.

The recorder checks and copies each op as it comes (`prepareOp`: the values made plain copies,
then the op coded on a throwaway varint sink), keeps the open chunk's ops in memory and codes
them at the seal. An op that doesn't code runs unclaimed (its push goes to the catch-all).

### Where this build chooses, or deviates from the spec

- **A seal during a stroke** (a draft checkpoint while the pen is down, only on a flush): the ops
  before the stroke are sealed with no end hashes (`n = 0`: not taken, the canvas holds half a
  stroke; the player skips the check), and the stroke goes to the next chunk, whose start is the
  stroke's DOWN. The spec has no such case.
- **durationMs** is the clock at the chunk's end, i.e. the last op's time, or for a stroke its
  UP's time (the clock after it), so the decoder can check it.
- **Chunk starts**: the first at the recording's start, each next one at the previous seal
  (or the held stroke's DOWN). A chunk with no ops isn't sealed: a reload with no drawing after it
  writes no restore chunk (the next one restores the same picture).
- **The lattice** is searched only when the strokes aren't smoothed and the view isn't rotated
  (`getGrid` in kl-app.ts: the zoom and `devicePixelRatio`, U 32); otherwise the encoder gets no
  grid and only codes the "no lattice" bit. Klecks smooths by default, so most strokes go without.
- **Integers in values** above 2^52 are written as f64 (tag 5), the pen coder's integer model
  holding 2^52; a reader takes tag 4 or 5 alike.
- **Vendoring**: the copy is `src/app/script/klr/pen-coder.ts` (the path 2draw's
  `test/pen-coder-vendor.test.ts` compares), not a `vendor/` folder.

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

`embed/embed-draft.ts`. tiles-1 (still read, forever) plus, under `'klr'`, `TTail.klr` (v 2): the
HEAD (base64), the sealed chunks as pieces of their own (one each, an OPS chunk with its TILES
chunk if any; append-only, carried forward by compaction), and the clock, seed and id counters.
Saves are checkpoints: in a quiet gap (500 ms without input, not drawing), every `CHECKPOINT_MS`
(30 s) or `CHECKPOINT_CHANGES` (50 picture changes), whichever comes first, and on flush. Only
tiles new since the last checkpoint are appended. Every checkpoint seals the recording's open
chunk first (`getDraftState`), so a draft holds no open chunk: the tail carries no `.klr` bytes
but the HEAD. The tiles and the recording are taken at the same moment. (A tail of v 1, from the
interim coding with an open chunk in it, existed only in tests: its recording is dropped and a new
one starts, as for tiles-1.)

A reload opens the draft from its tiles (never by replay) with a fresh undo history. The recorder
continues the same recording: the draft's chunks stay as they are and the next chunk starts on a
restore (its header's `restore`, with the restored picture's hashes). The player
checks them, then starts a fresh history from its own history tiles (as the draft has them),
fresh brushes and an empty clipboard, as the reloaded page has. A tiles-1 draft (or one without
`klr`) starts a new recording from the restored picture as a reference; its video pieces are
dropped under `'klr'`, so it submits without a timelapse. The server's "kleki-1" layout is
unchanged: format, pieces and tail are opaque to it.

## Embed API

- `new Klecks({ recording: 'klr' })` (a start that isn't blank is the previous version's PSD:
  2draw gives it to the player, the file names no URL)
- `klecks.getKlr()`: the whole file, the open chunk sealed first.
- `klecks.getKlrChunks()`: `{ head, sealed[] }`, each framed; concatenated in that order they
  are the `.klr` so far (the open chunk's ops are coded when it is sealed).
- `klecks.getKlrInfo()`: chunks, ops, strokes, samples, bytes (sealed), openOps, catchAll,
  unencodable, hashTilesRead, sealMs / sealMaxMs (main-thread time of a seal: hashes and coding).
- `klecks.getDraftInfo()`: checkpoints, their main-thread ms (last, max), saved bytes, tail bytes,
  .klr pieces, restore ms.
- `Klecks.loadKlrPlayer()`: the headless `KlrPlayer` (`new KlrPlayer(bytes, { project? })`,
  `runAll()`, `step()`, `getKlCanvas()`, `getLayerHashes()`); its result counts hash checks and
  mismatches (per chunk, at its restore or its end), skipped EXT ops and the `error` that ended
  reading early, if any.
- `Klecks.features.klr`.

Chunks are sealed at every draft checkpoint, by `getKlr()`, and otherwise in a quiet gap (1.5 s
without an op, not drawing) once the open one has 100,000 samples, 20,000 ops or a minute.
Sealing hashes the layers' changed tiles and codes the chunk.

## Limits and next steps

- The player replays from the start; seeking needs checkpoints (phase 3).
- Text depends on the fonts the browser has.

## Measured (2026-11-26, `node scripts/test-klr.mjs`, 1200×900)

The same scripted session (127 strokes, 2,476 samples, over all seven brushes plus every op type,
10 chunks), before and after v0:

| | interim coding (c5a1f06) | v0, Chrome | v0, WebKit |
|---|---:|---:|---:|
| the .klr | 25,549 B | 11,151 B | 11,340 B |
| per stroke, all in | 201 B | 88 B | 89 B |
| per sample, all in | 10.3 B | 4.5 B | 4.6 B |
| per stroke, stroke ops only (with their BRUSH and LAYER ops) | 178 B | 72 B | 73 B |
| per sample, the same | 9.1 B | 3.7 B | 3.7 B |

The test's strokes are short (8 to 32 points), jittered and spread over 10 chunks that each
start the coder's statistics afresh, with a brush change every few strokes, so they cost more
than Pocket's corpus (0.97 B a sample, PEN-CODER.md section 1); a real session's long strokes
should land near that. Fresh-page replay with the headless player: every layer and every chunk's
end hashes equal, in Chrome and in WebKit (each its own recording), 140 to 180 strokes/s
including the filters; the catch-all never fired.

## Measured, drafts (2026-11-26, `node scripts/test-klr-draft.mjs --measure`, Mac M3)

300 scripted strokes over all brushes, a rest every 25, then flush and reload:

| | 1200×900 Chrome | 1200×900 WebKit | 3000×3000 Chrome | 3000×3000 WebKit |
|---|---|---|---|---|
| draft (pieces + tail) | 2.8 MB + 1.5 kB | 2.7 MB + 1.5 kB | 11.5 MB + 7.7 kB | 11.5 MB + 7.7 kB |
| .klr | 21 kB | 22 kB | 24 kB | 25 kB |
| checkpoints | 6 | 6 | 6 | 6 |
| main thread per checkpoint, last / max | 16 / 20 ms | 9 / 15 ms | 72 / 78 ms | 53 / 59 ms |
| longest unbroken stretch of it | 6.8 ms | 5.0 ms | 6.5 ms | 5.0 ms |
| the seal in it (coding, hashes left) | 3.2 / 4.4 ms | 1.0 / 3.0 ms | 2.7 / 3.7 ms | 1.0 / 4.0 ms |
| restore | 12 ms | 21 ms | 59 ms | 89 ms |

(Deflating runs in a worker and the store's own write is not counted.) Against the interim
coding (2.7 to 14 ms a checkpoint, a 50 kB .klr, 68 to 79 kB of tail) the tail shrank to the
HEAD and the layer list, and the .klr to less than half; a checkpoint now costs more main-thread
time because it seals, and a seal hashes the layer tiles changed since the last one (972 tiles
in all at 3000×3000). Those are read back a few at a time before the seal, giving way to input
like the tile deflating, so no stretch of it is longer than about 7 ms; the seal's own coding
takes 1 to 4 ms. Reloads right after a checkpoint and between two restore the checkpoint's
picture exactly; the final .klr, two restore chunks included, replays in a fresh page to the
final live hashes, in both browsers.

Drawing cost of software canvases (`scripts/perf-klr-canvas.mjs`, Chrome with the GPU on, ANGLE
Metal; 30 fast real-mouse strokes, pen and blend): GPU without recording and software with
`'klr'` both ran at 16.7 ms p50 frames, p95 at most 16.8 ms, no frame over 20 ms and no long
task, at 1200×900 and at 3000×3000. Headless Chrome on a Mac; not measured on an iPad.
