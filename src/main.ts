/**
 * Main — entry point and composition root: boot, menus and run flow, commands, frame loop, idle,
 * governor, hints, ghosts, haptics and music intensity.
 *
 * Purpose
 *   Wires the pure Game to the browser. Owns no rules: it builds the View, runs the menu → run →
 *   summary / game over → menu flow, feeds Game the merged input, routes Game events out to sound,
 *   effects and haptics, and drives one frame at a time.
 *
 * Operations
 *   - boot(): splash steps, each yielding a frame — "Igniting engines" (detectTier with the
 *     Options override, new View), "Charting planet 1" (attract Game), "Building caves" (rock in
 *     ~12 ms slices, a frame and a bar update between each), "Warming shaders" (View.warmup),
 *     "Loading fonts" (document.fonts.ready, capped at 1.5 s). Then the main menu.
 *   - showMenu(): the splash as main menu — Continue (next uncleared planet), New game (How to
 *     play first time), Planet select, Daily planet (layout seeded by today's date), Options,
 *     How to play.
 *   - startRun(n, seed?): a fresh Game; mode 'campaign' or 'daily'. Each planet load shows the
 *     intro card, loads that planet's ghost and resets the recorder (onPlanetLoaded).
 *   - Planet cleared ('complete' event) → showSummary() after the blast: campaign records stars
 *     and progress and keeps the run as the ghost if fastest, then Next planet or Main menu;
 *     daily records the day's best score.
 *   - Game over → #pause as the game-over card: run stats, Fly again (same planet, fresh lives),
 *     Share result, Main menu. Pause: Resume, Restart planet, Sound, Main menu.
 *   - frame(): dt capped at 1/20 s (× 0.75 with the slow assist) → game.update(steer) → HUD →
 *     minimap (15 Hz) → hints → ghost record / playback → govern → engine + music → view.sync.
 *   - Idle: when nothing simulates, the loop runs SETTLE seconds more, then stops and suspends
 *     audio; wake() restarts it. A slow interval polls gamepads so they can wake menus.
 *   - govern(): average frame > SLOW_MS for SLOW_FOR s → view.degrade(); GRACE s between steps.
 *   - watchContext(): lost WebGL context → reload once; a second loss within a minute → message.
 *
 * Usage
 *   Loaded by index.html as the only module script; expects its DOM ids (#app, #hud, #minimap,
 *   #joy, #touch, #boot / .ls-menu, #pause, #sheet, #intro). File order: imports, constants and
 *   state, functions, then the short start-up block at the end.
 *
 * Highlights
 *   - Keys: in menus ↑ ↓ move, Enter selects, Esc backs out; in play Esc / P pause, R restart
 *     (paused), Q main menu (paused), N minimap, M mute. Gamepads: Start pause, d-pad + A / B in
 *     menus. Touch: every menu is plain buttons; body.playing shows the touch controls only
 *     during a run.
 *   - window.__game / window.__running are read-only test hooks used by scripts/smoke.py.
 *
 * See also: core/game.ts, render/view.ts, ui/menu.ts, core/save.ts, player/input.ts, ui/hud.ts,
 * ui/minimap.ts, fx/audio.ts, render/tier.ts; DESIGN.md "12. UI", "14. Frame loop, idle and boot".
 */
import "./styles.css";
import { Game, type GameEvent } from "./core/game";
import { applyUiColors, COLORS, themeFor, type RGB } from "./core/palette";
import {
    ghostPose,
    GHOST_DT,
    loadGhost,
    persist,
    recordResult,
    save,
    saveGhost,
    todaySeed,
    type Ghost,
} from "./core/save";
import { isMuted, setEngine, setMusicIntensity, setVolumes, sfx, suspendAudio, toggleMute, unlock } from "./fx/audio";
import { clearInput, HELP, isTouch, pollPads, setPadHandler, setStickThrust, setupInput, steer } from "./player/input";
import { detectTier, TIER_SETTINGS, type Tier } from "./render/tier";
import { View } from "./render/view";
import { drawHud } from "./ui/hud";
import {
    clock,
    closeSheet,
    howtoBody,
    howtoPages,
    menuBack,
    menuNav,
    menuSelect,
    optionsBody,
    planetSelectBody,
    renderMainMenu,
    sheetOpen,
    showIntro,
    showSheet,
    summaryBody,
} from "./ui/menu";
import { Minimap, setColourBlind } from "./ui/minimap";
import { planetName } from "./world/names";

// ---- Constants --------------------------------------------------------------------------------

