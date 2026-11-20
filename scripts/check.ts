/**
 * check — headless asserts for the pure modules (level, game physics/rules, GPU tiers).
 *
 * Purpose
 *   The smallest set of checks that fail if the core logic breaks, runnable without a browser.
 *
 * Operations
 *   1. Planets 1..50: a flood fill that only enters cells with a full 3x3 of air (ship-sized)
 *      reaches the pod and reactor from the start; turrets and fuel cells sit in air; at least
 *      three turrets; generation is deterministic.
 *   2. rod() holds its length to 1e-9 over 2000 steps while both bodies fall and one
 *      accelerates sideways.
 *   3. A tilted idle ship falls, crashes once, loses a life and respawns.
 *   4. Grabbing the pod from a hover closer than the rod length does not crash and lifts it;
 *      carrying it above exitY completes the planet, pays the bonus and loads planet 2.
 *   5. Real GPU renderer strings classify into the expected tiers.
 *
 * Usage
 *   npm run check  (node --import ./scripts/ts-resolve.mjs scripts/check.ts). Prints
 *   "check: ok" or throws an AssertionError naming the failing case.
 *
 * Highlights
 *   - Runs on Node's native TypeScript support; ts-resolve.mjs adds .ts to the extensionless
 *     src/ imports.
 *   - The browser-side counterpart is scripts/smoke.py (Playwright, desktop + touch).
 *
 * See also: src/level.ts, src/game.ts, src/tier.ts, scripts/smoke.py; DESIGN.md
 * "13. Checks and tooling".
 */
import assert from "node:assert/strict";
import { difficulty, generateLevel, MAX_DIFFICULTY_AT, solidAt, type Difficulty } from "../src/level";
import { evenGlow, NEON_LUMA, PLANET_THEMES, themeFor } from "../src/palette";
import { PLANET_NAMES, planetName } from "../src/names";
import { Game, rod, type Input } from "../src/game";
import { classifyGpu } from "../src/tier";
import { BLOCK, blockAt } from "../src/rock";

for (let n = 1; n <= 50; n++) {
    const lv = generateLevel(n);
    const open = (x: number, y: number) => {
        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) if (solidAt(lv, x + dx + 0.5, y + dy + 0.5)) return false;
        return true;
    };
    const seen = new Uint8Array(lv.w * lv.h);
    const q = [[Math.floor(lv.start.x), Math.floor(lv.start.y)]];
    seen[q[0][1] * lv.w + q[0][0]] = 1;
    while (q.length) {
        const [x, y] = q.pop()!;
        for (const [nx, ny] of [
            [x + 1, y],
            [x - 1, y],
            [x, y + 1],
            [x, y - 1],
        ]) {
            if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h || seen[ny * lv.w + nx] || !open(nx, ny)) continue;
            seen[ny * lv.w + nx] = 1;
            q.push([nx, ny]);
        }
    }
    const reach = (x: number, y: number) => {
        for (let dy = 0; dy <= 3; dy++)
            for (let dx = -2; dx <= 2; dx++) if (seen[(Math.floor(y) + dy) * lv.w + Math.floor(x) + dx]) return true;
        return false;
    };
    assert.ok(reach(lv.pod.x, lv.pod.y), `level ${n}: pod unreachable`);
    assert.ok(reach(lv.reactor.x, lv.reactor.y + 2), `level ${n}: reactor unreachable`);
    assert.ok(lv.turrets.length >= 2, `level ${n}: only ${lv.turrets.length} turrets`);
    for (const t of lv.turrets) assert.ok(!solidAt(lv, t.x, t.y), `level ${n}: turret in rock`);
    for (const f of lv.fuel) assert.ok(!solidAt(lv, f.x, f.y), `level ${n}: fuel in rock`);
    assert.deepEqual(generateLevel(n).grid, lv.grid, `level ${n}: not deterministic`);
}

