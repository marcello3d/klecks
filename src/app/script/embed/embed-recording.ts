import { KlApp } from '../app/kl-app';
import { THistoryEntryDataComposed } from '../klecks/history/history.types';
import { drawProjectTo } from '../klecks/canvas/draw-project';
import { EmbedInput, getEmbedInput } from './embed-input';
import {
    BITRATE,
    BYTES_CAP,
    BYTES_MUX_CAP,
    CODECS,
    diffComposed,
    KEY_EVERY,
    MAX_CLIPS,
    placement,
    RECORDING_FPS,
    sameBytes,
    thinStride,
    TPlacement,
    TVideoChunk,
    VIDEO_CAP,
    VIDEO_CAP_FALLBACK,
    videoRect,
    videoSize,
} from './recording-format';

/**
 * Timelapse recording (opt-in, the embed's `recording` option): one H.264 video frame per
 * history step, taken in a quiet gap. Design: docs/2draw-recording.md.
 *
 * - A history change marks the recording dirty. Once the artist rests (QUIET_MS without input,
 *   not drawing) the changed rectangle is redrawn into a canvas the recorder keeps, at video
 *   size, and handed to a VideoEncoder as a VideoFrame. However many steps happened in between,
 *   that's one frame.
 * - The encoder runs in a worker if it can, else on the main thread (encode() returns at once).
 * - Encoded chunks stay here, grouped in clips (one size, one codec description each); the
 *   draft (embed-draft.ts) stores them, getClips() muxes them into MP4s at submit.
 * - Nothing here may break drawing or saving: every failure ends in no recording, or a
 *   shorter one.
 */

const QUIET_MS = 120;
const FLUSH_TIMEOUT_MS = 3000; // a stuck encoder doesn't hold up a draft save or a submit
const MAX_QUEUE = 2; // frames waiting in the encoder before grabs are skipped (and coalesce)
const FRAME_US = Math.round(1e6 / RECORDING_FPS);

export type TRecordingClip = {
    codec: string;
    description: Uint8Array;
    width: number;
    height: number;
    chunks: TVideoChunk[];
    // what the draft holds of it
    savedChunks: number;
    pieces: number[];
};

export type TRecordingRestored = { clips: TRecordingClip[] };

export type TRecordingInfo = {
    state: 'starting' | 'recording' | 'stopped' | 'unavailable';
    reason?: string;
    codec?: string;
    backend?: 'worker' | 'main';
    width?: number;
    height?: number;
    clips: { width: number; height: number; frames: number; keys: number; bytes: number }[];
    bytes: number;
    grabs: number; // frames made
    grabsBusy: number; // grab timers that found the artist busy (and waited)
    grabsWhileDrawing: number; // grabs that ran while drawing: must stay 0
    grabMs: { n: number; mean: number; p95: number; max: number };
};

// A clip's share of a draft save: chunks [from, to) are new in the store.
export type TRecordingSavePart = { clip: TRecordingClip; from: number; to: number };

type TBackendEvents = {
    chunk: (session: number, bytes: Uint8Array, key: boolean, description?: Uint8Array) => void;
    error: (session: number, message: string) => void;
};

interface TBackend {
    readonly kind: 'worker' | 'main';
    configure(session: number, config: VideoEncoderConfig): void;
    encode(frame: VideoFrame, key: boolean, timestamp: number): void; // takes the frame
    queueSize(): number;
    flush(): Promise<void>; // every encoder so far
    close(): void;
}

/**
 * The encoder, wherever it runs. Self-contained, as it is also the worker's source, and plain
 * ES2017 (no optional chaining, no classes) so the build doesn't put helpers outside it. One
 * VideoEncoder per session. A new session lets the previous encoder finish what it holds
 * before it closes, so a clip's last frames aren't dropped.
 */
