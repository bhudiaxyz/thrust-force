/**
 * Game — rules, physics and state for one play session (ship, pod, bullets, reactor, score).
 *
 * Purpose
 *   The simulation. The ship rotates, thrusts against gravity and keeps its momentum. Holding
 *   SHIELD both protects from bullets and works the tractor beam: near the pod it latches the
 *   pod onto a rigid tow rod, near a fuel cell it drains fuel. Turrets shoot when they can see
 *   the ship. Shooting the reactor stuns the turrets; enough hits make it go critical and start
 *   a countdown. Leaving through the sky with the pod (or with the reactor critical) completes
 *   the planet and loads the next.
 *
 * Operations
 *   - update(dt, input): accumulates real time (capped 0.25 s) and runs fixed 1/120 s step()s.
 *   - step(): phase timers (dead → respawn / reload, complete → next planet, over) → flight
 *     (rotate, fuel burn, thrust, gravity, drag) → pod integration + rod() → tractor beam →
 *     firing → turrets → reactor countdown → collisions (crash or land) → exit check.
 *     moveBullets() runs every step, even in the pause phases, so shots finish naturally.
 *   - rod(a, ma, b, mb, len): rigid distance constraint, position + velocity projection
 *     weighted by inverse mass (exported for the check).
 *   - hull(x, y, a): the six world-space hull points used for rock collision.
 *   - Death: crash (hull point in rock, unless a slow, upright, rear-only touchdown, which
 *     lands), attached pod in rock, turret/reactor contact, unshielded bullet hit, or the
 *     reactor blowing while still below. Respawn is at the entrance; if the reactor was
 *     critical the level is rebuilt.
 *
 * Usage
 *   const g = new Game(1); g.onEvent = (e, x, y) => ...; each frame g.update(dt, input), then
 *   read g.ship, g.pod, g.bullets, g.level, g.phase, g.fuel, g.score... for drawing. main.ts
 *   owns the instance; view.ts only reads it.
 *
 * Highlights
 *   - Pure: no three.js or DOM; scripts/check.ts drives it headless.
 *   - Input is five booleans (Input); devices are main.ts's problem.
 *   - Effects leave only through onEvent(GameEvent, x, y): one callback, routed by main.ts to
 *     sound and particles.
 *   - The rod length is the distance at the moment of grabbing (min 2), so latching never yanks
 *     a resting pod into the floor.
 *   - All feel constants are in CFG.
 *
 * See also: level.ts, main.ts, view.ts, scripts/check.ts; DESIGN.md "6. Game rules and physics"
 * and "15. Tuning reference".
 */
import { generateLevel, lineOfSight, solidAt, type Level, type Pt } from "./level";

export interface Input {
    left: boolean;
    right: boolean;
    thrust: boolean;
    fire: boolean;
    shield: boolean;
}
export interface Body {
    x: number;
    y: number;
    vx: number;
    vy: number;
}
export interface Bullet extends Body {
    life: number;
    enemy: boolean;
}
export type GameEvent =
    | "shoot"
    | "enemyShoot"
    | "hit"
    | "boom"
    | "bigBoom"
    | "attach"
    | "fuel"
    | "land"
    | "alarm"
    | "critical"
    | "complete"
    | "extra"
    | "gameover";
export type Phase = "play" | "dead" | "complete" | "over";

export const CFG = {
    thrust: 15,
    turn: 4.3,
    drag: 0.04,
    fuelMax: 100,
    thrustBurn: 4.5,
    shieldBurn: 8,
    rodLen: 4.5,
    podMass: 1.6,
    grab: 5.5,
    bulletSpeed: 24,
    reload: 0.17,
    reactorTime: 10,
    stun: 4,
};
const STEP = 1 / 120;

// Ship hull in local space (nose up): nose, nose-side midpoints, then bottom corners and middle.
const HULL: [number, number][] = [
    [0, 0.95],
    [-0.35, 0.15],
    [0.35, 0.15],
    [-0.7, -0.6],
    [0.7, -0.6],
    [0, -0.4],
];

