/**
 * Audio — tiny WebAudio synth: effects, a looping engine rumble and procedural music. No files.
 *
 * Purpose
 *   Gives every game event a sound and the game a soundtrack without shipping audio: effects
 *   are oscillators and one shared white-noise buffer; the music is sequenced live.
 *
 * Operations
 *   - unlock(): creates the AudioContext, a master gain feeding separate sfx and music gains,
 *     the 2 s noise buffer, the looping engine source (noise → 420 Hz low-pass), and starts the
 *     music scheduler; or resumes a suspended context.
 *   - tone() / noise(): an oscillator with pitch glide and decay; a noise slice through a
 *     low-pass that sweeps down to 60 Hz (explosion tails).
 *   - sfx: one entry per GameEvent.
 *   - setEngine(on): eases the engine gain (setTargetAtTime, no clicks).
 *   - Music: a look-ahead scheduler (every 25 ms, schedules 0.12 s ahead on the audio clock)
 *     plays a 4-bar minor progression (Am – F – C – G): a sawtooth bass on the beat through a
 *     low-pass, a quiet square arpeggio in 16ths, and noise hi-hats. setMusicIntensity(0..1)
 *     raises tempo (96 → 132 BPM), opens the filter and adds the hats; main.ts drives it from
 *     the reactor countdown.
 *   - setVolumes(music, sfx): 0..1 each (Options); toggleMute() / isMuted(): master on / off,
 *     persisted in localStorage 'tf-muted'.
 *   - suspendAudio(): idle; unlock() resumes.
 *   - UI sounds: sfx.uiMove (a soft tick when the menu highlight moves) and sfx.uiSelect (a chirp
 *     on select); sfx.shieldHit for a blocked shot.
 *
 * Usage
 *   main.ts: unlock() from a user gesture, sfx[event]() from Game.onEvent, setEngine() and
 *   setMusicIntensity() every frame, setVolumes() from Options.
 *
 * Highlights
 *   - Browsers block audio until a gesture: before unlock() every call is a silent no-op.
 *   - The scheduler uses the audio clock, not timers, for timing, so the beat stays steady even
 *     when frames hitch; it only schedules while the context is running.
 *
 * See also: main.ts (event routing), core/game.ts (GameEvent), core/save.ts (volumes); DESIGN.md "13. Audio".
 */
/** One sound per GameEvent (functions below are hoisted). */
export const sfx = {
    shoot: () => tone(1200, 0.07, "square", 0.05, 500),
    enemyShoot: () => tone(320, 0.12, "sawtooth", 0.04, 160),
    hit: () => noise(0.08, 0.15, 3000),
    boom: () => noise(0.5, 0.45, 1800),
    bigBoom: () => (noise(1.6, 0.7, 900), tone(90, 1.2, "sine", 0.4, 30)),
    attach: () => tone(300, 0.3, "triangle", 0.15, 900),
    fuel: () => tone(600, 0.25, "sine", 0.15, 1400),
    land: () => noise(0.12, 0.15, 500),
    alarm: () => tone(980, 0.18, "square", 0.06, 700),
    critical: () => tone(200, 0.8, "sawtooth", 0.15, 1200),
    complete: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.25, "triangle", 0.12), i * 110)),
    extra: () => [784, 1046, 1318].forEach((f, i) => setTimeout(() => tone(f, 0.15, "square", 0.06), i * 90)),
    checkpoint: () => [660, 990].forEach((f, i) => setTimeout(() => tone(f, 0.12, "sine", 0.1), i * 70)),
    pad: () => tone(440, 0.3, "sine", 0.08, 880),
    shieldHit: () => (tone(1500, 0.1, "triangle", 0.06, 2200), noise(0.06, 0.08, 6000)),
    uiMove: () => tone(1320, 0.035, "sine", 0.035, 1500),
    uiSelect: () => tone(660, 0.09, "triangle", 0.07, 1320),
    gameover: () => tone(400, 1.4, "triangle", 0.15, 80),
};

