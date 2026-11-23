/**
 * Save — everything the game remembers between visits, in localStorage: progress, medals,
 * daily-planet bests, options, and ghost runs.
 *
 * Purpose
 *   One typed place for persistence, so no other module touches localStorage keys directly
 *   (audio's mute flag excepted, which predates it).
 *
 * Operations
 *   - save: the loaded SaveData (cleared = highest planet completed, stars per planet, best score,
 *     daily bests by date, seenHowto, options). persist() writes it back as JSON ('tf-save').
 *   - recordResult(result): updates cleared, best stars for that planet; returns true for a new best.
 *   - Options: music / sfx volume, quality tier override, stick thrust threshold, left-handed touch
 *     layout, colour-blind markers, hints, ghost, and the three assists.
 *   - Ghosts: a ghost is the ship's (x, y, angle) sampled every GHOST_DT seconds of planet time
 *     on the fastest completion. saveGhost / loadGhost store one per planet ('tf-ghost-<n>') as
 *     base64 Int16 triples (x, y × 50, angle × 1000), about 5 kB for a 90 s run.
 *   - todaySeed(): yyyymmdd as a number, the daily planet's layout seed.
 *   - ghostPose interpolates the angle the short way round, so a ghost never spins when its
 *     recorded heading crosses ±180°.
 *   - Headless (no window, e.g. scripts/check.ts): load() returns defaults without touching
 *     storage.
 *
 * Usage
 *   main.ts reads save.options at boot, calls recordResult() on each completed planet,
 *   saveGhost() when a run beats the stored one, persist() after changes.
 *
 * Highlights
 *   - Defensive load: missing or corrupt JSON falls back to defaults, merged field by field, so
 *     adding an option never breaks an old save.
 *   - Storage can be unavailable (private mode, quota): every write is try/caught; the game
 *     just doesn't remember.
 *
 * See also: main.ts, ui/menu.ts (planet select, options); DESIGN.md "12. UI".
 */
import type { Assist, Result } from "./game";

export interface Options {
    music: number;
    sfx: number;
    tier: "auto" | "high" | "mobile-high" | "mid" | "low";
    stickThrust: number; // stick push that also thrusts, 0.6..0.95
    lefty: boolean; // touch: stick on the right, buttons on the left
    colourBlind: boolean; // minimap markers in a colour-blind-safe set
    hints: boolean;
    ghost: boolean;
    assist: Assist;
}

export interface SaveData {
    cleared: number;
    stars: Record<number, number>;
    best: number;
    daily: Record<string, number>;
    seenHowto: boolean;
    options: Options;
}

export const GHOST_DT = 0.1;

const DEFAULTS: SaveData = {
    cleared: 0,
    stars: {},
    best: 0,
    daily: {},
    seenHowto: false,
    options: {
        music: 0.5,
        sfx: 1,
        tier: "auto",
        stickThrust: 0.75,
        lefty: false,
        colourBlind: false,
        hints: true,
        ghost: true,
        assist: { slow: false, autoLevel: false, freeShield: false },
    },
};

/** The loaded save (function declarations hoist, so load() is defined below). */
export const save: SaveData = load();

function load(): SaveData {
    // Headless (scripts/check.ts under Node): no browser storage, so start from defaults.
    if (typeof window === "undefined") return structuredClone(DEFAULTS);
    try {
        const raw = JSON.parse(localStorage.getItem("tf-save") ?? "{}");
        const legacyBest = Number(localStorage.getItem("tf-best") ?? 0);
        return {
            ...DEFAULTS,
            ...raw,
            best: Math.max(raw.best ?? 0, legacyBest),
            options: {
                ...DEFAULTS.options,
                ...raw.options,
                assist: { ...DEFAULTS.options.assist, ...raw.options?.assist },
            },
        };
    } catch {
        return structuredClone(DEFAULTS);
    }
}

export function persist() {
    try {
        localStorage.setItem("tf-save", JSON.stringify(save));
    } catch {
        /* storage unavailable: play on without remembering */
    }
}

/** Record a completed planet; returns true when it beats the stored stars. */
export function recordResult(r: Result): boolean {
    save.cleared = Math.max(save.cleared, r.n);
    const better = r.stars > (save.stars[r.n] ?? -1);
    if (better) save.stars[r.n] = r.stars;
    persist();
    return better;
}

export function todaySeed(d = new Date()) {
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// ---- Ghosts -----------------------------------------------------------------------------------

export interface Ghost {
    time: number; // completion time it was recorded on
    samples: Int16Array; // x*50, y*50, a*1000 triples every GHOST_DT
}

export function saveGhost(n: number, time: number, samples: number[]) {
    const q = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) q[i] = Math.round(samples[i] * (i % 3 === 2 ? 1000 : 50));
    let bin = "";
    const bytes = new Uint8Array(q.buffer);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    try {
        localStorage.setItem(`tf-ghost-${n}`, JSON.stringify({ time, data: btoa(bin) }));
    } catch {
        /* quota: keep the old ghost */
    }
}

export function loadGhost(n: number): Ghost | null {
    try {
        const raw = localStorage.getItem(`tf-ghost-${n}`);
        if (!raw) return null;
        const { time, data } = JSON.parse(raw);
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { time, samples: new Int16Array(bytes.buffer) };
    } catch {
        return null;
    }
}

/** Ghost pose at planet time t (linear interpolation), or null past its end. */
export function ghostPose(g: Ghost, t: number): { x: number; y: number; a: number } | null {
    const f = t / GHOST_DT;
    const i = Math.floor(f);
    const n = g.samples.length / 3;
    if (i >= n - 1) return null;
    const k = f - i,
        s = g.samples;
    const at = (j: number, c: number) => s[j * 3 + c] / (c === 2 ? 1000 : 50);
    return {
        x: at(i, 0) + (at(i + 1, 0) - at(i, 0)) * k,
        y: at(i, 1) + (at(i + 1, 1) - at(i, 1)) * k,
        a: at(i, 2) + Math.atan2(Math.sin(at(i + 1, 2) - at(i, 2)), Math.cos(at(i + 1, 2) - at(i, 2))) * k,
    };
}