const $ = (id: string) => document.getElementById(id)!;
const boot = $("boot"),
    pauseEl = $("pause"),
    hud = $("hud");
const minimap = new Minimap($("minimap"));

/** Small one-colour bursts per event; explosions get the full layered treatment (View.explode). */
const BURSTS: Partial<Record<GameEvent, [count: number, speed: number, rgb: RGB, life: number]>> = {
    hit: [6, 4, COLORS.fx.hit, 0.3],
    fuel: [30, 5, COLORS.fx.fuel, 0.8],
    attach: [24, 4, COLORS.fx.attach, 0.6],
    land: [10, 2, COLORS.fx.land, 0.4],
    checkpoint: [20, 4, COLORS.fixture.checkpointOn, 0.6],
    pad: [16, 3, COLORS.fixture.pad, 0.5],
};
/** Vibration (ms) per event; Android browsers honour it, iOS ignores it. */
const BUZZ: Partial<Record<GameEvent, number>> = {
    bigBoom: 220,
    boom: 40,
    land: 20,
    attach: 45,
    checkpoint: 15,
    pad: 12,
};

const DAILY_SEED = todaySeed();
const DAILY_N = 12 + (DAILY_SEED % 15); // difficulty of today's daily planet
const DAILY_KEY = String(DAILY_SEED);

/** Hints already shown this run (each fires once). */
const hintsShown = new Set<string>();
const KEY_NAME = isTouch ? { shield: "◎", fire: "●" } : { shield: "↓ / S / Shift", fire: "Space" };

const SETTLE = 1.5; // seconds the loop keeps drawing after play stops, before idling
const SLOW_MS = 26, // governor: frame time that counts as slow,
    SLOW_FOR = 2, // for this long,
    GRACE = 3; // then this long to settle after a quality step or a new planet

const INITIAL_TIER = save.options.tier;
const STEPS = ["Igniting engines", "Charting planet 1", "Building caves", "Warming shaders", "Loading fonts"];
const bar = document.querySelector<HTMLElement>(".ls-bar span")!,
    tip = document.querySelector(".ls-tip")!;

// ---- State ------------------------------------------------------------------------------------

let view: View;
let attract: Game;
let game: Game | null = null;
let mode: "campaign" | "daily" = "campaign";
let paused = false;
// Ghosts: the stored best run for this planet, and the one being recorded.
let introFor: unknown = null;
let ghost: Ghost | null = null;
let rec: number[] = [];
let recNext = 0;
// Frame loop + idle.
let last = performance.now();
let idleFor = 0;
let running = false;
let lastMap = 0;
// Governor.
let avgMs = 16,
    slowFor = 0,
    graceUntil = 0,
    lastGov = 0,
    govLevel: unknown = null;

// ---- Options ----------------------------------------------------------------------------------

function applyOptions(changed?: string) {
    const o = save.options;
    setVolumes(o.music, o.sfx);
    setStickThrust(o.stickThrust);
    document.body.classList.toggle("lefty", o.lefty);
    setColourBlind(o.colourBlind);
    if (game) game.assist = o.assist;
    if (changed === "ghost" && !o.ghost) ghost = null;
    persist();
}

// ---- Events -----------------------------------------------------------------------------------

function onEvent(e: GameEvent, x: number, y: number) {
    sfx[e]?.();
    if (e === "bigBoom" || e === "boom") view.explode(x, y, e === "bigBoom");
    const b = BURSTS[e];
    if (b) view.burst(x, y, ...b);
    const buzz = BUZZ[e];
    if (buzz) navigator.vibrate?.(buzz);
    if (e === "complete") setTimeout(showSummary, 1400);
    if (e === "gameover") setPause(true);
}

// ---- Runs and menus ---------------------------------------------------------------------------

function startRun(n: number, seed?: number) {
    unlock();
    closeSheet();
    mode = seed === undefined ? "campaign" : "daily";
    game = new Game(n, seed);
    game.onEvent = onEvent;
    game.assist = save.options.assist;
    introFor = null;
    hintsShown.clear();
    setPause(false);
    hud.hidden = false;
    $("minimap").hidden = false;
    document.body.classList.add("playing");
    boot.classList.add("dismissed");
    setTimeout(() => game && boot.classList.add("gone"), 700);
}

