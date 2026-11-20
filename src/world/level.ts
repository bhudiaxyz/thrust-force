/**
 * Level — the difficulty curve, the seeded cave generator, and grid queries for one planet.
 *
 * Purpose
 *   Turns a planet number (and optional seed) into a playable planet: a W x H occupancy grid
 *   (1 = rock, 0 = air, 1 cell = 1 world unit, row 0 at the bottom, y up) with open sky, a hilly
 *   surface, a winding shaft to a flat-floored chamber, and its contents — pod, reactor,
 *   turrets, fuel cells, landing pads, checkpoints, mines and laser gates. Also answers the
 *   spatial questions the game asks: is this cell / point rock, can A see B, is a gate on.
 *
 * Operations
 *   - difficulty(n): every knob eased (t^1.2) from planet 1 to MAX_DIFFICULTY_AT (50), then held:
 *     gravity, depth, switchbacks, tunnel radius / pinch / wobble, pockets, branches, loops,
 *     caverns, turrets (count, rate, range, bullet speed, aim, fraction that lead), fuel, reactor
 *     HP; plus threats that arrive on schedule — mines from 8, gates from 15, leading turrets from
 *     20 — and reversed gravity on every 10th planet.
 *   - generateLevel(n, { seed }): surface → chamber → shaft switchbacks joined by stroke()s →
 *     caverns, loops, dead-end branches → mount points → pads (before turrets) → turrets, fuel →
 *     mines on shaft legs → gates across mid-leg tunnel rows → name and par time. A seed (daily
 *     planet) changes the layout and name while difficulty follows n.
 *   - isRock / isAir (integer cells on a Grid) and solidAt (world points): the one rock-or-air
 *     rule every module shares. lineOfSight samples a segment with solidAt.
 *   - gateOn(g, t) / gateIn(g, t): is a gate's beam on, and how soon it comes on.
 *
 * Usage
 *   core/game.ts: generateLevel in Game.load(); solidAt / lineOfSight / gateOn every step;
 *   lv.diff for turret and mine behaviour. render/, ui/, fx/ read the grid and fixtures.
 *   scripts/check.ts flood-fills planets 1–50 and checks the curve and schedule.
 *
 * Highlights
 *   - Pure and deterministic: no three.js or DOM; same n (and seed), same planet.
 *   - The Level carries mutable per-playthrough state (turrets, fuel, mines); a reset is a
 *     fresh generateLevel. WALL columns each side are never carved.
 *
 * See also: core/game.ts, world/names.ts, core/random.ts, render/view.ts, scripts/check.ts;
 * DESIGN.md "4. Coordinate system and the grid", "5. Level generation and difficulty".
 */
import { planetName } from "./names";
import { rng } from "../core/random";

export interface Pt {
    x: number;
    y: number;
}
export interface Turret extends Pt {
    up: boolean; // floor-mounted (true) or hanging from the ceiling
    alive: boolean;
    cooldown: number;
    lead: boolean; // aims where the ship will be, not where it is
}
export interface FuelCell extends Pt {
    amount: number;
}
/** Drifting proximity mine: rests at home, homes in on a ship it can see, explodes on contact. */
export interface Mine extends Pt {
    hx: number;
    hy: number;
    alive: boolean;
}
/** Laser gate: a horizontal beam across the tunnel from x0 to x1 at y, cycling on and off. */
export interface Gate {
    x0: number;
    x1: number;
    y: number;
    period: number; // seconds per on/off cycle
    phase: number; // 0..1 offset into the cycle
}
/** Fraction of each gate cycle the beam is on, and the warning flicker before it switches on. */
export const MAX_DIFFICULTY_AT = 50;
/** Columns on each side never carved, so the playfield is walled up into the sky. */
export const WALL = 3;
export const GATE_ON = 0.55,
    GATE_WARN = 0.4;
/** Is a gate's beam on at time t (seconds since the planet loaded)? */
export const gateOn = (g: Gate, t: number) => (t / g.period + g.phase) % 1 < GATE_ON;
/** Seconds until a gate next switches on (0 while it is on). */
export const gateIn = (g: Gate, t: number) => {
    const c = (t / g.period + g.phase) % 1;
    return c < GATE_ON ? 0 : (1 - c) * g.period;
};
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
    /** Switchback points, top to bottom: passing one makes it the respawn point. */
    checkpoints: Pt[];
    /** Landing pads (centre of the 3-cell floor, y = floor surface): landing refuels. */
    pads: Pt[];
    mines: Mine[];
    gates: Gate[];
    /** Target time in seconds for the time medal. */
    par: number;
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
    mines: number; // drifting proximity mines (from planet 8)
    gates: number; // cycling laser gates (from planet 15)
    leadAim: number; // fraction of turrets that lead their shots (from planet 20)
    reversed: boolean; // gravity pulls up (every 10th planet)
}

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
        mines: n < 8 ? 0 : R(2, 9),
        gates: n < 15 ? 0 : R(1, 5),
        leadAim: n < 20 ? 0 : L(0.25, 0.85),
        reversed: n % 10 === 0,
    };
}

