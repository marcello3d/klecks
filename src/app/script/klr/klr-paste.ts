import { KlCanvas } from '../klecks/canvas/kl-canvas';
import { drawTransformedImageWithBounds } from '../bb/base/canvas';

export type TKlrPasteParams = {
    name?: string; // default: the next 'Layer n'
    transform: { x: number; y: number; width: number; height: number; angleDeg: number };
    isPixelated?: boolean;
};

/**
 * An image as a new layer on top (or drawn onto the top layer at the layer limit), as
 * "import as layer" does (kl-app-import-handler.ts). Live in-app paste and the .klr player
 * both run this. Returns the index of the layer it went to.
 */
export function pasteAsLayer(
    klCanvas: KlCanvas,
    image: HTMLCanvasElement | HTMLImageElement,
    p: TKlrPasteParams,
): number {
    const operation = (ctx: CanvasRenderingContext2D) => {
        drawTransformedImageWithBounds(ctx, image, p.transform, undefined, p.isPixelated);
    };
    if (
        !klCanvas.addLayer(undefined, {
            name: p.name,
            mixModeStr: 'source-over',
            isVisible: true,
            opacity: 1,
            image: operation,
        })
    ) {
        klCanvas.drawOperation(klCanvas.getLayers().length - 1, operation);
    }
    return klCanvas.getLayers().length - 1;
}
