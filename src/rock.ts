/**
 * Rock — voxel block types: a procedural pixel-art texture atlas, the rule that picks a block
 * type for each rock cell, and the instanced material that draws them.
 *
 * Purpose
 *   Gives the planet geology instead of flat-coloured cubes. Every rock cell becomes one of
 *   eight block types, each a 16x16 pixel-art tile generated at runtime (no image files), tinted
 *   by the planet palette through the per-instance colour.
 *
 * Operations
 *   - BLOCK: tile indices (Stone, Cobble, Strata, Gravel, Topsoil, Ore, Crystal, Basalt).
 *   - blockAt(lv, x, y): pure placement rule, layered top-down:
 *       surface skin (air above, at the surface)  → Topsoil
 *       up to 4 cells below the surface           → Gravel (subsoil)
 *       air-facing cells deeper than 6            → Crystal (~4%, deeper than 15) / Ore (~7%)
 *       the bottom ~22% of the planet (wavy edge) → Basalt
 *       everything else                           → Stone / Strata / Cobble / Gravel regions
 *                                                   from low-frequency value noise
 *     Region noise is seeded by the level number, so each planet's strata differ but stay
 *     deterministic.
 *   - rockMaterial(bump): MeshStandardMaterial with the albedo atlas as map (and, when bump, as
 *     a bump map for pixel relief) and a matching emissive
 *     atlas (only ore flecks and crystal facets are lit, so they glow and bloom). onBeforeCompile
 *     reads the per-instance `aTile` attribute and derives tile-local UVs from object-space
 *     position on each face, so the 1x1x3 box repeats the tile 3 times along its depth instead
 *     of stretching it.
 *   - wallMaterial(color): the back wall gets the Stone tile on its own repeating texture
 *     (ShapeGeometry UVs are world units, so it repeats once per cell).
 *
 * Usage
 *   view.ts build(): set geometry attribute aTile (InstancedBufferAttribute, 1 float per
 *   instance) from blockAt(), use rockMaterial(), and lighten setColorAt() for Ore/Crystal
 *   (TINTLESS) so their own colours show.
 *
 * Highlights
 *   - One draw call for all rock whatever the mix of types.
 *   - Nearest filtering, no mipmaps: crisp pixels, and fract()-based tiling causes no seams.
 *   - Textures are built once, lazily, on first use, and shared across levels.
 *   - blockAt is pure (no DOM), so scripts/check.ts can assert the layering.
 *
 * See also: view.ts (build), level.ts (grid, surface); DESIGN.md "7.2 Level meshes".
 */
import * as THREE from "three";
import { isAir, type Level } from "./level";
import { rng } from "./random";
import { COLORS } from "./palette";

export const BLOCK = { Stone: 0, Cobble: 1, Strata: 2, Gravel: 3, Topsoil: 4, Ore: 5, Crystal: 6, Basalt: 7 };
const TILES = 8;
const S = 16;
/** Block types that carry their own colour: tint them close to white. */
export const TINTLESS = new Set([BLOCK.Ore, BLOCK.Crystal]);

