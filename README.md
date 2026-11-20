# Thrust Force

A gravity-and-inertia cave shooter for the browser, built with Three.js, TypeScript and Vite. Steer a heavy little ship down a winding shaft into a hostile planet, latch onto the pod with your tractor beam, and haul it back out to space while it swings on its tow rod. Every gram of momentum is yours to manage: overshoot a turn and you meet the rock.

It takes its inspiration from the classic Amiga-era thrust-and-gravity games, such as Jeremy Smith's _Thrust_ (1986) and _Gravity Force_. The planets, art, sound and code here are all original.

## Highlights

- **Real inertia**: rotate, thrust and fight gravity that gets heavier on every planet. A slow, upright touchdown lands; anything else crashes.
- **Tow-rod physics**: the pod outweighs your ship and hangs on a rigid rod, so carrying it means swinging a pendulum through narrow tunnels.
- **Reactor gambit**: each hit on the reactor briefly stuns the turrets. Hit it enough times and it goes critical, leaving ten seconds to get out. Escape and the planet goes with it, for a big bonus.
- **Endless planets**: every level is generated from its number: deeper shafts, tighter turns, more turrets and stronger gravity. Planet 7 is the same for everyone.
- **Fuel matters**: thrust and shield both burn fuel. Hover over fuel cells with the tractor beam to refuel.
- **Neon voxel look**: 3D voxel rock with glowing edge lines, a light that rides with your ship, bloom, shadows, particle explosions and a palette per planet.
- **Synthesised sound**: every effect is generated live with WebAudio, so there are no audio files.
- **Runs everywhere**: desktop, laptop, tablet and phone. Quality adapts to the GPU (override with `?tier=high|mid|low`), and touch controls appear on touch screens.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5180/thrust-force/
```

Architecture and all technical detail are in [DESIGN.md](DESIGN.md).

## Controls

### Desktop

| Key                | Action                                                   |
| ------------------ | -------------------------------------------------------- |
| ← → · A D          | Rotate                                                   |
| ↑ · W              | Thrust                                                   |
| Space              | Fire                                                     |
| ↓ · S · Left Shift | Shield + tractor beam (grabs the pod, drains fuel cells) |
| Esc · P            | Pause / resume                                           |
| R (while paused)   | Restart                                                  |
| M                  | Sound on / off                                           |
| Enter              | Launch (splash) · Fly again (game over)                  |

### Touch / mobile

| Control                | Action                                       |
| ---------------------- | -------------------------------------------- |
| Left-half stick (drag) | Point the ship's nose in the stick direction |
| Stick pushed fully out | Thrust while steering                        |
| ▲                      | Thrust                                       |
| ●                      | Fire                                         |
| ◎                      | Shield + tractor beam                        |
| ❚❚                     | Pause                                        |

Tap the splash screen to launch. The stick appears wherever your left thumb lands.

## How to play

1. Fly down through the shaft. Turrets fire when they can see you; shoot them or keep your shield up.
2. Hover near the pod in the chamber and hold the shield/tractor to latch on.
3. Fly back up and out through the sky with the pod in tow.
4. Optionally, shoot the reactor until it goes critical, then race out before it blows.

## License

Released under the [MIT License](LICENSE).
