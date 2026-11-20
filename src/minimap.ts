/**
 * Minimap — a pixel map of the whole planet in the bottom-right corner, with live markers.
 *
 * Purpose
 *   Shows where you are in the planet: surface, shaft and caves, plus the ship, pod, reactor,
 *   turrets and fuel cells, so routes and threats can be read at a glance.
 *
 * Operations
 *   - draw(game): when game.level changes, bakes the grid into an offscreen canvas at 1 px per
 *     cell (rock shaded by depth, air-facing rock edges in cyan, sky clear) and resizes the
 *     visible canvas to fit MAX_W x MAX_H CSS px. Every call then blits that bake (nearest
 *     scaling, so it stays pixel-crisp like the voxels) and draws the markers on top: fuel
 *     (green), live turrets (red), reactor (amber, red strobe when critical), pod (amber),
 *     ship (cyan, with a heading tick) and a faint box for the camera's rough view.
 *   - toggle(): collapses to / expands from the map icon button.
 *
 * Usage
 *   main.ts: const map = new Minimap($('minimap')); map.draw(game) each active frame;
 *   N key or a click on the map toggles it. It starts collapsed (iconified) only when the
 *   screen is too small to spare the room (phones), open otherwise (tablets, desktops);
 *   re-checked on resize / rotation until the player toggles it.
 *
 * Highlights
 *   - 2D canvas only, no three.js: a few hundred fillRects per frame, negligible cost.
 *   - Rendered at devicePixelRatio for sharp markers; the bake is scaled with smoothing off.
 *   - Hidden with the HUD before launch.
 *
 * See also: main.ts, level.ts (grid, surface), index.html (#minimap); DESIGN.md "10. UI".
 */
import type { Game } from './game';
import type { Level } from './level';
import { COLORS } from './palette';

const M = COLORS.minimap;

const MAX_W = 150,
    MAX_H = 210;

export class Minimap {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private bake = document.createElement('canvas');
    private level: Level | null = null;
    private scale = 1; // CSS px per cell
    private dpr = Math.min(devicePixelRatio || 1, 2);

    /** True once the player has toggled the map; from then on their choice sticks. */
    private chosen = false;

    constructor(private root: HTMLElement) {
        this.canvas = root.querySelector('canvas')!;
        this.ctx = this.canvas.getContext('2d')!;
        this.fit();
        addEventListener('resize', () => this.fit());
        root.addEventListener('click', () => this.toggle());
        // Don't take focus on press, or Space (fire) would then "click" the button.
        root.addEventListener('pointerdown', (e) => e.preventDefault());
    }

    private last: Game | null = null;

    /**
     * Collapse to the icon only when the screen can't spare the room: the open map needs about
     * MAX_W x MAX_H plus margins, and must leave most of a phone screen for play. Phones in
     * portrait or landscape collapse; tablets and desktops stay open. Re-checked on resize and
     * rotation until the player picks for themselves.
     */
    private fit() {
        if (this.chosen) return;
        const roomy = innerWidth >= MAX_W * 4 && innerHeight >= MAX_H * 2.4;
        this.root.classList.toggle('collapsed', !roomy);
    }

    toggle() {
        this.chosen = true;
        this.root.classList.toggle('collapsed');
        if (this.last) this.draw(this.last); // so it isn't blank when opened while paused
    }

    private rebake(lv: Level) {
        this.level = lv;
        const { w, h, grid } = lv;
        this.bake.width = w;
        this.bake.height = h;
        const bctx = this.bake.getContext('2d')!;
        const img = bctx.createImageData(w, h);
        const solid = (x: number, y: number) => x < 0 || x >= w || y < 0 || (y < h && grid[y * w + x] === 1);
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const i = ((h - 1 - y) * w + x) * 4; // canvas rows run top-down; the grid runs bottom-up
                if (!solid(x, y)) {
                    // Air: faint blue inside the planet, clear in the sky.
                    img.data.set(y < lv.surface[x] ? [...M.air, 200] : [0, 0, 0, 0], i);
                    continue;
                }
                const edge = !solid(x + 1, y) || !solid(x - 1, y) || !solid(x, y + 1) || !solid(x, y - 1);
                const t = y / h;
                const [lo, hi] = [M.rockLow, M.rockHigh];
                img.data.set(
                    edge ? [...M.edge, 255] : [lo[0] + (hi[0] - lo[0]) * t, lo[1] + (hi[1] - lo[1]) * t, lo[2] + (hi[2] - lo[2]) * t, 235],
                    i,
                );
            }
        bctx.putImageData(img, 0, 0);
        this.scale = Math.min(MAX_W / w, MAX_H / h);
        const cw = Math.round(w * this.scale),
            ch = Math.round(h * this.scale);
        this.canvas.style.width = `${cw}px`;
        this.canvas.style.height = `${ch}px`;
        this.canvas.width = Math.round(cw * this.dpr);
        this.canvas.height = Math.round(ch * this.dpr);
    }

    draw(g: Game) {
        this.last = g;
        if (this.root.classList.contains('collapsed')) return;
        const lv = g.level;
        if (lv !== this.level) this.rebake(lv);
        const c = this.ctx,
            k = this.scale * this.dpr,
            H = lv.h;
        const px = (x: number) => x * k,
            py = (y: number) => (H - y) * k;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, this.canvas.width, this.canvas.height);
        c.imageSmoothingEnabled = false;
        c.drawImage(this.bake, 0, 0, this.canvas.width, this.canvas.height);

        const dot = (x: number, y: number, r: number, color: string) => {
            c.fillStyle = color;
            c.fillRect(px(x) - r * this.dpr, py(y) - r * this.dpr, 2 * r * this.dpr, 2 * r * this.dpr);
        };
        for (const f of lv.fuel) if (f.amount > 0) dot(f.x, f.y, 1.5, M.fuel);
        for (const t of lv.turrets) if (t.alive) dot(t.x, t.y, 1.5, M.turret);
        const crit = g.critical >= 0;
        if (!(crit && g.critical === 0))
            dot(lv.reactor.x, lv.reactor.y + 1, 2.5, crit && Math.floor(performance.now() / 150) % 2 ? M.reactorCritical : M.reactor);
        dot(g.pod.x, g.pod.y, 2, M.pod);

        const s = g.ship;
        if (g.phase === 'play' || g.phase === 'complete') {
            // Camera's rough view (visible half-extent ~ 16 x 12 cells at the default zoom).
            c.strokeStyle = M.view;
            c.lineWidth = this.dpr;
            c.strokeRect(px(s.x - 20), py(s.y + 12), 40 * k, 24 * k);
            dot(s.x, s.y, 2, M.ship);
            c.strokeStyle = M.heading;
            c.lineWidth = 1.5 * this.dpr;
            c.beginPath();
            c.moveTo(px(s.x), py(s.y));
            c.lineTo(px(s.x - Math.sin(s.a) * 4), py(s.y + Math.cos(s.a) * 4));
            c.stroke();
        }
    }
}