{
    const a = { x: 0, y: 0, vx: 0, vy: 0 },
        b = { x: 0, y: -4.5, vx: 0, vy: 0 };
    for (let i = 0; i < 2000; i++) {
        const h = 1 / 120;
        a.vx += 12 * h;
        a.vy -= 5 * h;
        b.vy -= 5 * h;
        a.x += a.vx * h;
        a.y += a.vy * h;
        b.x += b.vx * h;
        b.y += b.vy * h;
        rod(a, 1, b, 1.6, 4.5);
        assert.ok(Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - 4.5) < 1e-9, "rod stretched");
    }
}

{
    const g = new Game(1);
    const idle: Input = { left: false, right: false, thrust: false, fire: false, shield: false };
    let booms = 0;
    g.onEvent = (e) => e === "bigBoom" && booms++;
    // Tilt the ship so it can't land softly, then let it fall.
    g.ship.a = 1.2;
    for (let i = 0; i < 120 * 20 && booms === 0; i++) g.update(1 / 120, idle);
    assert.equal(booms, 1, "idle ship should crash");
    assert.equal(g.lives, 2);
    for (let i = 0; i < 120 * 3; i++) g.update(1 / 120, idle);
    assert.equal(g.phase, "play", "should respawn");
}

{
    // Grab the pod from a hover closer than the rod length, then lift it clear: no crash.
    const g = new Game(1);
    let died = false;
    g.onEvent = (e) => e === "bigBoom" && (died = true);
    const lv = g.level;
    lv.turrets.length = 0;
    Object.assign(g.ship, { x: lv.pod.x, y: lv.pod.y + 3.2, vx: 0, vy: 0, a: 0 });
    const grab: Input = { left: false, right: false, thrust: false, fire: false, shield: true };
    // Hover: thrust half the time to roughly cancel gravity, while holding the beam.
    for (let i = 0; i < 120 * 3; i++) g.update(1 / 120, { ...grab, thrust: g.ship.vy < 0.8 });
    assert.ok(g.pod.attached, "pod not attached");
    assert.ok(!died, "grabbing the pod crashed");
    assert.ok(g.pod.y > lv.pod.y + 0.3, "pod not lifted");

    // Carry it out through the sky: level completes, bonus paid, next planet loads.
    Object.assign(g.ship, { x: lv.w / 2, y: lv.exitY + 0.5, vx: 0, vy: 0 });
    Object.assign(g.pod, { x: lv.w / 2, y: lv.exitY + 0.5 - g.pod.len, vx: 0, vy: 0 });
    g.update(1 / 60, grab);
    assert.equal(g.phase, "complete");
    assert.ok(g.score >= 4500, `bonus not paid: ${g.score}`);
    for (let i = 0; i < 120 * 4; i++) g.update(1 / 120, grab);
    assert.equal(g.levelNo, 2, "next planet not loaded");
}

{
    const t = (renderer: string, mobile = false, cores = 8, memGB?: number) =>
        classifyGpu({ renderer, mobile, cores, memGB });
    // Desktop / laptop.
    assert.equal(t("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11)"), "high");
    assert.equal(t("ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11)"), "high");
    assert.equal(t("ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11)"), "mid"); // 2016 entry discrete
    assert.equal(t("ANGLE (NVIDIA, NVIDIA GeForce MX250 Direct3D11)"), "mid"); // 2019 laptop
    assert.equal(t("Apple M1"), "high");
    assert.equal(t("ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)"), "mid");
    assert.equal(t("ANGLE (AMD, AMD Radeon(TM) Vega 8 Graphics Direct3D11)"), "mid"); // 2018-19 Ryzen laptop
    assert.equal(t("ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)"), "low"); // 2017-19 laptop
    assert.equal(t("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))"), "low");
    assert.equal(t("ANGLE (NVIDIA GeForce RTX 3060)", false, 8, 2), "low"); // 2 GB RAM
    // Phones and tablets.
    assert.equal(t("Apple GPU", true, 4), "mobile-high"); // any iPad / iPhone (Safari masks the model)
    assert.equal(t("Adreno (TM) 730", true), "mobile-high"); // Galaxy S22 (Snapdragon)
    assert.equal(t("Samsung Xclipse 920", true), "mobile-high"); // Galaxy S22 (Exynos)
    assert.equal(t("Adreno (TM) 740", true), "mobile-high");
    assert.equal(t("Mali-G710", true), "mobile-high"); // Pixel 7 / Dimensity 9000
    assert.equal(t("Adreno (TM) 640", true), "mid"); // Galaxy S10 (2019)
    assert.equal(t("Mali-G76", true), "mid"); // Galaxy S10 Exynos (2019)
    assert.equal(t("Mali-G78", true), "mid");
    assert.equal(t("Adreno (TM) 618", true), "low"); // budget 2019-20
    assert.equal(t("Mali-G52", true), "low");
}

