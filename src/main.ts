/**
 * Main — entry point and composition root: boot, game commands, pause / game over, frame loop,
 * idle handling and the frame-time governor.
 *
 * Purpose
 *   Wires the pure Game to the browser. Owns no rules: it builds the View, feeds Game the merged
 *   input (input.ts), routes Game events out to sound (audio.ts) and effects (View), keeps the
 *   splash and pause / game-over dialog in step with game state, and drives one frame at a time.
 *
 * Operations
 *   - Boot (async IIFE): splash steps, each yielding a frame so the bar paints —
 *     "Igniting engines" (detectTier, new View), "Charting planet 1" (attract Game),
 *     "Building caves" (sync + pump(Infinity)), "Warming shaders" (View.warmup). Then
 *     #boot.ready shows the launch button. No WebGL2 or a startup error → message in the splash.
 *   - start(): unlocks audio, new Game(1), hides splash / dialog, shows HUD and minimap.
 *   - setPause(open): opens / closes #pause; when game.phase is 'over' it is the game-over screen
 *     (data-kind="over"); saves the best score (localStorage 'tf-best').
 *   - Commands: Enter / Space launch, Esc / P pause, R restart (paused), Enter fly again (game
 *     over), M mute, N minimap; buttons in #pause and the touch ❚❚ do the same.
 *   - frame(): dt capped at 1/20 s → game.update(dt, steer()) → drawHud → minimap (15 Hz) →
 *     governor → engine sound → view.sync(game ?? attract).
 *   - Idle: when nothing simulates (splash, paused, game over) the loop runs SETTLE more seconds
 *     so motion comes to rest, then stops requesting frames and suspends audio; wake() (any
 *     input, resize, pause toggle, launch) restarts it. A hidden tab pauses the game.
 *   - Governor: while playing, an average frame interval above SLOW_MS for SLOW_FOR seconds calls
 *     view.degrade() (DPR → shadows → bloom), with GRACE seconds to settle after each step or a
 *     new planet. Never steps back up, so quality can't oscillate.
 *   - Lost WebGL context: reload once; a second loss within a minute shows a message instead.
 *
 * Usage
 *   Loaded by index.html as the only module script; expects its DOM ids (#app, #hud, #minimap,
 *   #joy, #touch, #boot and .ls-*, #pause and pause-*).
 *
 * Highlights
 *   - The tier picks starting quality; the governor corrects it on the device itself.
 *   - window.__game / window.__running are read-only test hooks used by scripts/smoke.py.
 *
 * See also: game.ts, view.ts, input.ts, hud.ts, minimap.ts, tier.ts, audio.ts, index.html;
 * DESIGN.md "9. Input", "10. UI", "12. Frame loop".
 */
import "./styles.css";
import { Game, type GameEvent } from "./game";
import { View } from "./view";
import { Minimap } from "./minimap";
import { drawHud } from "./hud";
import { clearInput, HELP, isTouch, setupInput, steer } from "./input";
import { applyUiColors, COLORS, type RGB } from "./palette";
import { detectTier, TIER_SETTINGS } from "./tier";
import { sfx, setEngine, toggleMute, unlock, isMuted, suspendAudio } from "./audio";

const $ = (id: string) => document.getElementById(id)!;
const boot = $("boot"),
    pauseEl = $("pause"),
    hud = $("hud");
applyUiColors();
setupInput();

document.querySelector("#pause .bindings")!.innerHTML = HELP.map(
    ([k, v]) => `<div class="binding"><kbd>${k}</kbd><span>${v}</span></div>`
).join("");
document.querySelector(".ls-controls")!.textContent = HELP.slice(0, 4)
    .map(([k, v]) => `${k} ${v}`)
    .join("   ·   ");
document.querySelector(".ls-enter")!.textContent = isTouch ? "Tap to launch" : "Click or press Enter to launch";

