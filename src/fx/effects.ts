/**
 * Fx — transient visual effects: sparks, voxel explosions (ember debris, shockwave rings, flash
 * light), thrust exhaust and cave dust.
 *
 * Purpose
 *   Everything short-lived or ambient that reacts to game events but isn't the level or the
 *   ship itself. Split out of view.ts so View stays scene + level + camera.
 *
 * Operations
 *   - Effects(scene, tierSettings): builds the pooled objects once (spark Points, debris
 *     InstancedMesh, 6 rings, flash PointLight, optional dust Points) and adds them to the scene.
 *   - burst(x, y, n, speed, rgb, life): n sparks in random directions.
 *   - exhaust(x, y, vx, vy): one spark shot backwards out of the engine.
 *   - explode(x, y, big): layered voxel explosion — wall flash, white-hot / amber / red / neon
 *     sparks, two shockwave rings, and tumbling cubes (mostly embers cooling white → amber → red
 *     → soot via COLORS.ember, plus hull-grey and neon chunks) that bounce off rock.
 *   - update(dt, level, camX, camY, inside): integrates and compacts sparks and debris, expands
 *     rings, decays the flash, drifts dust in a box wrapped around the camera (shown only when
 *     inside the planet).
 *   - Dust clumps (every tier, ts.clumps): small clusters of CLUMP_N faint motes that drift as one
 *     and swirl slowly, each tinted from the planet's neon, rock, ore amber or crystal cyan
 *     (recoloured by setNeon / setRockColour). Depth-tested, so rock hides them: caves only.
 *   - setNeon(rgb) per planet; reset() on a new planet; hiddenObjects() for shader warm-up.
 *   - shake: camera-shake amount raised by big effects; View reads and decays it.
 *   - trail(i, x, y, on, hot, dt): two glowing ribbon trails (0 = ship tail, 1 = towed pod),
 *     triangle strips in the planet's neon that taper and fade to the tail, brighter while
 *     thrusting; a jump of over 4 units (respawn) restarts them.
 *   - explode(..., nearRock): blasts against a wall throw ~30% of their cubes in the planet's rock
 *     colour (setRockColour).
 *
 * Usage
 *   View owns one Effects; main.ts reaches it through View.explode / View.burst.
 *
 * Highlights
 *   - Fixed pools, no per-frame allocation: dead sparks / debris are compacted to the front so
 *     the draw range is exactly the live set; when a pool is full, random slots are reused.
 *   - All effect colours are HDR and toneMapped:false, so they bloom; they come from palette.ts.
 *
 * See also: render/view.ts, core/palette.ts (COLORS.fx, COLORS.ember), render/tier.ts (particles, dust);
 * DESIGN.md "7.3 Per-frame posing".
 */
import * as THREE from "three";
import { solidAt, type Level } from "../world/level";
import { COLORS, ramp, type RGB } from "../core/palette";
import type { TierSettings } from "../render/tier";

const C = COLORS;
const MAX_DEBRIS = 400;
/** Engine trail: points kept per ribbon, and the ribbon's half-width at its head. */
const TRAIL_N = 36,
    TRAIL_W = 0.16;
/** Cave dust volume (world units) wrapped around the camera. */
const DUST_BOX: [number, number] = [60, 44];
/** Motes per dust clump, the clump radius, and how faint clumps are (colour scale). */
const CLUMP_N = 8,
    CLUMP_R = 0.7,
    CLUMP_DIM = 0.5;

/** Soft round sprite shared by every Points layer (alpha mask; colour comes from vertices). */
export function dotTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.4, "rgba(255,255,255,0.6)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
}

