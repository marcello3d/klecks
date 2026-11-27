/**
 * The brushes' random numbers (pen scatter, blend and smudge dithering, chemy distort), seeded
 * so an input recording (.klr) replays them exactly: the recorder reseeds before each stroke
 * and filter, and stores the seed. Without a recorder it is just another uniform PRNG.
 * mulberry32 (public domain, Tommy Ettinger).
 */
let state = (Math.random() * 4294967296) >>> 0;

export function klRandom(): number {
    let t = (state = (state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function klRandomSeed(seed: number): void {
    state = Math.imul(seed >>> 0, 0x9e3779b1) | 0;
}

// 2draw: the .klr player draws a stroke over several frames (KlrPlayer.strokeTo); another player
// on the page may use klRandom in between, so a stroke under way keeps its own state
export function klRandomGetState(): number {
    return state;
}

export function klRandomSetState(s: number): void {
    state = s | 0;
}
