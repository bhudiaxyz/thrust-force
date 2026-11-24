/**
 * Palette — every colour the game draws with, in one place: per-planet themes plus the fixed
 * colours for lights, ship, fixtures, effects, rock tiles, minimap and UI.
 *
 * Purpose
 *   Makes theming a data change. A planet's look comes from a PlanetTheme picked by themeFor(n);
 *   everything else reads COLORS. No other module hard-codes a colour (index.html's pre-JS splash
 *   background and favicon excepted, since they paint before any script runs).
 *
 * Operations
 *   - Colour formats, by where they end up:
 *       Hex      (0xRRGGBB) for lit three.js materials and lights (sRGB, tone-mapped).
 *       RGB      ([r, g, b], linear, 1 = white, > 1 = HDR) for unlit "neon" materials, lines,
 *                particles and debris; channels above 1 are what cross the bloom threshold.
 *       RGB8     ([0..255] x 3) for pixels painted into canvases (rock tile atlas, minimap).
 *       CSS      (strings) for the 2D minimap overlay and the UI.
 *   - PLANET_THEMES / themeFor(n): 24 named themes (rock gradient deep → top, surface skin,
 *     neon edge colour, sky); planets cycle through them in order, so every planet in a run of
 *     24 looks different.
 *   - COLORS: fixed colours grouped by subject (light, ship, pod, fixture, bullet, fx, ember ramp,
 *     rock tiles, minimap, ui).
 *   - ramp(stops, t): samples a colour ramp such as COLORS.ember (cooling debris).
 *   - evenGlow(rgb): rescales a theme's neon to NEON_LUMA perceived brightness, so every theme
 *     glows equally under bloom (yellow and green read far brighter than blue at equal values).
 *   - applyUiColors(): writes COLORS.ui into the CSS custom properties that styles.css derives
 *     every UI tint from (via color-mix), so the UI re-themes from here too.
 *
 * Usage
 *   view.ts: themeFor(level.n) in build(), COLORS.* for materials, lights and effects.
 *   rock.ts: COLORS.rock for the ore / crystal pixels. minimap.ts: COLORS.minimap.
 *   main.ts: COLORS.fx for small bursts, COLORS.ui.stick, applyUiColors() at startup.
 *
 * Highlights
 *   - To add a theme, append a PlanetTheme (the cycle length follows the array); to theme by
 *     something other than planet number, change themeFor().
 *   - Theme neon values set hue only: view.ts passes them through evenGlow(), so their
 *     brightness is NEON_LUMA whatever is written here.
 *   - styles.css keeps the same values as fallbacks so the splash looks right before JS loads.
 *
 * See also: render/view.ts, render/rock.ts, ui/minimap.ts, main.ts, styles.css; DESIGN.md "7.1 Scene and look".
 */

export type RGB = [number, number, number];
export type RGB8 = [number, number, number];

export interface PlanetTheme {
    name: string;
    deep: number; // rock colour at the bottom of the planet
    top: number; // rock colour near the surface
    surf: number; // surface skin (topsoil)
    neon: RGB; // edge strips, shockwave, neon sparks and debris
    sky: number; // scene background
}