export function hull(x: number, y: number, a: number): [number, number][] {
    const c = Math.cos(a),
        s = Math.sin(a);
    return HULL.map(([hx, hy]) => [x + hx * c - hy * s, y + hx * s + hy * c]);
}

/** Rigid rod between two bodies: positional and velocity correction weighted by inverse mass. */
export function rod(a: Body, ma: number, b: Body, mb: number, len: number) {
    const dx = b.x - a.x,
        dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    const nx = dx / d,
        ny = dy / d;
    const wa = 1 / ma,
        wb = 1 / mb;
    const corr = (d - len) / (wa + wb);
    a.x += nx * corr * wa;
    a.y += ny * corr * wa;
    b.x -= nx * corr * wb;
    b.y -= ny * corr * wb;
    const j = ((b.vx - a.vx) * nx + (b.vy - a.vy) * ny) / (wa + wb);
    a.vx += nx * j * wa;
    a.vy += ny * j * wa;
    b.vx -= nx * j * wb;
    b.vy -= ny * j * wb;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export class Game {
    level!: Level;
    levelNo = 1;
    score = 0;
    lives = 3;
    fuel = CFG.fuelMax;
    phase: Phase = "play";
    phaseTimer = 0;
    ship = { x: 0, y: 0, vx: 0, vy: 0, a: 0 };
    pod = { x: 0, y: 0, vx: 0, vy: 0, attached: false, len: CFG.rodLen };
    bullets: Bullet[] = [];
    thrusting = false;
    shielding = false;
    beam: Pt | null = null;
    reactorHp = 0;
    critical = -1; // seconds left, < 0 when the reactor is stable
    stun = 0;
    message = "";
    messageTime = 0;
    onEvent: (e: GameEvent, x: number, y: number) => void = () => {};
    private reload = 0;
    private acc = 0;
    private nextExtra = 10000;
    private resetLevel = false;
    private lastAlarm = 0;
    private nagTime = 0;

    constructor(levelNo = 1) {
        this.load(levelNo);
    }

    load(n: number) {
        this.levelNo = n;
        this.level = generateLevel(n);
        this.reactorHp = this.level.reactorHp;
        this.critical = -1;
        this.stun = 0;
        this.pod = { ...this.level.pod, vx: 0, vy: 0, attached: false, len: CFG.rodLen };
        this.respawn();
        this.say(`Planet ${n}: ${this.level.name} — gravity ${this.level.gravity.toFixed(1)}`, 3);
    }

    respawn() {
        const s = this.level.start;
        this.ship = { x: s.x, y: s.y, vx: 0, vy: 0, a: 0 };
        if (this.pod.attached) this.pod = { ...this.level.pod, vx: 0, vy: 0, attached: false, len: CFG.rodLen };
        this.fuel = Math.max(this.fuel, 40);
        this.bullets = [];
        this.phase = "play";
    }

    say(msg: string, t = 2.5) {
        this.message = msg;
        this.messageTime = t;
    }

    update(dt: number, input: Input) {
        this.acc = Math.min(this.acc + dt, 0.25);
        while (this.acc >= STEP) {
            this.acc -= STEP;
            this.step(STEP, input);
        }
    }

    private emit(e: GameEvent, p: Pt) {
        this.onEvent(e, p.x, p.y);
    }

    private addScore(v: number) {
        this.score += v;
        if (this.score >= this.nextExtra) {
            this.nextExtra += 10000;
            this.lives++;
            this.say("Extra ship!");
            this.emit("extra", this.ship);
        }
    }

    private die() {
        if (this.phase !== "play") return;
        this.emit("bigBoom", this.ship);
        if (this.pod.attached) this.emit("boom", this.pod);
        this.lives--;
        this.phase = "dead";
        this.phaseTimer = 2.2;
        this.thrusting = this.shielding = false;
        this.beam = null;
        if (this.critical >= 0) this.resetLevel = true;
    }

    private step(h: number, inp: Input) {
        const lv = this.level,
            s = this.ship,
            pod = this.pod;
        this.messageTime -= h;
        this.moveBullets(h);

        if (this.phase !== "play") {
            if (this.phase === "over" || (this.phaseTimer -= h) > 0) return;
            if (this.phase === "complete") return this.load(this.levelNo + 1);
            if (this.lives <= 0) {
                this.phase = "over";
                this.emit("gameover", s);
                return;
            }
            if (this.resetLevel) {
                this.resetLevel = false;
                return this.load(this.levelNo);
            }
            return this.respawn();
        }

        // Flight.
        if (inp.left) s.a += CFG.turn * h;
        if (inp.right) s.a -= CFG.turn * h;
        this.thrusting = inp.thrust && this.fuel > 0;
        this.shielding = inp.shield && this.fuel > 0;
        this.fuel = Math.max(
            0,
            this.fuel - ((this.thrusting ? CFG.thrustBurn : 0) + (this.shielding ? CFG.shieldBurn : 0)) * h
        );
        const t = this.thrusting ? CFG.thrust : 0;
        s.vx += -Math.sin(s.a) * t * h;
        s.vy += (Math.cos(s.a) * t - lv.gravity) * h;
        s.vx *= 1 - CFG.drag * h;
        s.vy *= 1 - CFG.drag * h;
        s.x += s.vx * h;
        s.y += s.vy * h;
        if (pod.attached) {
            pod.vy -= lv.gravity * h;
            pod.x += pod.vx * h;
            pod.y += pod.vy * h;
            rod(s, 1, pod, CFG.podMass, pod.len);
        }

        // Tractor beam.
        this.beam = null;
        if (this.shielding) {
            if (!pod.attached && dist(s, pod) < CFG.grab) {
                // The rod takes the grab distance as its length, so latching on never yanks the
                // pod into the floor or the ship into the pod.
                pod.attached = true;
                pod.vx = pod.vy = 0;
                pod.len = Math.max(2, dist(s, pod));
                this.say("Pod locked on — get it out!");
                this.emit("attach", pod);
            }
            for (const f of lv.fuel) {
                if (f.amount <= 0 || f.y > s.y || dist(s, f) > 4.5) continue;
                const take = Math.min(f.amount, 40 * h, CFG.fuelMax - this.fuel);
                f.amount -= take;
                this.fuel += take;
                this.beam = f;
                if (f.amount <= 0) {
                    this.addScore(300);
                    this.emit("fuel", f);
                }
                break;
            }
        }

        // Firing.
        this.reload -= h;
        if (inp.fire && this.reload <= 0) {
            this.reload = CFG.reload;
            const [nx, ny] = hull(s.x, s.y, s.a)[0];
            const dx = -Math.sin(s.a),
                dy = Math.cos(s.a);
            this.bullets.push({
                x: nx,
                y: ny,
                vx: s.vx + dx * CFG.bulletSpeed,
                vy: s.vy + dy * CFG.bulletSpeed,
                life: 1.4,
                enemy: false,
            });
            this.emit("shoot", s);
        }

        // Turrets.
        this.stun -= h;
        if (this.stun <= 0) {
            for (const tu of lv.turrets) {
                if (!tu.alive || (tu.cooldown -= h) > 0) continue;
                tu.cooldown = lv.diff.turretInterval * (0.7 + Math.random() * 0.6);
                const dx = s.x - tu.x,
                    dy = s.y - tu.y;
                const d = Math.hypot(dx, dy);
                if (d > lv.diff.turretRange || (tu.up ? dy < -0.5 : dy > 0.5) || !lineOfSight(lv, tu, s)) continue;
                const ang = Math.atan2(dy, dx) + (Math.random() - 0.5) * 2 * lv.diff.aimSpread;
                const sp = lv.diff.bulletSpeed;
                this.bullets.push({
                    x: tu.x + Math.cos(ang) * 0.8,
                    y: tu.y + Math.sin(ang) * 0.8,
                    vx: Math.cos(ang) * sp,
                    vy: Math.sin(ang) * sp,
                    life: 3,
                    enemy: true,
                });
                this.emit("enemyShoot", tu);
            }
        }

        // Reactor countdown.
        if (this.critical >= 0) {
            this.critical -= h;
            if (Math.ceil(this.critical) !== this.lastAlarm) {
                this.lastAlarm = Math.ceil(this.critical);
                this.emit("alarm", lv.reactor);
            }
            if (this.critical <= 0) {
                this.critical = 0;
                this.emit("bigBoom", lv.reactor);
                this.say("The planet is gone.");
                this.die();
                return;
            }
        }

        // Collisions: ship and pod against rock and fixtures.
        const pts = hull(s.x, s.y, s.a);
        const hits = pts.map(([x, y]) => solidAt(lv, x, y));
        if (hits.some(Boolean)) {
            const gentle = Math.hypot(s.vx, s.vy) < 5 && Math.abs(wrap(s.a)) < 0.45 && s.vy <= 0.5;
            if (!gentle || hits[0] || hits[1] || hits[2]) return this.die();
            for (let k = 0; k < 60 && hull(s.x, s.y, s.a).some(([x, y]) => solidAt(lv, x, y)); k++) s.y += 0.02;
            if (s.vy < -1) this.emit("land", s);
            s.vy = 0;
            s.vx *= 0.9;
            s.a *= 0.92;
        }
        for (const tu of lv.turrets) if (tu.alive && dist(s, tu) < 1.3) return this.die();
        if (dist(s, lv.reactor) < 2.4) return this.die();
        if (pod.attached) {
            for (let k = 0; k < 8; k++) {
                const a = (k / 8) * Math.PI * 2;
                if (solidAt(lv, pod.x + Math.cos(a) * 0.55, pod.y + Math.sin(a) * 0.55)) return this.die();
            }
        }

        // Exit through the sky.
        if (s.y > lv.exitY) {
            if (pod.attached || this.critical >= 0) {
                let bonus = 0;
                if (pod.attached) bonus += 4000 + 500 * lv.n;
                if (this.critical >= 0) bonus += 3000 + 500 * lv.n;
                this.addScore(bonus);
                this.say(
                    `${pod.attached ? "Pod recovered" : "Mission complete"}${this.critical >= 0 ? " — planet destroyed" : ""}  +${bonus}`,
                    3
                );
                if (this.critical >= 0) this.emit("bigBoom", lv.reactor);
                this.phase = "complete";
                this.phaseTimer = 3.2;
                this.critical = -1;
                this.emit("complete", s);
            } else if (s.y > lv.exitY + 2) {
                s.y = lv.exitY + 2;
                s.vy = Math.min(s.vy, 0);
                if ((this.nagTime -= h) <= 0) {
                    this.say("Recover the pod first");
                    this.nagTime = 2;
                }
            }
        }
    }

    private moveBullets(h: number) {
        const lv = this.level,
            s = this.ship;
        const keep = (b: Bullet): boolean => {
            b.x += b.vx * h;
            b.y += b.vy * h;
            if ((b.life -= h) <= 0) return false;
            if (solidAt(lv, b.x, b.y)) {
                this.emit("hit", b);
                return false;
            }
            if (b.enemy) {
                if (this.phase !== "play" || dist(b, s) > 1) return true;
                if (!this.shielding) this.die();
                return false;
            }
            for (const tu of lv.turrets)
                if (tu.alive && dist(b, tu) < 0.9) {
                    tu.alive = false;
                    this.addScore(750);
                    this.emit("boom", tu);
                    return false;
                }
            for (const f of lv.fuel)
                if (f.amount > 0 && dist(b, f) < 0.8) {
                    f.amount = 0;
                    this.addScore(150);
                    this.emit("boom", f);
                    return false;
                }
            const r = lv.reactor;
            if (dist(b, { x: r.x, y: r.y + 1 }) < 1.8) {
                this.emit("hit", b);
                if (this.critical < 0) {
                    this.stun = CFG.stun;
                    this.addScore(50);
                    if (--this.reactorHp <= 0) {
                        this.critical = CFG.reactorTime;
                        this.lastAlarm = 0;
                        this.say("Reactor critical — get out!", 3);
                        this.emit("critical", r);
                    }
                }
                return false;
            }
            return true;
        };
        // In-place compaction (no new array 120 times a second).
        let live = 0;
        for (const b of this.bullets) if (keep(b)) this.bullets[live++] = b;
        this.bullets.length = live;
    }
}
