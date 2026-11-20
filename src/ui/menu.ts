/**
 * Menu — the main menu, dialog sheets (planet select, options, how to play, planet summary),
 * and the planet intro card.
 *
 * Purpose
 *   All screen-level UI that isn't the HUD or pause dialog, as small DOM builders over two hosts
 *   in index.html: .ls-menu (the splash doubles as the main menu) and #sheet (a modal dialog
 *   styled like #pause). main.ts owns the flow; this module only renders and reports choices.
 *
 * Operations
 *   - renderMainMenu(items): buttons into .ls-menu; the first enabled one takes focus.
 *   - showSheet({ title, body, actions, onBack }): opens #sheet with a body (HTML string or
 *     Node) and a row of action buttons; returns close(). Esc / gamepad B = onBack.
 *   - menuNav(dir) / menuSelect() / menuBack(): keyboard arrows and gamepad d-pad / A / B move
 *     focus through the visible menu or sheet and press the focused control.
 *   - planetSelectBody(cleared, stars, onPick): a grid of unlocked planets (cleared + 1) with
 *     names and medal stars.
 *   - optionsBody(opts, onChange): sliders, selects and toggles bound to an Options object.
 *   - howtoPages: the three-tip first-run tutorial (main.ts pages through it in a sheet).
 *   - summaryBody(result, best): bonus rows that count up, stars, par time, deaths.
 *   - showIntro(level, themeName): the 2.8 s planet title card with stats and a map preview.
 *
 * Usage
 *   main.ts: renderMainMenu on boot and on return to the menu; showSheet for every sub-screen;
 *   showIntro when a planet loads; menuNav / menuSelect / menuBack from keys and gamepads.
 *
 * Highlights
 *   - Everything is plain buttons and inputs, so mouse, touch, keyboard (Tab, arrows, Enter)
 *     and gamepads all work; focus moves into each sheet and returns when it closes.
 *   - Text comes in through textContent or escaped templates; planet names are generated, but
 *     nothing user-supplied is ever injected as HTML.
 *
 * See also: main.ts (flow), core/save.ts (options, progress), ui/minimap.ts (preview), index.html
 * (#sheet, #intro, .ls-menu), styles.css; DESIGN.md "12. UI".
 */
import type { Result } from "../core/game";
import type { Level } from "../world/level";
import { Minimap } from "./minimap";
import { planetName } from "../world/names";
import type { Options } from "../core/save";
import { isTouch } from "../player/input";

let onSheetBack: (() => void) | null = null; // the open sheet's Esc / B action
let introTimer = 0;

const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const starText = (n: number) => "★".repeat(n) + "☆".repeat(3 - n);
export const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

// ---- Main menu --------------------------------------------------------------------------------

export interface MenuItem {
    label: string;
    hint?: string;
    disabled?: boolean;
    action: () => void;
}

export function renderMainMenu(items: MenuItem[]) {
    const nav = $(".ls-menu");
    nav.replaceChildren(
        ...items.map((it) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "menu-btn";
            b.disabled = !!it.disabled;
            b.innerHTML = `<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ""}`;
            b.addEventListener("click", (e) => {
                e.stopPropagation();
                it.action();
            });
            return b;
        })
    );
    nav.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus({ preventScroll: true });
}

// ---- Sheets -----------------------------------------------------------------------------------

export interface SheetAction {
    label: string;
    kbd?: string;
    primary?: boolean;
    action: () => void;
}

export const sheetOpen = () => $("#sheet").classList.contains("open");

export function showSheet(o: { title: string; body: string | Node; actions: SheetAction[]; onBack?: () => void }) {
    const sheet = $("#sheet");
    $("#sheet-title").textContent = o.title;
    const body = $("#sheet .sheet-body");
    if (typeof o.body === "string") body.innerHTML = o.body;
    else body.replaceChildren(o.body);
    $("#sheet .sheet-actions").replaceChildren(
        ...o.actions.map((a) => {
            const b = document.createElement("button");
            b.type = "button";
            if (a.primary) b.className = "primary";
            b.innerHTML = `<span>${esc(a.label)}</span>${a.kbd ? `<kbd>${esc(a.kbd)}</kbd>` : ""}`;
            b.addEventListener("click", a.action);
            return b;
        })
    );
    onSheetBack = o.onBack ?? null;
    sheet.classList.add("open");
    const first =
        sheet.querySelector<HTMLElement>(".sheet-actions .primary") ??
        sheet.querySelector<HTMLElement>(
            ".sheet-body button, .sheet-body input, .sheet-body select, .sheet-actions button"
        );
    first?.focus({ preventScroll: true });
    return closeSheet;
}

