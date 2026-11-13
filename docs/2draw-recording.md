# Timelapse recording in Klecks (2draw fork)

Design doc, 2026-11-13. It replaces the earlier input-replay design (see "Alternatives
considered"). Implemented on the `recording` branch (phase 1): `embed/embed-recording.ts`,
`embed/recording-format.ts`, `embed/embed-input.ts`, the draft's video pieces in
`embed/embed-draft.ts`. Where it differs from the text below:

- The embed has no crop, resize or rotate (those filters are `inEmbed: false`), so a canvas size
  change can't happen there. The recorder still handles one (a new clip); a second clip comes
  from a draft continued in another browser, which the tests cover (Chrome to WebKit).
- A resumed draft adds no keyframe at load: the recording already ends on that picture. The new
  encoder's keyframe is the first change after the reload, so reloads cost nothing.
- The owner's answers to section 11: private drawings upload their timelapse like the picture;
  recording is always on, with no opt-out; pacing stays at 30 steps a second; the cap stays at
  16 MiB per version and recordings are kept until the drawing is deleted. Code references are to the `2draw` branch at fc40750
(`src/app/script/...`, written below without that prefix) and to 2draw.net's `origin/beta`.

## Summary

- **The goal is a timelapse, and a lossy video is fine.** Klecks records one video frame per
  history step (a stroke, a fill, a layer change, an undo) and 2draw plays it with a plain
  `<video>`.
- **H.264 in MP4, or nothing.** It is the only codec that both the encoders we can reach
  (Chrome, Safari) produce and every `<video>` plays, iPhone included. A browser without
  `VideoEncoder` or without a usable H.264 encoder doesn't record.
- **Nothing interrupts drawing.** A frame is grabbed only in a quiet gap, by redrawing just the
  changed rectangle into a small canvas the recorder keeps: 0.3 ms in Chrome at 4096×4096
  (measured). Encoding happens off the main thread. Fast strokes are coalesced into one frame.
- **Drafts carry the recording.** Encoded chunks are appended to the autosave draft
  (`klecks-tiles-1`) as extra pieces. After a reload or crash the recording resumes with a
  keyframe.
- **Submit** muxes the chunks into an MP4 (`mp4-muxer`) and 2draw's wrapper uploads it next to
  the PNG and PSD. Each "Draw more" adds a clip; the view page plays a drawing's clips in order.
- **Defaults from the measurements:** long side capped at 1920 px, 1 Mbit/s at a nominal
  30 steps per second (about 3 to 4 kB per step, 2 to 2.5 MB per 600 strokes), a keyframe every
  300 frames, hard cap 16 MiB per upload.

## 1. Measurements

A throwaway probe (not in the repo), run on the owner's Mac (Apple silicon) in headless
Chrome 157 and in Playwright's WebKit 27.2 build. Playwright's bundled Chromium 147 gave the
same support table as Chrome. Not measured: Safari on a real iPhone or iPad, Android, Windows.

The drawing is synthetic: 600 strokes on two layers over white. 300 pressure-tapered dark lines
(2 to 6 px), then 210 wide translucent colour strokes on the layer below, then 90 detail lines
and eraser strokes. Two canvas sizes: 2000×1500 (video 1920×1440) and 4096×4096 (video
1920×1920). One frame per stroke, a keyframe every 300 frames, timestamps at 30 per second, so
every file is 20 s long. The synthetic strokes land all over the canvas, which is harder on the
encoder than a real drawing that stays in one area for a while.

### 1.1 What records and what plays

| | Chrome 157 | WebKit 27.2 (Playwright) |
|---|---|---|
| `VideoEncoder` | yes | yes |
| H.264 High (`avc1.640033`), Main, Constrained Baseline | hardware (VideoToolbox) and software | yes (VideoToolbox; "prefer-software" gives the same bytes) |
| VP9 | software only | claims support, dropped 9 of 600 frames |
| AV1 | software only | encodes, but its own `<video>` can't decode the file |
| per-frame quantizer mode | hardware H.264, VP9, AV1; not software H.264 | none |
| plays the other browser's H.264 MP4 | yes | yes |
| plays Chrome's VP9 MP4 / AV1 MP4 | yes / yes | yes here / no |

H.264 files from either browser play in both, including a file made by two encoder instances
back to back (the resume case). AV1 fails in WebKit on hardware without an AV1 decoder, which
is most iPhones. VP9 in MP4 played in desktop WebKit but is not something to rely on in iPhone
Safari. So the ladder is H.264 only: High, then Main, then Constrained Baseline, picked with
`VideoEncoder.isConfigSupported`.

### 1.2 File size and quality, 600 strokes, 1920×1440

PSNR is the last frame as `<video>` shows it against the source canvas.

| Encoder, setting | MP4 | key frame | delta frame | PSNR |
|---|---|---|---|---|
| Chrome H.264 hardware, 0.5 Mbit/s | 1.47 MB | 165 kB | 1.9 kB | 31.8 dB |
| Chrome H.264 hardware, 1 Mbit/s | 2.51 MB | 214 kB | 3.5 kB | 37.0 dB |
| Chrome H.264 hardware, 2 Mbit/s | 4.22 MB | 247 kB | 6.2 kB | 40.0 dB |
| Chrome H.264 hardware, 4 Mbit/s | 6.11 MB | 258 kB | 9.4 kB | 40.9 dB |
| Chrome H.264 software, 0.5 Mbit/s | 1.25 MB | 87 kB | 1.8 kB | 30.3 dB |
| Chrome H.264 software, 1 Mbit/s | 1.93 MB | 147 kB | 2.7 kB | 35.2 dB |
| Chrome H.264 software, 2 Mbit/s | 2.66 MB | 165 kB | 3.9 kB | 37.5 dB |
| Chrome H.264 software, 4 Mbit/s | 3.66 MB | 171 kB | 5.5 kB | 40.2 dB |
| Chrome H.264 hardware, quantizer 22 / 28 / 34 / 40 | 2.19 / 1.39 / 0.88 / 0.54 MB | | | 37.4 / 34.0 / 30.8 / 27.7 dB |
| WebKit H.264, 1 Mbit/s | 2.50 MB | 229 kB | 3.4 kB | 36.9 dB |
| WebKit H.264, 2 Mbit/s | 4.27 MB | 267 kB | 6.2 kB | 40.8 dB |
| Chrome VP9 software, 1 / 2 Mbit/s | 2.76 / 3.87 MB | 185 kB | 4.0 / 5.8 kB | 38.8 / 41.0 dB |
| Chrome AV1 software, 1 / 2 Mbit/s | 1.97 / 2.29 MB | 50 / 79 kB | 3.1 / 3.6 kB | 38.4 / 39.2 dB |

Other sizes, H.264 at 1 Mbit/s:

| Canvas, video | Chrome hardware | Chrome software |
|---|---|---|
| 4096×4096, 1920×1920 | 2.47 MB, 35.8 dB | 2.03 MB, 35.0 dB |
| 2000×1500 capped at 1280 (1280×960) | 2.25 MB, 36.2 dB | 1.46 MB, 35.4 dB |

- With a bitrate target the size follows the bitrate more than the picture: bytes per step is
  roughly bitrate ÷ 30. A lower cap (1280) saves little and costs sharpness, so the cap stays
  at 1920.
- Quantizer mode would let quiet steps cost almost nothing, but Safari and Chrome's software
  encoder don't offer it. Not used.
- Muxing adds under 10 kB.

### 1.3 How line art looks

Stills of frame 150 (line art only) and frame 599 (everything), source against decoded, viewed
at 1:1 and 2× (Chrome's files; WebKit's were compared by PSNR only):

- 1 Mbit/s and up, hardware or software: thin tapered lines keep their shape and weight. Edges
  are a little softer than the source. No blocking on the white.
- Quantizer 34: faint ringing next to lines.
- Quantizer 40: visible smear and grey halos.
- 4:2:0 chroma is the known weak spot for thin coloured lines. Dark line art is unaffected. In
  the stills a thin green line over colour stayed clearly readable.

### 1.4 Encode time

Encoding is asynchronous. `encode()` itself returned in under 0.1 ms in Chrome and under 1 ms
in WebKit (rare spikes to 15 ms in WebKit), even when called on the main thread.

| | per frame, wall clock | frame in to chunk out | frames held until `flush()` |
|---|---|---|---|
| Chrome H.264 hardware, 1920×1440 | 6 ms | 36 ms | 2 |
| Chrome H.264 hardware, 1920×1920 | 8 ms | 47 ms | 2 |
| Chrome H.264 software, 1920×1440 | 4 ms | 10 ms | 0 to 1 |
| Chrome H.264 software, 1920×1920 | 6 ms | 15 ms | 0 to 1 |
| WebKit H.264, 1920×1440 | 3 ms | up to 130 ms | about 20 |

- `flush()` took 5 ms (software) to 20 ms (hardware, WebKit), did not force a keyframe and did
  not change the output bytes.
- A second encoder with the same configuration produced the same parameter sets
  (`decoderConfig.description`), and its chunks appended to the first encoder's in one MP4 track
  played in both browsers.
- Chrome's hardware and software encoders give different descriptions (34 and 38 bytes), so a
  draft resumed on another encoder can't continue the same track.

### 1.5 Main-thread cost of the grab

Layer canvases as Klecks has them after its per-stroke readbacks (software-backed). "Full" draws
every layer scaled to the video size; "rectangle" redraws only the stroke's bounding box into a
canvas kept between frames. Time is the composite plus `new VideoFrame(canvas)`, mean / max.

| Variant | Chrome 2000×1500 | Chrome 4096×4096 | WebKit 2000×1500 | WebKit 4096×4096 |
|---|---|---|---|---|
| full, GPU-backed target | 0.9 / 7 ms | 27 / 47 ms | 5 / 17 ms | 19 / 38 ms |
| full, software target (`willReadFrequently`) | 13 / 15 ms | 18 / 22 ms | 12 / 13 ms | 30 / 39 ms |
| rectangle, GPU-backed target | 0.6 / 1.4 ms | 32 / 56 ms | 4 / 14 ms | 16 / 30 ms |
| **rectangle, software target** | **0.3 / 1.6 ms** | **0.3 / 1.8 ms** | **3 / 11 ms** | **15 / 23 ms** |

- In Chrome the rectangle redraw into a software target costs 0.3 ms at any canvas size. A
  GPU-backed target is a trap: every grab uploads the whole software layers (30 ms at 4096²).
- `createImageBitmap(canvas)` instead of `new VideoFrame(canvas)` cost the same. Resizing a
  whole layer with `createImageBitmap` blocked for 16 to 43 ms. Neither is used.
- WebKit's cost is in the composite, not the frame, and grows with the layer size even for a
  small rectangle. 15 ms in a quiet gap at 4096² is tolerable, but this is Playwright's WebKit
  on a Mac, not an iPad. It gets measured on the owner's iPad in phase 1 (section 9).

## 2. Defaults

| | Value | Why |
|---|---|---|
| Codec | H.264: `avc1.640033`, else `avc1.4d0033`, else `avc1.42e033` | 1.1 |
| Container | MP4, one video track, `moov` first | plain `<video>`, starts before the file is down |
| Video size | canvas scaled so the long side is at most 1920, both sides even | 1.2 |
| Rate | `bitrateMode: 'variable'`, 1 Mbit/s at a nominal 30 fps | 1.2, 1.3: the lowest setting whose stills were clean |
| Time base | frame n at n/30 s. Real pauses are not recorded | a timelapse: 600 steps play in 20 s |
| Keyframes | the first frame, every 300th, and the first after a resume | seeking within 10 s; 150 to 270 kB each |
| `hardwareAcceleration` | `no-preference` | both were fine |
| Quiet gap before a grab | 120 ms without input, and not drawing | section 3 |
| Size cap | 16 MiB per upload, all its clips together | section 7 |

At these settings a step costs 3 to 4 kB, so 16 MiB holds roughly 4,000 to 5,000 steps;
thinning (section 7) starts at half of that.

## 3. Capturing frames in Klecks

New file `embed/embed-recording.ts`, class `EmbedRecording`, created in
`main-embed.ts` `onProjectReady` next to `EmbedDraft`. It is opt-in through a new embed option
`recording`, and `Klecks.features.recording` (`embed/bootstrap/embed-wrapper.ts`) says the build
has it.

**The hook is the history, as for drafts.** `klApp.getKlHistory().addListener(...)`
(`klecks/history/kl-history.ts:84`) fires after every push, undo and redo, in a timeout. That
covers strokes, fills, filters, layer changes, imports and transforms without touching any of
them. The listener only marks the recording dirty and schedules a grab.

**The quiet gap** is `EmbedDraft`'s rule with a shorter wait: no `pointerdown`, pressed
`pointermove`, `pointerup`, `wheel` or `keydown` for 120 ms, and `klApp.isDrawing()` false
(`app/kl-app.ts:2401`). The input tracking in `EmbedDraft` (`onInput`, `isBusy`) moves into a
small shared helper so both use one set of listeners. The grab runs before the draft save
(300 ms), so a save includes the frame for the state it saves.

**Coalescing is free.** The grab compares `klHistory.getComposed()` now with the composed state
of the last grab. Tiles are immutable (`history.types.ts`), so a changed tile is a changed
reference. However many strokes or undos happened in between, the result is one frame. A
grab where nothing visible changed (selection, active layer) makes no frame; this is
`getPictureKey` in `embed-draft.ts`.

**The grab:**

1. Diff the two composed states.
   - Same size, same layer list and properties: the union of the changed 256 px tiles
     (`HISTORY_TILE_SIZE`) is the dirty rectangle.
   - A layer added, removed, reordered or with changed opacity, visibility, blend mode or
     clipping: the whole picture is dirty (13 to 30 ms, rare, and still in a quiet gap).
   - A changed canvas size ends the clip (section 4).
2. Redraw the dirty rectangle into the recorder's own canvas: video size, created once with
   `willReadFrequently: true`. It is `drawProject` (`klecks/canvas/draw-project.ts`) with a
   target canvas and a clip rectangle: white, then `LayerCompositor.draw` over
   `klCanvas.getProject()`'s layer canvases, scaled. Blend modes and clipping groups come out as
   in the PNG.
3. `new VideoFrame(canvas, { timestamp })` and transfer it to the encoder.

No pixels are read back and nothing is awaited on the main thread.

**At submit** the recorder grabs once more if the picture changed since the last frame, without
waiting for a quiet gap, so the clip ends on the submitted picture.

## 4. Encoder

**Worker.** A dedicated worker made from a blob URL, as `deflateInWorker` in `embed-draft.ts`
does (2draw's CSP already has `worker-src 'self' blob:`). It owns the `VideoEncoder`.

- Main to worker: `configure` (codec, size, bitrate), `frame` (the transferred `VideoFrame`, key
  or not), `flush`.
- Worker to main: `chunk` (the bytes as a transferred `ArrayBuffer`, key flag), `config` (the
  `decoderConfig.description`), `flushed`, `error`.

If the worker can't be made, or `VideoEncoder` isn't in its scope, the same code runs on the
main thread: `encode()` returns in well under a millisecond (1.4). If frames queue up
(`encodeQueueSize > 2`), new grabs are skipped and coalesce into the next one.

**Chunks live on the main thread**, at most 16 MiB. The draft save and the muxer both need them
there.

**Clips.** A clip is one MP4 track: one codec string, one description, one frame size. A new
clip starts when

- the canvas size changes (crop, resize, rotate), or
- a resumed draft's encoder gives a different description than the stored clip (another browser
  or device, 1.4).

A recording is a list of clips. Usually there is one.

**Choosing the configuration** at start: walk the ladder with `isConfigSupported` at the video
size. If none is supported at 1920, try a 1280 cap (some Android encoders are said to stop at
1920×1088; untested). If still none, there is no recording, and nothing else changes for the
artist.

**Errors.** An encoder error closes the encoder and makes one new one, starting with a
keyframe. A second error ends recording for the session. What was recorded is kept.

## 5. Drafts and resume

The recording rides in the `klecks-tiles-1` draft that `EmbedDraft` already writes. The store
(`TEmbedDraftStore`) and 2draw's side of it don't change: pieces are opaque bytes to them.

- **Video pieces.** Encoded chunks are packed into pieces of their own, appended like tile
  pieces and under the same `PIECE_MAX` (1 MiB). A piece is a run of records: `u32` length, `u8`
  flags (bit 0: keyframe), the chunk bytes. Frame numbers are the order.
- **Tail.** `TTail` gets an optional field. A reader that doesn't know it ignores it, so the
  format name stays `klecks-tiles-1`:

  ```ts
  video?: {
      v: 1;
      clips: {
          codec: string; // 'avc1.640033'
          description: string; // base64
          width: number;
          height: number;
          fps: 30;
          frames: number;
          pieces: number[]; // piece indices, in order
      }[];
  };
  ```

- **One save, one state.** `EmbedDraft.save()` asks the recorder for the chunks not saved yet
  (after a `flush()`, since Safari holds about 20 frames back), appends them with the tiles and
  writes the tail in the same `store.save`. The tail never points at a piece that isn't stored.
  Chunks from a failed or aborted save stay queued.
- **Compaction** (`fresh: true`) writes everything again, so the video pieces go in again.
  `shouldCompact` counts video bytes as live.
- **Resume.** `restoreDraft` returns the clips and their chunk bytes with the project. The
  recorder starts a new encoder; its first frame is a keyframe of the restored picture. If size
  and description match the last clip, the chunks continue it; otherwise a new clip starts.
  Frames encoded after the last save are lost with the crash, and so are the strokes they
  showed, so picture and recording agree.
- **A browser that can't record** opens such a draft, carries the video pieces and the tail
  field along untouched, and still muxes and uploads them at submit. The clip then stops where
  that device took over.
- **Draft size.** 2draw allows 128 MiB per Klecks draft (`KLEKI_DRAFT_MAX_BYTES`). The
  recording uses at most 16 MiB of it.

## 6. Muxing and the embed API

`Klecks.getRecording(): Promise<Blob[]>` on the embed wrapper, next to `getPNG` and `getPSD`:
one `video/mp4` blob per clip, an empty array when there is no recording. It grabs the final
frame, flushes, and muxes each clip.

**Library: `mp4-muxer` 5.2.2, pinned.**

- It does exactly this job: WebCodecs chunks in, a non-fragmented MP4 with `moov` first out
  (`fastStart: 'in-memory'`). The probe's files were made with it and play in Chrome and WebKit.
- MIT like Klecks, no dependencies, about 70 kB unminified. It is imported dynamically at
  submit, so the embed's start-up bundle doesn't grow.
- Its author has deprecated it in favour of Mediabunny. Mediabunny is MPL-2.0, an 11 MB package
  and a whole media toolkit; we need one writer. The MP4 that `mp4-muxer` writes doesn't depend
  on the library being maintained. If it ever has to go, the replacement is Mediabunny's writer
  or a few hundred lines of our own box writing.

Muxing is a few copies of at most 16 MiB, on the main thread at submit (not timed separately
in the probe; it was not noticeable there).

## 7. Limits

- **16 MiB per upload**, all clips of the version together. The recorder watches its total and
  thins instead of stopping: past 8 MiB every 2nd step becomes a frame, past 12 MiB every 4th,
  past 14 MiB every 8th. At 15.5 MiB it stops, and keeps room for the final frame.
- **1920 px** on the long side. Larger canvases are scaled down.
- **8 clips per version.** At the limit a canvas-size change is drawn fitted into the current
  clip's frame instead.
- **One frame per quiet gap.** Continuous fast hatching becomes one frame when the pen rests.
- **Not recorded:** real time, the view (zoom, pan, rotation), the cursor, brush previews, the
  selection outline, the UI.
- **Lossy.** The last frame is close to the picture, not equal to it. The player ends on the
  entry's PNG.
- **No recording** in a browser without `VideoEncoder` or an H.264 encoder.

## 8. The 2draw side

Today no tool uploads video and Klecks has no replay. Every existing recording is one cumulative
file per version that replaces the previous version's file; nothing plays several files in a
row. What changes, all in `2draw.net`:

**Wrapper** (`html/applet/klecks/kleki-2draw.js`, `params.onSubmit`):

- When the build has `Kleki.features.recording` and the boot data allows it, pass the
  `recording` option, and at submit append the clips to the same `FormData` as `mp4`, `mp4_2`,
  `mp4_3`, ...
- If `getRecording()` throws, submit without it. A recording never blocks a submit.

**Upload** (`worker/src/modules/site/get.ts`, `DECODERS.kleki` in `worker/src/lib/applet.ts`
around line 2610, `appletGetHandleDrawData` in `worker/src/lib/appletget.ts`):

- Accept the optional clips, as ChickenPaint's optional `recording` is accepted. Check: at most
  8 clips, 16 MiB together, each starting with an `ftyp` box. Clips that fail are dropped and
  logged; the drawing is still saved.
- Pass them as extra types with `keep: true`, so a new version doesn't supersede the previous
  version's clips: `{ psd: false, mp4: true, "2.mp4": true, ... }`.
- The body is parsed in Worker memory under the existing 100 MB limit. 16 MiB more fits.

**Storage** (`worker/src/lib/imagefiles.ts`, `worker/src/lib/image.ts`):

- Keys follow the version: `data/13/132671/132671-v2.mp4`, then `132671-v2.2.mp4` for a second
  clip. They fit `2draw2_imageurls.image` (`char(50)`) and `DATA_KEY` in `lib/dataproxy.ts`.
- `imageContentType` has no `mp4`. Add `mp4: "video/mp4"`, or S3 serves the clips as
  `application/octet-stream`.
- No migration. A drawing's clips are the `2draw2_imageurls` rows matching
  `<folder><id>-v%.mp4`: one primary-key prefix query, sorted by version and clip number.
- As with every stored file: public-read on S3, never deleted, and the bytes count toward
  `entry_file_size`.

**View page and player** (`worker/src/lib/applet.ts`, `worker/src/skin/base/view/image.ts`,
`worker/src/client/`):

- `ANIMATION_FORMATS`, `appletHasInlineAnimation`, `appletAnimationKind` and
  `replayRecordingURL` assume one file with one extension. Klecks gets its own branch: the replay
  box is shown when the drawing has at least one clip, and gets the clip URLs (through
  `dataProxyURL`) in a `data-clips` attribute. An older revision's page lists the clips up to
  that revision.
- New `worker/src/client/video-player.ts`: a player class for `applet-player.ts`'s interface
  (`ready`, `duration`, `currentTime`, `isPlaying`, `seeking`, `play`, `pause`, `seek(ms)`,
  `setSpeed`), so `anim-strip.ts` gives it the same play button, seek bar and speed menu as the
  other tools.
  - One muted, `playsinline` `<video>` in the replay box, letterboxed to the picture's box, as
    clips can differ in size.
  - The playlist's duration is the sum of the clips' (`preload="metadata"` on each). At a clip's
    end the next one loads. Seeking maps the time to a clip and an offset.
  - Speed is `playbackRate`. At the end it shows the final PNG, as the other players do.
- `lib/toolhub.ts` says "No replay" for Kleki; that changes with the rollout.

**CSP** (`worker/src/lib/csp.ts`): there is no `media-src`, so video falls back to
`default-src 'self'` and S3 or CDN video is blocked on beta, where the policy is enforced. Add
`media-src 'self' blob:` plus the S3 and data-CDN origins. No WASM is involved, so `script-src`
stays as it is.

**Gate:** a beta variable `KLEKI_RECORDING=1` next to `KLEKI_DRAFT`, read where `klecksAllowed`
is (`worker/src/lib/klecks.ts`). The view page needs no gate: without clips there is no box.

## 9. Implementation plan

### Phase 1: recorder and drafts, in the fork

1. `embed/embed-recording.ts`: scheduling, the diff and rectangle grab, the worker and its
   main-thread fallback, clips, the size budget. `drawProject` gets the optional target and clip
   rectangle. The input tracking is shared with `EmbedDraft`.
2. `embed-draft.ts`: video pieces, the tail field, `restoreDraft` returning the clips,
   compaction, carrying an unknown recording along.
3. `Klecks.getRecording()`, `Klecks.features.recording`, the `recording` option, `mp4-muxer`.
   `examples/embed/example-draft.html` gets a "Play recording" button. README-2draw.md lists the
   feature.

Tests (the fork has none today, so these are new: `scripts/test-recording.mjs` on Playwright,
and `node --test` for the pure parts):

- Unit: piece packing and unpacking, the tail round trip, the thinning schedule, the dirty
  rectangle from two composed states.
- Chrome and WebKit, against the example page: draw 50 scripted strokes; `getRecording()`
  returns one MP4 that `<video>` loads, with 50 frames or fewer and the right size; the last
  frame's PSNR against the PNG is at least 30 dB.
- Resume: draw, reload from the draft, draw, submit: one clip, a keyframe at the join, plays
  through.
- Canvas resize mid-session gives two clips. A fake store that fails a save loses no chunks.
- No interruption: during a scripted fast-stroke burst no grab runs (a counter in the
  recorder), and one frame appears after it.
- A browser context with `VideoEncoder` deleted: no recording, no errors, the draft still
  saves.
- By hand on the owner's iPad and iPhone: the grab time at 2000×1500 and 4096×4096 (logged by
  the example page), `playbackRate` at the speed menu's top setting, and that an upload plays on
  the phone. If the iPad's grab is past 10 ms, lengthen the quiet gap there.

