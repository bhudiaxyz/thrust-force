/**
 * check — headless asserts for the pure modules: level, difficulty, game rules, tiers, blocks,
 * themes, names, and the gameplay additions (checkpoints, pads, threats, reverse gravity, daily).
 *
 * Purpose
 *   The smallest set of checks that fail if the core logic breaks, runnable without a browser.
 *
 * Operations
 *   1. Planets 1..50: a ship-sized (3x3 air) flood fill reaches the pod and reactor from the
 *      start; turrets and fuel sit in air; at least two turrets; generation is deterministic.
 *   2. rod() holds its length to 1e-9 over 2000 steps of falling and sideways thrust.
 *   3. A tilted idle ship falls, crashes once, loses a life and respawns.
 *   4. Grabbing the pod from closer than the rod length doesn't crash and lifts it; carrying it
 *      above exitY completes the planet with a result, waits, and next() loads planet 2.
 *   5. GPU renderer strings (current and ~7-year-old devices) classify into the expected tiers.
 *   6. Block types: all eight appear; topsoil only on the surface; ore / crystal only exposed.
 *   7. Difficulty never eases planet to planet (including mines, gates, lead aim), saturates at
 *      MAX_DIFFICULTY_AT, and planet 1 is roomy.
 *   8. Themes distinct within a cycle and cycling; evenGlow lands on NEON_LUMA.
 *   9. Planet names: 50 unique hand-picked, every name one capitalised word, stable.
 *  10. Checkpoints become the respawn point; resting on a pad refuels; mines from planet 8, gates
 *      from 15, no leading turrets before 20, reversed gravity on 10; an upside-down ceiling
 *      landing works on a reversed planet; a daily seed changes the layout deterministically.
 *
 * Usage
 *   npm run check  (node --import ./scripts/ts-resolve.mjs scripts/check.ts). Prints
 *   "check: ok" or throws an AssertionError naming the failing case.
 *
 * Highlights
 *   - Runs on Node's native TypeScript support; ts-resolve.mjs adds .ts to extensionless imports.
 *   - The browser-side counterpart is scripts/smoke.py (menus, desktop, phone, landscape).
 *
 * See also: src/world/level.ts, src/core/game.ts, src/render/tier.ts, src/render/rock.ts,
 * src/core/palette.ts, src/world/names.ts, scripts/smoke.py; DESIGN.md "15. Checks and tooling".
 */
import assert from "node:assert/strict";
import { difficulty, generateLevel, MAX_DIFFICULTY_AT, solidAt, type Difficulty } from "../src/world/level";
import { evenGlow, NEON_LUMA, PLANET_THEMES, themeFor } from "../src/core/palette";
import { PLANET_NAMES, planetName } from "../src/world/names";
import { Game, rod, type Input } from "../src/core/game";
import { classifyGpu } from "../src/render/tier";
import { BLOCK, blockAt } from "../src/render/rock";

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
    assert.ok(g.result && g.result.pod && g.result.stars >= 1, "result not recorded");
    for (let i = 0; i < 120 * 4; i++) g.update(1 / 120, grab);
    assert.equal(g.levelNo, 1, "should wait on the summary, not advance by itself");
    g.next();
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
        "mines",
        "gates",
        "leadAim",
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

{
    // Checkpoints: passing one makes it the respawn point.
    const g = new Game(5);
    const idle: Input = { left: false, right: false, thrust: false, fire: false, shield: false };
    g.level.turrets.length = 0;
    g.level.mines.length = 0;
    const cp = g.level.checkpoints[1];
    assert.ok(cp, "planet 5 should have checkpoints");
    Object.assign(g.ship, { x: cp.x, y: cp.y, vx: 0, vy: 0, a: 1.4 });
    g.update(1 / 120, idle);
    assert.equal(g.checkpoint, 1, "checkpoint not taken");
    for (let i = 0; i < 120 * 20 && g.phase === "play"; i++) g.update(1 / 120, idle); // tilted: crashes
    for (let i = 0; i < 120 * 3 && g.phase !== "play"; i++) g.update(1 / 120, idle);
    assert.ok(Math.hypot(g.ship.x - cp.x, g.ship.y - cp.y) < 3, "should respawn at the checkpoint");

    // Pads: landing on one refuels.
    const pg = new Game(3);
    pg.level.turrets.length = 0;
    const pad = pg.level.pads[0];
    assert.ok(pad, "planet 3 should have a pad");
    Object.assign(pg.ship, { x: pad.x, y: pad.y + 1.2, vx: 0, vy: -1, a: 0 });
    pg.fuel = 10;
    for (let i = 0; i < 120 * 2; i++) pg.update(1 / 120, idle);
    assert.equal(pg.phase, "play", "pad landing crashed");
    assert.ok(pg.fuel > 25, `pad did not refuel: ${pg.fuel}`);

    // Threats arrive gradually; reversed gravity every 10th planet.
    assert.equal(generateLevel(7).mines.length, 0);
    assert.ok(generateLevel(8).mines.length > 0, "mines from planet 8");
    assert.equal(generateLevel(14).gates.length, 0);
    assert.ok(generateLevel(15).gates.length > 0, "gates from planet 15");
    assert.ok(!generateLevel(19).turrets.some((t) => t.lead));
    assert.ok(generateLevel(10).gravity < 0 && generateLevel(11).gravity > 0, "reverse gravity on planet 10");

    // Reversed gravity: an upside-down slow touchdown on a ceiling lands.
    const rg = new Game(10);
    rg.level.turrets.length = 0;
    rg.level.mines.length = 0;
    const lv = rg.level;
    let spot: { x: number; y: number } | null = null;
    for (let y = 20; y < lv.h - 40 && !spot; y++)
        for (let x = 10; x < lv.w - 10 && !spot; x++)
            if (
                [-1, 0, 1].every((d) => solidAt(lv, x + d + 0.5, y + 1.5) && !solidAt(lv, x + d + 0.5, y + 0.5)) &&
                [-2, -1].every((d) => !solidAt(lv, x + 0.5, y + d + 0.5))
            )
                spot = { x: x + 0.5, y: y + 0.4 };
    assert.ok(spot, "no ceiling found on planet 10");
    Object.assign(rg.ship, { x: spot.x, y: spot.y - 0.5, vx: 0, vy: 1, a: Math.PI });
    for (let i = 0; i < 120; i++) rg.update(1 / 120, idle);
    assert.equal(rg.phase, "play", "upside-down ceiling landing should not crash");

    // Daily planet: a seed changes the layout and name, deterministically.
    const d1 = generateLevel(12, { seed: 20261120 }),
        d2 = generateLevel(12, { seed: 20261120 });
    assert.deepEqual(d1.grid, d2.grid);
    assert.notDeepEqual(d1.grid, generateLevel(12).grid);
    assert.match(d1.name, /^[A-Z][a-z]+$/);
}

console.log("check: ok");
