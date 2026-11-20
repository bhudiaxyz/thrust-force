/**
 * Level — seeded cave generator and grid queries for one planet.
 *
 * Purpose
 *   Turns a level number into a playable planet: a W x H occupancy grid (1 = rock, 0 = air,
 *   1 cell = 1 world unit, row 0 at the bottom, y up) with open sky at the top, a hilly surface,
 *   a zig-zag shaft winding down to a flat-floored chamber, and the fixtures placed in it (pod,
 *   reactor, turrets, fuel cells, start point). Also answers the two spatial questions the game
 *   asks of rock: "is this point solid?" and "can A see B?".
 *
 * Operations
 *   - rng(seed): mulberry32 PRNG; every random choice in generation comes from it.
 *   - generateLevel(n): fill with rock → carve the surface (two-sine heightline) → carve the
 *     chamber (ellipse, refilled below floorY and cleared above, so the floor is flat) → carve
 *     the shaft (waypoints alternating left/right, joined by strokes of discs whose radius
 *     wobbles but never drops below 2.7; optional side pockets) → find 3-wide floor/ceiling
 *     mount points → pick() turrets and fuel cells with minimum spacing from each other and from
 *     the start, entrance, pod and reactor. Difficulty scalars (gravity, turret count, shaft
 *     radius, reactor HP, depth) all scale with n.
 *   - solidAt(lv, x, y): the single collision primitive. Above the grid = air (the exit);
 *     left/right/below the grid = rock.
 *   - lineOfSight(lv, a, b): samples the segment every 0.5 units with solidAt.
 *
 * Usage
 *   game.ts calls generateLevel(n) in Game.load() and queries solidAt / lineOfSight every step;
 *   view.ts reads grid, surface and fixture positions to build meshes; scripts/check.ts
 *   flood-fills the result.
 *
 * Highlights
 *   - Pure: no three.js or DOM, so it runs under Node.
 *   - Deterministic: the same n always yields the same planet (seed n * 7919 + 1337).
 *   - The returned Level also carries mutable per-playthrough state (turret alive/cooldown,
 *     fuel amount); resetting a level means calling generateLevel(n) again.
 *   - WALL = 3 columns each side are never carved, so the playfield is walled up into the sky.
 *
 * See also: game.ts, view.ts (build), scripts/check.ts; DESIGN.md "4. Coordinate system" and
 * "5. Level generation".
 */
export interface Pt {
    x: number;
    y: number;
}
export interface Turret extends Pt {
    up: boolean; // floor-mounted (true) or hanging from the ceiling
    alive: boolean;
    cooldown: number;
}
export interface FuelCell extends Pt {
    amount: number;
}
export interface Level {
    n: number;
    w: number;
    h: number;
    grid: Uint8Array;
    surface: number[]; // first air row per column
    gravity: number;
    start: Pt;
    pod: Pt;
    reactor: Pt;
    reactorHp: number;
    turrets: Turret[];
    fuel: FuelCell[];
    exitY: number;
}

export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function solidAt(lv: Level, x: number, y: number): boolean {
    if (y >= lv.h) return false;
    if (x < 0 || x >= lv.w || y < 0) return true;
    return lv.grid[Math.floor(y) * lv.w + Math.floor(x)] === 1;
}