### Phase 2: upload, storage and player on beta, in 2draw.net

1. Copy the build into `html/applet/klecks/`, set `KLECKS_BUILD`; the wrapper change; the
   `KLEKI_RECORDING` gate.
2. `DECODERS.kleki`, `imageContentType`, the clip query.
3. `video-player.ts`, the replay box for Klecks, CSP.
4. Deploy to beta with `node scripts/deploy.ts beta`.

Tests (Vitest in `worker/test/`, `npm test`):

- `appletget-upload.test.ts`: png + psd + one and three clips store the expected keys; a second
  version keeps the first version's clips; an oversized or non-MP4 clip is dropped and the
  drawing saved.
- `imagefiles.test.ts`: `mp4` is `video/mp4`. `csp.test.ts`: `media-src`.
- `replay-box.test.ts` (which today asserts Kleki has no box): a box with `data-clips` when
  clips exist, none otherwise, the right list on an older revision.
- A `video-player.test.ts` for the playlist arithmetic (time to clip and offset, total
  duration), and `anim-strip.test.ts` with the new host.
- On beta with the test login (`worker/scripts/beta-login.ts`): draw, submit with "Keep
  private", view page plays; Draw more, submit, both clips play in order; delete the test
  entry. The same view page on the owner's iPhone.

Production follows the Klecks build's own rollout and is the owner's deploy.

