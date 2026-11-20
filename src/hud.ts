/**
 * Hud — the in-game heads-up display: score, planet, ships, fuel and reactor bars, countdown,
 * message line.
 *
 * Purpose
 *   Mirrors Game state into the #hud DOM overlay, cheaply enough to run every frame on phones.
 *
 * Operations
 *   - drawHud(game): computes each displayed value as a string and hands it to put(), which
 *     writes to the DOM only when the string differs from last time. Fuel width is rounded to
 *     0.5%, the reactor bar to 1% and message opacity to 0.01, so steady values cause no writes.
 *
 * Usage
 *   main.ts calls drawHud(game) every active frame after game.update().
 *
 * Highlights
 *   - Writing identical text or styles every frame still triggers style recalculation, which
 *     shows up as jank on phones; the cache makes a steady HUD free.
 *   - #hud is pointer-events: none, so it never intercepts touches meant for the game.
 *
 * See also: main.ts, game.ts, index.html (#hud), styles.css; DESIGN.md "10. UI".
 */
import { CFG, type Game } from './game';

const el = (id: string) => document.getElementById(id)!;
const score = el('h-score'),
    lives = el('h-lives'),
    level = el('h-level'),
    fuel = el('h-fuel'),
    reactor = el('h-reactor'),
    count = el('h-count'),
    msg = el('h-msg');

const cache = new Map<string, string>();
function put(key: string, v: string, write: (v: string) => void) {
    if (cache.get(key) === v) return;
    cache.set(key, v);
    write(v);
}

export function drawHud(g: Game) {
    put('score', g.score.toLocaleString(), (v) => (score.textContent = v));
    put('lives', '▲'.repeat(Math.max(0, g.lives)), (v) => (lives.textContent = v));
    put('level', `Planet ${g.levelNo}: ${g.level.name}`, (v) => (level.textContent = v));
    put('fuel', `${Math.round((g.fuel / CFG.fuelMax) * 200) / 2}%`, (v) => (fuel.style.width = v));
    put('low', String(g.fuel < 20), (v) => fuel.classList.toggle('low', v === 'true'));
    put('reactor', `${Math.round((g.reactorHp / g.level.reactorHp) * 100)}%`, (v) => (reactor.style.width = v));
    put('count', g.critical >= 0 ? g.critical.toFixed(1) : '', (v) => (count.textContent = v));
    put('msg', g.messageTime > 0 ? g.message : '', (v) => (msg.textContent = v));
    put('msgA', Math.min(1, Math.max(0, g.messageTime * 2)).toFixed(2), (v) => (msg.style.opacity = v));
}
