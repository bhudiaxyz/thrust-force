/**
 * Names — a single-word name for every planet.
 *
 * Purpose
 *   Gives each planet an identity ("Planet 1: Avren") shown in the arrival message, the HUD and
 *   the pause / game-over dialog. Names are invented words, one word each, no spaces.
 *
 * Operations
 *   - PLANET_NAMES: 50 hand-picked names, one per planet up to full difficulty
 *     (MAX_DIFFICULTY_AT in level.ts).
 *   - planetName(n): PLANET_NAMES[n - 1] for planets 1..50; beyond that a seeded syllable
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
 *   - scripts/check.ts asserts the 50 are unique and every name is a single capitalised word.
 *
 * See also: level.ts, game.ts (arrival message), main.ts (HUD, pause); DESIGN.md "5".
 */
import { rng } from './random';

export const PLANET_NAMES = [
    'Avren', 'Kesra', 'Vael', 'Orin', 'Tamsk', 'Ilva', 'Zerith', 'Quell', 'Moru', 'Saphe',
    'Drav', 'Lunek', 'Ostra', 'Pellin', 'Ravik', 'Sidra', 'Thune', 'Vesk', 'Wyre', 'Xarn',
    'Yllin', 'Zoma', 'Arvo', 'Belk', 'Corra', 'Dimmet', 'Eskar', 'Fenn', 'Gorrim', 'Halvi',
    'Iskel', 'Jarrow', 'Lorne', 'Merrow', 'Osk', 'Prell', 'Rhune', 'Skelda', 'Torva', 'Umbrel',
    'Vantor', 'Wexa', 'Zell', 'Ashkar', 'Brannoc', 'Cindra', 'Delvo', 'Maro', 'Tesk', 'Kordo',
];

// Clusters (th, dr, ...) only start a word; later syllables use single consonants, so names
// stay pronounceable.
const FIRST = ['b', 'd', 'k', 'l', 'm', 'n', 'r', 's', 't', 'v', 'z', 'th', 'dr', 'kr', 'st'];
const ONSET = ['b', 'd', 'k', 'l', 'm', 'n', 'r', 's', 't', 'v', 'z'];
const VOWEL = ['a', 'e', 'i', 'o', 'u', 'a', 'e', 'o'];
const CODA = ['', '', '', 'n', 'r', 'l', 's', 'th', 'x'];

export function planetName(n: number): string {
    if (n >= 1 && n <= PLANET_NAMES.length) return PLANET_NAMES[n - 1];
    const r = rng(n * 104729 + 7);
    const pick = (a: string[]) => a[Math.floor(r() * a.length)];
    const syllables = r() < 0.6 ? 2 : 3;
    let word = '';
    for (let i = 0; i < syllables; i++)
        word += pick(i ? ONSET : FIRST) + pick(VOWEL) + (i === syllables - 1 ? pick(CODA) : '');
    return word[0].toUpperCase() + word.slice(1);
}