const hash = (x: number, y: number, s: number) => {
    const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
    return v - Math.floor(v);
};
/** Smooth value noise in [0, 1]. */
function noise(x: number, y: number, s: number) {
    const xi = Math.floor(x),
        yi = Math.floor(y);
    const fx = x - xi,
        fy = y - yi;
    const u = fx * fx * (3 - 2 * fx),
        v = fy * fy * (3 - 2 * fy);
    const a = hash(xi, yi, s),
        b = hash(xi + 1, yi, s),
        c = hash(xi, yi + 1, s),
        d = hash(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function blockAt(lv: Level, x: number, y: number): number {
    const { h } = lv;
    const air = (xx: number, yy: number) => isAir(lv, xx, yy);
    const depth = lv.surface[x] - 1 - y; // 0 = the surface skin row
    if (depth <= 0) return air(x, y + 1) ? BLOCK.Topsoil : BLOCK.Gravel;
    if (depth < 4) return BLOCK.Gravel;
    const exposed = air(x + 1, y) || air(x - 1, y) || air(x, y + 1) || air(x, y - 1);
    if (exposed && depth > 6) {
        const r = hash(x, y, lv.n + 9);
        if (r < 0.04 && depth > 15) return BLOCK.Crystal;
        if (r < 0.11) return BLOCK.Ore;
    }
    if (y < h * 0.22 + 6 * noise(x * 0.1, 0, lv.n)) return BLOCK.Basalt;
    const n = noise(x * 0.07, y * 0.09, lv.n * 3.1);
    return n < 0.38 ? BLOCK.Stone : n < 0.6 ? BLOCK.Strata : n < 0.8 ? BLOCK.Cobble : BLOCK.Gravel;
}

// ---- Atlas ------------------------------------------------------------------------------------

type RGB = [number, number, number];

/** Draws all tiles into an albedo and an emissive ImageData, TILES*S x S. */
function paintAtlas() {
    const W = TILES * S;
    const albedo = new ImageData(W, S),
        glow = new ImageData(W, S);
    const put = (img: ImageData, t: number, x: number, y: number, c: RGB) => {
        const i = (((y + S) % S) * W + t * S + ((x + S) % S)) * 4;
        img.data.set([c[0], c[1], c[2], 255], i);
    };
    const grey = (v: number): RGB => [v, v, v];
    for (let i = 3; i < glow.data.length; i += 4) glow.data[i] = 255; // emissive: opaque black

    const r = rng(4242);
    const jit = (amp: number) => (r() - 0.5) * 2 * amp;

    const stone = (t: number) => {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) put(albedo, t, x, y, grey(196 + jit(22)));
        for (let k = 0; k < 2; k++) {
            let x = Math.floor(r() * S),
                y = Math.floor(r() * S);
            for (let s = 0; s < 7; s++) {
                put(albedo, t, x, y, grey(140));
                x += r() < 0.5 ? 1 : 0;
                y += r() < 0.6 ? 1 : -1;
            }
        }
        for (let k = 0; k < 6; k++) put(albedo, t, Math.floor(r() * S), Math.floor(r() * S), grey(236));
    };

    // 0 Stone: speckled grey with hairline cracks.
    stone(BLOCK.Stone);

    // 1 Cobble: Voronoi cells (wrapped, so the tile repeats seamlessly) with dark mortar.
    {
        const seeds = Array.from({ length: 6 }, () => [r() * S, r() * S, 175 + r() * 40]);
        for (let y = 0; y < S; y++)
            for (let x = 0; x < S; x++) {
                const ds = seeds
                    .map(([sx, sy, v]) => {
                        const dx = Math.min(Math.abs(x + 0.5 - sx), S - Math.abs(x + 0.5 - sx));
                        const dy = Math.min(Math.abs(y + 0.5 - sy), S - Math.abs(y + 0.5 - sy));
                        return [Math.hypot(dx, dy), v];
                    })
                    .sort((a, b) => a[0] - b[0]);
                put(
                    albedo,
                    BLOCK.Cobble,
                    x,
                    y,
                    grey(ds[1][0] - ds[0][0] < 1.3 ? 110 : ds[0][1] - ds[0][0] * 4 + jit(8))
                );
            }
    }

    // 2 Strata: horizontal sediment bands with a slight wobble.
    {
        const bands = Array.from({ length: S }, () => 160 + r() * 70);
        for (let y = 0; y < S; y++)
            for (let x = 0; x < S; x++) {
                const yy = (y + Math.round(Math.sin((x / S) * Math.PI * 2) * 1.2) + S) % S;
                put(albedo, BLOCK.Strata, x, y, grey(bands[yy - (yy % 2)] + jit(10)));
            }
    }

    // 3 Gravel: dense light and dark pebbles.
    {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) put(albedo, BLOCK.Gravel, x, y, grey(165 + jit(15)));
        for (let k = 0; k < 34; k++) {
            const x = Math.floor(r() * S),
                y = Math.floor(r() * S),
                v = r() < 0.5 ? 225 : 125;
            put(albedo, BLOCK.Gravel, x, y, grey(v));
            put(albedo, BLOCK.Gravel, x + 1, y, grey(v - 15));
        }
    }

    // 4 Topsoil: bright crust with drips over speckled earth (canvas row 0 = top of the face).
    {
        for (let x = 0; x < S; x++) {
            const crust = 3 + Math.floor(r() * 3) + (r() < 0.2 ? 2 : 0);
            for (let y = 0; y < S; y++)
                put(albedo, BLOCK.Topsoil, x, y, grey(y < crust ? 245 + jit(8) : 175 + jit(20)));
        }
        for (let k = 0; k < 8; k++) put(albedo, BLOCK.Topsoil, Math.floor(r() * S), 7 + Math.floor(r() * 9), grey(120));
    }

    // 5 Ore: stone with amber veins that also glow.
    {
        stone(BLOCK.Ore);
        const amber: RGB = COLORS.rock.oreAlbedo;
        for (let k = 0; k < 4; k++) {
            let x = Math.floor(r() * S),
                y = Math.floor(r() * S);
            for (let s = 0; s < 4; s++) {
                put(albedo, BLOCK.Ore, x, y, amber);
                put(glow, BLOCK.Ore, x, y, COLORS.rock.oreGlow);
                x += Math.floor(r() * 3) - 1;
                y += Math.floor(r() * 3) - 1;
            }
        }
    }

    // 6 Crystal: dark matrix with bright cyan diamond facets that glow.
    {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) put(albedo, BLOCK.Crystal, x, y, grey(95 + jit(12)));
        for (const [cx, cy, rad] of [
            [4, 5, 3],
            [11, 10, 4],
            [12, 2, 2],
        ])
            for (let y = -rad; y <= rad; y++)
                for (let x = -rad; x <= rad; x++) {
                    const d = Math.abs(x) + Math.abs(y);
                    if (d > rad) continue;
                    const c: RGB =
                        d === rad ? COLORS.rock.crystalEdge : x < 0 ? COLORS.rock.crystalLit : COLORS.rock.crystalFace;
                    put(albedo, BLOCK.Crystal, cx + x, cy + y, c);
                    put(
                        glow,
                        BLOCK.Crystal,
                        cx + x,
                        cy + y,
                        d === rad ? COLORS.rock.crystalGlowEdge : COLORS.rock.crystalGlow
                    );
                }
    }

    // 7 Basalt: vertical columns with dark joints.
    {
        for (let c = 0; c < 4; c++) {
            const v = 150 + r() * 30,
                joint = Math.floor(r() * S);
            for (let y = 0; y < S; y++)
                for (let x = c * 4; x < c * 4 + 4; x++) {
                    const edge = x === c * 4 || y === joint;
                    put(albedo, BLOCK.Basalt, x, y, grey(edge ? 95 : v + (x === c * 4 + 1 ? 18 : 0) + jit(6)));
                }
        }
    }
    return { albedo, glow };
}

