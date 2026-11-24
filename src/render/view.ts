/**
 * View — three.js presentation of a Game: scene, meshes, particles, chase camera, post-FX.
 *
 * Purpose
 *   Draws the game side-on in 2.5D. Rock cells are instanced voxel boxes (depth 3) textured
 *   with pixel-art block types and outlined with HDR neon strips on every air-facing edge; a
 *   dark back wall fills the tunnels, stars sit behind the sky, a light rides with the ship, and
 *   bloom, shadows, MSAA, bump relief and cave dust finish the look on tiers that can afford
 *   them. Each planet takes its palette from palette.ts.
 *
 * Operations
 *   - constructor(parent, tierSettings): renderer (no canvas MSAA: anti-aliasing happens on the
 *     multisampled composer target instead), ACES tone mapping, optional soft PCF shadows,
 *     lights, the persistent ship / pod / rod / beam / bullet objects, the Effects (fx.ts),
 *     shared rock + edge materials, and the composer (RenderPass → UnrealBloomPass → OutputPass).
 *   - build(level) (private): when game.level changes identity, disposes the old level, builds
 *     the cheap parts at once (back wall, stars, pedestal, turrets, fuel cells, reactor) and
 *     queues the rock as horizontal CHUNK-row slices.
 *     Stars are three STAR_LAYERS at very different depths (z -6..-16, -40..-80, -160..-320),
 *     so they slide at ~75%, ~35% and ~12% of the playfield's speed: a strong parallax.
 *   - pump(budgetMs, focusY): builds queued rock chunks nearest the ship first until the time
 *     budget is spent (always at least one). sync() calls it with the tier's buildMs, so a new
 *     planet streams in over a few frames instead of freezing one; boot calls it with Infinity.
 *   - warmup(): compiles every shader, including objects that start hidden (flame, shield,
 *     rings, rod, beam, debris), so the first thrust or explosion doesn't hitch.
 *   - Per planet it also builds landing pads (glow while refuelling), checkpoint beacons (light
 *     up once passed), mines (spiked, eye pulses faster when hunting) and laser gates (emitters +
 *     beam, flickering just before switching on); setGhost(pose) shows the best-run ghost.
 *   - sync(game, dt): pumps chunks, poses everything from game state, moves the chase camera
 *     and the shadow-casting sun, updates the effects (fx.ts), then renders.
 *   - burst() / explode(): delegate to Effects (sparks; layered voxel explosions).
 *   - degrade(): one step down in cost (DPR → shadows → bloom); returns false when nothing is
 *     left. Called by main.ts's frame-time governor.
 *   - resize(): on window resize.
 *   - The back wall is desaturated (HSL −0.35) so strongly tinted themes (Sulphur) don't haze.
 *   - Depth: rock and the back wall darken with depth (depthFade, to ~55% at the floor); a faint
 *     horizon glow band in the planet's neon sits behind the surface line.
 *   - landed(strength): a short camera dip after a clean landing. setRockTime drives the breathing
 *     ore / crystal glow each frame.
 *
 * Usage
 *   main.ts creates one View with TIER_SETTINGS[tier]; at boot: sync(attract, 0), pump(Infinity),
 *   await warmup(); then sync(game ?? attract, dt) every active frame, explode()/burst() from
 *   game events, degrade() when the governor asks.
 *
 * Highlights
 *   - Read-only with respect to Game; never writes game state.
 *   - What glows is decided by one rule: neon materials are toneMapped:false with HDR colours
 *     (>1), so they cross the bloom threshold (0.82) while lit surfaces mostly don't.
 *   - Rock chunks are separate InstancedMeshes, so three.js frustum-culls the ones off screen
 *     (and outside the shadow camera): typically 2-3 of 8-12 are drawn.
 *   - The per-frame path allocates nothing (scratch objects, element-wise buffer writes, cached
 *     turret barrels).
 *   - The camera sits 4 units below its look-at point so floors show their tops and tunnels
 *     read as 3D; portrait screens pull the camera back (z = 30 / aspect).
 *   - The chase target is clamped so the view stays inside the built rock (MARGIN beyond the
 *     sides and bottom) for the current aspect, so full screen vs browser bars and portrait vs
 *     landscape never show the void past the planet.
 *
 * See also: core/game.ts (state it draws), fx/effects.ts, render/rock.ts, core/palette.ts, render/tier.ts, main.ts; DESIGN.md
 * "7. Rendering".
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { Game } from "../core/game";
import { gateIn, gateOn, GATE_WARN, isAir, isRock, solidAt, type Level } from "../world/level";
import { dotTexture, Effects, pointsLayer } from "../fx/effects";
import type { TierSettings } from "./tier";
import { BLOCK, blockAt, rockMaterial, setRockTime, TINTLESS, wallMaterial } from "./rock";
import { COLORS, evenGlow, themeFor, type RGB } from "../core/palette";

const C = COLORS;
const WHITE = new THREE.Color(1, 1, 1);

/** Rows per rock chunk: one InstancedMesh each, so off-screen chunks are culled. */
const CHUNK = 24;
const MARGIN = 12; // solid cells drawn beyond the grid's sides and bottom
/** Camera distance from the playfield (landscape); stars use it to size their layers. */
const CAM_Z = 34;
/** Starfield layers: depth range, share of the tier's star count, point size and brightness. */
const STAR_LAYERS = [
    { near: 6, far: 16, share: 0.15, size: 0.3, bright: 1.2 }, // ~75% of playfield speed
    { near: 40, far: 80, share: 0.3, size: 0.55, bright: 1.0 }, // ~35%
    { near: 160, far: 320, share: 0.55, size: 2.2, bright: 0.8 }, // ~12%
];

