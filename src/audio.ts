/**
 * Audio — tiny WebAudio synth: blips, noise bursts and a looping engine rumble, no asset files.
 *
 * Purpose
 *   Gives every game event a sound without shipping audio files: all effects are synthesised
 *   at runtime from oscillators and one shared white-noise buffer.
 *
 * Operations
 *   - unlock(): creates the AudioContext, master gain, the 2 s noise buffer and the looping
 *     engine source (noise → 420 Hz low-pass → gain), or resumes a suspended context.
 *   - tone(freq, dur, type, vol, to): oscillator with exponential pitch glide and decay.
 *   - noise(dur, vol, cutoff): a random slice of the noise buffer through a low-pass that sweeps
 *     down to 60 Hz, which gives explosions their tail.
 *   - sfx: one entry per GameEvent (shoot, boom, bigBoom, attach, alarm, complete, ...).
 *   - setEngine(on): eases the engine gain to 0.35 or 0 (setTargetAtTime, no clicks).
 *   - toggleMute() / isMuted(): master gain 0 / 0.6, persisted in localStorage 'tf-muted'.
 *
 * Usage
 *   main.ts calls unlock() from a user gesture (launch / resume), sfx[event]() from
 *   Game.onEvent, and setEngine(game.thrusting) every frame.
 *
 * Highlights
 *   - Browsers block audio until a gesture: before unlock() every call is a silent no-op, so
 *     callers never need to check.
 *   - sfx keys match GameEvent names exactly, so routing is sfx[e]?.().
 *
 * See also: main.ts (event routing), game.ts (GameEvent); DESIGN.md "11. Audio".
 */
let ctx: AudioContext | null = null;
let master: GainNode;
let noiseBuf: AudioBuffer;
let engine: GainNode;
let muted = localStorage.getItem('tf-muted') === '1';

export function unlock() {
    if (ctx) return void ctx.resume();
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.6;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    engine = ctx.createGain();
    engine.gain.value = 0;
    src.connect(lp).connect(engine).connect(master);
    src.start();
}

export function toggleMute() {
    muted = !muted;
    localStorage.setItem('tf-muted', muted ? '1' : '0');
    if (ctx) master.gain.value = muted ? 0 : 0.6;
    return muted;
}

export function setEngine(on: boolean) {
    if (ctx) engine.gain.setTargetAtTime(on ? 0.35 : 0, ctx.currentTime, 0.04);
}

function tone(freq: number, dur: number, type: OscillatorType, vol: number, to = freq) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur);
}

function noise(dur: number, vol: number, cutoff: number) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cutoff, t);
    lp.frequency.exponentialRampToValueAtTime(60, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(lp).connect(g).connect(master);
    src.start(t, Math.random());
    src.stop(t + dur);
}

export const sfx = {
    shoot: () => tone(1200, 0.07, 'square', 0.05, 500),
    enemyShoot: () => tone(320, 0.12, 'sawtooth', 0.04, 160),
    hit: () => noise(0.08, 0.15, 3000),
    boom: () => noise(0.5, 0.45, 1800),
    bigBoom: () => (noise(1.6, 0.7, 900), tone(90, 1.2, 'sine', 0.4, 30)),
    attach: () => tone(300, 0.3, 'triangle', 0.15, 900),
    fuel: () => tone(600, 0.25, 'sine', 0.15, 1400),
    land: () => noise(0.12, 0.15, 500),
    alarm: () => tone(980, 0.18, 'square', 0.06, 700),
    critical: () => tone(200, 0.8, 'sawtooth', 0.15, 1200),
    complete: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.25, 'triangle', 0.12), i * 110)),
    extra: () => [784, 1046, 1318].forEach((f, i) => setTimeout(() => tone(f, 0.15, 'square', 0.06), i * 90)),
    gameover: () => tone(400, 1.4, 'triangle', 0.15, 80),
};

export const isMuted = () => muted;
