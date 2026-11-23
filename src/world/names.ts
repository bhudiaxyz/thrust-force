/**
 * Names — a single-word name for every planet.
 *
 * Purpose
 *   Gives each planet an identity ("Planet 1: Avren") shown in the arrival message, the HUD and
 *   the pause / game-over dialog. Names are invented words, one word each, no spaces.
 *
 * Operations
 *   - PLANET_NAMES: 100 hand-picked names, one per planet up to full difficulty
 *     (MAX_DIFFICULTY_AT in level.ts).
 *   - planetName(n): PLANET_NAMES[n - 1] for planets 1..100; beyond that a seeded syllable
 *     generator (2–3 syllables: consonant + vowel, a cluster only at the start, optional coda) builds a new word from n, so
 *     every planet still gets a stable, pronounceable single-word name.
 *
 * Usage
 *   level.ts stores planetName(n) as Level.name; game.ts and main.ts display it.
 *
 * Highlights
 *   - Pure and deterministic: planet n always has the same name.
 *   - Selection is by index, so reordering PLANET_NAMES renames existing planets; append new
 *     names at the end (the generator then starts later).
 *   - Distinct, not just unique: no two names are one edit apart or share their first three
 *     letters (tooSimilar). The 100 hand-picked names obey it; the generator retries with new
 *     seeds until a name clears every earlier one; dailyName(seed) clears every hand-picked name.
 *   - scripts/check.ts asserts this for planets 1..200 and the daily name.
 *
 * See also: world/level.ts, core/game.ts (arrival message), main.ts (HUD, pause); DESIGN.md "5".
 */
import { rng } from "../core/random";

export const PLANET_NAMES = [
    "Avren",
    "Kesra",
    "Vael",
    "Orin",
    "Tamsk",
    "Ilva",
    "Zerith",
    "Quell",
    "Moru",
    "Saphe",
    "Drav",
    "Lunek",
    "Ostra",
    "Pellin",
    "Ravik",
    "Sidra",
    "Thune",
    "Vesk",
    "Wyre",
    "Xarn",
    "Yllin",
    "Zoma",
    "Arvo",
    "Belk",
    "Corra",
    "Dimmet",
    "Eskar",
    "Fenn",
    "Gorrim",
    "Halvi",
    "Iskel",
    "Jarrow",
    "Lorne",
    "Merrow",
    "Osk",
    "Prell",
    "Brevan",
    "Skelda",
    "Torva",
    "Umbrel",
    "Vantor",
    "Wexa",
    "Zell",
    "Ashkar",
    "Brannoc",
    "Cindra",
    "Delvo",
    "Maro",
    "Quillon",
    "Kordo",
    "Lyrra",
    "Quarn",
    "Sevra",
    "Talos",
    "Ulvek",
    "Varro",
    "Wenna",
    "Saffra",
    "Ombra",
    "Abrel",
    "Borun",
    "Nexis",
    "Calden",
    "Elsk",
    "Ferro",
    "Grisk",
    "Hollin",
    "Irda",
    "Joskel",
    "Kaivo",
    "Lumir",
    "Ruvio",
    "Narra",
    "Silthe",
    "Pyrr",
    "Rasta",
    "Solvik",
    "Tirra",
    "Ursk",
    "Vellis",
    "Kythe",
    "Xeno",
    "Jorvik",
    "Amarra",
    "Arkel",
    "Brisa",
    "Bexley",
    "Dusk",
    "Eiran",
    "Fask",
    "Gavrel",
    "Ithra",
    "Ivorn",
    "Gloam",
    "Kelt",
    "Trevik",
    "Mirek",
    "Noska",
    "Orvan",
    "Fyrdal",
];

// Clusters (th, dr, ...) only start a word; later syllables use single consonants, so names
// stay pronounceable.
const FIRST = ["b", "d", "k", "l", "m", "n", "r", "s", "t", "v", "z", "th", "dr", "kr", "st"];
const ONSET = ["b", "d", "k", "l", "m", "n", "r", "s", "t", "v", "z"];
const VOWEL = ["a", "e", "i", "o", "u", "a", "e", "o"];
const CODA = ["", "", "", "n", "r", "l", "s", "th", "x"];

/** Generated names for planets beyond the hand-picked list, in planet order (built on demand). */
const generated: string[] = [];

/**
 * Two names are too alike when they are one edit apart (Vael / Cael) or share their first three
 * letters (Wyre / Wyrin). Every planet name is distinct from every other by this rule.
 */
export function tooSimilar(a: string, b: string): boolean {
    a = a.toLowerCase();
    b = b.toLowerCase();
    if (a.slice(0, 3) === b.slice(0, 3)) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++)
            cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
        prev = cur;
    }
    return prev[b.length] < 2;
}

/** A pronounceable word from seed, retried with new seeds until it is distinct from all taken. */
function makeName(seed: number, taken: string[]): string {
    for (let attempt = 0; ; attempt++) {
        const r = rng(seed * 104729 + 7 + attempt * 7919);
        const pick = (a: string[]) => a[Math.floor(r() * a.length)];
        const syllables = attempt > 40 || r() < 0.4 ? 3 : 2; // longer words once short ones run out
        let word = "";
        for (let i = 0; i < syllables; i++)
            word += pick(i ? ONSET : FIRST) + pick(VOWEL) + (i === syllables - 1 ? pick(CODA) : "");
        word = word[0].toUpperCase() + word.slice(1);
        if (!taken.some((t) => tooSimilar(t, word))) return word;
    }
}

export function planetName(n: number): string {
    if (n >= 1 && n <= PLANET_NAMES.length) return PLANET_NAMES[n - 1];
    const k = Math.max(1, n) - PLANET_NAMES.length; // 1-based index into generated
    while (generated.length < k)
        generated.push(makeName(PLANET_NAMES.length + generated.length + 1, [...PLANET_NAMES, ...generated]));
    return generated[k - 1];
}

/** The daily planet's name: seeded by the date, distinct from every hand-picked planet name. */
export function dailyName(seed: number): string {
    return makeName(seed, PLANET_NAMES);
}