const neonMat = ([r, g, b]: RGB) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b), toneMapped: false });

/** Brightness factor by depth: 1 near the surface, about 0.55 at the planet's floor. */
function depthFade(y: number, h: number) {
    return 0.55 + 0.45 * Math.pow(Math.min(1, Math.max(0, y) / h), 0.8);
}

/** Vertical soft band (alpha mask) for the horizon glow; built once and shared. */
let horizonTex: THREE.Texture | null = null;
function horizonTexture() {
    if (horizonTex) return horizonTex;
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 128;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.55, "rgba(255,255,255,0.9)");
    grad.addColorStop(0.62, "rgba(255,255,255,1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 128);
    horizonTex = new THREE.CanvasTexture(c);
    return horizonTex;
}

export class View {
    readonly renderer: THREE.WebGLRenderer;
    readonly scene = new THREE.Scene();
    readonly camera = new THREE.PerspectiveCamera(50, 1, 0.5, 400);
    private composer: EffectComposer;
    private bloom: UnrealBloomPass;
    private levelGroup = new THREE.Group();
    private builtFor: Level | null = null;
    private ship = new THREE.Group();
    private flame: THREE.Mesh;
    private shield: THREE.Mesh;
    private shipLight = new THREE.PointLight(C.light.ship, 14, 18, 1.4);
    private pod = new THREE.Group();
    private rodLine: THREE.Line;
    private beamLine: THREE.Line;
    private turrets: { grp: THREE.Group; barrel: THREE.Object3D }[] = [];
    private fuel: THREE.Group[] = [];
    private reactor = new THREE.Group();
    private pads: THREE.Mesh[] = [];
    private beacons: THREE.Mesh[] = [];
    private mines: THREE.Group[] = [];
    private gates: { beam: THREE.Mesh; mat: THREE.MeshBasicMaterial }[] = [];
    private ghost = new THREE.Group();
    private ghostPose: { x: number; y: number; a: number } | null = null;
    /** Camera dip after a landing (world units), springing back to 0. */
    private dip = 0;
    private reactorCore!: THREE.Mesh;
    private reactorLight = new THREE.PointLight(C.light.reactor, 50, 18, 1.6);
    private bullets: THREE.Points;
    private sun = new THREE.DirectionalLight(C.light.sun, 1.6);
    private time = 0;
    private fx: Effects;
    private starTex = dotTexture();
    private neon: RGB = themeFor(1).neon;
    // Rock streaming (see build / pump) and the materials every planet shares.
    private jobs: number[] = []; // chunk start rows still to build
    private chunkCtx: { lv: Level; deep: THREE.Color; top: THREE.Color; surf: THREE.Color } | null = null;
    private rockMat: THREE.MeshStandardMaterial;
    private stripMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    private boxGeo = new THREE.BoxGeometry(1, 1, 3);
    private unitBox = new THREE.BoxGeometry(1, 1, 1);

