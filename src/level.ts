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
 *   - Every random choice in generation comes from rng(seed) (random.ts).
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
import { planetName } from './names';
import { rng } from './random';

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
    name: string; // single-word planet name (names.ts)
    diff: Difficulty;
}

/**
 * Every difficulty knob, as a function of planet number. Planet 1 is roomy and gentle; the curve
 * eases in (t^1.2, so the early planets stay friendly) and reaches full difficulty at
 * planet MAX_DIFFICULTY_AT, then holds there. "Harder" means heavier gravity and more, faster,
 * sharper-shooting turrets; "more complex" means a deeper planet with more switchbacks, dead-end
 * side passages, loops (alternate routes), open caverns and tighter, more wobbly tunnels.
 */
export interface Difficulty {
    t: number; // 0 (planet 1) .. 1 (planet MAX_DIFFICULTY_AT = 50 and beyond), after easing
    gravity: number;
    depth: number; // rows of planet below the sky
    turns: number; // shaft switchbacks
    radius: number; // base tunnel radius
    minRadius: number; // tunnels never pinch below this
    wobble: number; // radius wobble amplitude
    pocket: number; // chance of a side pocket at each switchback
    branches: number; // dead-end side passages
    loops: number; // alternate routes rejoining the shaft
    caverns: number; // open caverns along the shaft
    turrets: number;
    fuelCells: number;
    reactorHp: number;
    turretInterval: number; // mean seconds between shots
    turretRange: number;
    bulletSpeed: number;
    aimSpread: number; // radians of random aim error
}

export const MAX_DIFFICULTY_AT = 50;

export function difficulty(n: number): Difficulty {
    const t = Math.min(1, Math.max(0, (n - 1) / (MAX_DIFFICULTY_AT - 1))) ** 1.2;
    const L = (a: number, b: number) => a + (b - a) * t;
    const R = (a: number, b: number) => Math.round(L(a, b));
    return {
        t,
        gravity: L(2.4, 7.2),
        depth: R(80, 250),
        turns: R(2, 9),
        radius: L(5.4, 3.5),
        minRadius: L(4.2, 3.0),
        wobble: L(0.6, 1.6),
        pocket: L(0.3, 0.7),
        branches: R(0, 5),
        loops: R(0, 2),
        caverns: R(0, 3),
        turrets: R(2, 22),
        fuelCells: R(3, 7),
        reactorHp: R(8, 30),
        turretInterval: L(4.5, 1.1),
        turretRange: L(20, 32),
        bulletSpeed: L(7, 15),
        aimSpread: L(0.4, 0.08),
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
    const diff = difficulty(n);
    const w = 96;
    const sky = 34;
    const h = diff.depth + sky;
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
    const steps = diff.turns;
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
    /** Carve a tunnel from a to b: discs every 0.5 units, radius wobbling but never below minRadius. */
    const stroke = (a: Pt, b: Pt, radius: number, phase: number) => {
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        for (let t = 0; t <= len; t += 0.5) {
            const k = t / len;
            const rad = Math.max(diff.minRadius, radius + diff.wobble * Math.sin(t * 0.35 + phase));
            carve(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, rad, rad);
        }
    };
    for (let i = 0; i < pts.length - 1; i++) {
        stroke(pts[i], pts[i + 1], diff.radius, i * 1.7);
        if (i > 0 && r() < diff.pocket) carve(pts[i].x + (pts[i].x < w / 2 ? -7 : 7), pts[i].y - 1, 6, 3.2);
    }
    const mid = pts.slice(1, -1); // switchback points (not the entrance or the chamber)
    const anyMid = () => mid[Math.floor(r() * mid.length)];
    // Caverns: open halls on the shaft.
    for (let k = 0; k < diff.caverns && mid.length; k++) {
        const p = anyMid();
        carve(p.x, p.y, 9 + r() * 5, 5 + r() * 3);
    }
    // Loops: a second route from switchback i to i + 2 via the opposite side of the planet.
    for (let k = 0; k < diff.loops && pts.length > 3; k++) {
        const i = Math.floor(r() * (pts.length - 3));
        const a = pts[i],
            b = pts[i + 2];
        const via = { x: Math.min(w - 12, Math.max(12, w - (a.x + b.x) / 2)), y: (a.y + b.y) / 2 };
        stroke(a, via, diff.radius * 0.85, k * 2.3);
        stroke(via, b, diff.radius * 0.85, k * 3.1);
    }
    // Branches: winding dead-end passages off a switchback, ending in a pocket.
    for (let k = 0; k < diff.branches && mid.length; k++) {
        let p = anyMid();
        let ang = (r() < 0.5 ? 0 : Math.PI) + (r() - 0.5) * 0.9;
        const segs = 3 + Math.floor(r() * 3);
        for (let s = 0; s < segs; s++) {
            const q = {
                x: Math.min(w - 8, Math.max(8, p.x + Math.cos(ang) * 7)),
                y: Math.min(h - sky - 8, Math.max(14, p.y + Math.sin(ang) * 7)),
            };
            stroke(p, q, diff.radius * 0.8, k + s);
            p = q;
            ang += (r() - 0.5) * 1.4;
        }
        carve(p.x, p.y, 4.5, 3);
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

    const turretCount = diff.turrets;
    const nf = Math.ceil(turretCount * 0.65);
    const turrets: Turret[] = [
        ...pick(floors, nf, 10, base + 6).map((p) => ({ ...p, y: p.y + 0.45, up: true })),
        ...pick(ceilings, turretCount - nf, 10, base - 2).map((p) => ({ ...p, y: p.y - 0.45, up: false })),
    ].map((t) => ({ ...t, alive: true, cooldown: 1 + r() * 3 }));
    const fuel = pick(floors, diff.fuelCells, 9, base - 4).map((p) => ({ x: p.x, y: p.y + 0.5, amount: 35 }));

    return {
        n,
        w,
        h,
        grid,
        surface,
        gravity: diff.gravity,
        start,
        pod,
        reactor,
        reactorHp: diff.reactorHp,
        turrets,
        fuel,
        exitY: h - 3,
        name: planetName(n),
        diff,
    };
}