function encoderHost(post: (msg: any, transfer?: Transferable[]) => void): (msg: any) => void {
    let enc: any = null;
    let closing: Promise<unknown>[] = [];
    function copy(d: any): Uint8Array | undefined {
        if (!d) {
            return undefined;
        }
        if (d instanceof ArrayBuffer) {
            return new Uint8Array(d.slice(0));
        }
        return new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice();
    }
    function closeLater(old: any): void {
        const done: Promise<unknown> = old
            .flush()
            .catch(function () {})
            .then(function () {
                try {
                    old.close();
                } catch (e) {
                    // closed by an error already
                }
                closing = closing.filter(function (p) {
                    return p !== done;
                });
            });
        closing.push(done);
    }
    return function (msg: any): void {
        if (msg.type === 'configure') {
            if (enc && enc.state === 'configured') {
                closeLater(enc);
            }
            enc = null;
            const session = msg.session;
            try {
                const e: any = new VideoEncoder({
                    output: function (chunk: any, meta: any) {
                        const bytes = new Uint8Array(chunk.byteLength);
                        chunk.copyTo(bytes);
                        const config = meta && meta.decoderConfig;
                        post(
                            {
                                type: 'chunk',
                                session: session,
                                bytes: bytes,
                                key: chunk.type === 'key',
                                timestamp: chunk.timestamp,
                                description: copy(config && config.description),
                            },
                            [bytes.buffer],
                        );
                    },
                    error: function (err: any) {
                        post({ type: 'error', session: session, message: String(err) });
                    },
                });
                e.addEventListener('dequeue', function () {
                    post({ type: 'queue', size: e.encodeQueueSize });
                });
                e.configure(msg.config);
                enc = e;
            } catch (err) {
                post({ type: 'error', session: session, message: String(err) });
            }
        } else if (msg.type === 'frame') {
            const frame = msg.frame;
            try {
                if (!enc || enc.state !== 'configured') {
                    throw new Error('Encoder not configured');
                }
                enc.encode(frame, { keyFrame: msg.key });
                post({ type: 'queue', size: enc.encodeQueueSize });
            } catch (err) {
                post({ type: 'error', session: msg.session, message: String(err) });
            } finally {
                frame.close();
            }
        } else if (msg.type === 'flush') {
            const all = closing.slice();
            if (enc && enc.state === 'configured') {
                all.push(enc.flush().catch(function () {}));
            }
            Promise.all(all).then(function () {
                post({ type: 'flushed', id: msg.id });
            });
        } else if (msg.type === 'close') {
            try {
                if (enc) {
                    enc.close();
                }
            } catch (e) {
                // closed already
            }
            enc = null;
        }
    };
}

class MainBackend implements TBackend {
    readonly kind = 'main' as const;
    private readonly handle: (msg: any) => void;
    private queue = 0;
    private flushId = 0;
    private readonly flushes = new Map<number, () => void>();
    private session = 0;

    constructor(events: TBackendEvents) {
        // posted asynchronously, as from a worker, so callbacks never run inside encode()
        this.handle = encoderHost((msg) => {
            queueMicrotask(() => onMessage(msg));
        });
        const onMessage = (msg: any) => {
            if (msg.type === 'chunk') {
                events.chunk(msg.session, msg.bytes, msg.key, msg.description);
            } else if (msg.type === 'error') {
                events.error(msg.session, msg.message);
            } else if (msg.type === 'queue') {
                this.queue = msg.size;
            } else if (msg.type === 'flushed') {
                this.flushes.get(msg.id)?.();
                this.flushes.delete(msg.id);
            }
        };
    }
    configure(session: number, config: VideoEncoderConfig): void {
        this.session = session;
        this.handle({ type: 'configure', session, config });
    }
    encode(frame: VideoFrame, key: boolean): void {
        this.queue++;
        this.handle({ type: 'frame', session: this.session, frame, key });
    }
    queueSize(): number {
        return this.queue;
    }
    flush(): Promise<void> {
        const id = ++this.flushId;
        return new Promise((resolve) => {
            this.flushes.set(id, resolve);
            this.handle({ type: 'flush', id });
        });
    }
    close(): void {
        this.handle({ type: 'close' });
    }
}

class WorkerBackend implements TBackend {
    readonly kind = 'worker' as const;
    private queue = 0;
    private flushId = 0;
    private readonly flushes = new Map<number, () => void>();
    private session = 0;