function showMenu() {
    game = null;
    paused = false;
    pauseEl.classList.remove("open");
    closeSheet();
    hud.hidden = true;
    $("minimap").hidden = true;
    document.body.classList.remove("playing");
    boot.classList.remove("dismissed", "gone");
    boot.classList.add("ready");
    document.querySelector(".ls-best")!.textContent = save.best ? `Best ${save.best.toLocaleString()}` : "";
    const next = save.cleared + 1;
    renderMainMenu([
        ...(save.cleared > 0
            ? [{ label: "Continue", hint: `Planet ${next}: ${planetName(next)}`, action: () => startRun(next) }]
            : []),
        { label: "New game", hint: "From planet 1", action: newGame },
        { label: "Planet select", hint: `${save.cleared} cleared`, action: planetSelect },
        {
            label: "Daily planet",
            hint: save.daily[DAILY_KEY]
                ? `Today's best ${save.daily[DAILY_KEY].toLocaleString()}`
                : "Same for everyone today",
            action: () => startRun(DAILY_N, DAILY_SEED),
        },
        { label: "Options", action: () => options(showMenu) },
        { label: "How to play", action: () => howto(showMenu) },
    ]);
    wake();
}

function newGame() {
    if (save.seenHowto) return startRun(1);
    howto(() => {
        save.seenHowto = true;
        persist();
        startRun(1);
    });
}

function howto(done: () => void) {
    const pages = howtoPages().length;
    const page = (i: number): void =>
        void showSheet({
            title: "How to play",
            body: howtoBody(i),
            actions: [
                ...(i > 0 ? [{ label: "Back", action: () => page(i - 1) }] : []),
                i < pages - 1
                    ? { label: "Next", kbd: "Enter", primary: true, action: () => page(i + 1) }
                    : { label: "Let's fly", kbd: "Enter", primary: true, action: done },
            ],
            onBack: i > 0 ? () => page(i - 1) : done,
        });
    page(0);
}

function planetSelect() {
    showSheet({
        title: "Planet select",
        body: planetSelectBody(save.cleared, save.stars, (n) => startRun(n)),
        actions: [{ label: "Back", kbd: "Esc", action: showMenu }],
        onBack: showMenu,
    });
}

function options(back: () => void) {
    showSheet({
        title: "Options",
        body: optionsBody(save.options, (key) => {
            applyOptions(key);
            if (key === "tier") $("sheet-title").textContent = "Options — reload to apply quality";
        }),
        actions: [
            ...(save.options.tier !== INITIAL_TIER ? [{ label: "Reload now", action: () => location.reload() }] : []),
            { label: "Done", kbd: "Esc", primary: true, action: back },
        ],
        onBack: back,
    });
}

function showSummary() {
    const g = game;
    if (!g || !g.result || g.phase !== "complete") return;
    const r = g.result;
    if (mode === "campaign") {
        const better = recordResult(r);
        if (save.options.ghost && (!ghost || r.time < ghost.time)) saveGhost(r.n, r.time, rec);
        showSheet({
            title: `Planet ${r.n}: ${r.name} cleared`,
            body: summaryBody(r, better),
            actions: [
                { label: "Main menu", action: showMenu },
                { label: "Next planet", kbd: "Enter", primary: true, action: () => (closeSheet(), g.next()) },
            ],
            onBack: showMenu,
        });
    } else {
        const prev = save.daily[DAILY_KEY] ?? 0;
        save.daily[DAILY_KEY] = Math.max(prev, g.score);
        save.best = Math.max(save.best, g.score);
        persist();
        showSheet({
            title: `Daily planet: ${r.name} cleared`,
            body: summaryBody(r, g.score > prev),
            actions: [{ label: "Main menu", kbd: "Enter", primary: true, action: showMenu }],
            onBack: showMenu,
        });
    }
}

function setPause(open: boolean) {
    const over = !!game && game.phase === "over";
    if (game && game.score > save.best) {
        save.best = game.score;
        persist();
    }
    paused = open;
    pauseEl.dataset.kind = over ? "over" : "pause";
    $("pause-title").textContent = over ? "Mission over" : "Paused";
    document.querySelector("#pause .p-score")!.textContent = game
        ? `Score ${game.score.toLocaleString()} · Planet ${game.levelNo}: ${game.level.name} · Best ${save.best.toLocaleString()}`
        : "";
    if (over && game) {
        const s = game.stats;
        document.querySelector("#pause .p-stats")!.innerHTML = [
            ["Planets cleared", s.planets],
            ["Pods recovered", s.pods],
            ["Reactors destroyed", s.reactors],
            ["Turrets destroyed", s.turrets],
            ["Mines cleared", s.mines],
            ["Flight time", clock(s.time)],
        ]
            .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
            .join("");
    }
    $("pause-restart").querySelector("span")!.textContent = over ? "Fly again" : "Restart planet";
    $("pause-share").querySelector("span")!.textContent = "Share result";
    $("pause-mute").querySelector("span")!.textContent = `Sound ${isMuted() ? "off" : "on"}`;
    pauseEl.classList.toggle("open", open);
    wake();
    if (open) (over ? $("pause-restart") : $("pause-resume")).focus({ preventScroll: true });
    else unlock();
}

