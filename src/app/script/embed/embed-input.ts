/**
 * When the artist last gave input: pressed pointer moves, pointer down/up, wheel, keys. A
 * hovering pen or mouse doesn't count. Shared by the draft (EmbedDraft) and the recording
 * (EmbedRecording), so both wait for the same quiet gap with one set of listeners.
 */
export class EmbedInput {
    lastInputMs: number = 0;

    private readonly onInput = (e: Event): void => {
        if (e.type !== 'pointermove' || (e as PointerEvent).buttons) {
            this.lastInputMs = performance.now();
        }
    };

    constructor() {
        ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown'].forEach((type) => {
            window.addEventListener(type, this.onInput, { capture: true, passive: true });
        });
    }

    // ms until `quietMs` have passed without input (0 or less: quiet now)
    waitMs(quietMs: number): number {
        return this.lastInputMs + quietMs - performance.now();
    }
}

let shared: EmbedInput | undefined;
export function getEmbedInput(): EmbedInput {
    return (shared ??= new EmbedInput());
}
