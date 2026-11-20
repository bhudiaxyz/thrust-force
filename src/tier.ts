/**
 * Tier — GPU classification into high / mid / low and the per-tier quality table.
 *
 * Purpose
 *   Scales visual cost to the device so phones and old laptops stay smooth while discrete GPUs
 *   get the full look. A cut-down version of voxel-planet's gpu-tier.ts: three tiers are enough
 *   because a side-on cave is far cheaper than a streamed planet.
 *     high  discrete desktop GPU / Apple Silicon / flagship phone: shadows, bloom, MSAA, DPR 2
 *     mid   modern integrated laptop GPU, mid-range phone: bloom, MSAA, DPR 1.5, no shadows
 *     low   old integrated, budget phone, software GL, <= 2 GB RAM: no bloom/MSAA, DPR 1
 *
 * Operations
 *   - TIER_SETTINGS: dprCap, antialias, bloom, shadows, particles, stars per tier.
 *   - classifyGpu(probe): pure mapping from {renderer string, mobile, cores, memGB} to a tier.
 *     Software renderers and low memory always go low; mobile is judged by GPU family (Apple,
 *     Adreno number, Mali-G number, Xclipse/Immortalis); desktop by discrete-GPU name patterns,
 *     then modern iGPU names; unknown renderers fall back on core count.
 *   - detectTier(): `?tier=high|mid|low` override, else probes a throwaway WebGL2 context
 *     (high-performance, like the real renderer) for UNMASKED_RENDERER_WEBGL, releases it, and
 *     classifies.
 *
 * Usage
 *   main.ts: const tier = detectTier(); new View(el, TIER_SETTINGS[tier]). The tier is also
 *   written to <html data-tier> for debugging. To add a knob, add a TierSettings field and set it
 *   in all three entries.
 *
 * Highlights
 *   - The probe uses the same powerPreference as the renderer, so hybrid laptops are tiered on
 *     the GPU actually used.
 *   - iPadOS (desktop "Macintosh" UA) is detected through maxTouchPoints.
 *   - classifyGpu is asserted against real renderer strings in scripts/check.ts.
 *
 * See also: view.ts, main.ts, scripts/check.ts; DESIGN.md "8. Quality tiers".
 */
export type Tier = 'high' | 'mid' | 'low';

export interface TierSettings {
    dprCap: number;
    antialias: boolean;
    bloom: boolean;
    shadows: boolean;
    particles: number;
    stars: number;
}

export const TIER_SETTINGS: Record<Tier, TierSettings> = {
    high: { dprCap: 2, antialias: true, bloom: true, shadows: true, particles: 3000, stars: 1800 },
    mid: { dprCap: 1.5, antialias: true, bloom: true, shadows: false, particles: 2000, stars: 1200 },
    low: { dprCap: 1, antialias: false, bloom: false, shadows: false, particles: 900, stars: 600 },
};

export interface GpuProbe {
    renderer: string;
    mobile: boolean;
    cores: number;
    memGB?: number;
}

export function classifyGpu(p: GpuProbe): Tier {
    const r = p.renderer.toLowerCase();
    if (/swiftshader|llvmpipe|software|basic render/.test(r) || (p.memGB ?? 8) <= 2) return 'low';
    if (p.mobile) {
        if (/apple/.test(r)) return 'high';
        const adreno = /adreno[^0-9]*(\d{3})/.exec(r);
        if (adreno) return +adreno[1] >= 700 ? 'high' : +adreno[1] >= 630 ? 'mid' : 'low';
        if (/xclipse|immortalis/.test(r)) return 'high';
        const mali = /mali-g(\d+)/.exec(r);
        if (mali) return +mali[1] >= 76 ? 'mid' : 'low';
        return p.cores >= 8 ? 'mid' : 'low';
    }
    if (/nvidia|geforce|rtx|radeon (rx|pro)|\brx ?\d{3,4}|apple m\d|apple gpu|arc\(tm\) a\d{3}/.test(r)) return 'high';
    if (/arc|iris|radeon/.test(r)) return 'mid';
    if (/intel/.test(r)) return 'low';
    return p.cores >= 8 ? 'mid' : 'low';
}

export function detectTier(): Tier {
    const forced = new URLSearchParams(location.search).get('tier');
    if (forced && forced in TIER_SETTINGS) return forced as Tier;
    let renderer = '';
    try {
        const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' });
        if (gl) {
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
            gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
    } catch {
        /* no WebGL2: renderer stays '' and classifies low */
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
