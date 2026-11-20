/**
 * Input — keyboard, touch buttons and the nipplejs steering stick, merged into one Input record.
 *
 * Purpose
 *   Turns every control device into the five booleans the Game understands (left, right,
 *   thrust, fire, shield), and owns the control help text, so devices and help stay in step.
 *
 * Operations
 *   - KEYS: KeyboardEvent.code → Input field. Codes are layout-independent (WASD works on
 *     AZERTY as the physical keys); arrows, WASD and Z/X are all bound. Mapped keys
 *     preventDefault so arrows and Space don't scroll or press focused buttons.
 *   - Touch buttons (#touch [data-k]): pointerdown + setPointerCapture sets the field,
 *     pointerup / pointercancel clear it, so sliding a thumb off a button still releases it.
 *   - Stick (#joy, left half): a nipplejs dynamic joystick. steer(shipAngle) aims absolutely:
 *     it presses left / right until the nose is within 0.06 rad of the stick direction; pushes
 *     under 25% are ignored; over 75% also thrusts, so one thumb flies the ship.
 *   - clearInput(): releases everything (window blur, so nothing sticks after alt-tab).
 *   - HELP: [key, action] rows for this device (KEY_HELP or TOUCH_HELP by (pointer: coarse)),
 *     rendered into the splash hint line and the pause dialog by main.ts.
 *
 * Usage
 *   main.ts: setupInput() once; each frame game.update(dt, steer(game.ship.a)); clearInput()
 *   on blur. Game commands (pause, restart, mute, minimap) stay in main.ts.
 *
 * Highlights
 *   - steer() returns a copy of the held state OR'd with the stick, so the stick can never
 *     cancel a held key or button.
 *   - Keep KEY_HELP / TOUCH_HELP in step with KEYS, main.ts's command keys and index.html's
 *     #touch buttons.
 *
 * See also: main.ts, game.ts (Input), index.html (#joy, #touch); DESIGN.md "9. Input".
 */
import nipplejs from "nipplejs";
import type { Input } from "./game";
import { COLORS } from "./palette";

export const isTouch = matchMedia("(pointer: coarse)").matches;

/** Held state from keys and touch buttons. Read through steer(), which adds the stick. */
const held: Input = { left: false, right: false, thrust: false, fire: false, shield: false };

export const KEYS: Record<string, keyof Input> = {
    ArrowLeft: "left",
    KeyA: "left",
    KeyZ: "left",
    ArrowRight: "right",
    KeyD: "right",
    KeyX: "right",
    ArrowUp: "thrust",
    KeyW: "thrust",
    ShiftRight: "thrust",
    Space: "fire",
    ArrowDown: "shield",
    KeyS: "shield",
    ShiftLeft: "shield",
};

const KEY_HELP = [
    ["← → / A D", "Rotate"],
    ["↑ / W", "Thrust"],
    ["Space", "Fire"],
    ["↓ / S / Shift", "Shield + tractor"],
    ["Esc / P", "Pause"],
    ["M", "Sound on / off"],
    ["N", "Minimap"],
];
const TOUCH_HELP = [
    ["Left stick", "Aim the nose"],
    ["Stick full", "Thrust"],
    ["▲", "Thrust"],
    ["●", "Fire"],
    ["◎", "Shield + tractor"],
    ["❚❚", "Pause"],
    ["Map icon", "Minimap"],
];
export const HELP = isTouch ? TOUCH_HELP : KEY_HELP;

const STICK = 120; // nipplejs size in px
let stick: { x: number; y: number; push: number } | null = null;

export function setupInput() {
    addEventListener("keydown", (e) => {
        const k = KEYS[e.code];
        if (!k) return;
        held[k] = true;
        e.preventDefault();
    });
    addEventListener("keyup", (e) => {
        const k = KEYS[e.code];
        if (k) held[k] = false;
    });

    document.querySelectorAll<HTMLElement>("#touch [data-k]").forEach((btn) => {
        const k = btn.dataset.k as keyof Input;
        const set = (v: boolean) => (e: PointerEvent) => {
            e.preventDefault();
            held[k] = v;
            btn.classList.toggle("on", v);
        };
        btn.addEventListener("pointerdown", (e) => {
            btn.setPointerCapture(e.pointerId);
            set(true)(e);
        });
        btn.addEventListener("pointerup", set(false));
        btn.addEventListener("pointercancel", set(false));
    });

    const joy = nipplejs.create({
        zone: document.getElementById("joy")!,
        mode: "dynamic",
        size: STICK,
        color: COLORS.ui.stick,
        restOpacity: 0.6,
    });
    joy.on("move", (evt) => {
        const d = evt.data;
        if (d?.vector) stick = { x: d.vector.x, y: d.vector.y, push: d.distance / (STICK / 2) };
    });
    joy.on("end", () => (stick = null));
}

export function clearInput() {
    for (const k of Object.keys(held) as (keyof Input)[]) held[k] = false;
    stick = null;
}

/** Held keys / buttons OR'd with the stick's left / right / thrust for a ship at angle a. */
export function steer(a: number): Input {
    const out = { ...held };
    if (!stick || stick.push < 0.25) return out;
    const target = Math.atan2(-stick.x, stick.y);
    const diff = Math.atan2(Math.sin(target - a), Math.cos(target - a));
    out.left ||= diff > 0.06;
    out.right ||= diff < -0.06;
    out.thrust ||= stick.push > 0.75;
    return out;
}