    private constructor(
        private readonly worker: Worker,
        events: TBackendEvents & { failed: () => void },
    ) {
        worker.onmessage = ({ data: msg }) => {
            if (msg.type === 'chunk') {
                events.chunk(msg.session, msg.bytes, msg.key, msg.description);
            } else if (msg.type === 'error') {
                events.error(msg.session, msg.message);
            } else if (msg.type === 'queue') {
                this.queue = msg.size;
            } else if (msg.type === 'flushed') {
                this.flushes.get(msg.id)?.();
                this.flushes.delete(msg.id);
            }
        };
        worker.onerror = (e) => {
            e.preventDefault();
            this.flushes.forEach((done) => done());
            this.flushes.clear();
            events.failed();
        };
    }

    // A worker with a VideoEncoder, or null (none, a CSP blocks it, no encoder in workers).
    static async create(
        events: TBackendEvents & { failed: () => void },
    ): Promise<WorkerBackend | null> {
        let worker: Worker;
        try {
            const src = `const encoderHost = ${encoderHost};
if (typeof VideoEncoder === 'undefined') {
    postMessage({ type: 'hello', ok: false });
} else {
    const handle = encoderHost((msg, transfer) => postMessage(msg, transfer || []));
    onmessage = ({ data }) => handle(data);
    postMessage({ type: 'hello', ok: true });
}`;
            const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            worker = new Worker(url);
            URL.revokeObjectURL(url);
        } catch (e) {
            return null;
        }
        const ok = await new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => resolve(false), 3000);
            worker.onmessage = ({ data }) => {
                clearTimeout(timeout);
                resolve(data?.type === 'hello' && data.ok === true);
            };
            worker.onerror = (e) => {
                e.preventDefault();
                clearTimeout(timeout);
                resolve(false);
            };
        });
        if (!ok) {
            worker.terminate();
            return null;
        }
        return new WorkerBackend(worker, events);
    }

    configure(session: number, config: VideoEncoderConfig): void {
        this.session = session;
        this.worker.postMessage({ type: 'configure', session, config });
    }
    encode(frame: VideoFrame, key: boolean): void {
        this.queue++;
        // throws if a VideoFrame can't be transferred: the caller falls back to MainBackend
        this.worker.postMessage({ type: 'frame', session: this.session, frame, key }, [frame]);
    }
    queueSize(): number {
        return this.queue;
    }
    flush(): Promise<void> {
        const id = ++this.flushId;
        return new Promise((resolve) => {
            this.flushes.set(id, resolve);
            this.worker.postMessage({ type: 'flush', id });
        });
    }
    close(): void {
        this.worker.terminate();
        this.flushes.forEach((done) => done());
        this.flushes.clear();
    }
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
    return Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}

async function chooseConfig(
    width: number,
    height: number,
    caps: number[] = [VIDEO_CAP, VIDEO_CAP_FALLBACK],
): Promise<{ config: VideoEncoderConfig; cap: number } | null> {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
        return null;
    }
    for (const cap of caps) {
        const [w, h] = videoSize(width, height, cap);
        for (const codec of CODECS) {
            const config: VideoEncoderConfig = {
                codec,
                width: w,
                height: h,
                bitrate: BITRATE,
                bitrateMode: 'variable',
                framerate: RECORDING_FPS,
                hardwareAcceleration: 'no-preference',
                latencyMode: 'quality',
                avc: { format: 'avc' },
            };
            try {
                if ((await VideoEncoder.isConfigSupported(config)).supported) {
                    return { config, cap };
                }
            } catch (e) {
                // try the next one
            }
        }
    }
    return null;
}

type TSession = {
    id: number;
    config: VideoEncoderConfig;
    frames: number; // sent to the encoder
    continues: TRecordingClip | null; // the clip it extends if the description matches
    clip: TRecordingClip | null; // known once the first chunk is out
    lastTimestamp: number;
};

export type TEmbedRecordingParams = {
    klApp: KlApp;
    canEncode: boolean; // false: only carry a restored recording along
    restored?: TRecordingRestored;
};

export class EmbedRecording {
    private readonly klApp: KlApp;
    private readonly input: EmbedInput;
    readonly clips: TRecordingClip[];
    private state: TRecordingInfo['state'] = 'starting';
    private reason: string | undefined;