function restart() {
    if (!game) return;
    startRun(game.levelNo, mode === "daily" ? DAILY_SEED : undefined);
}

async function share() {
    if (!game) return;
    const s = game.stats;
    const text = `Thrust Force: reached Planet ${game.levelNo} (${game.level.name}) with ${game.score.toLocaleString()} points. ${s.planets} planets cleared, ${s.reactors} reactors destroyed.`;
    const label = $("pause-share").querySelector("span")!;
    try {
        if (navigator.share) await navigator.share({ text, url: location.href });
        else {
            await navigator.clipboard.writeText(`${text} ${location.href}`);
            label.textContent = "Copied!";
        }
    } catch {
        label.textContent = "Couldn't share";
    }
}

// ---- Commands ---------------------------------------------------------------------------------

function onKey(e: KeyboardEvent) {
    if (e.repeat) return;
    const vertical = e.code === "ArrowDown" || e.code === "ArrowUp";
    if (sheetOpen()) {
        if (e.code === "Escape") menuBack();
        else if (vertical) menuNav(e.code === "ArrowDown" ? 1 : -1);
        return;
    }
    if (!game) {
        if (vertical) menuNav(e.code === "ArrowDown" ? 1 : -1);
        return;
    }
    const over = game.phase === "over";
    if (paused && vertical) menuNav(e.code === "ArrowDown" ? 1 : -1);
    else if (e.code === "Escape" || e.code === "KeyP") {
        if (!over) setPause(!paused);
    } else if ((e.code === "KeyR" && paused) || (e.code === "Enter" && over)) restart();
    else if (e.code === "KeyQ" && paused) showMenu();
    else if (e.code === "KeyN") minimap.toggle();
    else if (e.code === "KeyM") {
        toggleMute();
        if (paused) setPause(true);
    }
}

function onPad(b: "pause" | "up" | "down" | "select" | "back") {
    wake();
    const inMenu = sheetOpen() || !game || paused;
    if (b === "pause") {
        if (game && game.phase !== "over" && !sheetOpen()) setPause(!paused);
    } else if (!inMenu) return;
    else if (b === "up" || b === "down") menuNav(b === "down" ? 1 : -1);
    else if (b === "select") menuSelect();
    else if (b === "back") {
        if (sheetOpen()) menuBack();
        else if (paused && game?.phase !== "over") setPause(false);
    }
}

function wireEvents() {
    addEventListener("keydown", onKey);
    $("pause-resume").addEventListener("click", () => setPause(false));
    $("pause-restart").addEventListener("click", restart);
    $("pause-share").addEventListener("click", share);
    $("pause-menu").addEventListener("click", showMenu);
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
    setPadHandler(onPad);
    // Gamepads can't wake an idle loop by events, so poll their buttons slowly while idle.
    setInterval(() => !running && pollPads(), 120);
    // Any input or resize wakes an idle loop; losing focus or hiding the tab pauses the game.
    for (const ev of ["keydown", "pointerdown", "pointermove", "wheel", "resize"] as const)
        addEventListener(ev, wake, { passive: true });
    addEventListener("blur", () => {
        clearInput();
        if (game && game.phase === "play" && !sheetOpen()) setPause(true);
    });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && game && game.phase === "play" && !paused && !sheetOpen()) setPause(true);
    });
}

// ---- Hints (early planets) --------------------------------------------------------------------

function hints(g: Game) {
    if (!save.options.hints || mode !== "campaign" || g.levelNo > 2 || g.phase !== "play") return;
    const s = g.ship,
        lv = g.level;
    const hint = (id: string, when: boolean, msg: string) => {
        if (!when || hintsShown.has(id) || g.messageTime > 0.5) return;
        hintsShown.add(id);
        g.say(msg, 4);
    };
    hint(
        "pod",
        !g.pod.attached && Math.hypot(s.x - g.pod.x, s.y - g.pod.y) < 9,
        `Hold ${KEY_NAME.shield} near the pod to latch on`
    );
    hint("out", g.pod.attached, "Now fly up and out through the sky with it");
    hint("fuel", g.fuel < 35, `Low fuel: land on a green pad, or hover over a fuel cell holding ${KEY_NAME.shield}`);
    hint(
        "turret",
        lv.turrets.some((t) => t.alive && Math.hypot(t.x - s.x, t.y - s.y) < lv.diff.turretRange),
        `Turrets fire when they see you: shoot them (${KEY_NAME.fire}) or shield`
    );
    hint("checkpoint", g.checkpoint === 0, "Checkpoint: you'll respawn here");
}

