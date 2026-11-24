/**
 * Tier — GPU classification into four quality tiers and the per-tier settings table.
 *
 * Purpose
 *   Scales visual and CPU cost to the device so 7-year-old phones and laptops stay smooth while
 *   current desktops get the full look. A cut-down version of voxel-planet's gpu-tier.ts.
 *     high         desktop discrete GPU / Apple Silicon Mac: 4x MSAA, 4096 shadows, bump relief,
 *                  cave dust, bloom, DPR 2
 *     mobile-high  flagship phone / tablet (Galaxy S22 class: Adreno 7xx, Xclipse; any WebGL2
 *                  iPad / iPhone): 2x MSAA, 1024 shadows, bump, bloom, DPR 1.5
 *     mid          modern integrated laptop GPU (Iris Xe, Radeon iGPU, Arc), 2019-21 phones
 *                  (Adreno 630-6xx, Mali-G76+): 2x MSAA, bloom, DPR 1.5, no shadows
 *     low          older Intel UHD/HD, budget phones, software GL, <= 2 GB RAM: no MSAA, no
 *                  bloom, DPR 1, fewer particles
 *
 * Operations
 *   - TIER_SETTINGS: one row per tier (fields documented on TierSettings).
 *   - classifyGpu(probe): pure mapping from {renderer string, mobile, cores, memGB} to a tier.
 *     Software renderers and low memory always go low. Mobile is judged by GPU family; desktop
 *     by discrete-GPU name patterns, then modern iGPU names; unknown renderers fall back on
 *     core count.
 *   - detectTier(): `?tier=high|mobile-high|mid|low` override, else probes a throwaway WebGL2
 *     context (high-performance, like the real renderer) for UNMASKED_RENDERER_WEBGL, releases
 *     it, and classifies. Returns 'none' when WebGL2 is unavailable, so boot can explain why.
 *
 * Usage
 *   main.ts: const tier = detectTier(); new View(el, TIER_SETTINGS[tier]). The tier is also
 *   written to <html data-tier> for debugging. Add a field to TierSettings and all four rows.
 *
 * Highlights
 *   - The tier is only the starting point: main.ts runs a frame-time governor that calls
 *     View.degrade() (resolution → shadows → bloom) if a device can't keep up, so a misjudged
 *     device stutters for a couple of seconds at most.
 *   - The probe uses the same powerPreference as the renderer, so hybrid laptops are tiered on
 *     the GPU actually used. iPadOS (desktop "Macintosh" UA) is detected through maxTouchPoints.
 *   - classifyGpu is asserted against real renderer strings in scripts/check.ts.
 *
 * See also: render/view.ts, main.ts (governor), scripts/check.ts; DESIGN.md "10. Quality tiers".
 */
export type Tier = "high" | "mobile-high" | "mid" | "low";

export interface TierSettings {
    /** Max device pixel ratio for the drawing buffer. */
    dprCap: number;
    /** MSAA samples on the post-processing render target (0 = off). */
    msaa: number;
    bloom: boolean;
    /** Sun shadow map edge in px (0 = no shadows). */
    shadowMap: number;
    /** Pixel relief on rock tiles (bump map from the albedo atlas). */
    bump: boolean;
    /** Floating dust motes inside the planet. */
    dust: number;
    /** Faint coloured dust clumps drifting in the caves (CLUMP_N motes each). */
    clumps: number;
    particles: number;
    stars: number;
    /** Main-thread ms per frame for streaming rock chunks after a planet loads. */
    buildMs: number;
}

export const TIER_SETTINGS: Record<Tier, TierSettings> = {
    high: {
        dprCap: 2,
        msaa: 4,
        bloom: true,
        shadowMap: 4096,
        bump: true,
        dust: 500,
        clumps: 40,
        particles: 3000,
        stars: 1800,
        buildMs: 8,
    },
    "mobile-high": {
        dprCap: 1.5,
        msaa: 2,
        bloom: true,
        shadowMap: 1024,
        bump: true,
        dust: 200,
        clumps: 28,
        particles: 2000,
        stars: 1200,
        buildMs: 5,
    },
    mid: {
        dprCap: 1.5,
        msaa: 2,
        bloom: true,
        shadowMap: 0,
        bump: false,
        dust: 0,
        clumps: 20,
        particles: 2000,
        stars: 1200,
        buildMs: 5,
    },
    low: {
        dprCap: 1,
        msaa: 0,
        bloom: false,
        shadowMap: 0,
        bump: false,
        dust: 0,
        clumps: 12,
        particles: 900,
        stars: 600,
        buildMs: 3,
    },
};

export interface GpuProbe {
    renderer: string;
    mobile: boolean;
    cores: number;
    memGB?: number;
}

export function classifyGpu(p: GpuProbe): Tier {
    const r = p.renderer.toLowerCase();
    if (/swiftshader|llvmpipe|software|basic render/.test(r) || (p.memGB ?? 8) <= 2) return "low";
    if (p.mobile) {
        // Every WebGL2-capable iOS / iPadOS device (A10+, 2016-) handles mobile-high; the
        // governor catches the oldest. Safari under-reports cores, so check Apple first.
        if (/apple/.test(r)) return "mobile-high";
        const adreno = /adreno[^0-9]*(\d{3})/.exec(r);
        if (adreno) return +adreno[1] >= 700 ? "mobile-high" : +adreno[1] >= 630 ? "mid" : "low";
        if (/xclipse|immortalis/.test(r)) return "mobile-high";
        const mali = /mali-g(\d+)/.exec(r);
        if (mali) return +mali[1] >= 710 ? "mobile-high" : +mali[1] >= 76 ? "mid" : "low";
        return p.cores >= 8 ? "mid" : "low";
    }
    if (p.cores <= 2) return "low";
    // Entry-level / old discrete GPUs (GTX 9xx, 1030-1050, MX, GT): mid rather than high.
    if (/gtx ?(9\d\d|10[3-5]0)|\bmx ?\d{2,3}\b|\bgt ?\d{3,4}\b|rx ?5[56]0\b/.test(r)) return "mid";
    if (/nvidia|geforce|rtx|radeon (rx|pro)|\brx ?\d{3,4}|apple m\d|apple gpu|arc\(tm\) a\d{3}/.test(r)) return "high";
    if (/arc|iris|radeon|vega/.test(r)) return "mid";
    if (/intel/.test(r)) return "low";
    return p.cores >= 8 ? "mid" : "low";
}

/** `?tier=` wins, then the Options override, then the GPU probe. */
export function detectTier(preferred?: Tier): Tier | "none" {
    const forced = new URLSearchParams(location.search).get("tier");
    if (forced && forced in TIER_SETTINGS) return forced as Tier;
    if (preferred && preferred in TIER_SETTINGS) return preferred;
    let renderer = "";
    try {
        const gl = document.createElement("canvas").getContext("webgl2", { powerPreference: "high-performance" });
        if (!gl) return "none";
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
        gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
        return "none";
    }
    const ua = navigator.userAgent;
    const mobile = /Mobi|Android|iPad|iPhone/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    return classifyGpu({
        renderer,
        mobile,
        cores: navigator.hardwareConcurrency || 4,
        memGB: (navigator as { deviceMemory?: number }).deviceMemory,
    });
}