    private backend: TBackend | null = null;
    private session: TSession | null = null;
    private lastSessionId = 0;
    private errors = 0;
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private place: TPlacement | null = null; // of the canvas in the current session's frame
    private lastComposed: THistoryEntryDataComposed | null = null; // the picture of the last frame
    private needFull: boolean = true;
    private dirty: boolean = false;
    private steps: number = 0; // changes seen, for thinning
    private timeout: ReturnType<typeof setTimeout> | undefined;
    private grabbing: Promise<void> | undefined;
    private totalBytes: number = 0;
    private cap: number = VIDEO_CAP;

    // stats
    private grabs = 0;
    private grabsBusy = 0;
    private grabsWhileDrawing = 0;
    private readonly grabMs: number[] = [];

    private readonly events: TBackendEvents = {
        chunk: (session, bytes, key, description) => this.onChunk(session, bytes, key, description),
        error: (session, message) => this.onEncoderError(session, message),
    };

    private stop(reason: string, state: 'stopped' | 'unavailable' = 'stopped'): void {
        if (this.state === 'stopped' || this.state === 'unavailable') {
            return;
        }
        this.state = state;
        this.reason = reason;
        clearTimeout(this.timeout);
        this.timeout = undefined;
        if (state === 'stopped') {
            console.warn('Recording stopped:', reason);
        }
        // the encoder may still hold frames: getClips()/the draft flush it first
    }

    private isRecording(): boolean {
        return this.state === 'recording';
    }

    private onHistoryChange(): void {
        if (!this.isRecording()) {
            return;
        }
        this.dirty = true;
        this.schedule();
    }

    private isBusy(): boolean {
        return this.klApp.isDrawing() || this.input.waitMs(QUIET_MS) > 0;
    }

    private schedule(delayMs?: number): void {
        if (this.timeout !== undefined || !this.dirty || !this.isRecording()) {
            return;
        }
        const waitMs =
            delayMs ?? (this.klApp.isDrawing() ? QUIET_MS : this.input.waitMs(QUIET_MS));
        this.timeout = setTimeout(
            () => {
                this.timeout = undefined;
                if (this.isBusy()) {
                    this.grabsBusy++;
                    this.schedule();
                } else {
                    void this.grab(false);
                }
            },
            Math.max(0, waitMs),
        );
    }

    private grab(final: boolean): Promise<void> {
        if (this.grabbing) {
            // one at a time; the change is picked up by the next one
            return this.grabbing.then(() => (this.dirty ? this.grab(final) : undefined));
        }
        this.grabbing = this.doGrab(final)
            .catch((e) => {
                this.stop('grab failed: ' + e);
                console.error(e);
            })
            .finally(() => {
                this.grabbing = undefined;
                this.schedule();
            });
        return this.grabbing;
    }