## 10. Alternatives considered

**Input-level replay** (the earlier version of this doc): record brush settings and the samples
reaching each brush, record everything else from the history entry, and replay with the engine
revision that recorded it. Dropped because:

- **Canvas 2D output differs between browsers**, and within Chrome between GPU and software
  canvases, down to alpha rounding on axis-aligned rectangles (measured for that design). A
  replay in another browser drifts from the original, so hashes could only be advisory and
  every replay had to end on the stored PNG anyway.
- **Frozen engines.** Exact replay needs every engine revision kept as a self-contained bundle
  forever, a new one for every brush change, and a recorded opcode or fallback diff for every
  tool, including tools upstream adds later. That is a standing cost on a fork we want to keep
  mergeable.
- A video needs neither: it records what was on screen, with a hook in one place.

What a video gives up: it is lossy, fixed at 1920 px, can't be zoomed or re-rendered, and is
larger than an input log would be for a simple drawing.

**Other shapes for the video:**

- `MediaRecorder` on `canvas.captureStream()`: real-time only, no control over frames or
  keyframes, WebM in Chrome.
- WebM/VP9 or AV1: smaller key frames with AV1, but iPhone Safari doesn't play them reliably
  (1.1).
- An animated image or a PNG sequence: larger, and no seeking with a plain element.
- Encoding at submit from stored history tiles: Klecks trims history by memory, and nothing
  would survive a reload.

