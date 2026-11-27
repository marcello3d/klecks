# Klecks for 2draw.net

This branch (`2draw`) is a fork of [Klecks](https://github.com/bitbof/klecks) by bitbof (MIT, see `LICENSE`), the
painting app behind [Kleki](https://kleki.com). 2draw.net runs its own build of the Klecks embed as its Kleki tool,
instead of bitbof's hosted embed (2draw.kleki.com).

## Build

```sh
npm ci
node scripts/build-2draw.mjs
```

This generates the icons and languages (`npm run icon:build`, `npm run lang:build`), runs
`parcel build src/embed.ts src/help.html` without source maps, and writes `dist-2draw/`: the embed and its chunks,
fonts and images, `help.html`, `LICENSE.txt`, and `VERSION` ("Klecks 2draw@<commit>"). 2draw.net serves it from
`/applet/klecks/`: replace everything in `html/applet/klecks/` there except `kleki-2draw.js` and `README.md` with the
contents of `dist-2draw/`, then set `KLECKS_BUILD` in `worker/src/lib/klecks.ts` to the commit.

`kleki-2draw.js` (in 2draw's repository) builds the `window.Kleki` 2draw calls, as bitbof's own 2draw wrapper does:
a blank canvas or the drawing to continue (`psdUrl`), and on submit the PNG and PSD posted to `uploadUrl`.

## What's different from upstream

- The embed's opt-in `draft` option: autosave through the embedder's storage, saved incrementally as Klecks's 256 px
  history tiles (format `klecks-tiles-1`). `Klecks.features.draft` says it is there. See
  `examples/embed/example-draft.html`. Proposed upstream as bitbof/klecks#260.
- The embed's opt-in `recording` option: a timelapse, one H.264 frame per history step, taken only when the artist
  rests, encoded in a worker, kept in the draft and muxed into MP4s (`mp4-muxer`) at submit by `getRecording()`.
  `Klecks.features.recording` says it is there; `getRecordingInfo()` tells what the recorder did. Browsers without an
  H.264 `VideoEncoder` don't record. See `docs/2draw-recording.md` and the "Play recording" button in
  `examples/embed/example-draft.html`. Tests: `node --test scripts/test-recording-unit.mjs` and
  `node scripts/test-recording.mjs` (Chrome and WebKit through Playwright).
- The embed's `recording: 'klr'`: an input recording (`.klr`) of everything that changes the picture, replayed
  exactly by a headless player in the browser that drew it (`Klecks.loadKlrPlayer()`). `getKlr()`,
  `getKlrChunks()`, `getKlrInfo()`; `Klecks.features.klr`. With it, `blockOutsideImages` (an embed option, on by
  default with `'klr'`) keeps images from outside Klecks out: copy and paste work through an in-memory clipboard.
  The brushes' random numbers come from a seedable PRNG (`klecks/utils/kl-random.ts`) and `KlHistory` has a push
  observer. See `docs/2draw-klr.md`. Tests: `node --test scripts/test-klr-unit.mjs` and `node scripts/test-klr.mjs`.
- `src/app/script/klr/pen-coder.ts` and `pen-coder-vectors-v1.json`: 2draw's shared stroke coder and its test
  vectors, vendored (below).
- `scripts/build-2draw.mjs` and this file.

## The pen coder (vendored)

`.klr` codes its op stream with the pen coder that Lascaux Pocket's `.lsp` uses. 2draw.net is its source of truth
(`worker/src/pocket/pen-coder.ts`, `worker/src/pocket/PEN-CODER.md`); this fork carries byte-identical copies:
`src/app/script/klr/pen-coder.ts` and `src/app/script/klr/pen-coder-vectors-v1.json` (from
`worker/test/fixtures/pen-coder/vectors-v1.json`). Never edit, reformat or lint them here (`.prettierignore`,
`.gitattributes` `-text`). `node --test scripts/test-pen-coder-vendor.mjs` checks both against pinned SHA-256s and runs
every vector both ways; 2draw's `test/pen-coder-vendor.test.ts` compares its file with this checkout's.

To re-vendor: change the coder in 2draw first (with its tests), then copy both files whole over the ones here, update
`PEN_CODER_SHA256` / `VECTORS_SHA256` and the "copied from" commit in `scripts/test-pen-coder-vendor.mjs`, and commit
them together, naming the 2draw commit in the message. A fix never starts in this copy.

To take upstream changes, merge bitbof/klecks `main` into this branch.
