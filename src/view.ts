/**
 * View — three.js presentation of a Game: scene, meshes, particles, chase camera, post-FX.
 *
 * Purpose
 *   Draws the game side-on in 2.5D. Rock cells are instanced voxel boxes (depth 3) with HDR
 *   neon strips on every air-facing edge, a dark back wall fills the tunnels, stars sit behind
 *   the sky, a light rides with the ship, and bloom (plus shadows on the high tier) finishes the
 *   look. Each planet gets one of six palettes.
 *
 * Operations
 *   - constructor(parent, tierSettings): renderer (MSAA, DPR cap, ACES tone mapping, optional
 *     PCF-soft shadows), lights, the persistent ship / pod / rod / beam / bullet / particle
 *     objects, and the composer (RenderPass → UnrealBloomPass if the tier allows → OutputPass).
 *   - build(level) (private): when game.level changes identity, disposes the old level and
 *     builds rock instances, edge-strip instances, back wall, stars, pedestal, turrets, fuel
 *     cells and reactor.
 *   - sync(game, dt): poses everything from game state (ship, flame, shield, pod + rod, beam,
 *     turret barrels tracking the ship, fuel cell fill, reactor pulse / critical strobe),
 *     refills the bullet buffer, integrates and compacts particles, emits thrust exhaust, moves
 *     the chase camera and shadow-casting sun, then renders.
 *   - burst(x, y, n, speed, rgb, life): particle explosion; big bursts add camera shake.
 *   - resize(): on window resize.
 *
 * Usage
 *   main.ts creates one View at boot with TIER_SETTINGS[tier], calls sync(game ?? attract, dt)
 *   every frame, and burst() from game events. scene, camera and renderer are public so boot
 *   can renderer.compileAsync(scene, camera) to warm shaders.
 *
 * Highlights
 *   - Read-only with respect to Game; never writes game state.
 *   - What glows is decided by one rule: neon materials are toneMapped:false with HDR colours
 *     (>1), so they cross the bloom threshold (0.82) while lit surfaces mostly don't.
 *   - Particles are a fixed pool; dead ones are compacted to the front every frame so the
 *     draw range is exactly the live set. When full, random slots are overwritten.
 *   - The camera sits 4 units below its look-at point so floors show their tops and tunnels
 *     read as 3D; portrait screens pull the camera back (z = 30 / aspect).
 *
 * See also: game.ts (state it draws), tier.ts (quality knobs), main.ts; DESIGN.md
 * "7. Rendering".
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Game } from './game';
import type { Level } from './level';
import type { TierSettings } from './tier';

const PALETTES = [
    { deep: 0x2a1d3a, top: 0x6b4a7a, surf: 0x9a7bd0, neon: [0.4, 1.6, 3.0], sky: 0x07071a },
    { deep: 0x3a1e12, top: 0x8a4a28, surf: 0xd08a4a, neon: [3.0, 1.0, 0.3], sky: 0x140806 },
    { deep: 0x0f2a24, top: 0x2f6a58, surf: 0x6ad0a0, neon: [0.3, 3.0, 1.4], sky: 0x03100e },
    { deep: 0x1a2236, top: 0x52617f, surf: 0xc8d6f0, neon: [1.8, 2.4, 3.0], sky: 0x060a14 },
    { deep: 0x301018, top: 0x7a2a3a, surf: 0xe0708a, neon: [3.0, 0.4, 1.4], sky: 0x12040a },
    { deep: 0x2a2a10, top: 0x6a6a2a, surf: 0xd8d070, neon: [2.6, 2.4, 0.4], sky: 0x0c0c04 },
];

function dotTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
}

function pointsLayer(max: number, size: number, tex: THREE.Texture) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
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

const neonMat = (r: number, g: number, b: number) =>
    new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b), toneMapped: false });

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
    private shipLight = new THREE.PointLight(0x9fd8ff, 14, 18, 1.4);
    private pod = new THREE.Group();
    private rodLine: THREE.Line;
    private beamLine: THREE.Line;
    private turrets: THREE.Group[] = [];
    private fuel: THREE.Group[] = [];
    private reactor = new THREE.Group();
    private reactorCore!: THREE.Mesh;
    private reactorLight = new THREE.PointLight(0xff6a2a, 50, 18, 1.6);
    private bullets: THREE.Points;
    private sparks: THREE.Points;
    private sun = new THREE.DirectionalLight(0xffffff, 1.6);
    private maxP: number;
    private pv: Float32Array;
    private plife: Float32Array;
    private pcol: Float32Array;
    private pn = 0;
    private shake = 0;
    private time = 0;

    constructor(
        parent: HTMLElement,
        private ts: TierSettings,
    ) {
        this.renderer = new THREE.WebGLRenderer({ antialias: ts.antialias, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, ts.dprCap));
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        parent.appendChild(this.renderer.domElement);
        this.maxP = ts.particles;
        this.pv = new Float32Array(this.maxP * 2);
        this.plife = new Float32Array(this.maxP);
        this.pcol = new Float32Array(this.maxP * 3);

        // Sun from upper-left-front. On the high tier it casts a soft shadow map that follows the
        // ship, so rock, ship and pod throw shadows onto the back wall and tunnel sides.
        this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x201810, 0.9));
        if (ts.shadows) {
            this.renderer.shadowMap.enabled = true;
            this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            this.sun.castShadow = true;
            this.sun.shadow.mapSize.set(2048, 2048);
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
            new THREE.MeshStandardMaterial({ color: 0x5a6678, metalness: 0.7, roughness: 0.35 }),
        );
        const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(hullGeo, 30),
            new THREE.LineBasicMaterial({ color: new THREE.Color(0.6, 2.2, 3.0), toneMapped: false }),
        );
        const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), neonMat(0.5, 2.5, 3));
        canopy.position.set(0, 0.2, 0.32);
        this.flame = new THREE.Mesh(
            new THREE.ConeGeometry(0.28, 1, 10),
            new THREE.MeshBasicMaterial({
                color: new THREE.Color(3, 1.4, 0.4),
                toneMapped: false,
                transparent: true,
                opacity: 0.9,
                blending: THREE.AdditiveBlending,
            }),
        );
        this.flame.rotation.z = Math.PI;
        this.shield = new THREE.Mesh(
            new THREE.RingGeometry(1.2, 1.32, 48),
            new THREE.MeshBasicMaterial({
                color: new THREE.Color(0.6, 2, 3),
                toneMapped: false,
                transparent: true,
                opacity: 0.8,
                blending: THREE.AdditiveBlending,
                side: THREE.DoubleSide,
            }),
        );
        hullMesh.castShadow = true;
        this.ship.add(hullMesh, edges, canopy, this.flame, this.shield);
        this.scene.add(this.shipLight);

        // Pod: glossy orb in a neon ring.
        const orb = new THREE.Mesh(
            new THREE.SphereGeometry(0.6, 24, 16),
            new THREE.MeshStandardMaterial({ color: 0x8090a0, metalness: 0.8, roughness: 0.25 }),
        );
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.06, 8, 32), neonMat(2.8, 2.2, 0.6));
        orb.castShadow = true;
        this.pod.add(orb, ring);

        const lineMat = (r: number, g: number, b: number) =>
            new THREE.LineBasicMaterial({ color: new THREE.Color(r, g, b), toneMapped: false });
        const line = () => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        this.rodLine = new THREE.Line(line(), lineMat(2.4, 2.0, 0.8));
        this.beamLine = new THREE.Line(line(), lineMat(0.6, 3, 1.2));
        this.rodLine.frustumCulled = this.beamLine.frustumCulled = false;
        this.scene.add(this.rodLine, this.beamLine);

        const tex = dotTexture();
        this.bullets = pointsLayer(400, 0.5, tex);
        this.sparks = pointsLayer(this.maxP, 0.35, tex);
        this.scene.add(this.bullets, this.sparks);

        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.5, 0.82);
        if (ts.bloom) this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
        this.resize();
        addEventListener('resize', () => this.resize());
    }

    resize() {
        const w = innerWidth,
            h = innerHeight;
        this.renderer.setSize(w, h);
        this.composer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    private build(lv: Level) {
        this.levelGroup.traverse((o) => {
            if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.InstancedMesh) {
                o.geometry.dispose();
                (o.material as THREE.Material).dispose();
            }
        });
        this.levelGroup.clear();
        const pal = PALETTES[(lv.n - 1) % PALETTES.length];
        this.scene.background = new THREE.Color(pal.sky);
        const { w, h, grid } = lv;
        const solid = (x: number, y: number) => x < 0 || x >= w || y < 0 || (y < h && grid[y * w + x] === 1);
        const air = (x: number, y: number) => x >= 0 && x < w && y >= 0 && !solid(x, y);

        // Rock voxels.
        let count = 0;
        for (const c of grid) count += c;
        const rock = new THREE.InstancedMesh(
            new THREE.BoxGeometry(1, 1, 3),
            new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 }),
            count,
        );
        const m = new THREE.Matrix4();
        const col = new THREE.Color();
        const deep = new THREE.Color(pal.deep),
            top = new THREE.Color(pal.top),
            surf = new THREE.Color(pal.surf);
        let i = 0;
        const bars: { x: number; y: number; horiz: boolean }[] = [];
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                if (!solid(x, y)) continue;
                const hash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
                const jitter = (hash - Math.floor(hash)) * 0.18 - 0.09;
                m.makeTranslation(x + 0.5, y + 0.5, 0);
                rock.setMatrixAt(i, m);
                col.copy(deep).lerp(top, y / h);
                if (air(x, y + 1) && y >= lv.surface[x] - 2) col.copy(surf);
                col.offsetHSL(0, 0, jitter);
                rock.setColorAt(i++, col);
                if (air(x, y + 1)) bars.push({ x: x + 0.5, y: y + 1, horiz: true });
                if (air(x, y - 1)) bars.push({ x: x + 0.5, y, horiz: true });
                if (air(x + 1, y)) bars.push({ x: x + 1, y: y + 0.5, horiz: false });
                if (air(x - 1, y)) bars.push({ x, y: y + 0.5, horiz: false });
            }
        rock.castShadow = rock.receiveShadow = true;
        this.levelGroup.add(rock);

        // Neon edge strips on the front face.
        const [nr, ng, nb] = pal.neon;
        const strips = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), neonMat(nr, ng, nb), bars.length);
        const s = new THREE.Vector3(),
            q = new THREE.Quaternion(),
            p = new THREE.Vector3();
        bars.forEach((b, k) => {
            s.set(b.horiz ? 1.04 : 0.1, b.horiz ? 0.1 : 1.04, 0.1);
            p.set(b.x, b.y, 1.52);
            strips.setMatrixAt(k, m.compose(p, q, s));
        });
        this.levelGroup.add(strips);

        // Back wall behind the tunnels, shaped to the surface so the sky stays open.
        const back = new THREE.Shape();
        back.moveTo(0, 0);
        back.lineTo(w, 0);
        for (let x = w - 1; x >= 0; x--) back.lineTo(x + 0.5, lv.surface[x] - 1);
        const wall = new THREE.Mesh(
            new THREE.ShapeGeometry(back),
            new THREE.MeshStandardMaterial({ color: new THREE.Color(pal.deep).multiplyScalar(0.55), roughness: 1 }),
        );
        wall.position.z = -1.45;
        wall.receiveShadow = true;
        this.levelGroup.add(wall);

        // Stars.
        const starCount = this.ts.stars;
        const sp = new Float32Array(starCount * 3),
            sc = new Float32Array(starCount * 3);
        for (let k = 0; k < starCount; k++) {
            sp.set([-80 + Math.random() * (w + 160), h * 0.4 + Math.random() * h, -40 - Math.random() * 40], k * 3);
            const v = 0.4 + Math.random() * 1.4;
            sc.set([v, v, v * 1.1], k * 3);
        }
        const sg = new THREE.BufferGeometry();
        sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
        sg.setAttribute('color', new THREE.BufferAttribute(sc, 3));
        const stars = new THREE.Points(
            sg,
            new THREE.PointsMaterial({
                size: 0.5,
                vertexColors: true,
                map: dotTexture(),
                transparent: true,
                toneMapped: false,
            }),
        );
        this.levelGroup.add(stars);

        // Pod pedestal.
        const ped = new THREE.Mesh(
            new THREE.CylinderGeometry(0.9, 1.1, 0.25, 16),
            new THREE.MeshStandardMaterial({ color: 0x506070, metalness: 0.7, roughness: 0.4 }),
        );
        ped.position.set(lv.pod.x, lv.pod.y - 0.62, 0);
        this.levelGroup.add(ped);

        // Turrets: dome + barrel, flipped for ceiling mounts.
        const domeGeo = new THREE.SphereGeometry(0.6, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
        const barrelGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.9, 8);
        barrelGeo.translate(0, 0.45, 0);
        const tMat = new THREE.MeshStandardMaterial({ color: 0x7a2020, metalness: 0.5, roughness: 0.4 });
        const eyeMat = neonMat(3, 0.3, 0.2);
        this.turrets = lv.turrets.map((t) => {
            const g = new THREE.Group();
            const dome = new THREE.Mesh(domeGeo, tMat);
            dome.position.y = -0.45;
            const eye = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), eyeMat);
            eye.position.set(0, -0.15, 0.45);
            const barrel = new THREE.Mesh(barrelGeo, tMat);
            barrel.position.y = -0.1;
            barrel.name = 'barrel';
            dome.castShadow = barrel.castShadow = true;
            g.add(dome, eye, barrel);
            g.position.set(t.x, t.y, 0);
            if (!t.up) g.rotation.z = Math.PI;
            this.levelGroup.add(g);
            return g;
        });

        // Fuel cells.
        const fGeo = new THREE.BoxGeometry(1, 1, 1);
        const fMat = new THREE.MeshStandardMaterial({ color: 0x30383a, metalness: 0.6, roughness: 0.4 });
        const fBand = neonMat(0.4, 3, 0.8);
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
        const rMat = new THREE.MeshStandardMaterial({ color: 0x606a78, metalness: 0.7, roughness: 0.35 });
        const base = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.8, 2.4), rMat);
        base.position.y = 0.4;
        const dome = new THREE.Mesh(new THREE.SphereGeometry(1.3, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), rMat);
        dome.position.y = 0.8;
        this.reactorCore = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), neonMat(3, 1.2, 0.3));
        this.reactorCore.position.set(0, 1.2, 1.05);
        const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 2.6, 12), rMat);
        chimney.position.set(1.2, 1.9, -0.4);
        base.castShadow = dome.castShadow = chimney.castShadow = true;
        this.reactor.add(base, dome, this.reactorCore, chimney, this.reactorLight);
        this.reactorLight.position.set(0, 2, 2);
        this.reactor.position.set(lv.reactor.x, lv.reactor.y, 0);
        this.reactor.visible = true;
        this.builtFor = lv;
        this.pn = 0;
    }

    burst(x: number, y: number, n: number, speed: number, rgb: [number, number, number], life = 1) {
        for (let k = 0; k < n; k++) {
            const i = this.pn < this.maxP ? this.pn++ : Math.floor(Math.random() * this.maxP);
            const a = Math.random() * Math.PI * 2,
                v = speed * (0.2 + Math.random());
            const pos = this.sparks.geometry.attributes.position.array as Float32Array;
            pos.set([x, y, (Math.random() - 0.5) * 1.5], i * 3);
            this.pv[i * 2] = Math.cos(a) * v;
            this.pv[i * 2 + 1] = Math.sin(a) * v;
            this.plife[i] = life * (0.5 + Math.random() * 0.5);
            this.pcol.set(rgb, i * 3);
        }
        if (n > 30) this.shake = Math.max(this.shake, n / 80);
    }

    sync(g: Game, dt: number) {
        const lv = g.level;
        if (lv !== this.builtFor) this.build(lv);
        this.time += dt;
        const s = g.ship;
        const alive = g.phase === 'play' || g.phase === 'complete';

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
            for (let k = 0; k < 2; k++) {
                this.burst(s.x + dx * 0.6, s.y + dy * 0.6, 1, 2, [3, 1.2, 0.3], 0.35);
                const i = this.pn - 1;
                this.pv[i * 2] += s.vx + dx * 9;
                this.pv[i * 2 + 1] += s.vy + dy * 9;
            }
        }

        const p = g.pod;
        this.pod.visible = p.attached ? alive : true;
        this.pod.position.set(p.x, p.y, 0);
        this.pod.rotation.y = this.time;
        this.setLine(this.rodLine, s, p, p.attached && alive);
        this.setLine(this.beamLine, s, g.beam ?? s, !!g.beam && alive);

        lv.turrets.forEach((t, k) => {
            const grp = this.turrets[k];
            grp.visible = t.alive;
            const barrel = grp.getObjectByName('barrel')!;
            const ang = Math.atan2(s.y - t.y, s.x - t.x) - Math.PI / 2 - grp.rotation.z;
            barrel.rotation.z = Math.max(-1.3, Math.min(1.3, Math.atan2(Math.sin(ang), Math.cos(ang))));
        });
        lv.fuel.forEach((f, k) => {
            this.fuel[k].visible = f.amount > 0;
            this.fuel[k].scale.y = 0.3 + 0.7 * (f.amount / 35);
        });

        const crit = g.critical >= 0;
        const pulse = crit
            ? 0.5 + 0.5 * Math.sin(this.time * 18)
            : g.stun > 0
              ? 0.2
              : 0.7 + 0.3 * Math.sin(this.time * 3);
        (this.reactorCore.material as THREE.MeshBasicMaterial).color.setRGB(
            3 * pulse + 0.4,
            crit ? 0.1 : 1.2 * pulse,
            0.2,
        );
        this.reactorLight.color.set(crit ? 0xff2010 : 0xff7a30);
        this.reactorLight.intensity = 20 + 60 * pulse;
        this.reactor.visible = !(crit && g.critical === 0);
        if (crit) this.shake = Math.max(this.shake, 0.15);

        // Bullets.
        const bp = this.bullets.geometry.attributes.position.array as Float32Array;
        const bc = this.bullets.geometry.attributes.color.array as Float32Array;
        const nb = Math.min(g.bullets.length, 400);
        for (let k = 0; k < nb; k++) {
            const b = g.bullets[k];
            bp.set([b.x, b.y, 0.4], k * 3);
            bc.set(b.enemy ? [3, 0.8, 0.2] : [1.5, 2.5, 3], k * 3);
        }
        this.bullets.geometry.attributes.position.needsUpdate = true;
        this.bullets.geometry.attributes.color.needsUpdate = true;
        this.bullets.geometry.setDrawRange(0, nb);

        // Particles: integrate, fade, compact the dead ones away.
        const pos = this.sparks.geometry.attributes.position.array as Float32Array;
        const colr = this.sparks.geometry.attributes.color.array as Float32Array;
        let live = 0;
        for (let k = 0; k < this.pn; k++) {
            if ((this.plife[k] -= dt) <= 0) continue;
            this.pv[k * 2 + 1] -= lv.gravity * 0.4 * dt;
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

        // Chase camera: lead with velocity, look slightly up from below for depth, shake.
        const aspect = this.camera.aspect;
        const z = aspect < 1 ? 30 / Math.max(aspect, 0.5) : 34;
        const tx = s.x + s.vx * 0.3,
            ty = s.y + s.vy * 0.3;
        const c = this.camera.position;
        const k = 1 - Math.exp(-dt * 4);
        if (this.time < 0.1 || c.distanceTo(new THREE.Vector3(tx, ty, z)) > 60) c.set(tx, ty, z);
        c.x += (tx - c.x) * k;
        c.y += (ty - 4 - c.y) * k;
        c.z = z;
        this.shake *= Math.exp(-dt * 3);
        const sh = this.shake;
        this.camera.lookAt(c.x + (Math.random() - 0.5) * sh, c.y + 4 + (Math.random() - 0.5) * sh, 0);

        this.composer.render(dt);
    }

    private setLine(l: THREE.Line, a: { x: number; y: number }, b: { x: number; y: number }, on: boolean) {
        l.visible = on;
        if (!on) return;
        const arr = l.geometry.attributes.position.array as Float32Array;
        arr.set([a.x, a.y, 0, b.x, b.y, 0]);
        l.geometry.attributes.position.needsUpdate = true;
    }
}