const ROOTS = [57, 53, 48, 55]; // A3, F3, C3, G3 (MIDI): Am – F – C – G
const CHORD = [0, 3, 7, 12]; // minor-ish arpeggio shape over each root

let ctx: AudioContext | null = null;
let master: GainNode;
let sfxBus: GainNode;
let musicBus: GainNode;
let noiseBuf: AudioBuffer;
let engine: GainNode;
let muted = localStorage.getItem("tf-muted") === "1";
let musicVol = 0.5,
    sfxVol = 1;
// Music sequencer state (see the Music section).
let intensity = 0;
let nextNote = 0;
let sixteenth = 0;

export function unlock() {
    if (ctx) return void ctx.resume();
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.6;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = sfxVol;
    musicBus = ctx.createGain();
    musicBus.gain.value = musicVol * 0.5;
    sfxBus.connect(master);
    musicBus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    engine = ctx.createGain();
    engine.gain.value = 0;
    src.connect(lp).connect(engine).connect(sfxBus);
    src.start();
    nextNote = ctx.currentTime + 0.1;
    setInterval(schedule, 25);
}

export function toggleMute() {
    muted = !muted;
    localStorage.setItem("tf-muted", muted ? "1" : "0");
    if (ctx) master.gain.value = muted ? 0 : 0.6;
    return muted;
}

export const isMuted = () => muted;

export function setVolumes(music: number, effects: number) {
    musicVol = music;
    sfxVol = effects;
    if (!ctx) return;
    musicBus.gain.setTargetAtTime(music * 0.5, ctx.currentTime, 0.05);
    sfxBus.gain.setTargetAtTime(effects, ctx.currentTime, 0.05);
}

export function setEngine(on: boolean) {
    if (ctx) engine.gain.setTargetAtTime(on ? 0.35 : 0, ctx.currentTime, 0.04);
}

function tone(freq: number, dur: number, type: OscillatorType, vol: number, to = freq, at = 0, bus = sfxBus) {
    if (!ctx) return;
    const t = at || ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + dur);
}

function noise(dur: number, vol: number, cutoff: number, at = 0, bus = sfxBus) {
    if (!ctx) return;
    const t = at || ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(cutoff, t);
    lp.frequency.exponentialRampToValueAtTime(60, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(lp).connect(g).connect(bus);
    src.start(t, Math.random());
    src.stop(t + dur);
}

/** Idle: suspend the AudioContext (stops all audio work); unlock() resumes it. */
export function suspendAudio() {
    if (ctx && ctx.state === "running") void ctx.suspend();
}

// ---- Music ------------------------------------------------------------------------------------

/** MIDI note number → frequency in Hz. */
function midi(m: number) {
    return 440 * 2 ** ((m - 69) / 12);
}

/** 0 = calm, 1 = reactor critical: faster, brighter, with hi-hats. */
export function setMusicIntensity(v: number) {
    intensity += (Math.min(1, Math.max(0, v)) - intensity) * 0.05;
}

function schedule() {
    if (!ctx || ctx.state !== "running" || musicVol <= 0) return;
    const bpm = 96 + 36 * intensity;
    const step = 60 / bpm / 4;
    while (nextNote < ctx.currentTime + 0.12) {
        const bar = Math.floor(sixteenth / 16) % 4;
        const s = sixteenth % 16;
        const root = ROOTS[bar];
        if (s % 4 === 0) tone(midi(root - 12), step * 3.5, "sawtooth", 0.09, midi(root - 12), nextNote, musicBus);
        const third = bar === 0 ? 3 : 4; // minor on Am, major on the others
        const shape = [0, third, 7, 12];
        const note = root + 12 + (shape[s % 4] ?? CHORD[s % 4]);
        tone(midi(note), step * 0.9, "square", 0.018 + 0.012 * intensity, midi(note), nextNote, musicBus);
        if (intensity > 0.4 && s % 2 === 1) noise(0.04, 0.05 * intensity, 7000, nextNote, musicBus);
        nextNote += step;
        sixteenth++;
    }
}