export const PLANET_THEMES: PlanetTheme[] = [
    { name: "Amethyst", deep: 0x2a1d3a, top: 0x6b4a7a, surf: 0x9a7bd0, neon: [0.4, 1.6, 3.0], sky: 0x07071a },
    { name: "Ember", deep: 0x3a1e12, top: 0x8a4a28, surf: 0xd08a4a, neon: [3.0, 1.0, 0.3], sky: 0x140806 },
    { name: "Verdigris", deep: 0x0f2a24, top: 0x2f6a58, surf: 0x6ad0a0, neon: [0.3, 3.0, 1.4], sky: 0x03100e },
    { name: "Glacier", deep: 0x1a2236, top: 0x52617f, surf: 0xc8d6f0, neon: [1.8, 2.4, 3.0], sky: 0x060a14 },
    { name: "Crimson", deep: 0x301018, top: 0x7a2a3a, surf: 0xe0708a, neon: [3.0, 0.4, 1.4], sky: 0x12040a },
    { name: "Sulphur", deep: 0x2a2a10, top: 0x6a6a2a, surf: 0xd8d070, neon: [2.6, 2.4, 0.4], sky: 0x0c0c04 },
    { name: "Abyss", deep: 0x0a1a2a, top: 0x1f4a6a, surf: 0x5aa8d8, neon: [3.0, 0.5, 2.6], sky: 0x02060e },
    { name: "Rust", deep: 0x2e1a10, top: 0x7a4024, surf: 0xc8784a, neon: [0.3, 2.6, 3.0], sky: 0x0e0704 },
    { name: "Jade", deep: 0x0c2416, top: 0x2a6a40, surf: 0x8ad89a, neon: [3.0, 2.2, 0.3], sky: 0x020c06 },
    { name: "Ash", deep: 0x1c1c20, top: 0x4c4c56, surf: 0xb0b0bc, neon: [3.0, 1.2, 0.2], sky: 0x060608 },
    { name: "Coral", deep: 0x2e1420, top: 0x8a4a50, surf: 0xf0a088, neon: [0.3, 3.0, 2.4], sky: 0x10060a },
    { name: "Cobalt", deep: 0x101436, top: 0x2c3a8a, surf: 0x7a90f0, neon: [1.6, 3.0, 0.3], sky: 0x04040f },
    { name: "Obsidian", deep: 0x0c0a12, top: 0x2a2436, surf: 0x6a5a8a, neon: [3.0, 0.3, 0.6], sky: 0x030205 },
    { name: "Saffron", deep: 0x2e1c06, top: 0x8a5a14, surf: 0xf0b040, neon: [0.6, 1.2, 3.0], sky: 0x0e0802 },
    { name: "Moss", deep: 0x141e0a, top: 0x3e5a1e, surf: 0xa0c860, neon: [3.0, 0.6, 2.2], sky: 0x050802 },
    { name: "Tidepool", deep: 0x06222a, top: 0x1a5a64, surf: 0x60c8c8, neon: [3.0, 1.6, 0.3], sky: 0x020a0c },
    { name: "Magma", deep: 0x240604, top: 0x6a1a0a, surf: 0xff7030, neon: [3.0, 2.6, 0.6], sky: 0x0c0201 },
    { name: "Lilac", deep: 0x221a30, top: 0x6a5490, surf: 0xd0b0f0, neon: [0.4, 3.0, 1.0], sky: 0x08060e },
    { name: "Copper", deep: 0x26140c, top: 0x7a4428, surf: 0xe09060, neon: [0.3, 3.0, 2.8], sky: 0x0a0503 },
    { name: "Nebula", deep: 0x1a0c2a, top: 0x4a2470, surf: 0xb070e0, neon: [0.5, 2.8, 3.0], sky: 0x06020c },
    { name: "Frost", deep: 0x16242c, top: 0x46707e, surf: 0xe0f4ff, neon: [3.0, 1.0, 2.4], sky: 0x050a0d },
    { name: "Bloodstone", deep: 0x200a0a, top: 0x5a1a1a, surf: 0xb04a3a, neon: [0.4, 3.0, 0.8], sky: 0x0a0202 },
    { name: "Dune", deep: 0x2a2014, top: 0x7a6440, surf: 0xe8d09a, neon: [3.0, 0.5, 0.4], sky: 0x0c0905 },
    { name: "Aurora", deep: 0x081a20, top: 0x1e4a50, surf: 0x70e0b0, neon: [2.2, 0.6, 3.0], sky: 0x02080a },
];

/** Perceived brightness every theme's neon is scaled to, so yellows don't out-bloom blues. */
export const NEON_LUMA = 1.4;

