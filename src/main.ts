/**
 * Main — entry point and composition root: boot splash, input, HUD, pause / game over, frame loop.
 *
 * Purpose
 *   Wires the pure Game to the browser. Owns no rules itself: it builds the View, routes input
 *   into Game, routes Game events out to sound and particles, keeps the DOM UI (splash, HUD,
 *   pause / game-over dialog) in step with game state, and drives everything once per frame.
 *
 * Operations
 *   - Boot (async IIFE at the bottom): splash steps "Igniting engines" (detectTier + new View),
 *     "Charting planet 1" (attract Game), "Warming shaders" (first sync + compileAsync), each
 *     yielding a frame so the progress bar paints; then #boot.ready shows the launch button,
 *     best score and control hints. WebGL failure is reported in the splash subtitle.
 *   - start(): unlocks audio, creates a new Game(1), hides splash / dialog, shows the HUD.
 *   - setPause(open): opens / closes #pause; when game.phase is 'over' the same dialog becomes
 *     the game-over screen (data-kind="over"); saves the best score to localStorage 'tf-best'.
 *   - Keyboard: KEYS maps KeyboardEvent.code to Input fields; Esc/P pause, R restart while
 *     paused, Enter launches / flies again, M mutes. Window blur clears keys and pauses.
 *   - Touch: #touch [data-k] hold buttons (pointer capture), and a nipplejs dynamic stick on the
 *     left half. steer() turns the stick into left/right/thrust each frame.
 *   - frame(): dt capped at 1/20 s → steer + game.update → HUD → engine sound →
 *     view.sync(game ?? attract).
 *
 * Usage
 *   Loaded by index.html as the only module script. Expects the DOM ids in index.html (#app,
 *   #hud and h-*, #joy, #touch, #boot and .ls-*, #pause and pause-*).
 *
 * Highlights
 *   - The stick aims absolutely: the nose turns toward the stick direction (0.06 rad
 *     tolerance), 25% dead zone, a push over 75% also thrusts, so one thumb flies the ship.
 *   - steer() returns a copy of input OR'd with the stick, so the stick never cancels a held
 *     key or button.
 *   - KEY_HELP / TOUCH_HELP drive both the splash hint and the pause bindings; keep them in
 *     step with KEYS and the #touch buttons. The device is chosen by (pointer: coarse).
 *   - window.__game / window.__running are read-only test hooks used by scripts/smoke.py.
 *
 * See also: game.ts, view.ts, tier.ts, audio.ts, index.html, styles.css; DESIGN.md
 * "9. Input", "10. UI" and "12. Frame loop".
 */
import './styles.css';
import nipplejs from 'nipplejs';
import { Game, CFG, type GameEvent, type Input } from './game';
import { View } from './view';
import { Minimap } from './minimap';
import { applyUiColors, COLORS, type RGB } from './palette';
import { detectTier, TIER_SETTINGS } from './tier';
import { sfx, setEngine, toggleMute, unlock, isMuted, suspendAudio } from './audio';

const $ = (id: string) => document.getElementById(id)!;
const boot = $('boot'),
    pauseEl = $('pause'),
    hud = $('hud');
const isTouch = matchMedia('(pointer: coarse)').matches;
applyUiColors();

const input: Input = { left: false, right: false, thrust: false, fire: false, shield: false };
const KEYS: Record<string, keyof Input> = {
    ArrowLeft: 'left',
    KeyA: 'left',
    KeyZ: 'left',
    ArrowRight: 'right',
    KeyD: 'right',
    KeyX: 'right',
    ArrowUp: 'thrust',
    KeyW: 'thrust',
    ShiftRight: 'thrust',
    Space: 'fire',
    ArrowDown: 'shield',
    KeyS: 'shield',
    ShiftLeft: 'shield',
};
// Shown on the splash and in the pause dialog; keep in step with KEYS and the #touch buttons.
const KEY_HELP = [
    ['← → / A D', 'Rotate'],
    ['↑ / W', 'Thrust'],
    ['Space', 'Fire'],
    ['↓ / S / Shift', 'Shield + tractor'],
    ['Esc / P', 'Pause'],
    ['M', 'Sound on / off'],
    ['N', 'Minimap'],
];
const TOUCH_HELP = [
    ['Left stick', 'Aim the nose'],
    ['Stick full', 'Thrust'],
    ['▲', 'Thrust'],
    ['●', 'Fire'],
    ['◎', 'Shield + tractor'],
    ['❚❚', 'Pause'],
    ['Map icon', 'Minimap'],
];
const help = isTouch ? TOUCH_HELP : KEY_HELP;
document.querySelector('#pause .bindings')!.innerHTML = help
    .map(([k, v]) => `<div class="binding"><kbd>${k}</kbd><span>${v}</span></div>`)
    .join('');