    private async doGrab(final: boolean): Promise<void> {
        if (!this.isRecording() || !this.backend || !this.session) {
            return;
        }
        if (this.backend.queueSize() > MAX_QUEUE && !final) {
            this.schedule(50); // the encoder is behind: coalesce into a later frame
            return;
        }
        const composed = this.klApp.getKlHistory().getComposed();
        const diff = this.lastComposed ? diffComposed(this.lastComposed, composed) : null;
        if (diff?.kind === 'none' && !this.needFull) {
            this.dirty = false;
            return;
        }
        const stride = thinStride(this.totalBytes);
        if (!final) {
            if (stride === 0) {
                this.dirty = false; // full: only the final frame still goes in
                return;
            }
            this.steps++;
            if (this.steps % stride !== 0) {
                this.dirty = false; // thinned: the next frame shows this step too
                return;
            }
        } else if (this.totalBytes >= BYTES_MUX_CAP) {
            return;
        }

        const { width, height } = composed.size;
        if (diff?.kind === 'resize' || !this.place) {
            await this.fitSession(width, height);
            if (!this.isRecording() || !this.session) {
                return;
            }
        }
        const full = this.needFull || !diff || diff.kind !== 'rect';
        this.dirty = false;
        this.lastComposed = composed;
        this.needFull = false;

        const t0 = performance.now();
        if (this.klApp.isDrawing()) {
            this.grabsWhileDrawing++;
        }
        const session = this.session;
        const vw = session.config.width;
        const vh = session.config.height;
        const place = this.place!;
        const rect = full
            ? { x: 0, y: 0, w: vw, h: vh }
            : videoRect(place, vw, vh, diff as { x0: number; y0: number; x1: number; y1: number });
        if (rect) {
            const ctx = this.ctx;
            ctx.save();
            ctx.beginPath();
            ctx.rect(rect.x, rect.y, rect.w, rect.h);
            ctx.clip();
            ctx.fillStyle = '#fff';
            ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
            ctx.translate(place.ox, place.oy);
            drawProjectTo(ctx, this.klApp.getProject(), place.w, place.h);
            ctx.restore();
        }
        const timestamp = session.frames * FRAME_US;
        const frame = new VideoFrame(this.canvas, { timestamp, duration: FRAME_US });
        const key = session.frames % KEY_EVERY === 0;
        session.frames++;
        try {
            this.backend.encode(frame, key, timestamp);
        } catch (e) {
            frame.close();
            // a worker that can't take VideoFrames: encode here instead, from a keyframe
            if (this.backend.kind === 'worker') {
                this.backend.close();
                this.backend = new MainBackend(this.events);
                this.startSession(this.session.config, this.session.clip ?? this.session.continues);
                this.dirty = true;
                return;
            }
            throw e;
        }
        const ms = performance.now() - t0;
        this.grabs++;
        this.grabMs.push(ms);
        if (this.grabMs.length > 2000) {
            this.grabMs.splice(0, 1000);
        }
    }

    // Makes the session's frame fit a canvas of this size: a new clip (and encoder) if the size
    // differs, or, past MAX_CLIPS, the picture fitted into the current clip's frame.
    private async fitSession(width: number, height: number): Promise<void> {
        const session = this.session!;
        const [vw, vh] = videoSize(width, height, this.cap);
        if (session.config.width === vw && session.config.height === vh) {
            this.setPlacement(width, height, true);
            return;
        }
        if (this.clips.length >= MAX_CLIPS || !this.clipsCanGrow()) {
            this.setPlacement(width, height, false);
            return;
        }
        const chosen = await chooseConfig(width, height, [this.cap]);
        if (!chosen) {
            this.setPlacement(width, height, false);
            return;
        }
        this.startSession(chosen.config, this.clips.at(-1) ?? null);
        this.setPlacement(width, height, true);
    }

    private clipsCanGrow(): boolean {
        // a new clip starts with a keyframe: leave it room
        return this.totalBytes < BYTES_MUX_CAP - 512 * 1024;
    }

    private setPlacement(width: number, height: number, fill: boolean): void {
        const { width: vw, height: vh } = this.session!.config;
        const p = placement(width, height, vw, vh, fill);
        const old = this.place;
        this.place = p;
        if (!old || old.sx !== p.sx || old.sy !== p.sy || old.ox !== p.ox || old.oy !== p.oy) {
            this.needFull = true;
        }
    }

    private startSession(config: VideoEncoderConfig, continues: TRecordingClip | null): void {
        const id = ++this.lastSessionId;
        this.session = { id, config, frames: 0, continues, clip: null, lastTimestamp: -1 };
        if (this.canvas.width !== config.width || this.canvas.height !== config.height) {
            this.canvas.width = config.width;
            this.canvas.height = config.height;
        }
        this.needFull = true;
        this.backend!.configure(id, config);
    }

    private onChunk(
        sessionId: number,
        bytes: Uint8Array,
        key: boolean,
        description?: Uint8Array,
    ): void {
        const session = this.session && this.session.id === sessionId ? this.session : null;
        let clip: TRecordingClip | null;
        if (session) {
            clip = session.clip;
        } else {
            // an earlier session's last frames: its clip is the last one with that size
            clip = this.sessionClips.get(sessionId) ?? null;
        }
        if (!clip) {
            if (!session || !key) {
                return; // nothing to attach it to (an encoder that failed before its first frame)
            }
            const c = session.continues;
            if (
                c &&
                c === this.clips.at(-1) &&
                c.codec === session.config.codec &&
                c.width === session.config.width &&
                c.height === session.config.height &&
                (sameBytes(c.description, description) || (!description && c.description))
            ) {
                clip = c;
            } else if (description && this.clips.length < MAX_CLIPS) {
                clip = {
                    codec: session.config.codec,
                    description,
                    width: session.config.width,
                    height: session.config.height,
                    chunks: [],
                    savedChunks: 0,
                    pieces: [],
                };
                this.clips.push(clip);
            } else {
                this.stop(description ? 'too many clips' : 'encoder gave no description');
                return;
            }
            session.clip = clip;
            this.sessionClips.set(sessionId, clip);
        }
        if (clip.chunks.length === 0 && !key) {
            return;
        }
        clip.chunks.push({ bytes, key });
        this.totalBytes += bytes.length;
    }
    private readonly sessionClips = new Map<number, TRecordingClip>();

