import { BB } from '../../bb/bb';
import { LayerCompositor } from './layer-compositor';
import { isLayerFill, TKlProject } from '../kl-types';
import { MultiPolygon } from 'polygon-clipping';
import { transformMultiPolygon } from '../../bb/multi-polygon/transform-multi-polygon';
import { scale } from 'transformation-matrix';
import { getSelectionPath2d } from '../../bb/multi-polygon/get-selection-path-2d';

export function drawProject(
    project: TKlProject,
    factor: number = 1,
    selection?: MultiPolygon,
): HTMLCanvasElement {
    const canvas = BB.canvas(
        Math.max(1, Math.round(project.width * factor)),
        Math.max(1, Math.round(project.height * factor)),
    );
    const transformedSelection = selection
        ? transformMultiPolygon(
              selection,
              scale(canvas.width / project.width, canvas.height / project.height),
          )
        : undefined;
    const ctx = BB.ctx(canvas);
    ctx.save();
    if (transformedSelection) {
        ctx.clip(getSelectionPath2d(transformedSelection));
    }
    if (factor > 1) {
        ctx.imageSmoothingEnabled = false;
    }
    try {
        drawProjectTo(ctx, project, canvas.width, canvas.height);
    } finally {
        ctx.restore();
    }
    return canvas;
}

/**
 * Draws the project's layers, scaled to width × height, at the origin of targetCtx (its
 * transform and clip apply). The recorder (embed/embed-recording.ts) draws a changed
 * rectangle with it into its own canvas.
 */
export function drawProjectTo(
    targetCtx: CanvasRenderingContext2D,
    project: TKlProject,
    width: number,
    height: number,
): void {
    const compositor = new LayerCompositor();
    try {
        compositor.draw(targetCtx, project.layers, width, height, (layerCtx, layer) => {
            if (isLayerFill(layer.image)) {
                layerCtx.fillStyle = layer.image.fill;
                layerCtx.fillRect(0, 0, width, height);
            } else if (layer.image instanceof Array) {
                throw new Error('not implemented');
            } else {
                layerCtx.drawImage(layer.image, 0, 0, width, height);
            }
        });
    } finally {
        compositor.destroy();
    }
}