export function closeSheet() {
    $("#sheet").classList.remove("open");
    onSheetBack = null;
}

/** Focusable controls in whichever menu is on top (sheet, else the main menu). */
function focusables(): HTMLElement[] {
    const root = sheetOpen() ? $("#sheet") : $("#pause").classList.contains("open") ? $("#pause") : $(".ls-menu");
    return [...root.querySelectorAll<HTMLElement>("button:not([disabled]), input, select")].filter(
        (e) => e.offsetParent !== null
    );
}

export function menuNav(dir: 1 | -1) {
    const els = focusables();
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    els[(i + dir + els.length) % els.length].focus({ preventScroll: true });
}

export function menuSelect() {
    const el = document.activeElement as HTMLElement | null;
    if (el && focusables().includes(el)) el.click();
}

export function menuBack() {
    onSheetBack?.();
}

// ---- Planet select ----------------------------------------------------------------------------

export function planetSelectBody(cleared: number, stars: Record<number, number>, onPick: (n: number) => void) {
    const grid = document.createElement("div");
    grid.className = "planet-grid";
    for (let n = 1; n <= cleared + 1; n++) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "planet-btn";
        b.innerHTML = `<b>${n}</b><span>${esc(planetName(n))}</span><i>${n <= cleared ? starText(stars[n] ?? 0) : "new"}</i>`;
        b.addEventListener("click", () => onPick(n));
        grid.append(b);
    }
    return grid;
}

// ---- Options ----------------------------------------------------------------------------------

export function optionsBody(o: Options, onChange: (key: string) => void) {
    const f = document.createElement("div");
    f.className = "options";
    const row = (label: string, control: HTMLElement, note = "") => {
        const l = document.createElement("label");
        l.className = "opt";
        l.innerHTML = `<span>${esc(label)}${note ? `<small>${esc(note)}</small>` : ""}</span>`;
        l.append(control);
        f.append(l);
    };
    const range = (val: number, min: number, max: number, step: number, set: (v: number) => void, key: string) => {
        const i = document.createElement("input");
        Object.assign(i, { type: "range", min, max, step, value: String(val) });
        i.addEventListener("input", () => {
            set(Number(i.value));
            onChange(key);
        });
        return i;
    };
    const check = (val: boolean, set: (v: boolean) => void, key: string) => {
        const i = document.createElement("input");
        i.type = "checkbox";
        i.checked = val;
        i.addEventListener("change", () => {
            set(i.checked);
            onChange(key);
        });
        return i;
    };
    const head = (t: string) => {
        const h = document.createElement("h3");
        h.textContent = t;
        f.append(h);
    };

    head("Sound");
    row(
        "Music",
        range(o.music, 0, 1, 0.05, (v) => (o.music = v), "volume")
    );
    row(
        "Effects",
        range(o.sfx, 0, 1, 0.05, (v) => (o.sfx = v), "volume")
    );

    head("Display");
    const tier = document.createElement("select");
    for (const [v, t] of [
        ["auto", "Auto (recommended)"],
        ["high", "High"],
        ["mobile-high", "Mobile high"],
        ["mid", "Medium"],
        ["low", "Low"],
    ])
        tier.add(new Option(t, v, false, o.tier === v));
    tier.addEventListener("change", () => {
        o.tier = tier.value as Options["tier"];
        onChange("tier");
    });
    row("Quality", tier, "Applies after reload");
    row(
        "Colour-blind minimap",
        check(o.colourBlind, (v) => (o.colourBlind = v), "colourBlind")
    );
    row(
        "Show best-run ghost",
        check(o.ghost, (v) => (o.ghost = v), "ghost")
    );

    head("Controls");
    row(
        "Stick thrust point",
        range(o.stickThrust, 0.6, 0.95, 0.05, (v) => (o.stickThrust = v), "stick"),
        "How far the touch / gamepad stick is pushed before it also thrusts"
    );
    if (isTouch)
        row(
            "Left-handed layout",
            check(o.lefty, (v) => (o.lefty = v), "lefty"),
            "Stick on the right"
        );
    row(
        "Hints on early planets",
        check(o.hints, (v) => (o.hints = v), "hints")
    );

    head("Assists");
    row(
        "Slower game (75%)",
        check(o.assist.slow, (v) => (o.assist.slow = v), "assist")
    );
    row(
        "Auto-level near the ground",
        check(o.assist.autoLevel, (v) => (o.assist.autoLevel = v), "assist")
    );
    row(
        "Shield uses no fuel",
        check(o.assist.freeShield, (v) => (o.assist.freeShield = v), "assist")
    );
    return f;
}