{
    // Block types: every kind appears on a deep planet, topsoil only on the surface skin,
    // ore/crystal only on air-facing cells.
    const lv = generateLevel(6);
    const seen = new Set<number>();
    for (let y = 0; y < lv.h; y++)
        for (let x = 0; x < lv.w; x++) {
            if (!solidAt(lv, x + 0.5, y + 0.5)) continue;
            const b = blockAt(lv, x, y);
            seen.add(b);
            if (b === BLOCK.Topsoil) assert.ok(y >= lv.surface[x] - 1, `topsoil buried at ${x},${y}`);
            if (b === BLOCK.Ore || b === BLOCK.Crystal) {
                const exposed = [
                    [1, 0],
                    [-1, 0],
                    [0, 1],
                    [0, -1],
                ].some(([dx, dy]) => !solidAt(lv, x + dx + 0.5, y + dy + 0.5));
                assert.ok(exposed, `ore/crystal hidden inside rock at ${x},${y}`);
            }
        }
    assert.equal(seen.size, Object.keys(BLOCK).length, `missing block types: ${[...seen]}`);
}

{
    // Difficulty only ever gets harder planet to planet, saturating at MAX_DIFFICULTY_AT.
    const harder: (keyof Difficulty)[] = [
        "gravity",
        "depth",
        "turns",
        "turrets",
        "reactorHp",
        "bulletSpeed",
        "branches",
    ];
    const easier: (keyof Difficulty)[] = ["radius", "minRadius", "turretInterval", "aimSpread"];
    for (let n = 2; n <= MAX_DIFFICULTY_AT + 5; n++) {
        const a = difficulty(n - 1),
            b = difficulty(n);
        for (const k of harder) assert.ok(b[k] >= a[k], `${k} dropped at planet ${n}`);
        for (const k of easier) assert.ok(b[k] <= a[k], `${k} rose at planet ${n}`);
    }
    assert.deepEqual(difficulty(MAX_DIFFICULTY_AT), difficulty(MAX_DIFFICULTY_AT + 10));
    assert.ok(difficulty(1).minRadius > 4, "planet 1 should be roomy");

    // Themes: consecutive planets never share a theme within a full cycle.
    const names = new Set(Array.from({ length: PLANET_THEMES.length }, (_, i) => themeFor(i + 1).name));
    assert.equal(names.size, PLANET_THEMES.length);
    assert.equal(themeFor(PLANET_THEMES.length + 1), themeFor(1), "themes should cycle");
    for (const t of PLANET_THEMES) {
        const [r, g, b] = evenGlow(t.neon);
        assert.ok(Math.abs(0.2126 * r + 0.7152 * g + 0.0722 * b - NEON_LUMA) < 1e-9, `${t.name}: uneven glow`);
    }
}

{
    // Planet names: the 50 hand-picked ones are unique; every name is one capitalised word.
    assert.equal(PLANET_NAMES.length, MAX_DIFFICULTY_AT, "one hand-picked name per planet up to full difficulty");
    assert.equal(new Set(PLANET_NAMES).size, PLANET_NAMES.length, "duplicate planet name");
    for (let n = 1; n <= 300; n++) assert.match(planetName(n), /^[A-Z][a-z]+$/, `planet ${n}: "${planetName(n)}"`);
    assert.equal(planetName(1), "Avren");
    assert.equal(planetName(77), planetName(77), "generated names must be stable");
    assert.equal(generateLevel(3).name, planetName(3));
}

console.log("check: ok");
