/**
 * Context settings for layer canvases (default: the browser's). See softwareCanvases().
 */
export const LAYER_CONTEXT: { settings?: CanvasRenderingContext2DSettings } = {};
export function layerContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const ctx = canvas.getContext('2d', LAYER_CONTEXT.settings);
    if (!ctx) {
        throw new Error("couldn't get 2d context");
    }
    return ctx;
}

let isSoftware = false;

/**
 * A 2D context with the browser's own settings (GPU where it likes), also after
 * softwareCanvases(): for a canvas that is only shown on screen, such as the easel's viewport.
 * Nothing may read its pixels back or draw it into a layer, a history tile, a thumbnail or an
 * export, since a GPU canvas draws and reads back differently and a .klr replay would drift.
 */
export function displayContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    // softwareCanvases()'s getContext puts the caller's options last, so this wins over it
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) {
        throw new Error("couldn't get 2d context");
    }
    return ctx;
}

/**
 * 2draw's .klr recording: every 2D canvas from here on is a software one (willReadFrequently).
 * Chrome otherwise starts a canvas on the GPU and moves it off after enough readbacks, at
 * moments that differ between the live app (frames, timers) and a replay (one task), and GPU
 * and software canvases draw and read back differently, so a replay drifts. The live app and
 * the player both call this before making canvases. Klecks reads its layers back after every
 * stroke, so they end up in software anyway. A canvas only shown on screen opts out with
 * displayContext().
 */
export function softwareCanvases(): void {
    if (isSoftware || typeof HTMLCanvasElement === 'undefined') {
        return;
    }
    isSoftware = true;
    LAYER_CONTEXT.settings = { willReadFrequently: true };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        options?: any,
    ) {
        if (type === '2d') {
            options = { willReadFrequently: true, ...options };
        }
        return getContext.call(this, type, options);
    } as typeof getContext;
}