// ---- How to play ------------------------------------------------------------------------------

export const howtoPages = () => {
    const k = isTouch
        ? { aim: "the left stick", thrust: "▲ (or push the stick fully)", fire: "●", shield: "◎" }
        : { aim: "← → / A D", thrust: "↑ / W", fire: "Space", shield: "↓ / S / Shift" };
    return [
        {
            icon: "▲",
            title: "Fly with momentum",
            text: `Rotate with ${k.aim} and thrust with ${k.thrust}. Gravity never lets go, and your ship keeps every bit of speed you give it. Touch down slowly and upright to land; anything else is a crash. Land on glowing green pads to refuel.`,
        },
        {
            icon: "◎",
            title: "Tow the pod out",
            text: `Hold ${k.shield} near the pod in the deepest chamber to latch your tractor beam on. It hangs on a rigid rod and outweighs you, so it swings. Fly back up and out through the sky with it to clear the planet. The same button shields you and drains fuel cells.`,
        },
        {
            icon: "✸",
            title: "Crack the reactor",
            text: `Shoot turrets with ${k.fire}. Every hit on the reactor silences them for a few seconds; enough hits and it goes critical, leaving ten seconds to escape for a big bonus. Glowing beacons are checkpoints. Medals: pod, reactor, and beating the par time.`,
        },
    ];
};

export function howtoBody(page: number) {
    const p = howtoPages()[page];
    return `<div class="howto"><div class="howto-icon">${p.icon}</div><h3>${esc(p.title)}</h3><p>${esc(p.text)}</p><p class="howto-dots">${howtoPages()
        .map((_, i) => (i === page ? "●" : "○"))
        .join(" ")}</p></div>`;
}

// ---- Planet summary ---------------------------------------------------------------------------

export function summaryBody(r: Result, newBest: boolean) {
    const rows: [string, number, boolean][] = [
        ["Pod recovered", r.podBonus, r.pod],
        ["Planet destroyed", r.reactorBonus, r.reactor],
        [`Time ${clock(r.time)} (par ${clock(r.par)})`, r.timeBonus, r.time <= r.par],
    ];
    const el = document.createElement("div");
    el.className = "summary";
    el.innerHTML = `<p class="stars" aria-label="${r.stars} of 3 medals">${starText(r.stars)}</p>
        ${newBest ? `<p class="new-best">New best for this planet!</p>` : ""}
        <dl>${rows
            .map(([k, v, ok]) => `<dt class="${ok ? "" : "dim"}">${esc(k)}</dt><dd data-to="${v}">+0</dd>`)
            .join("")}<dt class="total">Total</dt><dd class="total" data-to="${r.total}">+0</dd></dl>
        <p class="deaths">${r.deaths ? `${r.deaths} ship${r.deaths > 1 ? "s" : ""} lost` : "Flawless — no ships lost"}</p>`;
    // Count up each value over ~0.8 s.
    const t0 = performance.now();
    const tick = (now: number) => {
        const k = Math.min(1, (now - t0) / 800);
        el.querySelectorAll<HTMLElement>("dd").forEach((d) => {
            d.textContent = `+${Math.round(Number(d.dataset.to) * k).toLocaleString()}`;
        });
        if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return el;
}

// ---- Planet intro card ------------------------------------------------------------------------

export function showIntro(lv: Level, themeName: string, label = `Planet ${lv.n}`) {
    const card = $("#intro");
    $("#intro-num").textContent = label;
    $("#intro-name").textContent = lv.name;
    const g = Math.abs(lv.gravity).toFixed(1);
    const facts = [
        `${themeName} world`,
        `Gravity ${g}${lv.gravity < 0 ? " · reversed!" : ""}`,
        `${lv.turrets.length} turrets`,
        ...(lv.mines.length ? [`${lv.mines.length} mines`] : []),
        ...(lv.gates.length ? [`${lv.gates.length} laser gates`] : []),
        `Par ${clock(lv.par)}`,
    ];
    $("#intro-facts").replaceChildren(
        ...facts.map((t) => {
            const li = document.createElement("li");
            li.textContent = t;
            return li;
        })
    );
    Minimap.preview(lv, card.querySelector("canvas")!, 90, 130);
    card.classList.remove("show");
    void card.offsetWidth; // restart the CSS animation
    card.classList.add("show");
    clearTimeout(introTimer);
    introTimer = window.setTimeout(() => card.classList.remove("show"), 3200);
}
