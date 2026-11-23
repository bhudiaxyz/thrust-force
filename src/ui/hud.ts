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
 *   - Screen-edge glow (#vignette): toggles 'low-fuel' (slow red pulse under 20 fuel) and
 *     'critical' (fast amber pulse during the reactor countdown) through the same change cache.
 *
 * Usage
 *   main.ts calls drawHud(game) every active frame after game.update().
 *
 * Highlights
 *   - Writing identical text or styles every frame still triggers style recalculation, which
 *     shows up as jank on phones; the cache makes a steady HUD free.
 *   - #hud is pointer-events: none, so it never intercepts touches meant for the game.
 *
 * See also: main.ts, core/game.ts, index.html (#hud), styles.css; DESIGN.md "12. UI".
 */
import { CFG, type Game } from "../core/game";

const score = el("h-score"),
    lives = el("h-lives"),
    level = el("h-level"),
    fuel = el("h-fuel"),
    reactor = el("h-reactor"),
    count = el("h-count"),
    msg = el("h-msg"),
    vignette = el("vignette");

const cache = new Map<string, string>();
function el(id: string) {
    return document.getElementById(id)!;
}

function put(key: string, v: string, write: (v: string) => void) {
    if (cache.get(key) === v) return;
    cache.set(key, v);
    write(v);
}

export function drawHud(g: Game) {
    put("score", g.score.toLocaleString(), (v) => (score.textContent = v));
    put("lives", "▲".repeat(Math.max(0, g.lives)), (v) => (lives.textContent = v));
    put("level", `Planet ${g.levelNo}: ${g.level.name}`, (v) => (level.textContent = v));
    put("fuel", `${Math.round((g.fuel / CFG.fuelMax) * 200) / 2}%`, (v) => (fuel.style.width = v));
    put("low", String(g.fuel < 20), (v) => fuel.classList.toggle("low", v === "true"));
    put("reactor", `${Math.round((g.reactorHp / g.level.reactorHp) * 100)}%`, (v) => (reactor.style.width = v));
    put("count", g.critical >= 0 ? g.critical.toFixed(1) : "", (v) => (count.textContent = v));
    put("msg", g.messageTime > 0 ? g.message : "", (v) => (msg.textContent = v));
    put("lowFuel", String(g.fuel < 20 && g.phase === "play"), (v) =>
        vignette.classList.toggle("low-fuel", v === "true")
    );
    put("critical", String(g.critical >= 0), (v) => vignette.classList.toggle("critical", v === "true"));
    put("msgA", Math.min(1, Math.max(0, g.messageTime * 2)).toFixed(2), (v) => (msg.style.opacity = v));
}
