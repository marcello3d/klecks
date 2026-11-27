import { BB } from '../../../bb/bb';
import { LayerCompositor } from '../../canvas/layer-compositor';
import { TKlBasicLayer } from '../../kl-types';
import { css } from '../../../bb/base/base';
import { displayContext } from '../../canvas/layer-context';
import { MAX_RES_FACTOR } from './project-viewport';

/**
 * preview of image with layers. can do mix modes and opacity.
 * creates a canvas.
 */
export class KlCanvasPreview {
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D | null;
    private readonly compositor = new LayerCompositor();
    private layers: TKlBasicLayer[];

    // ----------------------------------- public -----------------------------------
    constructor(p: { width: number; height: number; layers: TKlBasicLayer[] }) {
        this.layers = p.layers;

        // device pixels (2draw), as ProjectViewport's useNativeResolution
        const res = Math.min(devicePixelRatio || 1, MAX_RES_FACTOR);
        const scale = (p.width * res) / p.layers[0].image.width;
        const width = scale > 1 ? p.layers[0].image.width : Math.round(p.width * res);
        const height = scale > 1 ? p.layers[0].image.height : Math.round(p.height * res);

        this.canvas = BB.canvas(width, height);
        // only shown: a display canvas, see displayContext()
        this.ctx = displayContext(this.canvas);

        css(this.canvas, {
            width: '100%',
            height: '100%',
            imageRendering: scale > 1 ? 'pixelated' : undefined,
            background: 'var(--kl-checkerboard-background)',
            backgroundSize: 16,
        });

        setTimeout(() => this.render(), 0);
    }

    getElement(): HTMLCanvasElement {
        return this.canvas;
    }

    setLayers(layers: TKlBasicLayer[]): void {
        this.layers = layers;
        this.render();
    }

    render(): void {
        if (!this.ctx) {
            return;
        }
        const ctx = this.ctx;

        ctx.save();
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.compositor.draw(
            ctx,
            this.layers,
            this.canvas.width,
            this.canvas.height,
            (target, layer) => {
                if (this.canvas.width > layer.image.width) {
                    target.imageSmoothingEnabled = false;
                }
                target.drawImage(layer.image, 0, 0, this.canvas.width, this.canvas.height);
            },
        );
        ctx.restore();
    }

    destroy(): void {
        BB.freeCanvas(this.canvas);
        this.compositor.destroy();
    }
}
