/**
 * Random — the one seeded pseudo-random number generator every procedural system shares.
 *
 * Purpose
 *   Deterministic randomness: the same seed always yields the same sequence, so planets, rock
 *   tile art and generated planet names are stable across runs and machines.
 *
 * Operations
 *   - rng(seed): returns a mulberry32 generator, () => number in [0, 1). 32-bit state, fast,
 *     good enough statistically for content generation (not for cryptography).
 *
 * Usage
 *   const r = rng(seed); r(). Seeds in use: level.ts (n * 7919 + 1337), rock.ts tile atlas
 *   (4242), names.ts generated names (n * 104729 + 7). Give each consumer its own seed formula
 *   so their sequences don't correlate.
 *
 * Highlights
 *   - Pure, no dependencies, so it can be imported by any module (including Node checks)
 *     without import cycles.
 *   - Gameplay-time randomness (turret aim jitter, particles) uses Math.random() on purpose;
 *     only content generation needs to be reproducible.
 *
 * See also: level.ts, rock.ts, names.ts.
 */
export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
