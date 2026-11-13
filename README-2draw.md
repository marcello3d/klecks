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
- `scripts/build-2draw.mjs` and this file.

To take upstream changes, merge bitbof/klecks `main` into this branch.
