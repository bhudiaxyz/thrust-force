# Thrust Force

A gravity-and-inertia cave shooter for the browser, built with Three.js, TypeScript and Vite. Steer a heavy little ship down a winding shaft into a hostile planet, latch onto the pod with your tractor beam, and haul it back out to space while it swings on its tow rod. Every gram of momentum is yours to manage: overshoot a turn and you meet the rock.

It takes its inspiration from the classic Commodore Amiga-era thrust-and-gravity games, primarily Jeremy Smith's _Thrust_ (1986) and Stephan Wenzler's _Gravity Force_ (1989). Its look borrows from _Tron_ (1982), for the glowing neon lines that trace dark geometry, and from _Minecraft_ (2009), for the voxel blocks and pixel-art rock textures. The planets, art, sound and code here are all original.

## Highlights

- **Real inertia**: rotate, thrust and fight gravity. A slow, upright touchdown lands; anything else crashes.
- **Tow-rod physics**: the pod outweighs your ship and hangs on a rigid rod, so carrying it means swinging a pendulum through the tunnels.
- **Reactor gambit**: each hit on the reactor briefly stuns the turrets. Hit it enough times and it goes critical, leaving ten seconds to get out. Escape and the planet goes with it, for a big bonus.
- **A gentle start, a long climb**: planet 1 is roomy, light and lightly defended. Over 50 planets, gravity grows, the shafts get deeper and twistier with dead ends, loops and open caverns, and the turrets multiply and sharpen their aim.
- **New threats as you go**: homing mines from planet 8, cycling laser gates from planet 15, turrets that lead their shots from planet 20, and reversed gravity on every 10th planet, where you land upside down on ceilings.
- **Checkpoints and landing pads**: glowing beacons at each switchback become your respawn point, and gentle touchdowns on green pads refuel you.
- **Medals and planet select**: earn up to three stars per planet (pod recovered, reactor destroyed, beating par time), then replay any planet you've unlocked, racing a translucent ghost of your best run.
- **Daily planet**: a fresh layout every day, the same for everyone, with your best score for the day kept.
- **Every planet has its own name and look**: _Planet 1: Avren_, _Planet 2: Kesra_ and so on, each with one of 24 colour themes.
- **Voxel geology**: rock is built from pixel-art blocks (topsoil, gravel, strata, cobble, stone and basalt), with glowing ore veins and crystals in the cave walls.
- **Neon voxel look**: glowing edge lines, a light that rides with your ship, bloom, shadows and dramatic voxel explosions with tumbling embers and shockwaves.
- **Minimap**: the whole planet in the corner, with you, the pod, the reactor, turrets and fuel. It folds away to an icon on small screens.
- **Fuel matters**: thrust and shield both burn fuel. Land on pads, or hover over fuel cells with the tractor beam, to refuel.
- **Synthesised sound and music**: every effect and a procedural soundtrack, which speeds up when the reactor goes critical, are generated live with WebAudio. There are no audio files.
- **Menus that work everywhere**: main menu, planet select, options, a three-page how-to, planet intro cards, end-of-planet summaries and game-over stats with sharing, all usable by mouse, keyboard, touch or gamepad.
- **Options and assists**: music and effects volume, quality override, stick sensitivity, a left-handed touch layout, colour-blind-friendly minimap markers, hints, and assists (slower game, auto-levelling, free shield) to make it easier.
- **Gamepads and haptics**: standard gamepads fly the ship and drive the menus; Android phones vibrate on crashes, landings and lock-ons.
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
| R (while paused)   | Restart planet                                           |
| Q (while paused)   | Main menu                                                |
| M                  | Sound on / off                                           |
| N                  | Minimap on / off                                         |
| ↑ ↓ · Enter · Esc  | Move · choose · back, in menus                           |
| Enter (game over)  | Fly again                                                |

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

Every menu is tappable. The stick appears wherever your left thumb lands; the left-handed option in Options mirrors the layout.

### Gamepad

| Control                      | Action                                        |
| ---------------------------- | --------------------------------------------- |
| Left stick                   | Point the nose (pushed fully: thrust as well) |
| D-pad ← →                    | Rotate                                        |
| A · right trigger            | Thrust                                        |
| X · right bumper             | Fire                                          |
| B · left trigger             | Shield + tractor beam                         |
| Start                        | Pause / resume                                |
| D-pad ↑ ↓ · A · B (in menus) | Move · choose · back                          |

## How to play

1. Fly down through the shaft. Turrets fire when they can see you; shoot them or keep your shield up.
2. Hover near the pod in the chamber and hold the shield/tractor to latch on.
3. Fly back up and out through the sky with the pod in tow.
4. Optionally, shoot the reactor until it goes critical, then race out before it blows.
5. Beat the par time for the third star. Glowing beacons are checkpoints; green pads refuel you.

## License

Released under the [MIT License](LICENSE).