    private onEncoderError(sessionId: number, message: string): void {
        console.warn('Recording encoder error:', message);
        if (!this.session || sessionId !== this.session.id || !this.isRecording()) {
            return;
        }
        this.errors++;
        if (this.errors >= 2) {
            this.stop('encoder error: ' + message);
            return;
        }
        // one new encoder, from a keyframe
        this.startSession(this.session.config, this.session.clip ?? this.session.continues);
        this.dirty = true;
        this.schedule();
    }

    private async start(): Promise<void> {
        const { width, height } = this.klApp.getKlHistory().getComposed().size;
        const chosen = await chooseConfig(width, height);
        if (!chosen) {
            this.stop('no H.264 encoder', 'unavailable');
            return;
        }
        const config = chosen.config;
        this.cap = chosen.cap;
        this.backend =
            (await WorkerBackend.create({
                ...this.events,
                failed: () => {
                    // the worker died: carry on here, from a keyframe
                    if (this.backend?.kind === 'worker' && this.session) {
                        this.backend = new MainBackend(this.events);
                        this.startSession(
                            this.session.config,
                            this.session.clip ?? this.session.continues,
                        );
                        this.dirty = true;
                        this.schedule();
                    }
                },
            })) ?? new MainBackend(this.events);
        if (this.state !== 'starting') {
            this.backend.close();
            return;
        }
        this.state = 'recording';
        const last = this.clips.at(-1) ?? null;
        this.startSession(config, last);
        this.setPlacement(width, height, true);
        this.lastComposed = this.klApp.getKlHistory().getComposed();
        if (last) {
            // A resumed draft: the recording already ends on this picture. The next change
            // starts the new encoder's keyframe.
            this.needFull = true;
        } else {
            // a new recording starts on the picture as it opened (blank, or the version that
            // "Draw more" continues)
            this.dirty = true;
            this.needFull = true;
            this.schedule(0);
        }
    }