function texture(img: ImageData, repeat = false) {
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d")!.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}

let atlas: { map: THREE.Texture; glow: THREE.Texture; stone: THREE.Texture } | null = null;
function getAtlas() {
    if (atlas) return atlas;
    const { albedo, glow } = paintAtlas();
    // The back wall's texture: the Stone tile cut out on its own so it can repeat.
    const stone = new ImageData(S, S);
    for (let y = 0; y < S; y++)
        stone.data.set(
            albedo.data.subarray((y * TILES * S + BLOCK.Stone * S) * 4, (y * TILES * S + (BLOCK.Stone + 1) * S) * 4),
            y * S * 4
        );
    atlas = { map: texture(albedo), glow: texture(glow), stone: texture(stone, true) };
    return atlas;
}

/**
 * The rock material. bump = pixel relief: the albedo atlas doubles as a bump map, so dark
 * cracks, mortar and joints read as recessed under the ship's light (high tiers only).
 * Create once per View and reuse across planets: the shader then compiles once.
 */
export function rockMaterial(bump: boolean) {
    const { map, glow } = getAtlas();
    const mat = new THREE.MeshStandardMaterial({
        map,
        emissiveMap: glow,
        emissive: 0xffffff, // multiplier for the emissive atlas, not a colour
        emissiveIntensity: 1.8,
        roughness: 0.85,
        metalness: 0.05,
        ...(bump ? { bumpMap: map, bumpScale: 2.5 } : {}),
    });
    // Tells three.js the patched shader differs per bump setting (programs are cached by key).
    mat.customProgramCacheKey = () => `rock-${bump}`;
    mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
            .replace(
                "#include <common>",
                "#include <common>\nattribute float aTile;\nvarying float vTile;\nvarying vec2 vLocal;"
            )
            .replace(
                "#include <uv_vertex>",
                `#include <uv_vertex>
                vTile = aTile;
                vec3 lp = position + vec3(0.5, 0.5, 1.5);
                vLocal = abs(normal.z) > 0.5 ? lp.xy : abs(normal.x) > 0.5 ? lp.zy : lp.xz;`
            );
        sh.fragmentShader = sh.fragmentShader
            .replace(
                "#include <common>",
                `#include <common>
                varying float vTile;
                varying vec2 vLocal;
                vec2 tileUv() { return vec2((fract(vLocal.x) + vTile) / ${TILES}.0, fract(vLocal.y)); }`
            )
            .replace("#include <map_fragment>", "diffuseColor *= texture2D(map, tileUv());")
            .replace(
                "#include <emissivemap_fragment>",
                "totalEmissiveRadiance *= texture2D(emissiveMap, tileUv()).rgb;"
            )
            // Bump: sample the atlas through tileUv(), but take screen-space derivatives from the
            // continuous vLocal (scaled to atlas units) so fract() wrap-arounds aren't seen as
            // cliffs in the height field.
            .replace(
                "#include <bumpmap_pars_fragment>",
                `#ifdef USE_BUMPMAP
                uniform sampler2D bumpMap;
                uniform float bumpScale;
                vec2 dHdxy_fwd() {
                    vec2 dSTdx = dFdx(vLocal) / vec2(${TILES}.0, 1.0);
                    vec2 dSTdy = dFdy(vLocal) / vec2(${TILES}.0, 1.0);
                    vec2 uv = tileUv();
                    float Hll = bumpScale * texture2D(bumpMap, uv).x;
                    float dBx = bumpScale * texture2D(bumpMap, uv + dSTdx).x - Hll;
                    float dBy = bumpScale * texture2D(bumpMap, uv + dSTdy).x - Hll;
                    return vec2(dBx, dBy);
                }
                ${THREE.ShaderChunk.bumpmap_pars_fragment.slice(THREE.ShaderChunk.bumpmap_pars_fragment.indexOf("vec3 perturbNormalArb"))}`
            );
    };
    return mat;
}

export function wallMaterial(color: THREE.Color) {
    return new THREE.MeshStandardMaterial({ map: getAtlas().stone, color, roughness: 1 });
}
