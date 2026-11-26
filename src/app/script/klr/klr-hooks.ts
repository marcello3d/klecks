/**
 * Where the app tells the .klr recorder what it does. Every call passes through when no
 * recorder is installed (upstream behaviour), so the hook sites in kl-app.ts, edit-ui.ts and
 * kl-app-select.ts stay one-liners.
 *
 * An op is logged before it runs and runs at depth > 0: KlCanvas calls and history pushes it
 * makes are part of it and are not logged again. A history push at depth 0 has no opcode and
 * goes to the catch-all (klr-recorder.ts).
 */
import { KlrUnencodable, TKlrOpInput } from './klr-format';
import { klRandomSeed } from '../klecks/utils/kl-random';
import type { TDrawEvent } from '../klecks/kl-types';

export type TKlrHookTarget = {
    /** logs the op (if it encodes) and runs fn as part of it */
    op<T>(build: () => TKlrOpInput, fn: () => T): T;
    /** a chain-out draw event: quantized, logged; fn draws it */
    chainOut(e: TDrawEvent, fn: (e: TDrawEvent) => void): void;
    /** the easel's per-frame brush flush */
    transfer(fn: () => void): void;
    /** next seed for a stroke or filter */
    nextSeed(): number;
    /** ids for selection samples and clipboard images */
    nextId(): number;
};

export const klrHooks: { rec?: TKlrHookTarget } = {};

export function klrOp<T>(build: () => TKlrOpInput, fn: () => T): T {
    return klrHooks.rec ? klrHooks.rec.op(build, fn) : fn();
}

export function klrChainOut(e: TDrawEvent, fn: (e: TDrawEvent) => void): void {
    if (klrHooks.rec) {
        klrHooks.rec.chainOut(e, fn);
    } else {
        fn(e);
    }
}

export function klrTransfer(fn: () => void): void {
    if (klrHooks.rec) {
        klrHooks.rec.transfer(fn);
    } else {
        fn();
    }
}

/** A filter applied to a layer, logged with its input and a seed. */
export function klrFilter<T>(name: string, layerIndex: number, input: unknown, fn: () => T): T {
    const rec = klrHooks.rec;
    if (!rec) {
        return fn();
    }
    const seed = rec.nextSeed();
    return rec.op(
        () => ({ op: 'filter', name, layer: layerIndex, seed, input: input as any }),
        () => {
            klRandomSeed(seed);
            return fn();
        },
    );
}

export function klrNextId(): number {
    return klrHooks.rec ? klrHooks.rec.nextId() : 0;
}

// selection samples taken while recording, by the id their SAMPLE op has
const sampleIds = new WeakMap<object, number>();

/** createSelectionSample (select tool, entering transform), logged so the player takes it too */
export function klrSample<T extends object | undefined>(
    layerIndex: number,
    create: () => T,
): T {
    const rec = klrHooks.rec;
    if (!rec) {
        return create();
    }
    const id = rec.nextId();
    const sample = rec.op(() => ({ op: 'sample', id, layer: layerIndex }), create);
    if (sample) {
        sampleIds.set(sample, id);
    }
    return sample;
}

/** klCanvasTransform / klCanvasFfd from the select tool: the parameters, the sample by id */
export function klrTransform<P extends { selectionSample: object }>(
    kind: 'xform' | 'ffd',
    p: P,
    fn: (p: P) => void,
): void {
    const rec = klrHooks.rec;
    if (!rec) {
        fn(p);
        return;
    }
    const sample = sampleIds.get(p.selectionSample);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { klCanvas, selectionSample, ffdRenderer, ...params } = p as any;
    rec.op(
        () => {
            if (sample === undefined) {
                throw new KlrUnencodable('selection sample taken before recording');
            }
            return { op: kind, sample, params };
        },
        () => fn(p),
    );
}