let view: View;
const minimap = new Minimap($("minimap"));
let attract: Game;
let game: Game | null = null;
let paused = false;
let ready = false;
let best = Number(localStorage.getItem("tf-best") ?? 0);

// Small one-colour bursts per event; explosions get the full layered treatment (View.explode).
const BURSTS: Partial<Record<GameEvent, [count: number, speed: number, rgb: RGB, life: number]>> = {
    hit: [6, 4, COLORS.fx.hit, 0.3],
    fuel: [30, 5, COLORS.fx.fuel, 0.8],
    attach: [24, 4, COLORS.fx.attach, 0.6],
    land: [10, 2, COLORS.fx.land, 0.4],
};

function onEvent(e: GameEvent, x: number, y: number) {
    sfx[e]?.();
    if (e === "bigBoom" || e === "boom") view.explode(x, y, e === "bigBoom");
    const b = BURSTS[e];
    if (b) view.burst(x, y, ...b);
    if (e === "gameover") setPause(true);
}

function start() {
    unlock();
    game = new Game(1);
    game.onEvent = onEvent;
    setPause(false);
    hud.hidden = false;
    $("minimap").hidden = false;
    if (!boot.classList.contains("dismissed")) {
        boot.classList.add("dismissed");
        setTimeout(() => boot.classList.add("gone"), 700);
    }
}

function setPause(open: boolean) {
    const over = !!game && game.phase === "over";
    if (game && game.score > best) {
        best = game.score;
        localStorage.setItem("tf-best", String(best));
    }
    paused = open;
    pauseEl.dataset.kind = over ? "over" : "pause";
    $("pause-title").textContent = over ? "Mission over" : "Paused";
    document.querySelector("#pause .p-score")!.textContent = game
        ? `Score ${game.score.toLocaleString()} · Planet ${game.levelNo}: ${game.level.name} · Best ${best.toLocaleString()}`
        : "";
    $("pause-mute").querySelector("span")!.textContent = `Sound ${isMuted() ? "off" : "on"}`;
    pauseEl.classList.toggle("open", open);
    wake();
    if (open) (over ? $("pause-restart") : $("pause-resume")).focus({ preventScroll: true });
    else unlock();
}

// ---- Commands ---------------------------------------------------------------------------------

addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (!game) {
        if (ready && (e.code === "Enter" || e.code === "Space")) start();
        return;
    }
    const over = game.phase === "over";
    if (e.code === "Escape" || e.code === "KeyP") {
        if (!over) setPause(!paused);
    } else if ((e.code === "KeyR" && paused) || (e.code === "Enter" && over)) start();
    else if (e.code === "KeyN") minimap.toggle();
    else if (e.code === "KeyM") {
        toggleMute();
        if (paused) setPause(true);
    }
});
boot.addEventListener("click", () => ready && !game && start());
$("pause-resume").addEventListener("click", () => setPause(false));
$("pause-restart").addEventListener("click", start);
$("pause-mute").addEventListener("click", () => {
    toggleMute();
    setPause(true);
});
pauseEl.addEventListener("click", (e) => {
    if (e.target === pauseEl && game?.phase !== "over") setPause(false);
});
$("t-pause").addEventListener("click", () => {
    if (game && game.phase !== "over") setPause(true);
});

// Any input or resize wakes an idle loop; losing focus or hiding the tab pauses the game.
for (const ev of ["keydown", "pointerdown", "pointermove", "wheel", "resize"] as const)
    addEventListener(ev, wake, { passive: true });
addEventListener("blur", () => {
    clearInput();
    if (game && game.phase !== "over") setPause(true);
});
document.addEventListener("visibilitychange", () => {
    if (document.hidden && game && game.phase !== "over" && !paused) setPause(true);
});

// ---- Frame loop + idle ------------------------------------------------------------------------

const SETTLE = 1.5;
let last = performance.now();
let idleFor = 0;
let running = false;
let lastMap = 0;

function wake() {
    idleFor = 0;
    if (running || !view) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
}

