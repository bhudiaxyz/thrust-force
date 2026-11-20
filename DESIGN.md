# Thrust Force: Design

This document covers how the game is built: module layout, data model, generation and difficulty, physics, rendering, effects, theming, input, UI, quality tiers and performance, tooling and deployment. The [README](README.md) covers what the game is and how to play it.

## Contents

1. [Goals and constraints](#1-goals-and-constraints)
2. [Stack and project layout](#2-stack-and-project-layout)
3. [Architecture](#3-architecture)
4. [Coordinate system and the grid](#4-coordinate-system-and-the-grid)
5. [Level generation and difficulty](#5-level-generation-and-difficulty)
6. [Game rules and physics (`game.ts`)](#6-game-rules-and-physics-gamets)
7. [Rendering (`view.ts`, `rock.ts`)](#7-rendering-viewts-rockts)
8. [Effects (`fx.ts`)](#8-effects-fxts)
9. [Palette and themes (`palette.ts`)](#9-palette-and-themes-palettets)
10. [Quality tiers, performance and stutter](#10-quality-tiers-performance-and-stutter)
11. [Input (`input.ts`)](#11-input-inputts)
12. [UI: splash, HUD, minimap, pause / game over](#12-ui-splash-hud-minimap-pause--game-over)
13. [Audio (`audio.ts`)](#13-audio-audiots)
14. [Frame loop, idle and boot (`main.ts`)](#14-frame-loop-idle-and-boot-maints)
15. [Checks and tooling](#15-checks-and-tooling)
16. [Build and deployment](#16-build-and-deployment)
17. [Tuning reference](#17-tuning-reference)
18. [Known limits and extension points](#18-known-limits-and-extension-points)

---

## 1. Goals and constraints

- **The genre's core feel**: rotation, thrust, gravity and momentum, with a heavy pod on a rigid rod. Everything else exists to stress that feel.
- **Original content**: levels, planet names, art and sound are all generated or written for this project. Classic Amiga thrust games inspired the mechanics; _Tron_ (neon lines on dark geometry) and _Minecraft_ (voxel blocks, pixel-art textures) inspired the look.
- **Small, plain code**: about 3,200 lines of TypeScript in 15 modules. There's no game engine, no ECS and no physics library. Rules are plain functions over plain objects.
- **Testable core**: the simulation and content generators (`level`, `game`, `names`, `random`, `palette`, the `tier` classifier, `rock`'s `blockAt`) touch no DOM, so they run headless under Node.
- **Everywhere**: static GitHub Pages hosting, desktop and mobile, smooth on devices about 7 years old, with extra fidelity on capable hardware.

## 2. Stack and project layout

| Piece      | Choice                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------- |
| Rendering  | three.js r185 (`WebGLRenderer`, `EffectComposer` on a multisampled target, `UnrealBloomPass`) |
| Language   | TypeScript 5, `strict`, ES2022 modules, bundler resolution                                    |
| Build      | Vite 8 (`base: '/thrust-force/'`, three.js split into its own chunk)                          |
| Touch      | nipplejs 1.x (dynamic joystick)                                                               |
| Sound      | WebAudio, synthesised at runtime (no assets)                                                  |
| Fonts      | Orbitron (display) and Inter (body), from Google Fonts                                        |
| Checks     | Node's native TypeScript runner + `node:assert`; Python Playwright for the browser smoke test |
| Formatting | Prettier per `.prettierrc` (4-space, double quotes, ES5 trailing commas, 120 columns)         |

```
index.html            DOM shell: #app canvas host, #hud, #minimap, #joy, #touch, #boot splash, #pause
src/
  main.ts             composition root: boot, commands, pause / game over, frame loop, idle, governor
  game.ts             rules + physics (pure)
  level.ts            difficulty curve, cave generator, isRock / isAir / solidAt / lineOfSight (pure)
  names.ts            single-word planet names (pure)
  random.ts           the shared seeded PRNG (pure)
  view.ts             three.js scene: ship, pod, fixtures, streamed rock chunks, stars, camera, post-FX
  fx.ts               sparks, voxel explosions, exhaust, cave dust; shared sprite helpers
  rock.ts             voxel block types: placement rule, pixel-art atlas, instanced rock material
  palette.ts          every colour: 24 planet themes + fixed colours; UI colours → CSS variables
  tier.ts             GPU classification + per-tier quality table (classifier is pure)
  input.ts            keyboard, touch buttons, nipplejs stick → Input; control help text
  hud.ts              HUD writer (DOM writes only on change)
  minimap.ts          2D-canvas planet map with live markers
  audio.ts            WebAudio synth
  styles.css          theme variables, HUD, minimap, splash, pause, touch layout
scripts/
  check.ts            headless asserts (npm run check)
  smoke.py            Playwright browser smoke test (desktop, emulated phone, idle)
  ts-resolve.mjs      Node resolve hook: lets scripts import extensionless src/ modules
.github/workflows/deploy-pages.yml   build + deploy to GitHub Pages on push to main
```

Every source file opens with a header in the same shape: a summary line, then **Purpose**, **Operations**, **Usage**, **Highlights** and **See also**. Start there when reading a module.

## 3. Architecture

The design follows one rule: **simulation and presentation don't share state they both write.**

```
   keyboard / touch / stick ─► input.ts ─► steer(a) : Input
                                               │
                                               ▼
 main.ts ─────────────────────────► Game.update(dt, input) ─► Game state (plain objects)
    ▲                                         │                       │ read-only
    │                                  onEvent(e, x, y)               ├─► hud.ts (DOM)
    │                                         ▼                       ├─► minimap.ts (2D canvas)
    └── audio.ts sfx[e] ◄──────────── main.ts ──► View.explode/burst  └─► View.sync ─► WebGL
                                                          │
                                                          └─► fx.ts Effects
```

- **`Game`** owns all mutable gameplay state: ship, pod, bullets, fuel, score, lives, phase, reactor and level entities. It advances only through `update(dt, input)`.
- **`View`** reads a `Game` every frame and poses meshes to match. It never writes game state. When `game.level` changes identity (new planet or level reset), it rebuilds the level, streaming the rock in over a few frames (§7.2).
- **Events** carry the one-way information that can't be polled: explosions, shots, pickups. `Game.onEvent(e, x, y)` is one callback. `main.ts` maps each event to a sound (`sfx[e]`), a layered explosion (`boom` / `bigBoom` → `View.explode`) or a small burst (the `BURSTS` table).
- **`Input`** is five booleans (`left, right, thrust, fire, shield`). The game never sees devices; `input.ts` merges them (§11).
- **Content is data**: planets from `generateLevel(n)`, looks from `themeFor(n)`, names from `planetName(n)`, difficulty from `difficulty(n)`, all deterministic in `n`.

The split keeps the logic checkable without a browser, and it lets the title screen draw a live, idle "attract" `Game` through the same `View`.

## 4. Coordinate system and the grid

- 1 grid cell = 1 world unit. `x` grows right and `y` grows up; row 0 is the bottom of the planet.
- A level is a `Uint8Array` of `w × h` cells, `1` = rock and `0` = air, indexed `grid[y * w + x]`. `w = 96`; `h = difficulty(n).depth + 34`, where the top 34 rows are open sky.
- **One rock rule, shared**: `isRock(grid, x, y)` on integer cells says left, right or below the grid is rock (walls, bedrock) and above it is air (the exit). `isAir` is "inside the playfield columns and not rock". `solidAt(lv, x, y)` is `isRock` on the containing cell, for world points. Every module (game, view, rock, minimap, fx, checks) uses these three; none re-implements the rule. They take a `Grid = Pick<Level, 'w' | 'h' | 'grid'>`, so the generator can use them before a `Level` exists.
- Three columns on each side (`WALL = 3`) are never carved, so the playfield is walled all the way up, sky included.
- `lineOfSight(grid, a, b)` samples the segment every 0.5 units with `solidAt`. Turrets use it to decide whether they can see the ship.
- The three.js scene uses the same coordinates. Rock voxels sit at `(x + 0.5, y + 0.5, 0)` and are 3 deep (z ∈ [−1.5, 1.5]); everything gameplay-relevant lives on z = 0.

## 5. Level generation and difficulty

### 5.1 The difficulty curve

`difficulty(n)` returns every knob for planet `n`. Progress is `t = clamp((n − 1) / 49, 0, 1) ^ 1.2`, so planet 1 is the easiest, the curve eases in gently, reaches full difficulty at **planet 50** (`MAX_DIFFICULTY_AT`) and holds there. Each knob is a linear blend `a + (b − a)·t`:

| Knob                   | Planet 1  | Planet 50 | Effect                                        |
| ---------------------- | --------- | --------- | --------------------------------------------- |
| `gravity`              | 2.4       | 7.2       | weight of the ship and pod                    |
| `depth`                | 80        | 250       | rows of planet under the sky                  |
| `turns`                | 2         | 9         | shaft switchbacks                             |
| `radius` / `minRadius` | 5.4 / 4.2 | 3.5 / 3.0 | tunnel width, and the narrowest pinch allowed |
| `wobble`               | 0.6       | 1.6       | radius wobble amplitude (pinches)             |
| `pocket`               | 30%       | 70%       | chance of a side pocket per switchback        |
| `branches`             | 0         | 5         | winding dead-end side passages                |
| `loops`                | 0         | 2         | alternate routes rejoining the shaft          |
| `caverns`              | 0         | 3         | open halls along the shaft                    |
| `turrets`              | 2         | 22        | turret count                                  |
| `turretInterval`       | 4.5 s     | 1.1 s     | mean time between shots                       |
| `turretRange`          | 20        | 32        | how far turrets see                           |
| `bulletSpeed`          | 7         | 15        | enemy bullet speed                            |
| `aimSpread`            | ±0.4 rad  | ±0.08 rad | enemy aim error                               |
| `fuelCells`            | 3         | 7         | refuelling points                             |
| `reactorHp`            | 8         | 30        | hits to make the reactor critical             |

"Harder" means heavier gravity and more, faster, better-aimed turrets. "More complex to navigate" means deeper planets with more switchbacks, dead ends, loops, caverns and tighter, more wobbly tunnels. The curve is stored on the level as `lv.diff`; `game.ts` reads the turret knobs from it. `check.ts` asserts that no knob ever eases from one planet to the next (§15).

### 5.2 Generation

`generateLevel(n)` is deterministic: `rng(n * 7919 + 1337)` from `random.ts` (mulberry32). The steps run in this order:

1. **Fill** the grid with rock.
2. **Surface**: a two-sine heightline (`base + 4·sin(0.09x + p1) + 2.2·sin(0.23x + p2)`, random phases). Everything above it inside the walls becomes air.
3. **Chamber**: an ellipse (rx 22, ry 10) at a random `cx`. Below `floorY = 8` it's refilled with rock and a 35 × 6 box is cleared above, giving a **flat floor**. The pod goes at `cx − 9.5` (resting 0.75 above the floor) and the reactor at `cx + 9.5`.
4. **Shaft**: start at the entrance under the surface, then `turns` switchbacks alternating between the left (12–42% of the width) and right (58–88%) of the planet, evenly spaced in height down to `floorY + 22`, and finally the chamber.
5. **Carve** each leg with `stroke(a, b, radius, phase)`: discs every 0.5 units, radius `max(minRadius, radius + wobble·sin(0.35t + phase))`. The `minRadius` floor guarantees a ship-sized passage. Each switchback may get a **side pocket** (ellipse 6 × 3.2) on its outer side.
6. **Complexity**: `caverns` large ellipses (9–14 × 5–8) on switchbacks; `loops` second routes from switchback `i` to `i + 2` via a point mirrored to the far side of the planet (radius 85%); `branches` winding dead ends of 3–5 seven-unit segments with random turns, ending in a small pocket (radius 80%).
7. **Mount points**: scan for 3-wide flat floors (rock row below, three rows of air above) and ceilings (the mirror image).
8. **Placement**: `pick()` shuffles candidates and takes them greedily with a minimum spacing from everything already placed. The start, entrance, pod and reactor are pre-seeded, so nothing spawns on top of them. Turrets are 65% floor-mounted; ceiling turrets stay below the surface. Fuel cells hold 35 units each.
9. **Name**: `planetName(n)` (§5.3).

The `Level` also holds the **mutable entity state** for that playthrough (turret `alive` / `cooldown`, fuel `amount`). Resetting a planet means calling `generateLevel(n)` again (a few ms).

### 5.3 Planet names (`names.ts`)

Planets 1–50 take one of 50 hand-picked, invented single-word names (`PLANET_NAMES`: Avren, Kesra, Vael, Orin…), one per planet up to full difficulty. Beyond 50, a seeded syllable generator (`rng(n * 104729 + 7)`) builds 2–3 syllables: consonant + vowel, with a cluster (th, dr, kr, st) only at the start and an optional soft coda, so names stay pronounceable ("Stazan", "Norol"). Selection is by index, so new names should be appended, not inserted. Names show as **"Planet 1: Avren"** in the arrival message, HUD and pause dialog.

## 6. Game rules and physics (`game.ts`)

### 6.1 Fixed timestep

`update(dt)` accumulates real time (capped at 0.25 s, so a stalled tab can't spiral) and runs `step(1/120)` as many times as needed. All physics are explicit Euler at 120 Hz. That rate is stable for the stiff rod constraint and deterministic per step, so behaviour doesn't depend on the display refresh rate.

### 6.2 Phases

| Phase      | Meaning                     | Exit                                                                                  |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `play`     | normal flight               | death → `dead`; leave through the sky with the pod or a critical reactor → `complete` |
| `dead`     | 2.2 s explosion pause       | lives left → `respawn()` (or `load(n)` if the reactor was critical); none → `over`    |
| `complete` | 3.2 s victory pause         | `load(n + 1)`                                                                         |
| `over`     | final; main.ts shows dialog | a new `Game` is created by main.ts                                                    |

Bullets keep flying during the pauses, so explosions and stray shots finish naturally.

### 6.3 Ship flight

State is `{x, y, vx, vy, a}`, where `a = 0` means nose up and positive `a` is counter-clockwise; the nose direction is `(−sin a, cos a)`. Per step: rotate at ±4.3 rad/s; `thrusting` and `shielding` need fuel (4.5/s and 8/s); acceleration is thrust (15 u/s²) along the nose minus `gravity`; a light linear drag (4%/s) lets momentum settle; then the position integrates.

### 6.4 Tow rod (two-body constraint)

`rod(a, ma, b, mb, len)` is a rigid distance constraint between the ship (mass 1) and the pod (mass 1.6), solved by inverse-mass weighting:

1. **Position projection**: move both bodies along the rod normal `n` by `(d − len) / (wa + wb)`, scaled by each body's inverse mass `w = 1/m`. The heavier pod moves less.
2. **Velocity projection**: remove the relative velocity along `n` with the same weighting. The rod then neither stretches nor compresses, but tangential motion stays free, so the pod swings like a pendulum and its momentum yanks the ship around.

The rod length is **the distance at the moment of grabbing** (min 2). A fixed length would yank a resting pod into the floor or drag the ship onto it; `check.ts` has a regression test for this.

### 6.5 Tractor beam and shield

These share one button. While `shielding`: an unattached pod within 5.5 latches on (`attach`); the first fuel cell below the ship within 4.5 drains at up to 40/s (`beam` is set for drawing; an emptied cell pays 300 and fires `fuel`); enemy bullets that reach the ship are absorbed.

### 6.6 Weapons and turrets

- The player fires from the nose at ship velocity + 24 u/s, with 0.17 s reload and 1.4 s life.
- A turret fires when its cooldown expires, the ship is within `turretRange`, it's in the turret's hemisphere (floor turrets don't shoot down, ceiling turrets don't shoot up) and `lineOfSight` is clear. It aims at the ship ± `aimSpread`, at `bulletSpeed`, every `turretInterval` × a random 0.7–1.3.
- **Stun**: every reactor hit silences all turrets for 4 s. Chipping at the reactor buys breathing room.

### 6.7 Reactor

A player bullet within 1.8 of the core costs 1 HP, pays 50 and stuns the turrets. At 0 HP, `critical = 10` s and a `critical` event fires; an `alarm` fires every whole second. If the countdown hits 0 with the ship still on the planet, you die and the planet is rebuilt on respawn.

### 6.8 Collisions and landing

The hull is six local points (nose, two nose-side midpoints, two rear corners, rear centre), rotated by `hull()`. If any is in rock, it's a **landing** when speed < 5, `|a| < 0.45` rad and `vy ≤ 0.5` with none of the three front points touching (the ship is nudged clear, `vy` zeroed, `vx` damped, angle eased upright), and otherwise a **crash**. Other deaths: touching a live turret (< 1.3) or the reactor (< 2.4), an unshielded bullet hit (< 1), or an attached pod in rock (8 points on a 0.55 circle). Player bullets hit rock, then turrets (750), fuel cells (150), then the reactor.

Bullets are updated **in place**: survivors are compacted to the front of the array, rather than `filter()` allocating a new array 120 times a second.

### 6.9 Exiting and scoring

Above `exitY` with the pod and/or a critical reactor, the planet completes: the pod is worth `4000 + 500n`, a destroyed planet `3000 + 500n`, and both can be earned together. With neither, a soft ceiling stops the ship and "Recover the pod first" shows. An extra ship comes every 10,000 points. Respawn is at the entrance, a carried pod returns to its pedestal and fuel refills to at least 40.

## 7. Rendering (`view.ts`, `rock.ts`)

### 7.1 Scene and look

- **Camera**: perspective, 50° FOV, z = `CAM_Z` 34 (30 / aspect on portrait screens). It chases `ship + 0.3·velocity` with exponential smoothing (`1 − e^(−4dt)`) and sits 4 units below its look-at point, so floors show their tops and tunnels read as 3D. `fx.shake` jitters the look-at target.
- **Lights**: a hemisphere light, a directional sun that follows the ship (`ship + (−12, 30, 36)`), a cyan light riding 7 units in front of the ship (brighter when thrusting), a pulsing reactor light, and the explosion flash.
- **What glows**: ACES Filmic tone mapping. "Neon" materials use `toneMapped: false` with HDR colours (channels above 1), so they cross the bloom threshold (0.82) while lit surfaces mostly don't. That one rule decides what glows.
- **Stars**: three `STAR_LAYERS` at very different depths: near (z −6…−16, 15% of stars), mid (−40…−80, 30%) and far (−160…−320, 55%). Under the perspective camera a layer at depth `d` moves at `CAM_Z / (CAM_Z + d)` of the playfield's speed (about 75%, 35% and 12%), which gives a strong parallax. Each layer spreads in proportion to the view size at its depth, and far stars are drawn larger to offset perspective shrinking.

### 7.2 Level meshes and streaming

`build(level)` disposes the old level (except shared materials and geometry) and builds the cheap parts at once: the **back wall** (a `ShapeGeometry` along the surface at z −1.45, textured with the Stone tile), stars, pod pedestal, **turrets** (half-dome + eye + barrel, flipped for ceilings; barrel references are cached), **fuel cells** and the **reactor**. The rock is only **queued**:

- It's cut into horizontal slices of `CHUNK = 24` rows, including `MARGIN = 12` cells of extra rock beyond the sides and bottom, so the camera never sees void.
- `pump(budgetMs, focusY)` builds queued chunks **nearest the ship first** until the budget is spent (always at least one). `sync()` calls it with the tier's `buildMs` (3–8 ms), so a new planet streams in over a few frames instead of freezing one. At boot, behind the splash, `pump(Infinity)` builds everything.
- Each chunk is two `InstancedMesh`es: **rock voxels** (1×1×3 boxes, one per solid cell, a per-instance `aTile` block type and colour) and **neon edge strips** (1.04 × 0.1 × 0.1 bars at z 1.52 on every air-facing side, the signature _Tron_ outline). Separate chunks let three.js **frustum-cull** whatever is off screen or outside the shadow camera: typically 2–3 of 8–12 chunks draw.
- The rock material, strip material and box geometries are **shared across planets**, so their shaders compile once and nothing is re-uploaded.
- Rock colour: `deep → top` by height, `surf` blended over the top four rows, ×1.45 to offset the tiles' average brightness, a hash-based ±9% lightness jitter, and ore and crystal lifted towards white so their own colours show.

### 7.3 Voxel block types (`rock.ts`)

Eight block types, each a 16 × 16 pixel-art tile painted at runtime into an **atlas** (no image files):

| Tile    | Look                                   | Where (`blockAt`)                                  |
| ------- | -------------------------------------- | -------------------------------------------------- |
| Topsoil | bright crust with drips over earth     | surface skin (air above, at the surface)           |
| Gravel  | dense light and dark pebbles           | up to 4 cells under the surface; some deep regions |
| Stone   | speckled grey, hairline cracks         | low-frequency noise regions                        |
| Strata  | wobbling sediment bands                | noise regions                                      |
| Cobble  | wrapped Voronoi cells with dark mortar | noise regions                                      |
| Basalt  | vertical columns with dark joints      | bottom ~22% of the planet (wavy edge)              |
| Ore     | stone with **glowing** amber veins     | ~7% of air-facing cells deeper than 6              |
| Crystal | dark matrix, **glowing** cyan facets   | ~4% of air-facing cells deeper than 15             |

Region noise is seeded by the planet number, so each planet's strata differ. `rockMaterial(bump)` is a `MeshStandardMaterial` patched in `onBeforeCompile`:

- **Tile UVs**: the vertex shader derives tile-local coordinates from object-space position on each face (`vLocal`), so the 1×1×3 box repeats a tile 3 times along its depth instead of stretching it. The fragment shader picks the atlas tile with `aTile` and `fract()`. Nearest filtering without mipmaps keeps pixels crisp and makes the `fract` seams invisible.
- **Glow**: an emissive atlas lights only the ore and crystal pixels, so they bloom.
- **Bump relief** (high tiers): the albedo atlas doubles as a bump map. The bump chunk is replaced so it samples through `tileUv()` but takes screen-space derivatives from the continuous `vLocal`; otherwise every `fract()` wrap would read as a cliff in the height field. `customProgramCacheKey` keeps the bump and plain variants apart.

### 7.4 Per-frame posing (`sync`)

Ship (extruded arrowhead, neon `EdgesGeometry` outline, canopy, flickering flame cone, spinning shield ring), pod (metal orb, amber torus) with the **tow rod** and **tractor beam** as two-vertex `Line`s, turret barrels tracking the ship (±1.3 rad), fuel-cell fill, reactor core (gentle pulse; dim while stunned; red strobe when critical; gone at 0), and bullets (a `Points` layer refilled in place). The per-frame path **allocates nothing**: scratch objects and element-wise buffer writes only.

### 7.5 Post-processing and shadows

- `EffectComposer` renders into a **`HalfFloat` render target with MSAA samples** from the tier (4 / 2 / 2 / 0). The canvas itself has no MSAA: with post-processing the canvas buffer is only a copy target, so its MSAA would cost memory and fill without anti-aliasing anything. HalfFloat keeps HDR neon above 1 for bloom.
- Passes: `RenderPass` → `UnrealBloomPass` (strength 0.75, radius 0.38, threshold 0.82; off on low) → `OutputPass` (tone mapping, sRGB).
- **Shadows** (high and mobile-high): the sun casts a PCF shadow map (`radius 3` blur; r185 deprecates `PCFSoftShadowMap`) of 4096² or 1024², with a ±32-unit frustum that follows the ship. Rock casts and receives, the back wall receives, and the ship, pod, turrets and reactor cast. The ship and pod throw shadows onto the tunnel's back wall.

## 8. Effects (`fx.ts`)

`Effects` owns every short-lived or ambient visual, built once as fixed pools:

- **Sparks**: a `Points` pool (size from the tier). `burst()` appends sparks with random direction and speed; `exhaust()` emits one backwards from the engine with the ship's velocity added. Each frame they integrate (40% gravity), fade by remaining life, and the live ones are **compacted** to the front so the draw range is exactly the live set. A full pool reuses random slots.
- **Explosions** (`explode(x, y, big)`; `big` for the ship or reactor, small for turrets and fuel cells), in layers:
    1. a flash point light (900 / 260) that lights the cave walls and decays as `e^(−7t)`
    2. white-hot, amber, red and planet-neon sparks
    3. two **shockwave rings**: neon, then amber, expanding with ease-out and fading
    4. up to 70 **tumbling voxel cubes**: 62% embers that cool white-hot → amber → red → soot along `COLORS.ember` (sampled with `ramp()`), 20% hull-grey chunks and 18% neon chunks. They fall, spin and **bounce off rock** (`solidAt`, losing energy), so they skitter along floors.
    5. camera shake (1.6 / 0.5).
- **Cave dust** (high tiers): motes drifting in a 60 × 44 box that wraps around the camera, shown only inside the planet.
- `hiddenObjects()` and `setDebrisWarm()` let `View.warmup()` compile these shaders before play (§10.3). `dotTexture()` and `pointsLayer()` are shared with `View` for bullets and stars.

## 9. Palette and themes (`palette.ts`)

All colours live here. No other module hard-codes one; the only exceptions are the pre-JS splash background and favicon in `index.html`.

- **Formats by destination**: hex for lit materials and lights; `RGB` (linear, > 1 = HDR) for neon materials, lines, particles and debris; `RGB8` (0–255) for canvas pixels (tile atlas, minimap); CSS strings for the minimap overlay and UI.
- **24 planet themes** (`PLANET_THEMES`, named: Amethyst, Ember, Verdigris, Glacier … Dune, Aurora). Each has `deep`, `top` and `surf` rock colours, a `neon` edge colour and a `sky`. `themeFor(n)` cycles through them in order, so every planet in a run of 24 looks different. Each theme pairs its rock with a contrasting neon.
- **Even glow**: theme neon values set hue only. `evenGlow()` rescales each to the same perceived brightness (`NEON_LUMA` 1.4, Rec. 709 luma), because at equal channel values yellow and green read far brighter than blue and would wash a cave out in bloom.
- **Fixed colours** (`COLORS`): lights, ship, pod, fixtures (including the reactor core's base + pulse-swing pairs), bullets, effects, the ember ramp, rock-tile accents, minimap and UI.
- **UI**: `applyUiColors()` writes `COLORS.ui` into CSS custom properties at startup. `styles.css` derives every tint from those with `color-mix(in srgb, var(--cyan) 35%, transparent)` and so on, so the UI re-themes from `palette.ts` too. The CSS keeps the same values as fallbacks, so the splash is right before JS runs.

## 10. Quality tiers, performance and stutter

### 10.1 Tiers (`tier.ts`)

A reduced version of the sibling voxel-planet project's scheme, with four tiers:

| Tier          | Typical hardware                                                                                 | DPR | MSAA | Bloom | Shadows | Bump | Dust | Particles | Build ms |
| ------------- | ------------------------------------------------------------------------------------------------ | --- | ---- | ----- | ------- | ---- | ---- | --------- | -------- |
| `high`        | desktop discrete GPU (GTX 1650+, RTX, RX), Apple Silicon Mac                                     | 2   | 4×   | ✓     | 4096    | ✓    | 500  | 3000      | 8        |
| `mobile-high` | Galaxy S22 class (Adreno 7xx, Xclipse), Mali-G710+, every WebGL2 iPad / iPhone                   | 1.5 | 2×   | ✓     | 1024    | ✓    | 200  | 2000      | 5        |
| `mid`         | Iris Xe, Radeon / Vega iGPU, Arc iGPU, GTX 1050 / MX; 2019–21 phones (Adreno 630–6xx, Mali-G76+) | 1.5 | 2×   | ✓     | –       | –    | –    | 2000      | 5        |
| `low`         | Intel UHD / HD, budget phones (Adreno < 630, Mali-G5x), software GL, ≤ 2 GB RAM                  | 1   | –    | –     | –       | –    | –    | 900       | 3        |

- `detectTier()` opens a throwaway WebGL2 context with `powerPreference: 'high-performance'` (the same as the real renderer, so hybrid laptops are judged on the GPU actually used), reads `UNMASKED_RENDERER_WEBGL`, and releases the context. It returns `'none'` without WebGL2, and boot then explains why instead of failing obscurely.
- Mobile is detected by user agent, plus `maxTouchPoints > 1` on a "Macintosh" UA (iPadOS). Safari reports every Apple GPU as "Apple GPU", so all iPads and iPhones get mobile-high and the governor catches the oldest.
- `classifyGpu(probe)` is pure and asserted against real renderer strings back to about 2017–19 (GTX 1050, MX250, UHD 620, Vega 8, Galaxy S10 Adreno 640 / Mali-G76, budget Adreno 618 / Mali-G52) as well as current devices (§15). `?tier=high|mobile-high|mid|low` overrides it.

### 10.2 The frame-time governor (`main.ts`)

The tier is a guess; the governor corrects it on the device. While playing, it keeps an exponential average of the real frame interval. If that stays above **26 ms for 2 s**, it calls `View.degrade()`, which drops one step of cost: DPR −0.25 down to 1, then shadows (materials are flagged for recompile once), then bloom. After each step, and after each new planet (while rock streams in), it waits a **3 s grace** before judging again. It never steps back up, so quality can't oscillate. Frames after a pause or tab switch (> 250 ms) are ignored.

### 10.3 Stutter and freeze avoidance

- **Shader warm-up**: `View.warmup()` makes every normally-hidden object visible (flame, shield, rod, beam, shockwave rings, one debris instance), runs `renderer.compileAsync` plus one composer render (post-processing programs and targets), then restores visibility. Without it, the first thrust, shield or explosion would stall on a shader compile mid-game.
- **Streamed rock** (§7.2): planet changes cost a few milliseconds per frame instead of one long freeze.
- **Shared materials** across planets: no recompiles on a new planet.
- **No per-frame allocation** in `View`, `Effects` or the bullet update, which keeps the garbage collector quiet.
- **HUD writes only on change** (`hud.ts`): identical text or style writes still trigger style recalculation, which shows up as jank on phones.
- **Minimap at 15 Hz**, not every frame.
- **Lost WebGL context** (GPU reset, driver update, memory pressure on phones): reload once automatically; a second loss within a minute shows a message instead of looping.

## 11. Input (`input.ts`)

All devices feed one `Input`:

- **Keyboard**: `KEYS` maps `KeyboardEvent.code` to a field. Codes are layout-independent (WASD works on AZERTY as the physical keys); arrows, WASD and Z/X are all bound; mapped keys `preventDefault` (no scrolling, no pressing a focused button). Game commands (pause, restart, mute, minimap) are handled separately in `main.ts`.
- **Touch buttons** (`#touch [data-k]`: ◎ shield, ● fire, ▲ thrust): `pointerdown` with `setPointerCapture` sets the field; `pointerup` / `pointercancel` clear it, so sliding a thumb off still releases.
- **Stick** (`#joy`, the left half): a nipplejs **dynamic** joystick that appears where the thumb lands. It aims **absolutely**: `steer(a)` computes the target heading from the stick vector and presses left / right until the nose is within 0.06 rad of it. Pushes under 25% are ignored; over **75% also thrusts**, so one thumb flies while the other fires and shields. `steer()` returns a _copy_ of the held state OR'd with the stick, so the stick never cancels a held key or button.
- `clearInput()` releases everything on window blur (no stuck thrust after alt-tab).
- `HELP` holds the device's `[key, action]` rows (`(pointer: coarse)` picks touch or keyboard). main.ts renders it into the splash hint line and pause dialog, so help and bindings live side by side.

## 12. UI: splash, HUD, minimap, pause / game over

Plain DOM over the canvas, styled by `styles.css` from palette-driven CSS variables, with Orbitron for display text.

- **Splash** (`#boot`) follows voxel-planet's boot screen, rethemed: a deep-space gradient with twinkling CSS stars and a masked cyan scan grid, and an emblem of the ship outline inside two counter-rotating orbit rings with the amber pod circling (the favicon is the same emblem). Below come the title, a rule with a diamond, and the tagline. The bar tracks **real boot steps** (§14.3); then `#boot.ready` shows the launch button, best score and control hints, and the backdrop goes translucent over the live attract scene.
- **HUD** (`hud.ts`): score, "Planet n: Name", ships, fuel bar (blinks red under 20), reactor HP bar, critical countdown, and a fading message line. It's `pointer-events: none`.
- **Minimap** (`minimap.ts`, bottom right): the planet is baked once per level into an offscreen canvas at 1 px per cell (rock shaded by depth, edges cyan, sky clear) and blitted with nearest scaling, so it stays pixel-crisp like the voxels. Markers on top: fuel (green), live turrets (red), reactor (amber; red strobe when critical), pod (amber), ship (white, with a cyan heading tick) and a faint box for the camera's view. It's a 2D canvas only, at device pixel ratio, redrawn at 15 Hz. It **collapses to a map icon only when the screen can't spare the room** (open needs about 600 × 504 CSS px), so phones in either orientation start iconified and tablets and desktops start open. It re-checks on resize and rotation until the player toggles it (N or click / tap), after which their choice sticks. On touch screens it sits under the pause button, clear of the thumb buttons. It doesn't take focus on press, so Space can't toggle it.
- **Pause** (`#pause`) follows voxel-planet's pause dialog: a blurred backdrop and a panel with Resume (Esc), Restart (R) and Sound (M), plus the device's bindings and a short how-to. The same dialog is the **game-over** screen via `data-kind="over"`. The best score persists in `localStorage['tf-best']`.
- **Accessibility basics**: `role="dialog"`, `aria-modal`, `aria-labelledby`, `aria-live` messages, labelled buttons, focus moved into the dialog, visible focus outlines, and `prefers-reduced-motion` stops the splash animation.

## 13. Audio (`audio.ts`)

- The `AudioContext` is created by `unlock()` on the first user gesture (launch or resume), as browsers require; before that every call is a no-op.
- `tone()` is an oscillator with an exponential pitch glide and decay. `noise()` plays a slice of a shared 2 s noise buffer through a low-pass sweeping down to 60 Hz, which gives explosions their tail. The engine is a looping noise source through a 420 Hz low-pass whose gain eases with `setTargetAtTime`, so it never clicks.
- `sfx` has one entry per `GameEvent`. Mute is a master gain of 0, persisted in `localStorage['tf-muted']`. `suspendAudio()` suspends the context when the loop idles.

## 14. Frame loop, idle and boot (`main.ts`)

### 14.1 Frame

`requestAnimationFrame` → `dt = min(Δ, 1/20)`: when active, `game.update(dt, steer(a))` → `drawHud` → minimap (15 Hz) → governor; then the engine sound and `view.sync(game ?? attract, paused ? 0 : dt)`. Below 20 fps the game runs in slow motion rather than tunnelling through walls; the 120 Hz fixed step inside `Game` does the rest.

### 14.2 Idle

When nothing is simulating (splash, paused, game over), the loop keeps drawing for `SETTLE` = 1.5 s so the camera, particles and debris come to rest, then **stops requesting frames** and suspends audio: no GPU or CPU work while idle. `wake()` restarts it on any key, pointer, wheel or resize, a pause toggle or launch. A hidden tab or minimised window pauses a running game.

### 14.3 Boot

An async sequence with a frame yield between steps, so the bar paints and the page stays responsive:

1. **Igniting engines**: `detectTier()` (or a no-WebGL2 message), `new View`, context-loss watch.
2. **Charting planet 1**: the attract `Game`.
3. **Building caves**: first `sync` (cheap parts) + `pump(Infinity)` (all rock, hidden behind the splash).
4. **Warming shaders**: `view.warmup()`.

Any error lands in the splash subtitle with a hint (`?tier=low`).

## 15. Checks and tooling

- **`npm run check`** (`scripts/check.ts`, Node's native TypeScript; `ts-resolve.mjs` adds `.ts` to extensionless imports) asserts:
    1. Planets **1–50**: a flood fill through cells with a full 3 × 3 of air (ship-sized) reaches the pod and reactor from the start; turrets and fuel sit in air; there are at least two turrets; generation is deterministic.
    2. The rod holds its length to 1e-9 over 2000 steps of falling and sideways thrust.
    3. A tilted idle ship falls, crashes once, loses a life and respawns.
    4. Grabbing the pod from closer than the rod length doesn't crash and lifts it; carrying it above `exitY` completes the planet, pays the bonus and loads planet 2.
    5. GPU renderer strings for current and about 7-year-old devices map to the expected tiers.
    6. All eight block types appear; topsoil only on the surface skin; ore and crystal only on air-facing cells.
    7. Difficulty never eases from one planet to the next, saturates at planet 50, and planet 1 is roomy.
    8. Theme names are distinct within a cycle, themes wrap, and `evenGlow` lands every neon on `NEON_LUMA`.
    9. The 50 hand-picked names are unique, every name is one capitalised word, and generated names are stable.
- **`python scripts/smoke.py [out_dir] [tier]`**: Playwright (Chromium on SwiftShader) against `npm run preview`. Desktop: thrust, rotate, fire, pause / resume, and the loop **idling** while paused and waking on resume. Emulated 412 × 860 touch phone: the nipplejs stick (steer, then full push → thrust), holding ◎ and ▲ and verifying release. It fails on any page error and saves screenshots. Software GL runs at a few fps, so every check **polls** game state through `window.__game` / `window.__running` instead of sleeping, and boot waits up to 3 minutes (the high tier in software is slow).
- **`npm run typecheck`** and **`npm run format`** (Prettier with the repo's `.prettierrc`).

## 16. Build and deployment

- `npm run build` = `tsc --noEmit && vite build`. `dist/` holds ≈ 75 kB of game JS (≈ 27 kB gzipped) plus a ≈ 580 kB three.js chunk (≈ 150 kB gzipped), split so browsers keep three.js cached across game updates.
- `vite.config.ts` sets `base: '/thrust-force/'` to match `https://<user>.github.io/thrust-force/`. If you rename the repo, change `base`.
- `.github/workflows/deploy-pages.yml` runs on every push to `main` (or manually): checkout → Node 22 → `npm ci` → `npm run build` → upload `dist` → `actions/deploy-pages`. In the repo settings, set Pages → Source to **GitHub Actions**.
- Licence: MIT (`LICENSE`).

## 17. Tuning reference

Feel constants are in `CFG` (`game.ts`); per-planet scaling is in `difficulty()` (§5.1); visual budgets are in `TIER_SETTINGS` (§10.1); colours are in `palette.ts` (§9).

| Constant                    | Value             | Effect                                      |
| --------------------------- | ----------------- | ------------------------------------------- |
| `thrust`                    | 15 u/s²           | engine power (vs gravity 2.4 → 7.2)         |
| `turn`                      | 4.3 rad/s         | rotation speed                              |
| `drag`                      | 0.04 /s           | how long momentum lasts                     |
| `fuelMax`                   | 100               | tank size                                   |
| `thrustBurn` / `shieldBurn` | 4.5 / 8 per s     | fuel economy                                |
| `rodLen`                    | 4.5               | default rod length (actual = grab distance) |
| `podMass`                   | 1.6               | pod weight relative to the ship             |
| `grab`                      | 5.5               | tractor reach for the pod                   |
| `bulletSpeed` / `reload`    | 24 / 0.17 s       | player gun                                  |
| `reactorTime`               | 10 s              | escape window                               |
| `stun`                      | 4 s               | turret silence per reactor hit              |
| `MAX_DIFFICULTY_AT`         | 50                | planet where the curve reaches full         |
| `NEON_LUMA`                 | 1.4               | perceived brightness of every theme's neon  |
| `CHUNK` / `MARGIN`          | 24 / 12 rows      | rock streaming slice size / extra rock      |
| governor                    | 26 ms · 2 s · 3 s | slow threshold · sustain · grace            |

## 18. Known limits and extension points

- **No two-player mode yet.** Gravity Force's split-screen dogfight would fit the architecture: two ships in `Game`, two `Input`s, and two viewports via `renderer.setScissor`.
- **No checkpoints**: respawn is always at the entrance. A checkpoint would update `start` when passing switchbacks.
- **Indestructible terrain**: bullets stop at rock. Destructible cells would need a `grid` write plus rebuilding that cell's chunk (chunks make this cheap now).
- **The governor only steps down.** Stepping back up would need hysteresis to avoid flapping.
- **Themes cycle every 24 planets**; to theme by something else (difficulty band, depth), change `themeFor()`.
- **Test hooks** `window.__game` / `window.__running` are read-only getters for the smoke test. They're harmless in production and expose nothing that isn't already in memory.
