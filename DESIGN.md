# Thrust Force: Design

This document covers how the game is built: module layout, data model, generation, physics, rendering, input, UI, quality tiers, tooling and deployment. The [README](README.md) covers what the game is and how to play it.

## Contents

1. [Goals and constraints](#1-goals-and-constraints)
2. [Stack and project layout](#2-stack-and-project-layout)
3. [Architecture](#3-architecture)
4. [Coordinate system and the grid](#4-coordinate-system-and-the-grid)
5. [Level generation (`level.ts`)](#5-level-generation-levelts)
6. [Game rules and physics (`game.ts`)](#6-game-rules-and-physics-gamets)
7. [Rendering (`view.ts`)](#7-rendering-viewts)
8. [Quality tiers (`tier.ts`)](#8-quality-tiers-tierts)
9. [Input: keyboard, touch buttons, nipplejs stick](#9-input-keyboard-touch-buttons-nipplejs-stick)
10. [UI: splash, HUD, pause / game over](#10-ui-splash-hud-pause--game-over)
11. [Audio (`audio.ts`)](#11-audio-audiots)
12. [Frame loop and timing](#12-frame-loop-and-timing)
13. [Checks and tooling](#13-checks-and-tooling)
14. [Build and deployment](#14-build-and-deployment)
15. [Tuning reference](#15-tuning-reference)
16. [Known limits and extension points](#16-known-limits-and-extension-points)

---

## 1. Goals and constraints

- **The genre's core feel**: rotation, thrust, gravity and momentum, with a heavy pod on a rigid rod. Everything else exists to stress that feel.
- **Original content**: levels are procedural, and the art, sound and names are new. Classic Amiga thrust games inspired the mechanics only.
- **Small and boring code**: about 1,600 lines of TypeScript in seven modules. No game engine, no ECS, no physics library. Rules are plain functions over plain objects.
- **Testable core**: the simulation (`level.ts`, `game.ts`, `tier.ts` classifier) imports nothing from three.js or the DOM, so it runs headless under Node.
- **Everywhere**: GitHub Pages static hosting, desktop and mobile, quality scaled per GPU.

## 2. Stack and project layout

| Piece      | Choice                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------- |
| Rendering  | three.js r185 (`WebGLRenderer`, `EffectComposer`, `UnrealBloomPass`, `OutputPass`)            |
| Language   | TypeScript 5, `strict`, ES2022 modules, bundler resolution                                    |
| Build      | Vite 8 (`base: '/thrust-force/'`, three.js split into its own chunk)                          |
| Touch      | nipplejs 1.x (dynamic joystick)                                                               |
| Sound      | WebAudio, synthesised at runtime (no assets)                                                  |
| Fonts      | Orbitron (display) and Inter (body), from Google Fonts                                        |
| Checks     | Node's native TypeScript runner + `node:assert`; Python Playwright for the browser smoke test |
| Formatting | Prettier (4-space, single quotes, 120 columns)                                                |

```
index.html            DOM shell: #app canvas host, #hud, #joy, #touch, #boot splash, #pause dialog
src/
  main.ts             composition root: boot sequence, input, HUD, pause, frame loop, event routing
  game.ts             rules + physics (pure)
  level.ts            seeded cave generator + grid queries (pure)
  view.ts             three.js scene, meshes, particles, camera, post-processing
  tier.ts             GPU classification + per-tier quality table (classifier is pure)
  audio.ts            WebAudio synth
  styles.css          theme variables, HUD, splash, pause, touch layout
scripts/
  check.ts            headless asserts (npm run check)
  smoke.py            Playwright browser smoke test (desktop + emulated phone)
  ts-resolve.mjs      Node resolve hook: lets scripts import extensionless src/ modules
.github/workflows/deploy-pages.yml   build + deploy to GitHub Pages on push to main
```

## 3. Architecture

The design follows one rule: **simulation and presentation don't share state they both write.**

```
         keyboard / touch / stick
                    │
                    ▼
 main.ts ── Input ──► Game.update(dt, input) ──► Game state (plain objects)
    ▲                       │                          │
    │                 onEvent(e, x, y)                 │ read-only
    │                       ▼                          ▼
    └──── audio.ts sfx ◄── main.ts ──► view.burst() ── View.sync(game, dt) ──► WebGL
```

- **`Game`** owns all mutable gameplay state: ship, pod, bullets, fuel, score, lives, phase, reactor and level entities. It advances only through `update(dt, input)`.
- **`View`** reads a `Game` every frame and poses meshes to match. It never writes game state. When `game.level` changes identity (new planet or level reset), it rebuilds the level meshes.
- **Events** carry the one-way information `View` can't infer by polling, such as explosions, shots and pickups. `Game.onEvent(e, x, y)` is a single callback. `main.ts` maps each event to a sound (`sfx[e]`) and an optional particle burst (the `BURSTS` table).
- **`Input`** is a five-boolean record (`left, right, thrust, fire, shield`). The game never sees devices. The touch stick is converted to the same booleans in `main.ts` (see §9).

This split makes the logic checkable without a browser, and it lets the title screen draw a live, idle "attract" `Game` with the same `View`.

## 4. Coordinate system and the grid

- 1 grid cell = 1 world unit. `x` grows right and `y` grows up; row 0 is the bottom of the planet.
- A level is a `Uint8Array` of `w × h` cells, `1` = rock and `0` = air, indexed `grid[y * w + x]`.
- `w = 96` always. `h = min(120 + 22n, 280) + 34`, where the top 34 rows are open sky.
- `solidAt(lv, x, y)` is the only collision primitive. Points **above** the grid are air (the exit), and points left, right or below the grid are rock. Three columns on each side (`WALL = 3`) are never carved, so the playfield is walled all the way up, sky included.
- `lineOfSight(lv, a, b)` samples the segment every 0.5 units with `solidAt`. Turrets use it to decide whether they can see the ship.
- The three.js scene uses the same coordinates. Rock voxels sit at `(x + 0.5, y + 0.5, 0)` and are 3 deep (z ∈ [−1.5, 1.5]). Everything gameplay-relevant lives on the z = 0 plane.

## 5. Level generation (`level.ts`)

`generateLevel(n)` is deterministic: a mulberry32 PRNG seeded with `n * 7919 + 1337`. The steps run in this order:

1. **Fill** the grid with rock.
2. **Surface**: a two-sine heightline (`base + 4·sin(0.09x + p1) + 2.2·sin(0.23x + p2)`, with random phases). Everything above it inside the walls becomes air.
3. **Chamber**: an ellipse (rx 22, ry 10) centred at a random `cx`. Below `floorY = 8` it is refilled with rock and a 35 × 6 box is cleared above it, which gives a **flat floor**. The pod is placed at `cx − 9.5` and the reactor at `cx + 9.5`.
4. **Shaft waypoints**: start at the entrance (`ex`, just under the surface), then `min(3 + n, 10)` waypoints that alternate between the left (12–42% of the width) and right (58–88%) of the planet. Their heights are evenly spaced from `top − 8` down to `floorY + 22`. A final waypoint sits in the chamber.
5. **Carve** each segment as a stroke of discs every 0.5 units. The radius is `max(2.7, rBase + 1.1·sin(0.35t + 1.7i))` with `rBase = max(2.9, 4.4 − 0.15n)`. The wobble gives the tunnel organic pinches, and the 2.7 floor guarantees a ship-sized passage (see the check in §13). There is a 60% chance of a **side pocket** (an ellipse 6 × 3.2) off each intermediate waypoint, on the outer side.
6. **Mount points**: scan for 3-wide flat floors (rock row below, three rows of air above) and ceilings (the mirror image).
7. **Placement**: `pick()` shuffles a candidate list and takes points greedily, keeping a minimum spacing from everything already placed. The start, entrance, pod and reactor are pre-seeded in the `taken` list, so nothing spawns on top of them.
    - Turrets: `min(3 + 2n, 22)`, with 65% on floors and the rest on ceilings. Ceiling turrets are kept below the surface. Each has `up` (orientation), `alive` and a randomised first `cooldown`.
    - Fuel cells: `2 + ceil(n / 2)`, inside the planet, 35 units each.
8. **Difficulty scalars**: `gravity = min(3.2 + 0.45n, 8)`, `reactorHp = 10 + 2n`, `exitY = h − 3`.

The `Level` object also holds the **mutable entity state** for that playthrough (turrets `alive`/`cooldown`, fuel `amount`). Resetting a level means calling `generateLevel(n)` again, which is cheap (a few ms).

## 6. Game rules and physics (`game.ts`)

### 6.1 Fixed timestep

`update(dt)` accumulates real time (capped at 0.25 s, so a stalled tab can't spiral) and runs `step(1/120)` as many times as needed. All physics are explicit Euler at 120 Hz. That rate is stable for the stiff rod constraint and deterministic per step, which makes behaviour independent of the display refresh rate.

### 6.2 Phases

`phase` is one of:

| Phase      | Meaning                     | Exit                                                                                  |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `play`     | normal flight               | death → `dead`; leave through the sky with the pod or a critical reactor → `complete` |
| `dead`     | 2.2 s explosion pause       | lives left → `respawn()` (or `load(n)` if the reactor was critical); none → `over`    |
| `complete` | 3.2 s victory pause         | `load(n + 1)`                                                                         |
| `over`     | final; main.ts shows dialog | a new `Game` is created by main.ts                                                    |

Bullets keep flying during the pauses, so explosions and stray shots finish naturally.

### 6.3 Ship flight

State is `{x, y, vx, vy, a}`, where `a` = 0 means the nose points up and positive `a` is counter-clockwise. The nose direction is `(−sin a, cos a)`.

Per step:

- Rotate at ±`turn` (4.3 rad/s).
- `thrusting = input.thrust && fuel > 0` and `shielding = input.shield && fuel > 0`. Fuel burns 4.5/s for thrust and 8/s for the shield.
- Acceleration is thrust (15 u/s²) along the nose, minus gravity. Velocity gets a light linear drag (4%/s) so the ship eventually settles. Then the position integrates.

### 6.4 Tow rod (two-body constraint)

`rod(a, ma, b, mb, len)` is a rigid distance constraint between the ship (mass 1) and the pod (mass `podMass` = 1.6), solved by inverse-mass weighting:

1. **Position projection**: move both bodies along the rod normal `n` by `(d − len) / (wa + wb)`, scaled by each body's inverse mass `w = 1/m`. The heavier pod moves less.
2. **Velocity projection**: remove the relative velocity along `n` with the same weighting. This makes the rod perfectly rigid (it neither stretches nor compresses) while leaving tangential motion free, so the pod swings like a pendulum and its momentum yanks the ship around.

When attached, the pod integrates gravity itself, then `rod()` runs. The rod length is set to **the distance at the moment of grabbing** (min 2). A fixed length would yank a pod resting on the floor straight into the floor, or drag the ship onto it. `check.ts` has a regression test for this.

### 6.5 Tractor beam and shield

These share one button. While `shielding`:

- If the pod is unattached and within `grab` (5.5), it latches (`attach` event).
- The first fuel cell below the ship within 4.5 units drains at up to 40/s into the tank. `beam` is set so the view can draw the beam, and an empty cell pays 300 points and fires a `fuel` event.
- Enemy bullets that reach the ship are absorbed.

### 6.6 Weapons and turrets

- The player fires from the nose at ship velocity + 24 u/s along the nose, with 0.17 s reload and a 1.4 s bullet life.
- A turret fires when its cooldown expires, the ship is within 30 units, the ship is in the turret's hemisphere (floor turrets don't shoot down, ceiling turrets don't shoot up), and `lineOfSight` is clear. It aims straight at the ship with ±0.075 rad of spread. Bullet speed is `10 + 0.6n` and the interval is `max(0.9, 3.2 − 0.2n)` × a random 0.7–1.3.
- **Stun**: every reactor hit sets `stun = 4 s`, during which no turret fires. This is the main tactical lever: chip at the reactor to get breathing room.

### 6.7 Reactor

`reactorHp` starts at `level.reactorHp`. A player bullet within 1.8 units of the reactor's core (`reactor.y + 1`) costs 1 HP, pays 50 points and stuns the turrets. At 0 HP, `critical = 10` seconds and a `critical` event fires. An `alarm` event fires every whole second. If the countdown reaches 0 while the ship is still on the planet, you die and the level is rebuilt on respawn (`resetLevel`).

### 6.8 Collisions and landing

The ship hull is six local points (nose, two nose-side midpoints, two rear corners, rear centre), rotated into world space by `hull()`. If any point is in rock:

- **Landing** when speed < 5, `|a| < 0.45` rad (upright) and `vy ≤ 0.5`, **and** none of the three front points touch. The ship is nudged up in 0.02 steps until clear, `vy` is zeroed, `vx` is damped and the angle eases towards upright. A `land` event fires if it came down faster than 1 u/s.
- Otherwise **crash**.

Other deaths: touching a live turret (< 1.3) or the reactor (< 2.4), an unshielded enemy-bullet hit (< 1), or an attached pod in rock. The pod is tested with 8 points on a 0.55 circle, and it rests 0.75 above the floor, so it starts clear.

Player bullets hit, in priority order: rock (spark), turret (< 0.9; 750 points, `boom`), fuel cell (< 0.8; 150 points, destroys the fuel), then the reactor.

### 6.9 Exiting and scoring

When `ship.y > exitY`:

- with the pod and/or a critical reactor, the level completes. The pod is worth `4000 + 500n` and a destroyed planet `3000 + 500n`; both can be earned together.
- with neither, a soft ceiling 2 units higher stops the ship and a "Recover the pod first" hint is shown (throttled to once every 2 s).

An extra ship is awarded every 10,000 points. Respawn puts the ship at the entrance with its velocity and angle zeroed, returns a carried pod to its pedestal, and refills fuel to at least 40.

## 7. Rendering (`view.ts`)

### 7.1 Scene and look

- **Camera**: perspective, 50° FOV, z = 34 (z = 30 / aspect on portrait screens, so the playfield width stays usable on phones). It chases `ship + 0.3·velocity` with exponential smoothing (`1 − e^(−4dt)`). The camera sits 4 units **below** its look-at point, so floors show their top faces and tunnels read as 3D. A `shake` value (raised by big bursts and a critical reactor, decaying as `e^(−3dt)`) jitters the look-at target.
- **Lights**: a hemisphere light (cool sky / warm ground), a directional "sun" from the upper-left-front, a cyan point light riding 7 units in front of the ship (brighter while thrusting), and a pulsing orange/red point light in the reactor.
- **Tone mapping**: ACES Filmic. "Neon" materials use `toneMapped: false` with HDR colours (channels above 1), so they reliably cross the bloom threshold (0.82) while lit surfaces mostly don't. That one rule decides what glows.
- **Palettes**: six per-planet palettes (`deep`, `top`, `surf` rock colours, a `neon` edge colour and a `sky` background), cycled by `(n − 1) % 6`.

### 7.2 Level meshes (rebuilt when `game.level` changes)

- **Rock**: one `InstancedMesh` of 1×1×3 boxes, one instance per solid cell (≈15–25k). The colour lerps `deep → top` by height with a hash-based ±9% lightness jitter, so the voxels read individually. Cells on the surface skin get `surf`.
- **Neon edges**: a second `InstancedMesh` of thin bars (1.04 × 0.1 × 0.1) at z = 1.52, one per solid-cell side that faces air. This outlines every cave wall in glowing light, which is the game's signature look.
- **Back wall**: a `ShapeGeometry` traced along the surface heightline at z = −1.45. It fills the tunnels' backs with dark rock while leaving the sky open.
- **Stars**: a `Points` cloud (count from the tier) far behind (z −40…−80) above the planet.
- **Fixtures**: the pod pedestal, turrets (half-dome + glowing eye + barrel, rotated π for ceiling mounts), fuel cells (box + glowing band, scaled by remaining fuel), and the reactor (base, dome, glowing core, chimney, point light).

Old level geometry and materials are disposed before rebuilding.

### 7.3 Per-frame posing (`sync`)

- **Ship**: an extruded, bevelled arrowhead (dark metal) with a neon `EdgesGeometry` outline and a glowing canopy. The flame cone flickers in length while thrusting, and the shield ring spins while shielding.
- **Pod**: a metal orb in an amber torus. The **tow rod** and **tractor beam** are two-vertex `Line`s whose buffers are rewritten in place.
- **Turrets**: visible only while alive. The barrel tracks the ship, clamped to ±1.3 rad from the mount normal.
- **Reactor**: the core pulses gently when stable, dims while the turrets are stunned, strobes red when critical, and disappears at 0.
- **Bullets**: a `Points` layer (max 400) whose position and colour buffers are refilled every frame (cyan for the player, orange for enemies) with `setDrawRange`.
- **Particles**: a pooled `Points` system (capacity from the tier). `burst()` appends particles with a random direction and speed. When the pool is full it overwrites random slots, which is cheaper than a ring buffer and visually identical. Each frame particles integrate (40% gravity), fade by remaining life, and the live ones are **compacted** to the front of the arrays, so the draw range always covers exactly the live set. Thrust exhaust is emitted here too, from the ship's tail with the ship's velocity added.
- Particles and bullets use one canvas-generated radial-gradient sprite with additive blending and `depthWrite: false`.

### 7.4 Post-processing

`EffectComposer`: `RenderPass` → `UnrealBloomPass` (strength 0.85, radius 0.5, threshold 0.82; skipped on the low tier) → `OutputPass` (tone mapping and the sRGB transform).

### 7.5 Shadows (high tier)

The sun casts a 2048² PCF-soft shadow map whose orthographic frustum (±32 units) follows the ship. The sun is repositioned at `ship + (−12, 30, 36)` every frame. Rock casts and receives shadows; the back wall receives; ship, pod, turrets and reactor cast. The visible effect: the ship and pod throw shadows onto the tunnel's back wall, which sells the depth.

## 8. Quality tiers (`tier.ts`)

This is a reduced version of the five-tier scheme in the sibling voxel-planet project. A side-on cave is much cheaper than a streamed planet, so three tiers are enough:

| Tier   | Typical hardware                                                          | DPR cap | MSAA | Bloom | Shadows | Particles | Stars |
| ------ | ------------------------------------------------------------------------- | ------- | ---- | ----- | ------- | --------- | ----- |
| `high` | discrete GPU, Apple Silicon, Apple mobile, Adreno 7xx, Xclipse/Immortalis | 2       | ✓    | ✓     | ✓       | 3000      | 1800  |
| `mid`  | Iris Xe / Arc / Radeon iGPU, Adreno 630–6xx, Mali-G76+                    | 1.5     | ✓    | ✓     | ✗       | 2000      | 1200  |
| `low`  | older Intel UHD/HD, budget phones, SwiftShader/llvmpipe, ≤ 2 GB RAM       | 1       | ✗    | ✗     | ✗       | 900       | 600   |

- `detectTier()` opens a throwaway WebGL2 context with `powerPreference: 'high-performance'` (the same as the real renderer, so hybrid laptops are tiered on the GPU actually used), reads `UNMASKED_RENDERER_WEBGL`, then releases the context with `WEBGL_lose_context`.
- Mobile detection is by user agent, plus `maxTouchPoints > 1` on a "Macintosh" UA (iPadOS).
- `classifyGpu(probe)` is pure and unit-tested. Software renderers and low memory always land in `low`, unknown renderers fall back on core count, and `?tier=high|mid|low` overrides everything.
- main.ts writes the tier to `<html data-tier>` (handy in devtools) and passes `TIER_SETTINGS[tier]` into `View`.

## 9. Input: keyboard, touch buttons, nipplejs stick

All three sources feed the same `Input` record:

- **Keyboard**: the `KEYS` map from `KeyboardEvent.code` to an `Input` field. Codes are layout-independent, so WASD works on AZERTY as the physical keys. Arrow keys, WASD and the Z/X classics are all bound. `preventDefault` stops arrow and space scrolling. The window `blur` event clears all keys (no stuck thrust after alt-tab) and pauses the game.
- **Touch buttons** (`#touch [data-k]`): `pointerdown` with `setPointerCapture` sets the field, and `pointerup`/`pointercancel` clear it. Pointer capture means sliding a thumb off the button still releases it correctly. The buttons have `flex-shrink: 0` and size to fit the right 60% of a 360 px phone.
- **Stick** (`#joy`, the left half of the screen): a nipplejs **dynamic** joystick that appears where the thumb lands. Rotate buttons are awkward for this genre on glass, so the stick is **absolute aim**: `steer()` computes the target heading `atan2(−vx, vy)` from the stick vector and presses `left`/`right` until the nose is within 0.06 rad of it. A dead zone ignores pushes under 25%, and a push over **75% also thrusts**, so one thumb can fly the whole ship while the other fires and shields. `steer()` returns a _copy_ of `input` OR'd with the stick output, so the stick can never cancel a held ▲ button or key.

The touch UI is only shown under `@media (pointer: coarse)`. Help text (splash hint line and pause bindings) is chosen with the same media query in `main.ts` (`KEY_HELP` / `TOUCH_HELP`).

## 10. UI: splash, HUD, pause / game over

The screens are plain DOM over the canvas, styled by `styles.css` CSS variables (`--cyan #66e0ff`, `--amber #ffc85a`, `--hot #ff5a3c` on `--bg #05060f`), with Orbitron for display text.

- **Splash** (`#boot`) follows voxel-planet's boot-screen pattern, rethemed. A radial deep-space gradient carries twinkling CSS-gradient stars and a masked cyan scan grid. The emblem is the ship outline (SVG) inside two counter-rotating orbit rings, with the amber pod circling them. Below it come the title, a rule with a diamond, and the tagline. The progress bar reflects **real boot steps** (`Igniting engines` = create the renderer, `Charting planet 1` = generate the attract level, `Warming shaders` = first `sync` + `renderer.compileAsync`), yielding a frame between steps so it paints. Then `#boot.ready` swaps the bar for the launch button, best score and control hints, and the backdrop goes translucent so the live attract scene shows through. Launching fades it out (`.dismissed`, then `.gone` after 700 ms). WebGL failures are shown in the subtitle. The favicon is the same emblem as an inline SVG.
- **HUD** (`#hud`): score, planet and ships left, fuel bar (blinks red under 20), reactor HP bar, a large countdown when critical, and a fading message line (`game.message` / `messageTime`). It is `pointer-events: none`.
- **Pause** (`#pause`) follows voxel-planet's pause pattern: a blurred backdrop and a panel with Resume (Esc), Restart (R) and Sound (M), plus the device-specific bindings and a short how-to. The same dialog is the **game-over** screen via `data-kind="over"` (the title turns red, Resume is hidden and Restart is highlighted). Clicking the backdrop resumes. The best score persists in `localStorage['tf-best']`.
- **Accessibility basics**: the dialog has `role="dialog"`, `aria-modal` and `aria-labelledby`. Messages are `aria-live`. Buttons have labels, focus moves into the dialog, focus outlines are visible, and `prefers-reduced-motion` stops splash animation.

## 11. Audio (`audio.ts`)

- The `AudioContext` is created lazily by `unlock()` on the first user gesture (launch or resume), as browsers require. Every sound call is a no-op before that.
- `tone(freq, dur, type, vol, to)` is an oscillator with an exponential pitch glide and decay. `noise(dur, vol, cutoff)` plays a slice of a shared 2 s white-noise buffer through a low-pass filter that sweeps down to 60 Hz, which gives explosions their "boom" tail.
- The engine is one looping noise source through a 420 Hz low-pass. Its gain eases towards 0.35 or 0 (`setTargetAtTime`) from `setEngine(thrusting)` every frame, so it never clicks.
- `sfx` has one entry per `GameEvent`, so `main.ts` can call `sfx[e]()` directly. Mute is a master gain at 0, persisted in `localStorage['tf-muted']`.

## 12. Frame loop and timing

`requestAnimationFrame` → `dt = min(Δ, 1/20)`:

1. If playing and not paused: `game.update(dt, steer(game))`, then the HUD is redrawn.
2. The engine sound follows `game.thrusting`.
3. `view.sync(game ?? attract, paused ? 0 : dt)` poses and renders. With `dt = 0` the scene still renders (behind the blurred pause dialog) but particles and the camera freeze.

The 1/20 cap means that below 20 fps the game runs in slow motion rather than tunnelling through walls. The 120 Hz fixed step inside `Game` does the rest.

## 13. Checks and tooling

- **`npm run check`**: `scripts/check.ts` under Node's native TypeScript support. `ts-resolve.mjs`, copied from voxel-planet, adds `.ts` to extensionless relative imports. It asserts:
    1. For planets 1–12, a flood fill that only enters cells with a full 3×3 of air reaches the pod and reactor from the start, so a real ship can always get there. It also checks that every turret and fuel cell sits in air, that there are at least 3 turrets, and that generation is deterministic.
    2. The rod holds its length to 1e-9 over 2000 steps while both bodies fall and the ship accelerates sideways.
    3. A tilted idle ship falls, crashes once, loses a life and respawns.
    4. Grabbing the pod from a hover closer than the rod length doesn't crash, and the pod lifts. Moving above `exitY` with it completes the level, pays the bonus and loads planet 2.
    5. A table of real GPU renderer strings maps to the expected tiers.
- **`python scripts/smoke.py [out_dir] [tier]`**: Playwright with Chromium on SwiftShader, against `npm run preview`. On desktop it drives thrust, rotate, fire and pause/resume. In an emulated 412×860 touch phone it drags the nipplejs stick (steer, then full push → thrust) and holds ◎ and ▲, then verifies the release. It fails on any page error and saves screenshots. Software GL runs at a few fps, so every assertion **polls** game state through `window.__game` (a read-only getter) instead of sleeping.
- **`npm run typecheck`** and **`npm run format`** (Prettier).

## 14. Build and deployment

- `npm run build` = `tsc --noEmit && vite build`. The output in `dist/` is ≈ 26 kB of game JS plus a ≈ 580 kB three.js chunk (≈ 150 kB gzipped), split so browsers cache three.js across game updates.
- `vite.config.ts` sets `base: '/thrust-force/'` to match the GitHub Pages project URL `https://<user>.github.io/thrust-force/`. Rename the repo → change `base`.
- `.github/workflows/deploy-pages.yml` runs on every push to `main` (or manually): checkout → Node 22 → `npm ci` → `npm run build` → upload `dist` → `actions/deploy-pages`. In the repo settings, set Pages → Source to **GitHub Actions**.
- Licence: MIT (`LICENSE`).

## 15. Tuning reference

All feel constants live in `CFG` in `game.ts`, and per-level scaling lives in `generateLevel`:

| Constant                    | Value                              | Effect                                      |
| --------------------------- | ---------------------------------- | ------------------------------------------- |
| `thrust`                    | 15 u/s²                            | engine power (vs gravity 3.65 → 8)          |
| `turn`                      | 4.3 rad/s                          | rotation speed                              |
| `drag`                      | 0.04 /s                            | how long momentum lasts                     |
| `fuelMax`                   | 100                                | tank size                                   |
| `thrustBurn` / `shieldBurn` | 4.5 / 8 per s                      | fuel economy                                |
| `rodLen`                    | 4.5                                | default rod length (actual = grab distance) |
| `podMass`                   | 1.6                                | pod weight relative to the ship             |
| `grab`                      | 5.5                                | tractor reach for the pod                   |
| `bulletSpeed` / `reload`    | 24 / 0.17 s                        | player gun                                  |
| `reactorTime`               | 10 s                               | escape window                               |
| `stun`                      | 4 s                                | turret silence per reactor hit              |
| gravity                     | `min(3.2 + 0.45n, 8)`              | per planet                                  |
| turrets                     | `min(3 + 2n, 22)`                  | per planet                                  |
| shaft radius                | `max(2.9, 4.4 − 0.15n)`, floor 2.7 | tunnel tightness                            |

## 16. Known limits and extension points

- **No two-player mode yet.** Gravity Force's split-screen dogfight would fit the architecture: two ships in `Game`, two `Input`s, and two viewports via `renderer.setScissor`.
- **No checkpoints**: respawn is always at the entrance. A checkpoint would be a `start` update when passing waypoints.
- **Indestructible terrain**: bullets stop at rock. Destructible cells would need a `grid` write plus an instance-matrix update for that cell and its neighbours' edge bars.
- **Particle pool overwrite** is random when saturated. That's fine visually; switch to a ring buffer if it ever matters.
- **Level rebuild** regenerates every mesh, about 25k instances, in a few ms. It's fine between levels, but don't do it per frame.
- **Test hook** `window.__game` is a read-only getter used by the smoke test. It's harmless in production and exposes nothing that isn't already in memory.