export const COLORS = {
    light: {
        hemiSky: 0xbfd4ff,
        hemiGround: 0x201810,
        sun: 0xffffff,
        ship: 0x9fd8ff,
        reactor: 0xff7a30,
        reactorCritical: 0xff2010,
        flash: 0xffd8a8,
    },
    ship: {
        hull: 0x5a6678,
        outline: [0.6, 2.2, 3.0] as RGB,
        canopy: [0.5, 2.5, 3.0] as RGB,
        flame: [3.0, 1.4, 0.4] as RGB,
        shield: [0.6, 2.0, 3.0] as RGB,
    },
    pod: {
        body: 0x8090a0,
        ring: [2.8, 2.2, 0.6] as RGB,
        rod: [2.4, 2.0, 0.8] as RGB,
        beam: [0.6, 3.0, 1.2] as RGB,
    },
    fixture: {
        pedestal: 0x506070,
        turret: 0x7a2020,
        turretEye: [3.0, 0.3, 0.2] as RGB,
        fuelBody: 0x30383a,
        fuelBand: [0.4, 3.0, 0.8] as RGB,
        reactorBody: 0x606a78,
        /** Reactor core = base + pulse * swing (pulse 0..1); critical uses the red pair. */
        reactorCoreBase: [0.4, 0, 0.2] as RGB,
        reactorCoreSwing: [3.0, 1.2, 0] as RGB,
        reactorCriticalBase: [0.4, 0.1, 0.2] as RGB,
        reactorCriticalSwing: [3.0, 0, 0] as RGB,
        pad: [0.3, 2.6, 1.6] as RGB, // landing pad glow (brighter while refuelling)
        checkpoint: [0.5, 0.9, 1.2] as RGB, // beacon not yet passed
        checkpointOn: [0.6, 3.0, 1.2] as RGB, // beacon passed (respawn point)
        mineBody: 0x2a2430,
        mineEye: [3.0, 0.2, 0.4] as RGB,
        gate: [3.0, 0.15, 0.35] as RGB, // laser beam
        gateEmitter: 0x40404a,
        ghost: [0.6, 1.6, 2.4] as RGB, // best-run ghost ship (drawn translucent)
    },
    bullet: {
        player: [1.5, 2.5, 3.0] as RGB,
        enemy: [3.0, 0.8, 0.2] as RGB,
    },
    fx: {
        exhaust: [3.0, 1.2, 0.3] as RGB,
        hit: [2.0, 2.0, 2.5] as RGB,
        fuel: [0.4, 3.0, 0.8] as RGB,
        attach: [3.0, 2.4, 0.6] as RGB,
        land: [1.0, 1.0, 1.0] as RGB,
        sparkCore: [3.0, 2.8, 2.4] as RGB,
        sparkAmber: [3.0, 1.3, 0.25] as RGB,
        sparkRed: [2.2, 0.25, 0.08] as RGB,
        ringHot: [3.0, 1.5, 0.4] as RGB,
        debrisHull: [0.55, 0.62, 0.72] as RGB,
        star: [1.0, 1.0, 1.1] as RGB, // multiplied by a random 0.4..1.8 brightness
        dust: [0.8, 0.85, 1.0] as RGB, // cave dust motes, times a random 0.25..0.75
    },
    /** Cooling ember debris, sampled with ramp(): t = remaining life, 1 → 0. */
    ember: [
        [1.0, [3.0, 2.9, 1.8]],
        [0.7, [3.0, 1.8, 0.4]],
        [0.45, [3.0, 0.6, 0.15]],
        [0.15, [0.5, 0.1, 0.05]],
        [0.0, [0.12, 0.08, 0.08]],
    ] as [number, RGB][],
    rock: {
        oreAlbedo: [255, 176, 60] as RGB8,
        oreGlow: [255, 150, 40] as RGB8,
        crystalEdge: [70, 200, 255] as RGB8,
        crystalLit: [190, 245, 255] as RGB8,
        crystalFace: [120, 225, 255] as RGB8,
        crystalGlowEdge: [20, 90, 140] as RGB8,
        crystalGlow: [60, 190, 255] as RGB8,
        /** Tints for Ore / Crystal instances are lerped this far toward white. */
        tintlessLift: 0.7,
    },
    minimap: {
        rockLow: [40, 38, 70] as RGB8,
        rockHigh: [90, 78, 120] as RGB8,
        edge: [102, 224, 255] as RGB8,
        air: [14, 24, 44] as RGB8,
        fuel: "#5dff8a",
        turret: "#ff4a3a",
        reactor: "#ff9a3a",
        reactorCritical: "#ff2a10",
        pod: "#ffc85a",
        ship: "#e6f4ff",
        heading: "#66e0ff",
        view: "rgba(102, 224, 255, 0.35)",
        pad: "#40e0a0",
        checkpoint: "#6a8aa0",
        checkpointOn: "#6aff9a",
        mine: "#ff70c0",
        gate: "#ff3050",
        ghost: "rgba(150, 220, 255, 0.6)",
    },
    /** Colour-blind-safe minimap markers (Okabe–Ito based): replaces the matching minimap keys. */
    minimapColourBlind: {
        fuel: "#56b4e9",
        turret: "#e69f00",
        reactor: "#f0e442",
        reactorCritical: "#ffffff",
        pod: "#cc79a7",
        mine: "#d55e00",
        gate: "#ffffff",
        pad: "#009e73",
    },
    ui: {
        bg: "#05060f",
        ink: "#e6f4ff",
        cyan: "#66e0ff",
        amber: "#ffc85a",
        hot: "#ff5a3c",
        "panel-base": "#060a18",
        "panel-raised": "#0f1830",
        "panel-hover": "#182648",
        stick: "rgba(102, 224, 255, 0.45)", // joypad knob
        stickBase: "rgba(102, 224, 255, 0.1)", // joypad base, faint like the touch buttons
    },
};

/** Theme for planet n: the themes in order, cycling (planet 25 = theme 1 again). */
export const themeFor = (n: number): PlanetTheme => PLANET_THEMES[(n - 1) % PLANET_THEMES.length];

/** Scale an HDR colour so its luma (Rec. 709 weights) is NEON_LUMA, keeping its hue. */
export function evenGlow(c: RGB): RGB {
    const luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] || 1;
    const k = NEON_LUMA / luma;
    return [c[0] * k, c[1] * k, c[2] * k];
}

/** Sample a ramp of [t, colour] stops sorted by descending t. */
export function ramp(stops: [number, RGB][], t: number, out: RGB = [0, 0, 0]): RGB {
    for (let i = 1; i < stops.length; i++) {
        const [t1, c1] = stops[i];
        if (t >= t1) {
            const [t0, c0] = stops[i - 1];
            const k = (t - t1) / (t0 - t1 || 1);
            for (let j = 0; j < 3; j++) out[j] = c1[j] + (c0[j] - c1[j]) * Math.min(1, k);
            return out;
        }
    }
    const last = stops[stops.length - 1][1];
    out[0] = last[0];
    out[1] = last[1];
    out[2] = last[2];
    return out;
}

/** Push COLORS.ui into the CSS custom properties styles.css builds its tints from. */
export function applyUiColors() {
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(COLORS.ui)) if (!k.startsWith("stick")) root.setProperty(`--${k}`, v);
}