document.querySelector('.ls-controls')!.textContent = help
    .slice(0, 4)
    .map(([k, v]) => `${k} ${v}`)
    .join('   ·   ');
document.querySelector('.ls-enter')!.textContent = isTouch ? 'Tap to launch' : 'Click or press Enter to launch';

let view: View;
const minimap = new Minimap($('minimap'), isTouch);
let attract: Game;
let game: Game | null = null;
let paused = false;
let ready = false;
let best = Number(localStorage.getItem('tf-best') ?? 0);

const BURSTS: Partial<Record<GameEvent, [number, number, RGB, number]>> = {
    hit: [6, 4, COLORS.fx.hit, 0.3],
    fuel: [30, 5, COLORS.fx.fuel, 0.8],
    attach: [24, 4, COLORS.fx.attach, 0.6],
    land: [10, 2, COLORS.fx.land, 0.4],
};

function onEvent(e: GameEvent, x: number, y: number) {
    sfx[e]?.();
    if (e === 'bigBoom' || e === 'boom') view.explode(x, y, e === 'bigBoom');
    const b = BURSTS[e];
    if (b) view.burst(x, y, b[0], b[1], b[2], b[3]);
    if (e === 'gameover') setPause(true);
}

function start() {
    unlock();
    game = new Game(1);
    game.onEvent = onEvent;
    setPause(false);
    hud.hidden = false;
    $('minimap').hidden = false;
    if (!boot.classList.contains('dismissed')) {
        boot.classList.add('dismissed');
        setTimeout(() => boot.classList.add('gone'), 700);
    }
}

function setPause(open: boolean) {
    const over = !!game && game.phase === 'over';
    if (game && game.score > best) {
        best = game.score;
        localStorage.setItem('tf-best', String(best));
    }
    paused = open;
    pauseEl.dataset.kind = over ? 'over' : 'pause';
    $('pause-title').textContent = over ? 'Mission over' : 'Paused';
    document.querySelector('#pause .p-score')!.textContent = game
        ? `Score ${game.score.toLocaleString()} · Planet ${game.levelNo}: ${game.level.name} · Best ${best.toLocaleString()}`
        : '';
    $('pause-mute').querySelector('span')!.textContent = `Sound ${isMuted() ? 'off' : 'on'}`;
    pauseEl.classList.toggle('open', open);
    wake();
    if (open) (over ? $('pause-restart') : $('pause-resume')).focus({ preventScroll: true });
    else unlock();
}

addEventListener('keydown', (e) => {
    const k = KEYS[e.code];
    if (k) {
        input[k] = true;
        e.preventDefault();
    }
    if (e.repeat) return;
    if (!game) {
        if (ready && (e.code === 'Enter' || e.code === 'Space')) start();
        return;
    }
    const over = game.phase === 'over';
    if (e.code === 'Escape' || e.code === 'KeyP') {
        if (!over) setPause(!paused);
    } else if ((e.code === 'KeyR' && paused) || (e.code === 'Enter' && over)) start();
    else if (e.code === 'KeyN') minimap.toggle();
    else if (e.code === 'KeyM') {
        toggleMute();
        if (paused) setPause(true);
    }
});
// Any input or resize wakes an idle loop.
for (const ev of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'resize'] as const)
    addEventListener(ev, wake, { passive: true });
// Hidden tab / minimised window: pause a running game (the loop then idles and audio suspends).
document.addEventListener('visibilitychange', () => {
    if (document.hidden && game && game.phase !== 'over' && !paused) setPause(true);
});

addEventListener('keyup', (e) => {
    const k = KEYS[e.code];
    if (k) input[k] = false;
});
addEventListener('blur', () => {
    Object.keys(input).forEach((k) => (input[k as keyof Input] = false));
    if (game && game.phase !== 'over') setPause(true);
});
boot.addEventListener('click', () => ready && !game && start());
$('pause-resume').addEventListener('click', () => setPause(false));
$('pause-restart').addEventListener('click', start);
$('pause-mute').addEventListener('click', () => {
    toggleMute();
    setPause(true);
});
pauseEl.addEventListener('click', (e) => {
    if (e.target === pauseEl && game?.phase !== 'over') setPause(false);
});

// Touch buttons: hold-to-press, each bound to one Input field.
document.querySelectorAll<HTMLElement>('#touch [data-k]').forEach((btn) => {
    const k = btn.dataset.k as keyof Input;
    const set = (v: boolean) => (e: PointerEvent) => {
        e.preventDefault();
        input[k] = v;
        btn.classList.toggle('on', v);
    };
    btn.addEventListener('pointerdown', (e) => {
        btn.setPointerCapture(e.pointerId);
        set(true)(e);
    });
    btn.addEventListener('pointerup', set(false));
    btn.addEventListener('pointercancel', set(false));
});
$('t-pause').addEventListener('click', () => {
    if (game && game.phase !== 'over') setPause(true);
});