// ---- Ghosts -----------------------------------------------------------------------------------

function onPlanetLoaded(g: Game) {
    introFor = g.level;
    showIntro(g.level, themeFor(g.levelNo).name, mode === "daily" ? "Daily planet" : `Planet ${g.levelNo}`);
    ghost = mode === "campaign" && save.options.ghost ? loadGhost(g.levelNo) : null;
    rec = [];
    recNext = 0;
}

function recordGhost(g: Game) {
    while (g.time >= recNext && (g.phase === "play" || g.phase === "dead")) {
        rec.push(g.ship.x, g.ship.y, Math.atan2(Math.sin(g.ship.a), Math.cos(g.ship.a)));
        recNext += GHOST_DT;
    }
}

// ---- Frame loop, idle, governor ---------------------------------------------------------------

function wake() {
    idleFor = 0;
    if (running || !view) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
}

function frame(now: number) {
    let dt = Math.min((now - last) / 1000, 1 / 20);
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
        if (game.level !== introFor) onPlanetLoaded(game);
        if (game.assist.slow) dt *= 0.75;
        game.update(dt, steer(game.ship.a));
        drawHud(game);
        hints(game);
        recordGhost(game);
        const gp = ghost ? ghostPose(ghost, game.time) : null;
        view.setGhost(gp);
        minimap.ghost = gp;
        if (now - lastMap > 66) {
            lastMap = now; // the minimap is coarse: 15 Hz is plenty
            minimap.draw(game);
        }
        govern(now, game);
    } else if (!game) view.setGhost(null);
    setEngine(!!game && active && game.thrusting && game.phase === "play");
    setMusicIntensity(game ? (game.critical >= 0 ? 1 : 0.2) : 0);
    view.sync(game ?? attract, paused ? 0 : dt);
}

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

function nextFrame() {
    return new Promise(requestAnimationFrame);
}

/** Show boot step i (progress k within it, 0..1), then yield a frame so the bar paints. */
async function step(i: number, k = 0) {
    tip.textContent = `${STEPS[i]}…`;
    bar.style.width = `${((i + k) / STEPS.length) * 100}%`;
    await nextFrame();
}

function fail(msg: string) {
    boot.classList.remove("ready", "dismissed", "gone");
    const sub = document.querySelector(".ls-sub")!;
    sub.classList.add("error");
    sub.textContent = msg;
}

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

async function startup() {
    try {
        await step(0);
        const tier = detectTier(INITIAL_TIER === "auto" ? undefined : (INITIAL_TIER as Tier));
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
        // Rock in ~12 ms slices with a frame between, so the bar moves and the splash stays
        // animated even on a phone where the whole planet takes a few hundred ms to build.
        view.sync(attract, 0); // cheap parts now; rock chunks queued
        const total = view.pendingChunks;
        while (view.pendingChunks > 0) {
            view.pump(12, attract.ship.y);
            await step(2, 1 - view.pendingChunks / total);
        }
        await step(3);
        await view.warmup();
        // Wait for the web fonts (capped) so menu labels don't reflow when they arrive.
        await step(4);
        await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
        bar.style.width = "100%";
        applyOptions();
        showMenu();
    } catch (err) {
        fail(`Could not start WebGL: ${(err as Error).message}. Adding ?tier=low to the address may help.`);
    }
}

// ---- Start-up ---------------------------------------------------------------------------------

applyUiColors();
setupInput();
document.querySelector("#pause .bindings")!.innerHTML = HELP.map(
    ([k, v]) => `<div class="binding"><kbd>${k}</kbd><span>${v}</span></div>`
).join("");
document.querySelector(".ls-controls")!.textContent = HELP.slice(0, 4)
    .map(([k, v]) => `${k} ${v}`)
    .join("   ·   ");
wireEvents();
void startup();

// Test hooks (scripts/smoke.py reads state through these).
Object.defineProperty(window, "__game", { get: () => game });
Object.defineProperty(window, "__running", { get: () => running });
