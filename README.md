# Thrust Force

A gravity-and-inertia cave shooter for the browser, built with Three.js, TypeScript and Vite. Steer a heavy little ship down a winding shaft into a hostile planet, latch onto the pod with your tractor beam, and haul it back out to space while it swings on its tow rod. Every gram of momentum is yours to manage: overshoot a turn and you meet the rock.

It takes its inspiration from the classic Commodore Amiga-era thrust-and-gravity games, primarily Jeremy Smith's _Thrust_ (1986) and Stephan Wenzler's _Gravity Force_ (1989). Its look borrows from _Tron_ (1982), for the glowing neon lines that trace dark geometry, and from _Minecraft_ (2009), for the voxel blocks and pixel-art rock textures. The planets, art, sound and code here are all original.

## Highlights

- **Real inertia**: rotate, thrust and fight gravity. A slow, upright touchdown lands; anything else crashes.
- **Tow-rod physics**: the pod outweighs your ship and hangs on a rigid rod, so carrying it means swinging a pendulum through the tunnels.
- **Reactor gambit**: each hit on the reactor briefly stuns the turrets. Hit it enough times and it goes critical, leaving ten seconds to get out. Escape and the planet goes with it, for a big bonus.
- **A gentle start, a long climb**: planet 1 is roomy, light and lightly defended. Over 50 planets, gravity grows, the shafts get deeper and twistier with dead ends, loops and open caverns, and the turrets multiply and sharpen their aim.
- **Every planet has its own name and look**: _Planet 1: Avren_, _Planet 2: Kesra_ and so on, each with one of 24 colour themes.
- **Voxel geology**: rock is built from pixel-art blocks (topsoil, gravel, strata, cobble, stone and basalt), with glowing ore veins and crystals in the cave walls.
- **Neon voxel look**: glowing edge lines, a light that rides with your ship, bloom, shadows and dramatic voxel explosions with tumbling embers and shockwaves.
- **Minimap**: the whole planet in the corner, with you, the pod, the reactor, turrets and fuel. It folds away to an icon on small screens.
- **Fuel matters**: thrust and shield both burn fuel. Hover over fuel cells with the tractor beam to refuel.
- **Synthesised sound**: every effect is generated live with WebAudio, so there are no audio files.
- **Runs everywhere**: desktop, laptop, tablet and phone, including devices about 7 years old. Quality adapts to the GPU and steps itself down if frames run slow. Override it with `?tier=high|mobile-high|mid|low`.

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
| N                  | Minimap on / off                                         |
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
| Map icon               | Open / close the minimap                     |

Tap the splash screen to launch. The stick appears wherever your left thumb lands.

## How to play

1. Fly down through the shaft. Turrets fire when they can see you; shoot them or keep your shield up.
2. Hover near the pod in the chamber and hold the shield/tractor to latch on.
3. Fly back up and out through the sky with the pod in tow.
4. Optionally, shoot the reactor until it goes critical, then race out before it blows.

## License

Released under the [MIT License](LICENSE).