// Steering stick: the ship turns its nose toward the stick direction; pushed past 75% it also
// thrusts. Converted to left/right/thrust each frame in steer() so game.ts stays input-agnostic.
let stick: { x: number; y: number; push: number } | null = null;
const STICK = 120;
const joy = nipplejs.create({
    zone: $('joy'),
    mode: 'dynamic',
    size: STICK,
    color: COLORS.ui.stick,
    restOpacity: 0.6,
});
joy.on('move', (evt) => {
    const d = evt.data;
    if (d?.vector) stick = { x: d.vector.x, y: d.vector.y, push: d.distance / (STICK / 2) };
});
joy.on('end', () => (stick = null));

/** Keyboard/buttons OR'd with the stick's left/right/thrust for this frame. */
function steer(g: Game): Input {
    const out = { ...input };
    if (!stick || stick.push < 0.25) return out;
    const target = Math.atan2(-stick.x, stick.y);
    const diff = Math.atan2(Math.sin(target - g.ship.a), Math.cos(target - g.ship.a));
    out.left ||= diff > 0.06;
    out.right ||= diff < -0.06;
    out.thrust ||= stick.push > 0.75;
    return out;
}

const hudScore = $('h-score'),
    hudLives = $('h-lives'),
    hudLevel = $('h-level'),
    hudFuel = $('h-fuel'),
    hudReactor = $('h-reactor'),
    hudCount = $('h-count'),
    hudMsg = $('h-msg');

function drawHud(g: Game) {
    hudScore.textContent = g.score.toLocaleString();
    hudLives.textContent = '▲'.repeat(Math.max(0, g.lives));
    hudLevel.textContent = `Planet ${g.levelNo}: ${g.level.name}`;
    hudFuel.style.width = `${(g.fuel / CFG.fuelMax) * 100}%`;
    hudFuel.classList.toggle('low', g.fuel < 20);
    hudReactor.style.width = `${(g.reactorHp / g.level.reactorHp) * 100}%`;
    hudCount.textContent = g.critical >= 0 ? g.critical.toFixed(1) : '';
    hudMsg.textContent = g.messageTime > 0 ? g.message : '';
    hudMsg.style.opacity = String(Math.min(1, Math.max(0, g.messageTime * 2)));
}

// Idle handling: when nothing is simulating (splash, paused, game over) the loop keeps drawing
// for SETTLE seconds so the camera, particles and debris come to rest, then stops requesting
// frames entirely (no GPU or CPU work, audio suspended). wake() restarts it: any input, resize,
// pause toggle or launch calls it.
const SETTLE = 1.5;
let last = performance.now();
let idleFor = 0;
let running = false;
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
    if (game && !paused) {
        game.update(dt, steer(game));
        drawHud(game);
        minimap.draw(game);
    }
    setEngine(!!game && !paused && game.thrusting && game.phase === 'play');
    view.sync(game ?? attract, paused ? 0 : dt);
}

// Boot: each step updates the splash bar, then yields a frame so it paints.
const bar = document.querySelector<HTMLElement>('.ls-bar span')!,
    tip = document.querySelector('.ls-tip')!;
const STEPS = ['Igniting engines', 'Charting planet 1', 'Warming shaders'];
const step = async (i: number) => {
    tip.textContent = `${STEPS[i]}…`;
    bar.style.width = `${((i + 1) / STEPS.length) * 100}%`;
    await new Promise(requestAnimationFrame);
};
(async () => {
    try {
        await step(0);
        const tier = detectTier();
        document.documentElement.dataset.tier = tier;
        view = new View($('app'), TIER_SETTINGS[tier]);
        await step(1);
        attract = new Game(1);
        await step(2);
        view.sync(attract, 0);
        await view.renderer.compileAsync(view.scene, view.camera);
        document.querySelector('.ls-best')!.textContent = best ? `Best ${best.toLocaleString()}` : '';
        boot.classList.add('ready');
        ready = true;
        wake();
    } catch (err) {
        const sub = document.querySelector('.ls-sub')!;
        sub.classList.add('error');
        sub.textContent = `Could not start WebGL: ${(err as Error).message}`;
    }
})();

// Test hook (scripts/smoke.py reads ship state through it).
Object.defineProperty(window, '__game', { get: () => game });
Object.defineProperty(window, '__running', { get: () => running });
