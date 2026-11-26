/**
 * What the .klr recorder reads from a brush and the player gives back, and how a stroke
 * reaches each brush (the same calls the brush UIs make, brushes-ui/*.ts). Shared by
 * klr-recorder.ts and klr-player.ts.
 */
import { BRUSHES } from '../klecks/brushes/brushes';
import { KlHistory } from '../klecks/history/kl-history';
import { TKlCanvasLayer } from '../klecks/canvas/kl-canvas';
import { TKlrBrushId, TKlrValue } from './klr-format';

// [field, setter]: restored by assigning the field, or, where the brush derives state from it
// (pen's alpha canvas, colour strings), by its setter. Not by setters in general: some
// transform the value (sketchy's setSize doubles it). Append only; a removed field stays
// readable by being ignored.
type TField = [string, string?];
export const BRUSH_FIELDS: Record<TKlrBrushId, TField[]> = {
    penBrush: [
        ['settingSize'],
        ['settingSpacing'],
        ['settingOpacity'],
        ['settingScatter'],
        ['settingColor', 'setColor'],
        ['settingAlphaId', 'setAlpha'],
        ['settingLockLayerAlpha'],
        ['settingHasSizePressure'],
        ['settingHasOpacityPressure'],
        ['settingHasScatterPressure'],
    ],
    blendBrush: [
        ['size'],
        ['opacity'],
        ['blending'],
        ['color'],
        ['settingLockLayerAlpha'],
        ['settingSizePressure'],
        ['settingOpacityPressure'],
    ],
    sketchyBrush: [
        ['settingSize'],
        ['settingOpacity'],
        ['settingBlending'],
        ['settingScale'],
        ['settingColor'],
        // advances with every segment and lives across strokes
        ['sketchySeed'],
    ],
    pixelBrush: [
        ['settingSize'],
        ['settingSpacing'],
        ['settingOpacity'],
        ['settingColor', 'setColor'],
        ['settingLockLayerAlpha'],
        ['settingIsEraser'],
        ['settingHasSizePressure'],
        ['settingPattern'],
        ['settingTip'],
    ],
    chemyBrush: [
        ['settingSize'],
        ['settingOpacity'],
        ['settingColor'],
        ['settingLockLayerAlpha'],
        ['settingIsEraser'],
        ['settingMode'],
        ['settingDistort'],
        ['settingXSymmetry'],
        ['settingYSymmetry'],
        ['settingGradient'],
    ],
    smudgeBrush: [
        ['settingSize'],
        ['settingSpacing'],
        ['settingOpacity'],
        ['settingColor'],
        ['settingLockLayerAlpha'],
        ['settingHasSizePressure'],
        ['settingHasOpacityPressure'],
    ],
    eraserBrush: [
        ['size'],
        ['spacing'],
        ['opacity'],
        ['useSizePressure'],
        ['useOpacityPressure'],
        ['isTransparentBG'],
    ],
};

export type TKlrBrush = any; // the brush classes share no interface

const BRUSH_CLASSES: Record<TKlrBrushId, new () => TKlrBrush> = {
    penBrush: BRUSHES.PenBrush,
    blendBrush: BRUSHES.BlendBrush,
    sketchyBrush: BRUSHES.SketchyBrush,
    pixelBrush: BRUSHES.PixelBrush,
    chemyBrush: BRUSHES.ChemyBrush,
    smudgeBrush: BRUSHES.SmudgeBrush,
    eraserBrush: BRUSHES.EraserBrush,
};

export function createBrush(id: TKlrBrushId, klHistory: KlHistory): TKlrBrush {
    const brush = new BRUSH_CLASSES[id]();
    brush.setHistory(klHistory);
    return brush;
}

// plain copy: colours are BB.RGB instances, patterns objects with arrays
function copyValue(v: unknown): TKlrValue {
    if (v === null || typeof v !== 'object') {
        return v as TKlrValue;
    }
    if (Array.isArray(v)) {
        return v.map(copyValue);
    }
    const out: Record<string, TKlrValue> = {};
    for (const key of Object.keys(v)) {
        out[key] = copyValue((v as any)[key]);
    }
    return out;
}

export function readBrushSettings(id: TKlrBrushId, brush: TKlrBrush): Record<string, TKlrValue> {
    const out: Record<string, TKlrValue> = {};
    for (const [field] of BRUSH_FIELDS[id]) {
        out[field] = copyValue(brush[field]);
    }
    return out;
}

/** The fields of `now` that differ from `before` (all of them without `before`). */
export function diffBrushSettings(
    before: Record<string, TKlrValue> | undefined,
    now: Record<string, TKlrValue>,
): Record<string, TKlrValue> {
    if (!before) {
        return now;
    }
    const out: Record<string, TKlrValue> = {};
    for (const key of Object.keys(now)) {
        if (JSON.stringify(before[key]) !== JSON.stringify(now[key])) {
            out[key] = now[key];
        }
    }
    return out;
}

export function applyBrushSettings(
    id: TKlrBrushId,
    brush: TKlrBrush,
    settings: Record<string, TKlrValue>,
): void {
    for (const [field, setter] of BRUSH_FIELDS[id]) {
        if (!(field in settings)) {
            continue;
        }
        const value = copyValue(settings[field]);
        if (setter && typeof brush[setter] === 'function') {
            brush[setter](value);
        } else {
            brush[field] = value;
        }
    }
}

// what the brush UI's setLayer does
export function bindBrushLayer(id: TKlrBrushId, brush: TKlrBrush, layer: TKlCanvasLayer): void {
    if (id === 'eraserBrush') {
        brush.setLayer(layer);
    } else if (id === 'blendBrush') {
        brush.setContext(layer.context, layer.id);
    } else {
        brush.setContext(layer.context);
    }
}

// what the brush UI's startLine / goLine / endLine do
export function brushDown(id: TKlrBrushId, brush: TKlrBrush, x: number, y: number, p: number): void {
    if (id === 'chemyBrush') {
        brush.startLine(x, y);
    } else {
        brush.startLine(x, y, p);
    }
}

export function brushMove(id: TKlrBrushId, brush: TKlrBrush, x: number, y: number, p: number): void {
    if (id === 'chemyBrush') {
        brush.goLine(x, y);
    } else if (id === 'blendBrush') {
        brush.goLine(x, y, p, false);
    } else if (id === 'sketchyBrush') {
        brush.goLine(x, y, p, undefined);
    } else {
        brush.goLine(x, y, p);
    }
}

export function brushUp(_id: TKlrBrushId, brush: TKlrBrush): void {
    brush.endLine();
}