## 11. Open questions

### Product (for the owner)

1. **Private drawings and opt-out.** A timelapse shows more than the picture: erased sketches,
   reference images pasted and removed. Stored files are public-read on S3 even for "Keep
   private" entries. Proposed: record by default, with a "Don't include a timelapse" choice at
   submit, and no clip uploaded for "Keep private". Agree?
2. **Pacing.** One step is 1/30 s, so 600 strokes play in 20 s and a 4,000-step drawing in a
   bit over 2 minutes, with the speed menu on top. Is that the feel wanted, or should long
   drawings be squeezed to a fixed length?

### Technical (decided)

- H.264 only; no VP9 or AV1 ladder (1.1).
- Bitrate target, not quantizer mode (1.2).
- Rectangle redraw into a software canvas; no `createImageBitmap` resizing (1.5).
- Chunks stay on the main thread; muxing on the main thread at submit (4, 6).
- `mp4-muxer` pinned, not Mediabunny (6).
- Several clips per version, not letterboxing or re-encoding (4).
- The draft format name stays `klecks-tiles-1` (5).
- No database migration; clips are found by key prefix (8).
- Thinning at the size cap, not stopping (7).

### Cost (for the owner)

3. **Storage.** At the defaults a 600-stroke drawing adds about 2 to 2.5 MB and a long one up
   to the 16 MiB cap, per version, and S3 objects are never deleted, so every "Draw more" adds
   another clip. Is that acceptable as is, or should the cap be lower (8 MiB halves the worst
   case and starts thinning at about 1,000 steps)?