/** An additive, HDR Points layer with position + colour buffers for max points. */
export function pointsLayer(max: number, size: number, tex: THREE.Texture) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.PointsMaterial({
        size,
        map: tex,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    return pts;
}

export class Effects {
    shake = 0;
    private neon: RGB = [0.4, 1.6, 3];
    // Sparks.
    private sparks: THREE.Points;
    private maxP: number;
    private pv: Float32Array;
    private plife: Float32Array;
    private pcol: Float32Array;
    private pn = 0;
    // Debris.
    private debris: THREE.InstancedMesh;
    private dPos = new Float32Array(MAX_DEBRIS * 3);
    private dVel = new Float32Array(MAX_DEBRIS * 3);
    private dRot = new Float32Array(MAX_DEBRIS * 3);
    private dSpin = new Float32Array(MAX_DEBRIS * 3);
    private dLife = new Float32Array(MAX_DEBRIS * 2); // remaining, total
    private dSize = new Float32Array(MAX_DEBRIS);
    private dTint = new Float32Array(MAX_DEBRIS * 3); // 0,0,0 = ember (cools via COLORS.ember)
    private dn = 0;
    // Rings, flash, dust.
    private rings: { mesh: THREE.Mesh; life: number; max: number; size: number }[] = [];
    private flash = new THREE.PointLight(C.light.flash, 0, 40, 1.4);
    private dust: THREE.Points | null = null;
    // Dust clumps: centres (x, y, z) per clump, mote offsets (radius, angle, z, spin) per mote, a
    // colour source per clump (0 neon, 1 rock, 2 ore, 3 crystal) and a brightness per mote.
    private clumps: THREE.Points;
    private cCentre: Float32Array;
    private cMote: Float32Array;
    private cKind: Uint8Array;
    private cBright: Float32Array;
    private time = 0;
    // Scratch objects for the per-frame path.
    private m = new THREE.Matrix4();
    private q = new THREE.Quaternion();
    private e = new THREE.Euler();
    private p = new THREE.Vector3();
    private s = new THREE.Vector3();
    private c = new THREE.Color();
    private rgb: RGB = [0, 0, 0];
    /** Rock colour of the current planet, mixed into debris from blasts near walls. */
    private rock: RGB = [0.4, 0.35, 0.45];
    /** Ribbon trails (0 = ship, 1 = towed pod): recent positions, newest first, and a heat 0..1. */
    private trails: { mesh: THREE.Mesh; pts: number[]; heat: number }[] = [];

    constructor(scene: THREE.Scene, ts: TierSettings, tex: THREE.Texture) {
        this.maxP = ts.particles;
        this.pv = new Float32Array(this.maxP * 2);
        this.plife = new Float32Array(this.maxP);
        this.pcol = new Float32Array(this.maxP * 3);
        this.sparks = pointsLayer(this.maxP, 0.35, tex);

        this.debris = new THREE.InstancedMesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshBasicMaterial({ toneMapped: false }),
            MAX_DEBRIS
        );
        this.debris.setColorAt(0, new THREE.Color());
        this.debris.count = 0;
        this.debris.frustumCulled = false;

        const ringGeo = new THREE.RingGeometry(0.85, 1, 48);
        for (let k = 0; k < 6; k++) {
            const mesh = new THREE.Mesh(
                ringGeo,
                new THREE.MeshBasicMaterial({
                    toneMapped: false,
                    transparent: true,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false,
                    side: THREE.DoubleSide,
                })
            );
            mesh.visible = false;
            this.rings.push({ mesh, life: 0, max: 1, size: 1 });
            scene.add(mesh);
        }
        scene.add(this.sparks, this.debris, this.flash);

        // Engine trails: triangle-strip ribbons, additive and HDR so they glow, fading to the tail.
        for (let t = 0; t < 2; t++) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 3), 3));
            geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 3), 3));
            const idx: number[] = [];
            for (let i = 0; i < TRAIL_N - 1; i++)
                idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
            geo.setIndex(idx);
            geo.setDrawRange(0, 0);
            const mesh = new THREE.Mesh(
                geo,
                new THREE.MeshBasicMaterial({
                    vertexColors: true,
                    transparent: true,
                    depthWrite: false,
                    blending: THREE.AdditiveBlending,
                    side: THREE.DoubleSide,
                    toneMapped: false,
                })
            );
            mesh.frustumCulled = false;
            this.trails.push({ mesh, pts: [], heat: 0 });
            scene.add(mesh);
        }

        const nc = ts.clumps;
        this.clumps = pointsLayer(nc * CLUMP_N, 0.2, tex);
        this.cCentre = new Float32Array(nc * 3);
        this.cMote = new Float32Array(nc * CLUMP_N * 4);
        this.cKind = new Uint8Array(nc);
        this.cBright = new Float32Array(nc * CLUMP_N);
        for (let c = 0; c < nc; c++) {
            this.cCentre[c * 3] = Math.random() * DUST_BOX[0];
            this.cCentre[c * 3 + 1] = Math.random() * DUST_BOX[1];
            this.cCentre[c * 3 + 2] = -1 + Math.random() * 2;
            this.cKind[c] = Math.floor(Math.random() * 4);
        }
        for (let k = 0; k < nc * CLUMP_N; k++) {
            this.cMote[k * 4] = CLUMP_R * Math.sqrt(Math.random()); // even spread over the disc
            this.cMote[k * 4 + 1] = Math.random() * Math.PI * 2;
            this.cMote[k * 4 + 2] = (Math.random() - 0.5) * CLUMP_R;
            this.cMote[k * 4 + 3] = (0.15 + Math.random() * 0.35) * (Math.random() < 0.5 ? -1 : 1);
            this.cBright[k] = 0.4 + Math.random() * 0.6;
        }
        this.clumps.geometry.setDrawRange(0, nc * CLUMP_N);
        this.recolourClumps();
        scene.add(this.clumps);

        if (ts.dust > 0) {
            const n = ts.dust;
            this.dust = pointsLayer(n, 0.12, tex);
            const dp = this.dust.geometry.attributes.position.array as Float32Array;
            const dc = this.dust.geometry.attributes.color.array as Float32Array;
            for (let k = 0; k < n; k++) {
                dp[k * 3] = Math.random() * DUST_BOX[0];
                dp[k * 3 + 1] = Math.random() * DUST_BOX[1];
                dp[k * 3 + 2] = -1.2 + Math.random() * 2.4;
                const v = 0.25 + Math.random() * 0.5;
                dc[k * 3] = v * C.fx.dust[0];
                dc[k * 3 + 1] = v * C.fx.dust[1];
                dc[k * 3 + 2] = v * C.fx.dust[2];
            }
            this.dust.geometry.setDrawRange(0, n);
            scene.add(this.dust);
        }
    }

    setNeon(rgb: RGB) {
        this.neon = rgb;
        this.recolourClumps();
    }

    /** New planet: drop everything in flight. */
    reset() {
        this.pn = this.dn = 0;
        for (const t of this.trails) t.pts.length = 0;
    }

    setRockColour(rgb: RGB) {
        this.rock = rgb;
        this.recolourClumps();
    }

    /** Tint every clump from its colour source for this planet (on planet change only). */
    private recolourClumps() {
        const col = this.clumps.geometry.attributes.color.array as Float32Array;
        const src = [this.neon, this.rock, C.fx.clumpOre, C.fx.clumpCrystal];
        for (let k = 0; k < this.cBright.length; k++) {
            const rgb = src[this.cKind[Math.floor(k / CLUMP_N)]],
                v = this.cBright[k] * CLUMP_DIM;
            col[k * 3] = rgb[0] * v;
            col[k * 3 + 1] = rgb[1] * v;
            col[k * 3 + 2] = rgb[2] * v;
        }
        this.clumps.geometry.attributes.color.needsUpdate = true;
    }

    /**
     * Feed trail i a new head position. on = the body exists (else the trail drains away); hot =
     * thrusting, which brightens it. A jump of more than 4 units (respawn) restarts the trail.
     */
    trail(i: number, x: number, y: number, on: boolean, hot: boolean, dt: number) {
        const t = this.trails[i];
        t.heat += ((hot ? 1 : on ? 0.3 : 0) - t.heat) * Math.min(1, dt * 6);
        const p = t.pts;
        if (!on) {
            if (p.length) p.splice(-4, 4); // shrink from the tail
        } else if (!p.length || Math.hypot(p[0] - x, p[1] - y) > 4) {
            p.length = 0;
            p.push(x, y);
        } else if (Math.hypot(p[0] - x, p[1] - y) > 0.12) {
            p.unshift(x, y);
            if (p.length > TRAIL_N * 2) p.length = TRAIL_N * 2;
        }
        const n = p.length / 2;
        const pos = t.mesh.geometry.attributes.position.array as Float32Array;
        const col = t.mesh.geometry.attributes.color.array as Float32Array;
        const [r, g, b] = this.neon;
        for (let k = 0; k < n; k++) {
            const a = Math.max(0, k - 1),
                c = Math.min(n - 1, k + 1);
            let dx = p[a * 2] - p[c * 2],
                dy = p[a * 2 + 1] - p[c * 2 + 1];
            const len = Math.hypot(dx, dy) || 1;
            dx /= len;
            dy /= len;
            const f = 1 - k / TRAIL_N;
            const w = TRAIL_W * f;
            pos[k * 6] = p[k * 2] - dy * w;
            pos[k * 6 + 1] = p[k * 2 + 1] + dx * w;
            pos[k * 6 + 2] = -0.1;
            pos[k * 6 + 3] = p[k * 2] + dy * w;
            pos[k * 6 + 4] = p[k * 2 + 1] - dx * w;
            pos[k * 6 + 5] = -0.1;
            const v = f * f * t.heat * 0.9;
            col[k * 6] = col[k * 6 + 3] = r * v;
            col[k * 6 + 1] = col[k * 6 + 4] = g * v;
            col[k * 6 + 2] = col[k * 6 + 5] = b * v;
        }
        t.mesh.geometry.attributes.position.needsUpdate = true;
        t.mesh.geometry.attributes.color.needsUpdate = true;
        t.mesh.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
    }

    /** Objects that start hidden, so View.warmup() can compile their shaders up front. */
    hiddenObjects(): THREE.Object3D[] {
        return [...this.rings.map((r) => r.mesh), this.clumps];
    }

    /** Debris draws nothing at count 0; warm-up temporarily shows one instance. */
    setDebrisWarm(on: boolean) {
        this.debris.count = on ? 1 : this.dn;
    }

    burst(x: number, y: number, n: number, speed: number, rgb: RGB, life = 1) {
        const pos = this.sparks.geometry.attributes.position.array as Float32Array;
        for (let k = 0; k < n; k++) {
            const i = this.pn < this.maxP ? this.pn++ : Math.floor(Math.random() * this.maxP);
            const a = Math.random() * Math.PI * 2,
                v = speed * (0.2 + Math.random());
            pos[i * 3] = x;
            pos[i * 3 + 1] = y;
            pos[i * 3 + 2] = (Math.random() - 0.5) * 1.5;
            this.pv[i * 2] = Math.cos(a) * v;
            this.pv[i * 2 + 1] = Math.sin(a) * v;
            this.plife[i] = life * (0.5 + Math.random() * 0.5);
            this.pcol[i * 3] = rgb[0];
            this.pcol[i * 3 + 1] = rgb[1];
            this.pcol[i * 3 + 2] = rgb[2];
        }
        if (n > 30) this.shake = Math.max(this.shake, n / 80);
    }

    /** One exhaust spark at the engine, moving with the ship plus a backward kick (dx, dy). */
    exhaust(x: number, y: number, vx: number, vy: number) {
        this.burst(x, y, 1, 2, C.fx.exhaust, 0.35);
        const i = Math.min(this.pn, this.maxP) - 1;
        this.pv[i * 2] += vx;
        this.pv[i * 2 + 1] += vy;
    }

    /** nearRock: the blast is against a wall, so some debris is chunks of that rock. */
    explode(x: number, y: number, big: boolean, nearRock = false) {
        const k = big ? 1 : 0.45;
        this.flash.position.set(x, y, 4);
        this.flash.intensity = Math.max(this.flash.intensity, big ? 900 : 260);
        this.burst(x, y, Math.round(60 * k), 18 * k + 4, C.fx.sparkCore, 0.35);
        this.burst(x, y, Math.round(90 * k), 12 * k + 3, C.fx.sparkAmber, 1.2);
        this.burst(x, y, Math.round(50 * k), 7 * k + 2, C.fx.sparkRed, 1.8);
        this.burst(x, y, Math.round(40 * k), 10 * k + 3, this.neon, 1.1);
        this.ring(x, y, big ? 9 : 4, 0.55, this.neon);
        this.ring(x, y, big ? 5.5 : 2.5, 0.8, C.fx.ringHot);
        const pieces = big ? 70 : 22;
        for (let n = 0; n < pieces; n++) {
            const i = this.dn < MAX_DEBRIS ? this.dn++ : Math.floor(Math.random() * MAX_DEBRIS);
            const i3 = i * 3;
            const a = Math.random() * Math.PI * 2,
                v = (big ? 4 : 2.5) + Math.random() * (big ? 11 : 6);
            this.dPos[i3] = x;
            this.dPos[i3 + 1] = y;
            this.dPos[i3 + 2] = (Math.random() - 0.5) * 1.2;
            this.dVel[i3] = Math.cos(a) * v;
            this.dVel[i3 + 1] = Math.sin(a) * v + 3;
            this.dVel[i3 + 2] = (Math.random() - 0.5) * 6;
            for (let j = 0; j < 3; j++) {
                this.dRot[i3 + j] = Math.random() * 6;
                this.dSpin[i3 + j] = (Math.random() - 0.5) * 16;
            }
            const life = 1.2 + Math.random() * (big ? 2 : 1);
            this.dLife[i * 2] = this.dLife[i * 2 + 1] = life;
            this.dSize[i] = 0.12 + Math.random() * (big ? 0.3 : 0.18);
            const kind = Math.random();
            const tint =
                nearRock && kind < 0.3 ? this.rock : kind < 0.62 ? null : kind < 0.82 ? C.fx.debrisHull : this.neon;
            for (let j = 0; j < 3; j++) this.dTint[i3 + j] = tint ? tint[j] : 0;
        }
        this.shake = Math.max(this.shake, big ? 1.6 : 0.5);
    }

    private ring(x: number, y: number, size: number, life: number, rgb: RGB) {
        const r = this.rings.reduce((a, b) => (a.life < b.life ? a : b));
        r.mesh.position.set(x, y, 0.6);
        (r.mesh.material as THREE.MeshBasicMaterial).color.setRGB(rgb[0], rgb[1], rgb[2]);
        r.life = r.max = life;
        r.size = size;
        r.mesh.visible = true;
    }

    update(dt: number, lv: Level, camX: number, camY: number, inside: boolean) {
        this.time += dt;
        this.updateSparks(dt, lv.gravity);
        this.updateDebris(dt, lv);
        this.flash.intensity *= Math.exp(-dt * 7);
        for (const r of this.rings) {
            if (!r.mesh.visible) continue;
            r.life -= dt;
            if (r.life <= 0) {
                r.mesh.visible = false;
                continue;
            }
            const t = 1 - r.life / r.max;
            const sc = 0.3 + r.size * (1 - (1 - t) * (1 - t));
            r.mesh.scale.set(sc, sc, sc);
            (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * (1 - t);
        }
        if (this.dust) this.updateDust(dt, camX, camY, inside);
        this.updateClumps(dt, camX, camY, inside);
    }

    private updateSparks(dt: number, gravity: number) {
        const pos = this.sparks.geometry.attributes.position.array as Float32Array;
        const colr = this.sparks.geometry.attributes.color.array as Float32Array;
        let live = 0;
        for (let k = 0; k < this.pn; k++) {
            if ((this.plife[k] -= dt) <= 0) continue;
            this.pv[k * 2 + 1] -= gravity * 0.4 * dt;
            const f = Math.min(1, this.plife[k] * 2);
            pos[live * 3] = pos[k * 3] + this.pv[k * 2] * dt;
            pos[live * 3 + 1] = pos[k * 3 + 1] + this.pv[k * 2 + 1] * dt;
            pos[live * 3 + 2] = pos[k * 3 + 2];
            this.pv[live * 2] = this.pv[k * 2];
            this.pv[live * 2 + 1] = this.pv[k * 2 + 1];
            this.plife[live] = this.plife[k];
            this.pcol.copyWithin(live * 3, k * 3, k * 3 + 3);
            colr[live * 3] = this.pcol[live * 3] * f;
            colr[live * 3 + 1] = this.pcol[live * 3 + 1] * f;
            colr[live * 3 + 2] = this.pcol[live * 3 + 2] * f;
            live++;
        }
        this.pn = live;
        this.sparks.geometry.attributes.position.needsUpdate = true;
        this.sparks.geometry.attributes.color.needsUpdate = true;
        this.sparks.geometry.setDrawRange(0, live);
    }

    private updateDebris(dt: number, lv: Level) {
        const { m, q, e, p, s, c } = this;
        let live = 0;
        for (let i = 0; i < this.dn; i++) {
            if ((this.dLife[i * 2] -= dt) <= 0) continue;
            // Integrate with gravity; bounce off rock, losing energy, so chunks skitter along floors.
            const i3 = i * 3;
            this.dVel[i3 + 1] -= lv.gravity * 1.6 * dt;
            const nx = this.dPos[i3] + this.dVel[i3] * dt,
                ny = this.dPos[i3 + 1] + this.dVel[i3 + 1] * dt;
            if (solidAt(lv, this.dPos[i3], ny)) {
                this.dVel[i3 + 1] *= -0.4;
                this.dVel[i3] *= 0.7;
                this.dSpin[i3] *= 0.6;
            } else this.dPos[i3 + 1] = ny;
            if (solidAt(lv, nx, this.dPos[i3 + 1])) this.dVel[i3] *= -0.4;
            else this.dPos[i3] = nx;
            this.dPos[i3 + 2] += this.dVel[i3 + 2] * dt;
            for (let a = 0; a < 3; a++) this.dRot[i3 + a] += this.dSpin[i3 + a] * dt;

            const t = this.dLife[i * 2] / this.dLife[i * 2 + 1]; // 1 → 0
            const tr = this.dTint[i3],
                tg = this.dTint[i3 + 1],
                tb = this.dTint[i3 + 2];
            if (tr + tg + tb === 0) {
                const [r, g, b] = ramp(C.ember, t, this.rgb);
                c.setRGB(r, g, b);
            } else c.setRGB(tr * (0.35 + t), tg * (0.35 + t), tb * (0.35 + t));
            const sz = this.dSize[i] * Math.min(1, t * 4);
            m.compose(
                p.set(this.dPos[i3], this.dPos[i3 + 1], this.dPos[i3 + 2]),
                q.setFromEuler(e.set(this.dRot[i3], this.dRot[i3 + 1], this.dRot[i3 + 2])),
                s.set(sz, sz, sz)
            );
            if (live !== i) {
                this.dPos.copyWithin(live * 3, i3, i3 + 3);
                this.dVel.copyWithin(live * 3, i3, i3 + 3);
                this.dRot.copyWithin(live * 3, i3, i3 + 3);
                this.dSpin.copyWithin(live * 3, i3, i3 + 3);
                this.dTint.copyWithin(live * 3, i3, i3 + 3);
                this.dLife.copyWithin(live * 2, i * 2, i * 2 + 2);
                this.dSize[live] = this.dSize[i];
            }
            this.debris.setMatrixAt(live, m);
            this.debris.setColorAt(live, c);
            live++;
        }
        this.dn = live;
        this.debris.count = live;
        this.debris.instanceMatrix.needsUpdate = true;
        if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;
    }

    /** Drift motes and wrap them inside a box centred on the camera; hide outside the planet. */
    private updateDust(dt: number, camX: number, camY: number, inside: boolean) {
        const dust = this.dust!;
        dust.visible = inside;
        if (!inside) return;
        const dp = dust.geometry.attributes.position.array as Float32Array;
        const [bw, bh] = DUST_BOX;
        const ox = camX - bw / 2,
            oy = camY - bh / 2;
        for (let k = 0; k < dp.length; k += 3) {
            const ph = k * 0.37 + this.time * 0.3;
            const x = dp[k] + Math.sin(ph) * 0.15 * dt,
                y = dp[k + 1] + (0.12 + Math.cos(ph * 0.7) * 0.1) * dt;
            dp[k] = ((((x - ox) % bw) + bw) % bw) + ox;
            dp[k + 1] = ((((y - oy) % bh) + bh) % bh) + oy;
        }
        dust.geometry.attributes.position.needsUpdate = true;
    }

    /** Drift clump centres (wrapped around the camera like the motes) and swirl each clump's motes. */
    private updateClumps(dt: number, camX: number, camY: number, inside: boolean) {
        this.clumps.visible = inside;
        if (!inside) return;
        const cc = this.cCentre,
            mo = this.cMote;
        const pos = this.clumps.geometry.attributes.position.array as Float32Array;
        const [bw, bh] = DUST_BOX;
        const ox = camX - bw / 2,
            oy = camY - bh / 2;
        for (let c = 0; c < cc.length / 3; c++) {
            const ph = c * 1.7 + this.time * 0.2;
            const x = cc[c * 3] + Math.sin(ph) * 0.25 * dt,
                y = cc[c * 3 + 1] + (0.08 + Math.cos(ph * 0.8) * 0.12) * dt;
            cc[c * 3] = ((((x - ox) % bw) + bw) % bw) + ox;
            cc[c * 3 + 1] = ((((y - oy) % bh) + bh) % bh) + oy;
            // Breathe: the clump swells and shrinks a little.
            const swell = 1 + 0.2 * Math.sin(this.time * 0.6 + c);
            for (let j = 0; j < CLUMP_N; j++) {
                const k = c * CLUMP_N + j;
                const a = (mo[k * 4 + 1] += mo[k * 4 + 3] * dt);
                const r = mo[k * 4] * swell;
                pos[k * 3] = cc[c * 3] + Math.cos(a) * r;
                pos[k * 3 + 1] = cc[c * 3 + 1] + Math.sin(a) * r * 0.8;
                pos[k * 3 + 2] = cc[c * 3 + 2] + mo[k * 4 + 2];
            }
        }
        this.clumps.geometry.attributes.position.needsUpdate = true;
    }
}