function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    const active = !!game && !paused;
    idleFor = active ? 0 : idleFor + dt;
    if (idleFor > SETTLE) {
        running = false;
        suspendAudio();
        return;
    }
    requestAnimationFrame(frame);
    if (game && active) {
        game.update(dt, steer(game.ship.a));
        drawHud(game);
        if (now - lastMap > 66) {
            lastMap = now; // the minimap is coarse: 15 Hz is plenty
            minimap.draw(game);
        }
        govern(now, game);
    }
    setEngine(!!game && active && game.thrusting && game.phase === "play");
    view.sync(game ?? attract, paused ? 0 : dt);
}

// ---- Governor ---------------------------------------------------------------------------------

const SLOW_MS = 26,
    SLOW_FOR = 2,
    GRACE = 3;
let avgMs = 16,
    slowFor = 0,
    graceUntil = 0,
    lastGov = 0,
    govLevel: unknown = null;

function govern(now: number, g: Game) {
    const ms = now - lastGov;
    lastGov = now;
    if (ms > 250 || document.hidden) return; // first frame after a pause / tab switch
    if (g.level !== govLevel) {
        govLevel = g.level; // new planet: rock is streaming in, don't judge yet
        graceUntil = now + GRACE * 1000;
    }
    avgMs += (ms - avgMs) * 0.05;
    if (now < graceUntil) return;
    slowFor = avgMs > SLOW_MS ? slowFor + ms / 1000 : 0;
    if (slowFor < SLOW_FOR) return;
    slowFor = 0;
    graceUntil = now + GRACE * 1000;
    if (view.degrade()) console.info(`[thrust-force] slow frames (${avgMs.toFixed(1)} ms): quality stepped down`);
}

// ---- Boot -------------------------------------------------------------------------------------

const bar = document.querySelector<HTMLElement>(".ls-bar span")!,
    tip = document.querySelector(".ls-tip")!;
const STEPS = ["Igniting engines", "Charting planet 1", "Building caves", "Warming shaders"];
const step = async (i: number) => {
    tip.textContent = `${STEPS[i]}…`;
    bar.style.width = `${((i + 1) / STEPS.length) * 100}%`;
    await new Promise(requestAnimationFrame);
};
const fail = (msg: string) => {
    boot.classList.remove("ready", "dismissed", "gone");
    const sub = document.querySelector(".ls-sub")!;
    sub.classList.add("error");
    sub.textContent = msg;
};

(async () => {
    try {
        await step(0);
        const tier = detectTier();
        if (tier === "none")
            return fail(
                "This browser or device has no WebGL2, which Thrust Force needs. Try a current Chrome, Edge, Firefox or Safari."
            );
        document.documentElement.dataset.tier = tier;
        view = new View($("app"), TIER_SETTINGS[tier]);
        watchContext(view.renderer.domElement);
        await step(1);
        attract = new Game(1);
        await step(2);
        view.sync(attract, 0); // builds the planet's cheap parts and queues the rock chunks
        view.pump(Infinity, attract.ship.y); // behind the splash, so build it all now
        await step(3);
        await view.warmup();
        document.querySelector(".ls-best")!.textContent = best ? `Best ${best.toLocaleString()}` : "";
        boot.classList.add("ready");
        ready = true;
        wake();
    } catch (err) {
        fail(`Could not start WebGL: ${(err as Error).message}. Adding ?tier=low to the address may help.`);
    }
})();

function watchContext(canvas: HTMLCanvasElement) {
    canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        if (!sessionStorage.getItem("tf-ctx-reload")) {
            sessionStorage.setItem("tf-ctx-reload", "1");
            location.reload();
        } else fail("The graphics context was lost. Close other tabs or apps and reload the page.");
    });
    setTimeout(() => sessionStorage.removeItem("tf-ctx-reload"), 60000);
}

// Test hooks (scripts/smoke.py reads state through these).
Object.defineProperty(window, "__game", { get: () => game });
Object.defineProperty(window, "__running", { get: () => running });