    // ----------------------------------- public -----------------------------------
    constructor(p: TEmbedRecordingParams) {
        this.klApp = p.klApp;
        this.input = getEmbedInput();
        this.clips = p.restored?.clips ?? [];
        this.clips.forEach((c) => c.chunks.forEach((ch) => (this.totalBytes += ch.bytes.length)));
        this.canvas = document.createElement('canvas');
        this.canvas.width = 2;
        this.canvas.height = 2;
        // software-backed: redrawing a small rectangle stays cheap (docs, 1.5)
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false })!;
        this.klApp.getKlHistory().addListener(() => {
            try {
                this.onHistoryChange();
            } catch (e) {
                this.stop('' + e);
            }
        });
        if (!p.canEncode) {
            this.stop('not enabled', 'unavailable');
            return;
        }
        this.start().catch((e) => {
            this.stop('start failed: ' + e, 'unavailable');
        });
    }

    /**
     * Before a draft save: the frame for the picture being saved (if it changed and the
     * recorder is due one), and every frame the encoder holds. Then which chunks are new.
     */
    async prepareSave(urgent: boolean, fresh: boolean): Promise<TRecordingSavePart[]> {
        try {
            if (this.isRecording() && this.backend) {
                if (this.dirty || this.timeout !== undefined) {
                    clearTimeout(this.timeout);
                    this.timeout = undefined;
                    await this.grab(urgent);
                }
                await withTimeout(this.backend.flush(), FLUSH_TIMEOUT_MS);
            }
        } catch (e) {
            console.error(e);
        }
        return this.clips
            .filter((clip) => clip.chunks.length > 0)
            .map((clip) => ({ clip, from: fresh ? 0 : clip.savedChunks, to: clip.chunks.length }));
    }

    // The draft holds these now, in these pieces.
    committed(parts: { clip: TRecordingClip; to: number; pieces: number[] }[]): void {
        for (const { clip, to, pieces } of parts) {
            clip.savedChunks = to;
            clip.pieces = pieces;
        }
    }

    /**
     * At submit: the last frame (if the picture changed since), then each clip as an MP4.
     * Empty when there's no recording. A clip that won't mux is left out.
     */
    async getClips(): Promise<Blob[]> {
        if (this.isRecording() && this.backend) {
            try {
                const endMs = performance.now() + 500;
                while (this.klApp.isDrawing() && performance.now() < endMs) {
                    await new Promise((resolve) => setTimeout(resolve, 16));
                }
                // history listeners run in a timeout
                await new Promise((resolve) => setTimeout(resolve));
                clearTimeout(this.timeout);
                this.timeout = undefined;
                this.dirty = true;
                await this.grab(true);
                await withTimeout(this.backend.flush(), FLUSH_TIMEOUT_MS);
            } catch (e) {
                console.error('Recording: last frame failed', e);
            }
        }
        const clips = this.clips.filter((c) => c.chunks.length > 0);
        if (!clips.length) {
            return [];
        }
        const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
        const out: Blob[] = [];
        let budget = BYTES_MUX_CAP;
        for (const clip of clips) {
            if (budget <= 0) {
                break;
            }
            try {
                const target = new ArrayBufferTarget();
                const muxer = new Muxer({
                    target,
                    video: {
                        codec: 'avc',
                        width: clip.width,
                        height: clip.height,
                        frameRate: RECORDING_FPS,
                    },
                    fastStart: 'in-memory',
                });
                let n = 0;
                for (const chunk of clip.chunks) {
                    if (chunk.bytes.length > budget) {
                        budget = 0; // truncated at the cap
                        break;
                    }
                    budget -= chunk.bytes.length;
                    muxer.addVideoChunkRaw(
                        chunk.bytes,
                        chunk.key ? 'key' : 'delta',
                        n * FRAME_US,
                        FRAME_US,
                        n === 0
                            ? {
                                  decoderConfig: {
                                      codec: clip.codec,
                                      codedWidth: clip.width,
                                      codedHeight: clip.height,
                                      description: clip.description,
                                  },
                              }
                            : undefined,
                    );
                    n++;
                }
                if (!n) {
                    continue;
                }
                muxer.finalize();
                if (target.buffer.byteLength <= BYTES_CAP) {
                    out.push(new Blob([target.buffer], { type: 'video/mp4' }));
                }
            } catch (e) {
                console.error('Recording: a clip would not mux', e);
            }
        }
        return out;
    }

    getInfo(): TRecordingInfo {
        const sorted = [...this.grabMs].sort((a, b) => a - b);
        const n = sorted.length;
        const round = (v: number) => Math.round(v * 100) / 100;
        return {
            state: this.state,
            ...(this.reason ? { reason: this.reason } : {}),
            ...(this.session
                ? {
                      codec: this.session.config.codec,
                      width: this.session.config.width,
                      height: this.session.config.height,
                  }
                : {}),
            ...(this.backend ? { backend: this.backend.kind } : {}),
            clips: this.clips.map((c) => ({
                width: c.width,
                height: c.height,
                frames: c.chunks.length,
                keys: c.chunks.filter((ch) => ch.key).length,
                bytes: c.chunks.reduce((a, ch) => a + ch.bytes.length, 0),
            })),
            bytes: this.totalBytes,
            grabs: this.grabs,
            grabsBusy: this.grabsBusy,
            grabsWhileDrawing: this.grabsWhileDrawing,
            grabMs: {
                n,
                mean: n ? round(sorted.reduce((a, b) => a + b, 0) / n) : 0,
                p95: n ? round(sorted[Math.min(n - 1, Math.floor(n * 0.95))]) : 0,
                max: n ? round(sorted[n - 1]) : 0,
            },
        };
    }
}
