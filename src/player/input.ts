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
 *   - Stick (#joy, bottom-left corner; bottom-right when left-handed): a fixed nipplejs joypad
 *     (static mode), always shown during a run. steer(shipAngle) aims absolutely:
 *     it presses left / right until the nose is within 0.06 rad of the stick direction; pushes
 *     under 25% are ignored; over 75% also thrusts, so one thumb flies the ship.
 *   - Gamepads (standard mapping, polled in steer()): left stick aims absolutely like the touch
 *     stick (pushed past the thrust threshold also thrusts); d-pad left / right rotate; A or RT
 *     thrust; X or RB fire; B or LT shield. Start → onPadButton("pause"); in menus the d-pad and
 *     A → onPadButton("up" | "down" | "select"), B → "back" (edge-triggered).
 *   - setStickThrust(v): the push (0.6..0.95) at which the touch / pad stick also thrusts.
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
 * See also: main.ts, core/game.ts (Input), index.html (#joy, #touch); DESIGN.md "11. Input".
 */
import nipplejs from "nipplejs";
import type { Input } from "../core/game";
import { COLORS } from "../core/palette";

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
/** Last frame's button states per gamepad, for edge detection. */
const padPrev = new Map<number, boolean[]>();
let stick: { x: number; y: number; push: number } | null = null;
let thrustAt = 0.75;
/** Called on gamepad button presses that aren't flight controls (main.ts handles them). */
export let onPadButton: (b: "pause" | "up" | "down" | "select" | "back") => void = () => {};

export function setStickThrust(v: number) {
    thrustAt = Math.min(0.95, Math.max(0.6, v));
}

export function setPadHandler(fn: typeof onPadButton) {
    onPadButton = fn;
}

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

    // A fixed joypad centred in its bottom-corner zone. dynamicPage re-measures on every touch,
    // because the zone is hidden at creation and moves on rotation, full screen and left-handed.
    const joy = nipplejs.create({
        zone: document.getElementById("joy")!,
        mode: "static",
        position: { left: "50%", top: "50%" },
        dynamicPage: true,
        size: STICK,
        color: { front: COLORS.ui.stick, back: COLORS.ui.stickBase },
        restOpacity: 0.7,
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

/** Steer toward stick direction (x right, y up) for a ship at angle a; push 0..1. */
function aim(out: Input, a: number, x: number, y: number, push: number) {
    if (push < 0.25) return;
    const target = Math.atan2(-x, y);
    const diff = Math.atan2(Math.sin(target - a), Math.cos(target - a));
    out.left ||= diff > 0.06;
    out.right ||= diff < -0.06;
    out.thrust ||= push > thrustAt;
}

/** Edge-detected gamepad buttons; flight controls are OR'd into out. */
export function pollPads(out?: Input, a = 0) {
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
        if (!pad) continue;
        const b = pad.buttons.map((x) => x.pressed || x.value > 0.5);
        const prev = padPrev.get(pad.index) ?? [];
        const edge = (i: number) => b[i] && !prev[i];
        if (edge(9)) onPadButton("pause");
        if (edge(12)) onPadButton("up");
        if (edge(13)) onPadButton("down");
        if (edge(0)) onPadButton("select");
        if (edge(1)) onPadButton("back");
        padPrev.set(pad.index, b);
        if (!out) continue;
        const x = pad.axes[0] ?? 0,
            y = -(pad.axes[1] ?? 0);
        aim(out, a, x, y, Math.min(1, Math.hypot(x, y)));
        out.left ||= !!b[14];
        out.right ||= !!b[15];
        out.thrust ||= !!b[0] || !!b[7];
        out.fire ||= !!b[2] || !!b[5];
        out.shield ||= !!b[1] || !!b[6];
    }
}

/** Held keys / buttons OR'd with the touch stick and gamepads, for a ship at angle a. */
export function steer(a: number): Input {
    const out = { ...held };
    if (stick) aim(out, a, stick.x, stick.y, stick.push);
    pollPads(out, a);
    return out;
}