    constructor(
        parent: HTMLElement,
        private ts: TierSettings
    ) {
        // No canvas MSAA: the image goes through the composer, whose render target is
        // multisampled instead (canvas MSAA would be wasted memory and fill).
        this.renderer = new THREE.WebGLRenderer({
            antialias: false,
            stencil: false,
            powerPreference: "high-performance",
        });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, ts.dprCap));
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        parent.appendChild(this.renderer.domElement);

        // Sun from upper-left-front. On the high tier it casts a soft shadow map that follows the
        // ship, so rock, ship and pod throw shadows onto the back wall and tunnel sides.
        this.scene.add(new THREE.HemisphereLight(C.light.hemiSky, C.light.hemiGround, 0.9));
        if (ts.shadowMap > 0) {
            this.renderer.shadowMap.enabled = true;
            this.renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is deprecated in r185
            this.sun.shadow.radius = 3; // PCF blur, for soft edges
            this.sun.castShadow = true;
            this.sun.shadow.mapSize.set(ts.shadowMap, ts.shadowMap);
            const c = this.sun.shadow.camera;
            c.left = c.bottom = -32;
            c.right = c.top = 32;
            c.near = 1;
            c.far = 80;
            this.sun.shadow.bias = -0.0005;
            this.sun.shadow.normalBias = 0.03;
        }
        this.scene.add(this.sun, this.sun.target, this.levelGroup, this.ship, this.pod, this.reactor);

        // Ship: extruded arrowhead, neon outline, flame cone, shield ring, riding light.
        const shape = new THREE.Shape();
        shape.moveTo(0, 0.95);
        shape.lineTo(0.72, -0.62);
        shape.lineTo(0, -0.32);
        shape.lineTo(-0.72, -0.62);
        shape.closePath();
        const hullGeo = new THREE.ExtrudeGeometry(shape, {
            depth: 0.5,
            bevelEnabled: true,
            bevelSize: 0.05,
            bevelThickness: 0.08,
            bevelSegments: 1,
        });
        hullGeo.translate(0, 0, -0.25);
        const hullMesh = new THREE.Mesh(
            hullGeo,
            new THREE.MeshStandardMaterial({ color: C.ship.hull, metalness: 0.7, roughness: 0.35 })
        );
        const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(hullGeo, 30),
            new THREE.LineBasicMaterial({ color: new THREE.Color(...C.ship.outline), toneMapped: false })
        );
        const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), neonMat(C.ship.canopy));
        canopy.position.set(0, 0.2, 0.32);
        this.flame = new THREE.Mesh(
            new THREE.ConeGeometry(0.28, 1, 10),
            new THREE.MeshBasicMaterial({
                color: new THREE.Color(...C.ship.flame),
                toneMapped: false,
                transparent: true,
                opacity: 0.9,
                blending: THREE.AdditiveBlending,
            })
        );
        this.flame.rotation.z = Math.PI;
        this.shield = new THREE.Mesh(
            new THREE.RingGeometry(1.2, 1.32, 48),
            new THREE.MeshBasicMaterial({
                color: new THREE.Color(...C.ship.shield),
                toneMapped: false,
                transparent: true,
                opacity: 0.8,
                blending: THREE.AdditiveBlending,
                side: THREE.DoubleSide,
            })
        );
        hullMesh.castShadow = true;
        this.ship.add(hullMesh, edges, canopy, this.flame, this.shield);
        this.scene.add(this.shipLight);

        // Ghost of the best run: the same hull, translucent, no light or shadow.
        const ghostMat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(...C.fixture.ghost),
            toneMapped: false,
            transparent: true,
            opacity: 0.28,
            depthWrite: false,
        });
        this.ghost.add(
            new THREE.Mesh(hullGeo, ghostMat),
            new THREE.LineSegments(
                edges.geometry,
                new THREE.LineBasicMaterial({
                    color: new THREE.Color(...C.fixture.ghost),
                    transparent: true,
                    opacity: 0.6,
                    toneMapped: false,
                })
            )
        );
        this.ghost.visible = false;
        this.scene.add(this.ghost);

        // Pod: glossy orb in a neon ring.
        const orb = new THREE.Mesh(
            new THREE.SphereGeometry(0.6, 24, 16),
            new THREE.MeshStandardMaterial({ color: C.pod.body, metalness: 0.8, roughness: 0.25 })
        );
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.06, 8, 32), neonMat(C.pod.ring));
        orb.castShadow = true;
        this.pod.add(orb, ring);

        const lineMat = ([r, g, b]: RGB) =>
            new THREE.LineBasicMaterial({ color: new THREE.Color(r, g, b), toneMapped: false });
        const line = () => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        this.rodLine = new THREE.Line(line(), lineMat(C.pod.rod));
        this.beamLine = new THREE.Line(line(), lineMat(C.pod.beam));
        this.rodLine.frustumCulled = this.beamLine.frustumCulled = false;
        this.scene.add(this.rodLine, this.beamLine);

        const tex = dotTexture();
        this.bullets = pointsLayer(400, 0.5, tex);
        this.scene.add(this.bullets);
        this.fx = new Effects(this.scene, ts, tex);

        this.rockMat = rockMaterial(ts.bump);
        this.rockMat.userData.shared = this.stripMat.userData.shared = true;

        // HalfFloat keeps HDR neon above 1 for bloom; samples = MSAA on WebGL2.
        const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: ts.msaa });
        this.composer = new EffectComposer(this.renderer, target);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.75, 0.38, 0.82);
        if (ts.bloom) this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
        this.resize();
        addEventListener("resize", () => this.resize());
    }

    resize() {
        const w = innerWidth,
            h = innerHeight;
        this.renderer.setSize(w, h);
        this.composer.setPixelRatio(this.renderer.getPixelRatio());
        this.composer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    private build(lv: Level) {
        this.levelGroup.traverse((o) => {
            if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.InstancedMesh) {
                if (o.geometry !== this.boxGeo && o.geometry !== this.unitBox) o.geometry.dispose();
                const m = o.material as THREE.Material;
                if (!m.userData.shared) m.dispose();
            }
        });
        this.levelGroup.clear();
        const pal = themeFor(lv.n);
        this.scene.background = new THREE.Color(pal.sky);
        const { w, h } = lv;

        // Rock: queued as CHUNK-row slices (including the MARGIN rows below the grid), built by
        // pump() nearest the ship first. Edge-strip colour is per planet, the material shared.
        this.neon = evenGlow(pal.neon);
        this.stripMat.color.setRGB(...this.neon);
        this.fx.setNeon(this.neon);
        const rockCol = new THREE.Color(pal.top);
        this.fx.setRockColour([rockCol.r * 1.6, rockCol.g * 1.6, rockCol.b * 1.6]);
        this.chunkCtx = {
            lv,
            deep: new THREE.Color(pal.deep),
            top: new THREE.Color(pal.top),
            surf: new THREE.Color(pal.surf),
        };
        this.jobs = [];
        for (let y0 = -MARGIN; y0 < h; y0 += CHUNK) this.jobs.push(y0);

        // Back wall behind the tunnels, shaped to the surface so the sky stays open.
        const back = new THREE.Shape();
        back.moveTo(0, 0);
        back.lineTo(w, 0);
        for (let x = w - 1; x >= 0; x--) back.lineTo(x + 0.5, lv.surface[x] - 1);
        const wall = new THREE.Mesh(
            new THREE.ShapeGeometry(back),
            wallMaterial(new THREE.Color(pal.deep).offsetHSL(0, -0.35, 0).multiplyScalar(0.6))
        );
        // Darker the deeper it goes (vertex colours multiply the wall colour), so a deep planet's
        // bottom feels deep.
        const wg = wall.geometry,
            wp = wg.attributes.position;
        const wc = new Float32Array(wp.count * 3);
        for (let i = 0; i < wp.count; i++) {
            const f = depthFade(wp.getY(i), h);
            wc.set([f, f, f], i * 3);
        }
        wg.setAttribute("color", new THREE.BufferAttribute(wc, 3));
        (wall.material as THREE.MeshStandardMaterial).vertexColors = true;
        wall.position.z = -1.45;
        wall.receiveShadow = true;
        this.levelGroup.add(wall);

        // Horizon glow: a soft band of the planet's neon behind the surface line, far back so it
        // parallaxes with the far stars.
        const horizonY = Math.min(...lv.surface);
        const glow = new THREE.Mesh(
            new THREE.PlaneGeometry(w * 6, 40),
            new THREE.MeshBasicMaterial({
                map: horizonTexture(),
                color: new THREE.Color(...this.neon).multiplyScalar(0.05),
                transparent: true,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                toneMapped: false,
            })
        );
        glow.position.set(w / 2, horizonY + 4, -120);
        this.levelGroup.add(glow);

        // Stars: STAR_LAYERS at very different depths. Under the perspective camera a layer at depth
        // d slides across the screen at CAM_Z / (CAM_Z + d) of the playfield's speed, so near, mid
        // and far layers move at clearly different rates: that difference is the parallax. Each
        // layer spreads wide enough to fill the view at its depth; far stars are drawn larger to
        // offset perspective shrinking.
        const tex = this.starTex;
        for (const L of STAR_LAYERS) {
            const n = Math.round(this.ts.stars * L.share);
            const sp = new Float32Array(n * 3),
                sc = new Float32Array(n * 3);
            for (let k = 0; k < n; k++) {
                const z = -(L.near + Math.random() * (L.far - L.near));
                const spread = (CAM_Z - z) / CAM_Z; // view size at this depth relative to z = 0
                sp[k * 3] = w / 2 + (Math.random() - 0.5) * (w + 60) * spread;
                sp[k * 3 + 1] = h - 20 + (Math.random() - 0.5) * (2 * 18 * spread + h * 0.6);
                sp[k * 3 + 2] = z;
                const v = L.bright * (0.4 + Math.random() * 1.4);
                sc[k * 3] = v * C.fx.star[0];
                sc[k * 3 + 1] = v * C.fx.star[1];
                sc[k * 3 + 2] = v * C.fx.star[2];
            }
            const sg = new THREE.BufferGeometry();
            sg.setAttribute("position", new THREE.BufferAttribute(sp, 3));
            sg.setAttribute("color", new THREE.BufferAttribute(sc, 3));
            const stars = new THREE.Points(
                sg,
                new THREE.PointsMaterial({
                    size: L.size,
                    vertexColors: true,
                    map: tex,
                    transparent: true,
                    toneMapped: false,
                })
            );
            stars.frustumCulled = false;
            this.levelGroup.add(stars);
        }

        // Pod pedestal.
        const ped = new THREE.Mesh(
            new THREE.CylinderGeometry(0.9, 1.1, 0.25, 16),
            new THREE.MeshStandardMaterial({ color: C.fixture.pedestal, metalness: 0.7, roughness: 0.4 })
        );
        ped.position.set(lv.pod.x, lv.pod.y - 0.62, 0);
        this.levelGroup.add(ped);

        // Turrets: dome + barrel, flipped for ceiling mounts.
        const domeGeo = new THREE.SphereGeometry(0.6, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
        const barrelGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.9, 8);
        barrelGeo.translate(0, 0.45, 0);
        const tMat = new THREE.MeshStandardMaterial({ color: C.fixture.turret, metalness: 0.5, roughness: 0.4 });
        const eyeMat = neonMat(C.fixture.turretEye);
        this.turrets = lv.turrets.map((t) => {
            const g = new THREE.Group();
            const dome = new THREE.Mesh(domeGeo, tMat);
            dome.position.y = -0.45;
            const eye = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), eyeMat);
            eye.position.set(0, -0.15, 0.45);
            const barrel = new THREE.Mesh(barrelGeo, tMat);
            barrel.position.y = -0.1;
            dome.castShadow = barrel.castShadow = true;
            g.add(dome, eye, barrel);
            g.position.set(t.x, t.y, 0);
            if (!t.up) g.rotation.z = Math.PI;
            this.levelGroup.add(g);
            return { grp: g, barrel };
        });

        // Landing pads: glowing slabs on their floors.
        const padGeo = new THREE.BoxGeometry(3, 0.14, 2.6);
        this.pads = lv.pads.map((p) => {
            const m = new THREE.Mesh(padGeo, neonMat(C.fixture.pad));
            m.position.set(p.x, p.y + 0.07, 0);
            this.levelGroup.add(m);
            return m;
        });

        // Checkpoint beacons: small spinning diamonds at each switchback.
        const beaconGeo = new THREE.OctahedronGeometry(0.35);
        this.beacons = lv.checkpoints.map((c) => {
            const m = new THREE.Mesh(beaconGeo, neonMat(C.fixture.checkpoint));
            m.position.set(c.x, c.y, -0.8);
            this.levelGroup.add(m);
            return m;
        });

        // Mines: spiked dark spheres with a pulsing eye.
        const mineGeo = new THREE.IcosahedronGeometry(0.45, 0);
        const spikeGeo = new THREE.OctahedronGeometry(0.62, 0);
        const mineMat = new THREE.MeshStandardMaterial({
            color: C.fixture.mineBody,
            metalness: 0.6,
            roughness: 0.4,
            flatShading: true,
        });
        this.mines = lv.mines.map(() => {
            const g = new THREE.Group();
            const spikes = new THREE.Mesh(spikeGeo, mineMat);
            spikes.scale.set(0.8, 0.8, 0.8);
            const eye = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), neonMat(C.fixture.mineEye));
            eye.position.z = 0.45;
            eye.name = "eye";
            g.add(new THREE.Mesh(mineGeo, mineMat), spikes, eye);
            this.levelGroup.add(g);
            return g;
        });

        // Laser gates: emitters at both ends, a beam between (shown while on, flickering just before).
        const emitGeo = new THREE.BoxGeometry(0.5, 0.6, 1.2);
        const emitMat = new THREE.MeshStandardMaterial({
            color: C.fixture.gateEmitter,
            metalness: 0.7,
            roughness: 0.35,
        });
        this.gates = lv.gates.map((gt) => {
            const mat = neonMat(C.fixture.gate);
            mat.transparent = true;
            const beam = new THREE.Mesh(new THREE.BoxGeometry(gt.x1 - gt.x0, 0.12, 0.12), mat);
            beam.position.set((gt.x0 + gt.x1) / 2, gt.y, 0);
            for (const x of [gt.x0 + 0.25, gt.x1 - 0.25]) {
                const e = new THREE.Mesh(emitGeo, emitMat);
                e.position.set(x, gt.y, 0);
                this.levelGroup.add(e);
            }
            this.levelGroup.add(beam);
            return { beam, mat };
        });

        // Fuel cells.
        const fGeo = new THREE.BoxGeometry(1, 1, 1);
        const fMat = new THREE.MeshStandardMaterial({ color: C.fixture.fuelBody, metalness: 0.6, roughness: 0.4 });
        const fBand = neonMat(C.fixture.fuelBand);
        this.fuel = lv.fuel.map((f) => {
            const g = new THREE.Group();
            const band = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.18, 1.05), fBand);
            g.add(new THREE.Mesh(fGeo, fMat), band);
            g.position.set(f.x, f.y, 0);
            this.levelGroup.add(g);
            return g;
        });

        // Reactor: base, dome, glowing core, chimney.
        this.reactor.clear();
        const rMat = new THREE.MeshStandardMaterial({ color: C.fixture.reactorBody, metalness: 0.7, roughness: 0.35 });
        const base = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.8, 2.4), rMat);
        base.position.y = 0.4;
        const dome = new THREE.Mesh(new THREE.SphereGeometry(1.3, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), rMat);
        dome.position.y = 0.8;
        this.reactorCore = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), neonMat(C.fixture.reactorCoreSwing));
        this.reactorCore.position.set(0, 1.2, 1.05);
        const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 2.6, 12), rMat);
        chimney.position.set(1.2, 1.9, -0.4);
        base.castShadow = dome.castShadow = chimney.castShadow = true;
        this.reactor.add(base, dome, this.reactorCore, chimney, this.reactorLight);
        this.reactorLight.position.set(0, 2, 2);
        this.reactor.position.set(lv.reactor.x, lv.reactor.y, 0);
        this.reactor.visible = true;
        this.builtFor = lv;
        this.fx.reset();
    }

    /** Rock chunks still queued for the current planet. */
    get pendingChunks() {
        return this.jobs.length;
    }

    /** Build queued rock chunks, nearest to focusY first, until budgetMs is spent (min one). */
    pump(budgetMs: number, focusY: number) {
        const t0 = performance.now();
        while (this.jobs.length) {
            let best = 0;
            for (let k = 1; k < this.jobs.length; k++)
                if (Math.abs(this.jobs[k] + CHUNK / 2 - focusY) < Math.abs(this.jobs[best] + CHUNK / 2 - focusY))
                    best = k;
            const [y0] = this.jobs.splice(best, 1);
            this.buildChunk(y0, Math.min(y0 + CHUNK, this.chunkCtx!.lv.h));
            if (performance.now() - t0 >= budgetMs) break;
        }
    }

    /** One horizontal slice of rock: voxel instances + neon edge strips, as two InstancedMeshes. */
    private buildChunk(y0: number, y1: number) {
        const { lv, deep, top, surf } = this.chunkCtx!;
        const { w, h } = lv;
        const solid = (x: number, y: number) => isRock(lv, x, y);
        const air = (x: number, y: number) => isAir(lv, x, y);
        let count = 0;
        for (let y = y0; y < y1; y++) for (let x = -MARGIN; x < w + MARGIN; x++) if (solid(x, y)) count++;
        if (!count) return;
        const tiles = new Float32Array(count);
        const geo = this.boxGeo.clone(); // shares nothing mutable; holds this chunk's aTile attribute
        geo.setAttribute("aTile", new THREE.InstancedBufferAttribute(tiles, 1));
        const rock = new THREE.InstancedMesh(geo, this.rockMat, count);
        const m = this.tmpM,
            col = this.tmpC;
        const bars: number[] = []; // x, y, horiz(1/0) triples
        let i = 0;
        for (let y = y0; y < y1; y++)
            for (let x = -MARGIN; x < w + MARGIN; x++) {
                if (!solid(x, y)) continue;
                const inside = x >= 0 && x < w && y >= 0;
                const sx = Math.min(Math.max(x, 0), w - 1);
                const hash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
                const jitter = (hash - Math.floor(hash)) * 0.18 - 0.09;
                m.makeTranslation(x + 0.5, y + 0.5, 0);
                rock.setMatrixAt(i, m);
                const tile = inside ? blockAt(lv, x, y) : BLOCK.Stone;
                tiles[i] = tile;
                col.copy(deep).lerp(top, Math.max(0, y) / h);
                col.multiplyScalar(depthFade(y, h));
                if (inside && y >= lv.surface[sx] - 4) col.lerp(surf, y >= lv.surface[sx] - 1 ? 1 : 0.45);
                if (!inside) col.multiplyScalar(0.7);
                // The tile textures average ~75% brightness, so lift the tint to keep the palette.
                col.multiplyScalar(1.45);
                if (TINTLESS.has(tile)) col.lerp(WHITE, C.rock.tintlessLift);
                col.offsetHSL(0, 0, jitter);
                rock.setColorAt(i++, col);
                if (air(x, y + 1)) bars.push(x + 0.5, y + 1, 1);
                if (air(x, y - 1)) bars.push(x + 0.5, y, 1);
                if (air(x + 1, y)) bars.push(x + 1, y + 0.5, 0);
                if (air(x - 1, y)) bars.push(x, y + 0.5, 0);
            }
        rock.castShadow = rock.receiveShadow = true;
        this.levelGroup.add(rock);
        if (!bars.length) return;
        const strips = new THREE.InstancedMesh(this.unitBox, this.stripMat, bars.length / 3);
        const sc = this.tmpS,
            q = this.tmpQ.identity(),
            p = this.tmpP;
        for (let k = 0; k < bars.length; k += 3) {
            const horiz = bars[k + 2] === 1;
            sc.set(horiz ? 1.04 : 0.1, horiz ? 0.1 : 1.04, 0.1);
            p.set(bars[k], bars[k + 1], 1.52);
            strips.setMatrixAt(k / 3, m.compose(p, q, sc));
        }
        this.levelGroup.add(strips);
    }

    /**
     * Compile every shader up front, including objects that start hidden, so the first thrust,
     * shield, tow or explosion doesn't stall on a shader compile mid-game.
     */
    async warmup() {
        const hidden = [this.flame, this.shield, this.rodLine, this.beamLine, this.ghost, ...this.fx.hiddenObjects()];
        const was = hidden.map((o) => o.visible);
        hidden.forEach((o) => (o.visible = true));
        this.fx.setDebrisWarm(true);
        await this.renderer.compileAsync(this.scene, this.camera);
        this.composer.render(0); // also builds the post-processing programs and targets
        hidden.forEach((o, k) => (o.visible = was[k]));
        this.fx.setDebrisWarm(false);
    }

    /**
     * One step down in GPU cost, for the frame-time governor. Order: pixel ratio (down to 1),
     * then shadows, then bloom. Returns false when there is nothing left to drop.
     */
    degrade(): boolean {
        const dpr = this.renderer.getPixelRatio();
        if (dpr > 1) {
            this.renderer.setPixelRatio(Math.max(1, dpr - 0.25));
            this.resize();
            return true;
        }
        if (this.renderer.shadowMap.enabled) {
            this.renderer.shadowMap.enabled = false;
            this.sun.castShadow = false;
            this.scene.traverse((o) => {
                const m = (o as THREE.Mesh).material as THREE.Material | undefined;
                if (m) m.needsUpdate = true;
            });
            return true;
        }
        if (this.composer.passes.includes(this.bloom)) {
            this.composer.removePass(this.bloom);
            return true;
        }
        return false;
    }

    /** Best-run ghost pose for this frame (null hides it). */
    /** A clean landing: a short camera dip, scaled by how hard it came down (0..1). */
    landed(strength = 0.5) {
        this.dip = Math.max(this.dip, 0.25 + 0.35 * strength);
    }

    setGhost(p: { x: number; y: number; a: number } | null) {
        this.ghostPose = p;
    }

    /** Sparks: see Effects.burst. */
    burst(x: number, y: number, n: number, speed: number, rgb: RGB, life = 1) {
        this.fx.burst(x, y, n, speed, rgb, life);
    }

    /** Layered voxel explosion: see Effects.explode. */
    explode(x: number, y: number, big: boolean) {
        const lv = this.builtFor;
        let nearRock = false;
        if (lv)
            for (let k = 0; k < 8 && !nearRock; k++) {
                const a = (k / 8) * Math.PI * 2;
                nearRock = solidAt(lv, x + Math.cos(a) * 2.2, y + Math.sin(a) * 2.2);
            }
        this.fx.explode(x, y, big, nearRock);
    }

    private tmpM = new THREE.Matrix4();
    private tmpQ = new THREE.Quaternion();
    private tmpP = new THREE.Vector3();
    private tmpS = new THREE.Vector3();
    private tmpC = new THREE.Color();

    sync(g: Game, dt: number) {
        const lv = g.level;
        if (lv !== this.builtFor) this.build(lv);
        const s = g.ship;
        if (this.jobs.length) this.pump(this.ts.buildMs, s.y);
        this.time += dt;
        const alive = g.phase === "play" || g.phase === "complete";

        this.ship.visible = alive;
        this.ship.position.set(s.x, s.y, 0);
        this.ship.rotation.z = s.a;
        this.flame.visible = g.thrusting;
        this.flame.scale.set(1, 0.8 + Math.random() * 0.6, 1);
        this.flame.position.y = -0.4 - this.flame.scale.y * 0.5;
        this.shield.visible = g.shielding;
        this.shield.rotation.z = this.time * 3;
        this.shipLight.position.set(s.x, s.y, 7);
        this.sun.target.position.set(s.x, s.y, 0);
        this.sun.position.set(s.x - 12, s.y + 30, 36);
        this.shipLight.intensity = alive ? (g.thrusting ? 26 : 14) : 0;
        if (g.thrusting && alive) {
            const dx = Math.sin(s.a),
                dy = -Math.cos(s.a);
            for (let k = 0; k < 2; k++) this.fx.exhaust(s.x + dx * 0.6, s.y + dy * 0.6, s.vx + dx * 9, s.vy + dy * 9);
        }

        const p = g.pod;
        // The ship trail starts just past the rear wing tips (hull y −0.62), not inside the hull.
        const TAIL = 0.85;
        this.fx.trail(0, s.x + Math.sin(s.a) * TAIL, s.y - Math.cos(s.a) * TAIL, alive, g.thrusting && alive, dt);
        this.fx.trail(1, p.x, p.y, p.attached && alive, false, dt);
        this.pod.visible = p.attached ? alive : true;
        this.pod.position.set(p.x, p.y, 0);
        this.pod.rotation.y = this.time;
        this.setLine(this.rodLine, s, p, p.attached && alive);
        this.setLine(this.beamLine, s, g.beam ?? s, !!g.beam && alive);

        lv.turrets.forEach((t, k) => {
            const { grp, barrel } = this.turrets[k];
            grp.visible = t.alive;
            const ang = Math.atan2(s.y - t.y, s.x - t.x) - Math.PI / 2 - grp.rotation.z;
            barrel.rotation.z = Math.max(-1.3, Math.min(1.3, Math.atan2(Math.sin(ang), Math.cos(ang))));
        });
        lv.fuel.forEach((f, k) => {
            this.fuel[k].visible = f.amount > 0;
            this.fuel[k].scale.y = 0.3 + 0.7 * (f.amount / 35);
        });
        const padGlow = g.onPad ? 1.6 + 0.4 * Math.sin(this.time * 10) : 1;
        this.pads.forEach((m) => {
            const [r, gg, b] = C.fixture.pad;
            (m.material as THREE.MeshBasicMaterial).color.setRGB(r * padGlow, gg * padGlow, b * padGlow);
        });
        this.beacons.forEach((m, k) => {
            m.rotation.y = this.time * 1.5 + k;
            const c = k <= g.checkpoint ? C.fixture.checkpointOn : C.fixture.checkpoint;
            (m.material as THREE.MeshBasicMaterial).color.setRGB(c[0], c[1], c[2]);
        });
        lv.mines.forEach((m, k) => {
            const grp = this.mines[k];
            grp.visible = m.alive;
            if (!m.alive) return;
            grp.position.set(m.x, m.y, 0);
            grp.rotation.z = this.time * 0.8 + k;
            grp.rotation.y = this.time * 0.5;
            // Eye pulses faster when the mine is hunting (moved off its home spot).
            const hunting = Math.hypot(m.x - m.hx, m.y - m.hy) > 0.3;
            const e = grp.getObjectByName("eye") as THREE.Mesh;
            const v = 0.5 + 0.5 * Math.sin(this.time * (hunting ? 14 : 3));
            const [r, gg, b] = C.fixture.mineEye;
            (e.material as THREE.MeshBasicMaterial).color.setRGB(r * (0.3 + v), gg * (0.3 + v), b * (0.3 + v));
        });
        lv.gates.forEach((gt, k) => {
            const { beam, mat } = this.gates[k];
            const on = gateOn(gt, g.time);
            const soon = !on && gateIn(gt, g.time) < GATE_WARN;
            beam.visible = on || (soon && Math.floor(this.time * 30) % 2 === 0);
            mat.opacity = on ? 1 : 0.35;
        });
        this.ghost.visible = !!this.ghostPose;
        if (this.ghostPose) {
            this.ghost.position.set(this.ghostPose.x, this.ghostPose.y, 0.3);
            this.ghost.rotation.z = this.ghostPose.a;
        }

        const crit = g.critical >= 0;
        const pulse = crit
            ? 0.5 + 0.5 * Math.sin(this.time * 18)
            : g.stun > 0
              ? 0.2
              : 0.7 + 0.3 * Math.sin(this.time * 3);
        const [base, swing] = crit
            ? [C.fixture.reactorCriticalBase, C.fixture.reactorCriticalSwing]
            : [C.fixture.reactorCoreBase, C.fixture.reactorCoreSwing];
        (this.reactorCore.material as THREE.MeshBasicMaterial).color.setRGB(
            base[0] + swing[0] * pulse,
            base[1] + swing[1] * pulse,
            base[2] + swing[2] * pulse
        );
        this.reactorLight.color.set(crit ? C.light.reactorCritical : C.light.reactor);
        this.reactorLight.intensity = 20 + 60 * pulse;
        this.reactor.visible = !(crit && g.critical === 0);
        if (crit) this.fx.shake = Math.max(this.fx.shake, 0.15);

        // Bullets.
        const bp = this.bullets.geometry.attributes.position.array as Float32Array;
        const bc = this.bullets.geometry.attributes.color.array as Float32Array;
        const nb = Math.min(g.bullets.length, 400);
        for (let k = 0; k < nb; k++) {
            const b = g.bullets[k];
            const c = b.enemy ? C.bullet.enemy : C.bullet.player;
            bp[k * 3] = b.x;
            bp[k * 3 + 1] = b.y;
            bp[k * 3 + 2] = 0.4;
            bc[k * 3] = c[0];
            bc[k * 3 + 1] = c[1];
            bc[k * 3 + 2] = c[2];
        }
        this.bullets.geometry.attributes.position.needsUpdate = true;
        this.bullets.geometry.attributes.color.needsUpdate = true;
        this.bullets.geometry.setDrawRange(0, nb);

        // Chase camera: lead with velocity, look slightly up from below for depth, shake.
        const aspect = this.camera.aspect;
        const z = aspect < 1 ? 30 / Math.max(aspect, 0.5) : CAM_Z;
        // Keep the view inside the built rock (MARGIN beyond the sides and bottom) whatever the
        // screen shape: the visible half-size at the rock's back faces (z −1.5) depends on aspect,
        // so a tall portrait or wide landscape screen (full screen vs browser bars) stops earlier.
        const half = (z + 1.5) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) + 0.5;
        const loX = half * aspect - MARGIN,
            hiX = lv.w + MARGIN - half * aspect;
        const vx = s.x + s.vx * 0.3;
        const tx = loX < hiX ? Math.min(Math.max(vx, loX), hiX) : lv.w / 2,
            ty = Math.max(s.y + s.vy * 0.3, half - MARGIN);
        const c = this.camera.position;
        const k = 1 - Math.exp(-dt * 4);
        if (this.time < 0.1 || Math.hypot(c.x - tx, c.y - ty) > 60) c.set(tx, ty, z);
        c.x += (tx - c.x) * k;
        c.y += (ty - 4 - c.y) * k;
        this.dip *= Math.exp(-dt * 7);
        c.y -= this.dip * Math.min(1, dt * 60);
        c.z = z;
        this.fx.shake *= Math.exp(-dt * 3);
        const sh = this.fx.shake;
        this.camera.lookAt(c.x + (Math.random() - 0.5) * sh, c.y + 4 + (Math.random() - 0.5) * sh, 0);

        setRockTime(this.rockMat, this.time);
        this.fx.update(dt, lv, c.x, c.y + 4, s.y < lv.h - 40);

        this.composer.render(dt);
    }

    private setLine(l: THREE.Line, a: { x: number; y: number }, b: { x: number; y: number }, on: boolean) {
        l.visible = on;
        if (!on) return;
        const arr = l.geometry.attributes.position.array as Float32Array;
        arr[0] = a.x;
        arr[1] = a.y;
        arr[3] = b.x;
        arr[4] = b.y;
        l.geometry.attributes.position.needsUpdate = true;
    }
}
