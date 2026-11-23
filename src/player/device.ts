/**
 * Device — phone and tablet niceties: keep the screen awake during a run, and go full screen.
 *
 * Purpose
 *   Touch steering is intermittent, so phones would dim and lock mid-flight, and browser bars
 *   eat into a small screen. These two calls fix both without affecting desktops.
 *
 * Operations
 *   - keepAwake(on): takes (or releases) a Screen Wake Lock. Browsers drop the lock when the tab
 *     is hidden, so main.ts calls keepAwake(true) again when a run becomes visible.
 *   - enterFullscreen(): on touch devices only, requests full screen with the navigation UI
 *     hidden. Must run inside a user gesture (main.ts calls it from startRun, a button press).
 *
 * Usage
 *   main.ts: startRun → keepAwake(true) + enterFullscreen(); showMenu → keepAwake(false);
 *   visibilitychange (visible, mid-run) → keepAwake(true).
 *
 * Highlights
 *   - Both are best-effort: unsupported browsers (iPhone Safari has no element full screen; older
 *     ones lack wake locks) and refusals are silently ignored.
 *
 * See also: main.ts, player/input.ts (isTouch); DESIGN.md "12. UI, menus and progress".
 */
import { isTouch } from "./input";

let lock: WakeLockSentinel | null = null;

export async function keepAwake(on: boolean) {
    try {
        if (on && !lock && "wakeLock" in navigator) {
            lock = await navigator.wakeLock.request("screen");
            lock.addEventListener("release", () => (lock = null));
        } else if (!on && lock) {
            await lock.release();
            lock = null;
        }
    } catch {
        /* refused (battery saver, permissions) or unsupported: play on */
    }
}

export function enterFullscreen() {
    if (!isTouch || document.fullscreenElement || !document.documentElement.requestFullscreen) return;
    document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
}