/** The grid part of a Level: enough for the cell tests (and usable before a Level exists). */
export type Grid = Pick<Level, "w" | "h" | "grid">;

/**
 * Is integer cell (x, y) rock? The one rule every module shares: left / right of the grid and
 * below row 0 are rock (walls and bedrock), above the grid is air (the exit).
 */
export function isRock(g: Grid, x: number, y: number): boolean {
    return x < 0 || x >= g.w || y < 0 || (y < g.h && g.grid[y * g.w + x] === 1);
}

/** Is integer cell (x, y) open air inside the playfield columns (sky above the grid counts)? */
export function isAir(g: Grid, x: number, y: number): boolean {
    return x >= 0 && x < g.w && y >= 0 && !isRock(g, x, y);
}

/** Is world point (x, y) inside rock? isRock on the containing cell. */
export function solidAt(lv: Grid, x: number, y: number): boolean {
    return isRock(lv, Math.floor(x), Math.floor(y));
}

export function lineOfSight(lv: Grid, a: Pt, b: Pt): boolean {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(d / 0.5);
    for (let i = 1; i < steps; i++) {
        const t = i / steps;
        if (solidAt(lv, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false;
    }
    return true;
}

/**
 * Generate planet n. opts.seed replaces the layout seed (the daily planet uses the date) while
 * difficulty still follows n; the name then comes from the seed too.
 */
export function generateLevel(n: number, opts: { seed?: number } = {}): Level {
    const seed = opts.seed ?? n * 7919 + 1337;
    const r = rng(seed);
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

    const cells: Grid = { w, h, grid };
    const solid = (x: number, y: number) => isRock(cells, x, y);
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

    // Landing pads: one on the surface (away from the entrance), and about one per three
    // switchbacks inside. Picked before turrets so nothing is mounted on them.
    const pads = [
        ...pick(
            floors.filter((p) => p.y >= base - 8 && Math.abs(p.x - ex) > 12),
            1,
            10,
            h
        ),
        ...pick(floors, Math.max(1, Math.round(diff.turns / 3)), 14, base - 6),
    ];

    const turretCount = diff.turrets;
    const nf = Math.ceil(turretCount * 0.65);
    const turrets: Turret[] = [
        ...pick(floors, nf, 10, base + 6).map((p) => ({ ...p, y: p.y + 0.45, up: true })),
        ...pick(ceilings, turretCount - nf, 10, base - 2).map((p) => ({ ...p, y: p.y - 0.45, up: false })),
    ].map((t) => ({ ...t, alive: true, cooldown: 1 + r() * 3, lead: r() < diff.leadAim }));
    const fuel = pick(floors, diff.fuelCells, 9, base - 4).map((p) => ({ x: p.x, y: p.y + 0.5, amount: 35 }));

    // Mines: on shaft legs (midpoint of a random leg, nudged), in open air, away from fixtures.
    const open = (p: Pt) => {
        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) if (solid(Math.floor(p.x) + dx, Math.floor(p.y) + dy)) return false;
        return true;
    };
    const mines: Mine[] = [];
    for (let tries = 0; mines.length < diff.mines && tries < diff.mines * 12; tries++) {
        const i = 1 + Math.floor(r() * (pts.length - 2));
        const a = pts[i],
            b = pts[i + 1],
            k = 0.25 + r() * 0.5;
        const p = { x: a.x + (b.x - a.x) * k + (r() - 0.5) * 3, y: a.y + (b.y - a.y) * k + (r() - 0.5) * 3 };
        if (!open(p) || !far(p, 9) || mid.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 7)) continue;
        taken.push(p);
        mines.push({ ...p, hx: p.x, hy: p.y, alive: true });
    }

    // Laser gates: a horizontal beam across the tunnel at the middle of a shaft leg.
    const gates: Gate[] = [];
    const usedLegs = new Set<number>();
    for (let tries = 0; gates.length < diff.gates && tries < diff.gates * 10; tries++) {
        const i = 1 + Math.floor(r() * (pts.length - 2));
        if (usedLegs.has(i)) continue;
        const a = pts[i],
            b = pts[i + 1];
        const y = Math.floor((a.y + b.y) / 2),
            mx = Math.floor((a.x + b.x) / 2);
        if (solid(mx, y)) continue;
        let x0 = mx,
            x1 = mx;
        while (!solid(x0 - 1, y)) x0--;
        while (!solid(x1 + 1, y)) x1++;
        if (x1 - x0 < 5 || x1 - x0 > 26) continue;
        usedLegs.add(i);
        gates.push({ x0, x1: x1 + 1, y: y + 0.5, period: 3 + r() * 1.5, phase: r() });
    }

    return {
        n,
        w,
        h,
        grid,
        surface,
        gravity: diff.reversed ? -diff.gravity : diff.gravity,
        start,
        pod,
        reactor,
        reactorHp: diff.reactorHp,
        turrets,
        fuel,
        exitY: h - 3,
        name: planetName(opts.seed === undefined ? n : 51 + (seed % 100000)),
        diff,
        checkpoints: mid,
        pads,
        mines,
        gates,
        par: Math.round(25 + diff.depth * 0.3 + diff.turns * 5),
    };
}