export function lineOfSight(lv: Level, a: Pt, b: Pt): boolean {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(d / 0.5);
    for (let i = 1; i < steps; i++) {
        const t = i / steps;
        if (solidAt(lv, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false;
    }
    return true;
}

export const WALL = 3;

export function generateLevel(n: number): Level {
    const r = rng(n * 7919 + 1337);
    const w = 96;
    const sky = 34;
    const h = Math.min(120 + 22 * n, 280) + sky;
    const grid = new Uint8Array(w * h).fill(1);
    const set = (x: number, y: number, v: number) => {
        if (x >= WALL && x < w - WALL && y >= 2 && y < h) grid[y * w + x] = v;
    };

    // Surface heightline; everything above it (inside the walls) is sky.
    const base = h - sky;
    const p1 = r() * 6,
        p2 = r() * 6;
    const surface: number[] = [];
    for (let x = 0; x < w; x++) {
        surface.push(Math.round(base + 4 * Math.sin(x * 0.09 + p1) + 2.2 * Math.sin(x * 0.23 + p2)));
        for (let y = surface[x]; y < h; y++) set(x, y, 0);
    }

    const carve = (cx: number, cy: number, rx: number, ry: number) => {
        for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
            for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
                const dx = (x + 0.5 - cx) / rx,
                    dy = (y + 0.5 - cy) / ry;
                if (dx * dx + dy * dy <= 1) set(x, y, 0);
            }
    };

    // Chamber at the bottom: big ellipse with a flat floor.
    const floorY = 8;
    const cx = Math.round(30 + r() * (w - 60));
    carve(cx, floorY + 5, 22, 10);
    for (let x = cx - 24; x <= cx + 24; x++) for (let y = 0; y < floorY; y++) set(x, y, 1);
    for (let x = cx - 17; x <= cx + 17; x++) for (let y = floorY; y < floorY + 6; y++) set(x, y, 0);

    // Shaft: waypoints alternating sides from the entrance down to the chamber.
    const ex = Math.round(18 + r() * (w - 36));
    const steps = Math.min(3 + n, 10);
    const top = surface[ex] + 2;
    const bottom = floorY + 22;
    const pts: Pt[] = [{ x: ex, y: top }];
    let side = r() < 0.5 ? 0 : 1;
    for (let i = 1; i <= steps; i++) {
        side ^= 1;
        const x = side ? 0.58 + r() * 0.3 : 0.12 + r() * 0.3;
        pts.push({ x: x * w, y: top - 8 - ((top - 8 - bottom) * i) / steps });
    }
    pts.push({ x: cx, y: floorY + 6 });
    const rBase = Math.max(2.9, 4.4 - n * 0.15);
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i],
            b = pts[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        for (let t = 0; t <= len; t += 0.5) {
            const k = t / len;
            const rad = Math.max(2.7, rBase + 1.1 * Math.sin(t * 0.35 + i * 1.7));
            carve(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, rad, rad);
        }
        if (i > 0 && r() < 0.6) {
            const dir = a.x < w / 2 ? -1 : 1;
            carve(a.x + dir * 7, a.y - 1, 6, 3.2);
        }
    }

    const solid = (x: number, y: number) => x < 0 || x >= w || y < 0 || (y < h && grid[y * w + x] === 1);
    const start = { x: ex + 0.5, y: Math.max(surface[ex], surface[ex - 1], surface[ex + 1]) + 8 };
    const pod = { x: cx - 9.5, y: floorY + 0.75 };
    const reactor = { x: cx + 9.5, y: floorY };

    // Mount points: a flat 3-cell floor (air above) or ceiling (air below) with clearance.
    const floors: Pt[] = [],
        ceilings: Pt[] = [];
    for (let y = 2; y < h - 1; y++)
        for (let x = WALL + 1; x < w - WALL - 1; x++) {
            if (solid(x, y)) continue;
            const row3 = (yy: number) => solid(x - 1, yy) && solid(x, yy) && solid(x + 1, yy);
            const air3 = (yy: number) => !solid(x - 1, yy) && !solid(x, yy) && !solid(x + 1, yy);
            if (row3(y - 1) && air3(y) && air3(y + 1) && air3(y + 2)) floors.push({ x: x + 0.5, y });
            else if (row3(y + 1) && air3(y) && air3(y - 1) && air3(y - 2)) ceilings.push({ x: x + 0.5, y: y + 1 });
        }
    const taken: Pt[] = [start, pod, reactor, { x: ex + 0.5, y: top }];
    const far = (p: Pt, d: number) => taken.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= d);
    const pick = (list: Pt[], count: number, spacing: number, maxY: number) => {
        const out: Pt[] = [];
        const pool = list.filter((p) => p.y < maxY);
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(r() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        for (const p of pool) {
            if (out.length >= count) break;
            if (far(p, spacing)) {
                out.push(p);
                taken.push(p);
            }
        }
        return out;
    };

    const turretCount = Math.min(3 + 2 * n, 22);
    const nf = Math.ceil(turretCount * 0.65);
    const turrets: Turret[] = [
        ...pick(floors, nf, 10, base + 6).map((p) => ({ ...p, y: p.y + 0.45, up: true })),
        ...pick(ceilings, turretCount - nf, 10, base - 2).map((p) => ({ ...p, y: p.y - 0.45, up: false })),
    ].map((t) => ({ ...t, alive: true, cooldown: 1 + r() * 3 }));
    const fuel = pick(floors, 2 + Math.ceil(n / 2), 9, base - 4).map((p) => ({ x: p.x, y: p.y + 0.5, amount: 35 }));

    return {
        n,
        w,
        h,
        grid,
        surface,
        gravity: Math.min(3.2 + 0.45 * n, 8),
        start,
        pod,
        reactor,
        reactorHp: 10 + 2 * n,
        turrets,
        fuel,
        exitY: h - 3,
    };
}
