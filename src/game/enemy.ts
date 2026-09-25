/**
 * The horde.
 *
 * Every enemy is a tiny state machine: walk in from outside, tear the boards off
 * a window, climb through, then hunt the player and swing.
 *
 * Hunting thinks a few times a second and moves every frame. With the player
 * in plain sight (checked with a ray down the middle and one along each
 * shoulder, so a body never tries to squeeze past a corner it cannot fit
 * round) it walks straight at them. Otherwise it follows the shared flow field,
 * looking a few tiles ahead and heading for the farthest point it can reach in
 * a straight line, so paths cut corners smoothly instead of stepping tile by
 * tile. A body that stops making progress steps to the best neighbouring tile;
 * one that has been lost far away and out of sight for too long is recycled
 * back to a window near the player, so the horde never loses interest.
 *
 * Hits have weight: a spring-driven flinch away from the shot, a head snap on
 * headshots, a short stagger and a shove. Deaths are animated - thrown back,
 * pitched forward, buckling at the knees, or launched by an explosion - and the
 * body stays down for a couple of seconds before it sinks away.
 */

import * as THREE from 'three';
import { NavGrid } from '../world/grid.ts';
import { TILE, tileCenter, worldToTile } from '../world/mapdata.ts';
import { buildHound, buildZombie, type Outfit, type ZombieModel } from '../gfx/models.ts';
import { Rng } from '../core/rng.ts';
import { enemyDamage, enemySpeed, type EnemyKind } from './rules.ts';
import type { BarricadeProp } from '../world/props.ts';

export type EnemyState = 'idle' | 'approach' | 'breach' | 'climb' | 'hunt' | 'attack' | 'dead';

export type DeathKind = 'back' | 'forward' | 'crumple' | 'launch' | 'gib';

/** Where a zombie stands to tear boards: inside the window reveal, near the outer face. */
const WINDOW_STAND = 0.5;

/** How long a body lies on the floor before it sinks away. */
const LIE_TIME = 1.7;
const SINK_TIME = 0.9;

/** Out of sight and this far away for this long: recycle to a nearer window. */
const LOST_DISTANCE = 30;
const LOST_SECONDS = 6;

export type HitResult = {
  killed: boolean;
  head: boolean;
  gibbed: boolean;
  /** A headshot kill took the head clean off. */
  headless: boolean;
  damageDealt: number;
};

const HALF_PI = Math.PI / 2;

function ease(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

export class Enemy {
  readonly model: ZombieModel;
  kind: EnemyKind = 'walker';
  active = false;

  x = 0;
  z = 0;
  y = 0;
  yaw = 0;
  health = 0;
  maxHealth = 0;
  speed = 3;
  radius = 0.7;

  state: EnemyState = 'idle';
  /** Barricade this enemy is coming through, if any. */
  target: BarricadeProp | null = null;
  /** 1 on the frame a bullet lands, fading to 0; the renderer brightens the body with it. */
  hitFlash = 0;
  /** Whether it had the player in plain sight at its last think. */
  seesPlayer = false;
  deathKind: DeathKind = 'back';

  private phase = 0;
  private stateTimer = 0;
  private attackCooldown = 0;
  private swing = 0;
  private groanTimer = 0;
  private velX = 0;
  private velZ = 0;

  // Pursuit.
  private thinkTimer = 0;
  private hasWaypoint = false;
  private wpX = 0;
  private wpZ = 0;
  private lastX = 0;
  private lastZ = 0;
  private stuckTime = 0;
  private lostTime = 0;
  /** Path distance (in tiles) to the player at the last think, for measuring progress. */
  private lastFieldDist = -1;

  // Hit reactions: springs for the body and head, plus a stagger and a shove.
  private flinch = 0;
  private flinchV = 0;
  private roll = 0;
  private rollV = 0;
  private headSnap = 0;
  private headSnapV = 0;
  private stagger = 0;
  private pushX = 0;
  private pushZ = 0;

  // Death.
  private deathT = 0;
  private fallTime = 0.7;
  private fallSide = 1;
  private fallDir = 1;
  private airVY = 0;
  private spin = 0;
  private spinAngle = 0;
  private landAngle = 0;
  private landed = false;

  constructor(model: ZombieModel) {
    this.model = model;
    this.model.root.visible = false;
    // Yaw first, then the fall pitch and roll in the body's own frame.
    this.model.root.rotation.order = 'YXZ';
  }

  spawn(
    kind: EnemyKind, x: number, z: number, health: number, round: number,
    barricade: BarricadeProp | null, rng: Rng,
  ): void {
    this.kind = kind;
    this.active = true;
    this.x = x;
    this.z = z;
    this.y = 0;
    this.health = health;
    this.maxHealth = health;
    this.speed = enemySpeed(round, kind) * rng.range(0.9, 1.12);
    this.radius = this.model.radius;
    this.target = barricade;
    this.state = barricade ? 'approach' : 'hunt';
    this.phase = rng.range(0, Math.PI * 2);
    this.stateTimer = 0;
    this.attackCooldown = rng.range(0, 0.4);
    this.swing = 0;
    this.groanTimer = rng.range(0.5, 4);
    this.velX = 0;
    this.velZ = 0;
    this.hitFlash = 0;
    this.thinkTimer = rng.range(0, 0.1);
    this.hasWaypoint = false;
    this.seesPlayer = false;
    this.lastX = x;
    this.lastZ = z;
    this.stuckTime = 0;
    this.lostTime = 0;
    this.lastFieldDist = -1;
    this.flinch = this.flinchV = this.roll = this.rollV = this.headSnap = this.headSnapV = 0;
    this.stagger = 0;
    this.pushX = this.pushZ = 0;
    this.deathT = 0;
    this.landed = false;
    const m = this.model;
    m.root.visible = true;
    m.root.position.set(x, 0, z);
    m.root.rotation.set(0, 0, 0);
    m.root.scale.setScalar(1);
    m.body.rotation.set(0, 0, 0);
    m.head.rotation.set(0, 0, 0);
    m.head.visible = true;
    m.legL.rotation.set(0, 0, 0);
    m.legR.rotation.set(0, 0, 0);
    if (kind !== 'hound') {
      m.armL.rotation.set(-1.32, 0, 0);
      m.armR.rotation.set(-1.32, 0, 0);
    }
  }

  retire(): void {
    this.active = false;
    this.state = 'idle';
    this.target = null;
    this.model.root.visible = false;
  }

  get headY(): number {
    return this.y + this.model.headHeight;
  }

  /** Vertical extent used for bullet/AABB tests. */
  get bodyTop(): number {
    return this.y + this.model.height;
  }

  /** True once it has been out of sight and far away long enough to recycle. */
  get lost(): boolean {
    return this.state === 'hunt' && this.lostTime > LOST_SECONDS;
  }

  /**
   * Takes a hit. `dirX, dirZ` is the direction the shot was travelling (from
   * the shooter toward this body), which decides which way it reels and falls.
   */
  applyDamage(amount: number, head: boolean, explosive: boolean, dirX = 0, dirZ = 0): HitResult {
    if (this.state === 'dead') return { killed: false, head, gibbed: false, headless: false, damageDealt: 0 };
    const before = this.health;
    this.health -= amount;
    this.hitFlash = 1;
    const dealt = Math.min(before, amount);
    const frac = Math.min(1, amount / Math.max(1, this.maxHealth));

    // How the shot lines up with the way the body faces.
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const along = dirX * fx + dirZ * fz;
    const across = dirX * fz - dirZ * fx;

    if (this.health > 0) {
      const kick = 3 + frac * 16;
      this.flinchV += kick * (along === 0 ? -1 : along);
      this.rollV += -kick * 0.7 * across + (Math.random() - 0.5) * 2;
      if (head) this.headSnapV += -14 - frac * 10;
      this.stagger = Math.max(this.stagger, 0.1 + frac * 0.55);
      const shove = 1.2 + frac * 11;
      this.pushX += dirX * shove;
      this.pushZ += dirZ * shove;
      return { killed: false, head, gibbed: false, headless: false, damageDealt: dealt };
    }

    // Down it goes.
    const overkill = amount / Math.max(1, this.maxHealth);
    const gibbed = explosive ? overkill > 2.5 : overkill > 3.5;
    const headless = !gibbed && head && this.kind !== 'hound';
    this.state = 'dead';
    this.deathT = 0;
    this.landed = false;
    this.spinAngle = 0;
    this.velX = 0;
    this.velZ = 0;
    this.fallSide = across >= 0 ? -1 : 1;
    // Away from the shot: a frontal hit throws it on its back.
    this.fallDir = along > 0 ? 1 : -1;
    if (gibbed) {
      this.deathKind = 'gib';
    } else if (explosive) {
      this.deathKind = 'launch';
      this.airVY = 7 + Math.random() * 4;
      this.spin = (5 + Math.random() * 4) * -this.fallDir;
      const throwSpeed = 8 + Math.random() * 5;
      this.pushX = dirX * throwSpeed;
      this.pushZ = dirZ * throwSpeed;
    } else if (this.kind === 'hound') {
      this.deathKind = 'crumple';
      this.pushX = dirX * 5;
      this.pushZ = dirZ * 5;
    } else {
      const heavy = head || frac > 0.6;
      const roll = Math.random();
      this.deathKind = heavy ? (this.fallDir < 0 ? 'back' : 'forward') : roll < 0.4 ? 'crumple' : roll < 0.7 ? 'forward' : 'back';
      if (this.deathKind === 'forward' && !heavy) this.fallDir = 1;
      const shove = heavy ? 5 + frac * 4 : 2.5;
      this.pushX = dirX * shove;
      this.pushZ = dirZ * shove;
    }
    this.fallTime = { back: 0.62, forward: 0.8, crumple: 0.95, launch: 0.6, gib: 0.05 }[this.deathKind];
    if (headless) this.model.head.visible = false;
    return { killed: true, head, gibbed, headless, damageDealt: dealt };
  }

  /* --------------------------------------------------------------- update */

  update(
    dt: number, grid: NavGrid, px: number, pz: number, playerAlive: boolean,
    torn: Set<number>, onAttack: (e: Enemy, dmg: number) => void,
    onBoardBreak: (e: Enemy, b: BarricadeProp) => void,
    onGroan: (e: Enemy) => void,
  ): void {
    if (!this.active) return;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 9);

    if (this.state === 'dead') {
      this.updateDeath(dt, grid);
      return;
    }

    this.groanTimer -= dt;
    if (this.groanTimer <= 0) {
      this.groanTimer = 3 + Math.random() * 6;
      onGroan(this);
    }

    switch (this.state) {
      case 'approach':
        this.updateApproach(dt);
        break;
      case 'breach':
        this.updateBreach(dt, onBoardBreak);
        break;
      case 'climb':
        this.updateClimb(dt);
        break;
      case 'hunt':
      case 'attack':
        this.updateHunt(dt, grid, px, pz, playerAlive, torn, onAttack);
        break;
      default:
        break;
    }

    const moving = this.state === 'hunt' || this.state === 'approach';
    const gait = this.state === 'approach' ? this.speed * 0.8 : Math.hypot(this.velX, this.velZ);
    this.phase += dt * (moving ? 1.4 + gait * 0.72 : 2.2);
    this.animate(dt, gait);
  }

  /** Walk from the outside spawn point into the window reveal. */
  private updateApproach(dt: number): void {
    const b = this.target;
    if (!b) {
      this.state = 'hunt';
      return;
    }
    const outside = {
      x: b.center.x + b.def.dx * WINDOW_STAND,
      z: b.center.z + b.def.dz * WINDOW_STAND,
    };
    const dx = outside.x - this.x;
    const dz = outside.z - this.z;
    const d = Math.hypot(dx, dz);
    this.faceTowards(dx, dz, dt * 6);
    if (d < 0.35) {
      this.state = 'breach';
      this.stateTimer = 0;
      return;
    }
    const step = Math.min(d, this.speed * 0.8 * dt);
    this.x += (dx / d) * step;
    this.z += (dz / d) * step;
  }

  /** Rip the boards off, one every so often. */
  private updateBreach(dt: number, onBoardBreak: (e: Enemy, b: BarricadeProp) => void): void {
    const b = this.target;
    if (!b) {
      this.state = 'hunt';
      return;
    }
    this.faceTowards(-b.def.dx, -b.def.dz, dt * 4);
    if (b.isOpen) {
      this.state = 'climb';
      this.stateTimer = 0;
      return;
    }
    this.stateTimer -= dt;
    if (this.stateTimer <= 0) {
      this.stateTimer = 0.55;
      this.swing = 1;
      if (b.removeBoard()) onBoardBreak(this, b);
    }
  }

  /** Clamber through the window frame and drop inside. */
  private updateClimb(dt: number): void {
    const b = this.target;
    if (!b) {
      this.state = 'hunt';
      return;
    }
    this.stateTimer += dt;
    const inside = {
      x: b.center.x - b.def.dx * TILE * 0.9,
      z: b.center.z - b.def.dz * TILE * 0.9,
    };
    const t = Math.min(1, this.stateTimer / 1.0);
    const from = {
      x: b.center.x + b.def.dx * WINDOW_STAND,
      z: b.center.z + b.def.dz * WINDOW_STAND,
    };
    this.x = from.x + (inside.x - from.x) * t;
    this.z = from.z + (inside.z - from.z) * t;
    this.y = Math.sin(t * Math.PI) * 1.05;
    this.faceTowards(-b.def.dx, -b.def.dz, dt * 4);
    if (t >= 1) {
      this.y = 0;
      this.target = null;
      this.state = 'hunt';
      this.lastX = this.x;
      this.lastZ = this.z;
      this.thinkTimer = 0;
    }
  }

  /**
   * True when a body this wide can walk in a straight line between two
   * points: one ray down the middle and one along each shoulder.
   */
  private clearPath(grid: NavGrid, x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const d = Math.hypot(dx, dz);
    if (d < 0.01) return true;
    const r = this.radius * 0.85;
    const ox = (-dz / d) * r;
    const oz = (dx / d) * r;
    return grid.lineOfSight(x0, z0, x1, z1)
      && grid.lineOfSight(x0 + ox, z0 + oz, x1 + ox, z1 + oz)
      && grid.lineOfSight(x0 - ox, z0 - oz, x1 - ox, z1 - oz);
  }

  /** Follows the flow field a few tiles ahead and keeps the farthest point it can walk straight to. */
  private pickWaypoint(grid: NavGrid): void {
    const here = worldToTile(this.x, this.z);
    let flow = grid.flowAt(here.tx, here.tz);
    this.hasWaypoint = false;
    if (!flow) {
      // Shoved off the field (into a doorway edge, say): head for the best open neighbour.
      let best = -1;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const d = grid.distanceAt(here.tx + dx, here.tz + dz);
          if (d < 0 || (best >= 0 && d >= best)) continue;
          best = d;
          const c = tileCenter(here.tx + dx, here.tz + dz);
          this.wpX = c.x;
          this.wpZ = c.z;
          this.hasWaypoint = true;
        }
      }
      return;
    }
    let cx = here.tx;
    let cz = here.tz;
    for (let i = 0; i < 5 && flow; i++) {
      if (flow.dx === 0 && flow.dz === 0) break;
      cx += flow.dx;
      cz += flow.dz;
      const c = tileCenter(cx, cz);
      if (i > 0 && !this.clearPath(grid, this.x, this.z, c.x, c.z)) break;
      this.wpX = c.x;
      this.wpZ = c.z;
      this.hasWaypoint = true;
      flow = grid.flowAt(cx, cz);
    }
  }

  /** A few times a second: can it see the player, where next, is it stuck, is it lost. */
  private think(grid: NavGrid, px: number, pz: number, dist: number, interval: number): void {
    const moved = Math.hypot(this.x - this.lastX, this.z - this.lastZ);
    this.lastX = this.x;
    this.lastZ = this.z;
    if (moved < this.speed * interval * 0.25) this.stuckTime += interval;
    else this.stuckTime = Math.max(0, this.stuckTime - interval * 2);

    this.seesPlayer = dist < 48 && this.clearPath(grid, this.x, this.z, px, pz);
    if (this.seesPlayer) this.hasWaypoint = false;
    else this.pickWaypoint(grid);

    // Lost means far away, out of sight and getting no closer along the path.
    // A body that is still making its way over keeps going.
    const here = worldToTile(this.x, this.z);
    const fieldDist = grid.distanceAt(here.tx, here.tz);
    const closing = fieldDist >= 0 && this.lastFieldDist >= 0 && fieldDist < this.lastFieldDist;
    if (fieldDist >= 0) this.lastFieldDist = fieldDist;
    if (this.seesPlayer || dist <= LOST_DISTANCE) this.lostTime = 0;
    else if (closing) this.lostTime = Math.max(0, this.lostTime - interval * 4);
    else this.lostTime += interval;

    // Wedged: aim for the neighbouring tile nearest the goal, and shoulder sideways.
    if (this.stuckTime > 0.9 && this.stagger <= 0) {
      this.stuckTime = 0;
      const here = worldToTile(this.x, this.z);
      const d0 = grid.distanceAt(here.tx, here.tz);
      let best = d0 >= 0 ? d0 : 1e9;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const d = grid.distanceAt(here.tx + dx, here.tz + dz);
        if (d < 0 || d >= best) continue;
        best = d;
        const c = tileCenter(here.tx + dx, here.tz + dz);
        this.wpX = c.x;
        this.wpZ = c.z;
        this.hasWaypoint = true;
        this.seesPlayer = false;
      }
      const side = Math.random() < 0.5 ? 1 : -1;
      const hx = this.wpX - this.x;
      const hz = this.wpZ - this.z;
      const hd = Math.hypot(hx, hz) || 1;
      this.pushX += (-hz / hd) * side * 3;
      this.pushZ += (hx / hd) * side * 3;
    }
  }

  private updateHunt(
    dt: number, grid: NavGrid, px: number, pz: number, playerAlive: boolean,
    torn: Set<number>, onAttack: (e: Enemy, dmg: number) => void,
  ): void {
    const dxp = px - this.x;
    const dzp = pz - this.z;
    const dist = Math.hypot(dxp, dzp);
    const reach = this.radius + (this.kind === 'hound' ? 1.5 : 1.35);

    this.attackCooldown -= dt;
    this.stagger = Math.max(0, this.stagger - dt);

    // Shoves from bullets slide the body regardless of what it is doing.
    this.x += this.pushX * dt;
    this.z += this.pushZ * dt;
    const drag = Math.pow(0.004, dt);
    this.pushX *= drag;
    this.pushZ *= drag;

    if (playerAlive && dist <= reach) {
      this.state = 'attack';
      this.velX *= 0.8;
      this.velZ *= 0.8;
      this.faceTowards(dxp, dzp, dt * 8);
      // A staggered body cannot swing.
      if (this.attackCooldown <= 0 && this.stagger <= 0) {
        this.attackCooldown = this.kind === 'hound' ? 0.95 : 1.2;
        this.swing = 1;
        onAttack(this, enemyDamage(this.kind));
      }
      const res = grid.resolveCircle(this.x, this.z, this.radius, torn);
      this.x = res.x;
      this.z = res.z;
      return;
    }

    this.state = 'hunt';

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      const interval = 0.1 + Math.random() * 0.07;
      this.thinkTimer = interval;
      this.think(grid, px, pz, dist, interval);
    }

    // Heading: the player when in plain sight, otherwise the waypoint.
    let tx = px;
    let tz = pz;
    if (!this.seesPlayer && this.hasWaypoint) {
      tx = this.wpX;
      tz = this.wpZ;
    }
    const hx0 = tx - this.x;
    const hz0 = tz - this.z;
    const hd = Math.hypot(hx0, hz0) || 1;
    const hx = hx0 / hd;
    const hz = hz0 / hd;

    // Far behind and out of sight, the dead hurry to catch up.
    const catchUp = !this.seesPlayer && dist > 22 ? Math.min(1.45, 1 + (dist - 22) / 40) : 1;
    const speed = this.speed * catchUp * (this.stagger > 0 ? 0.3 : 1);
    const turn = Math.min(1, dt * 9);
    this.velX += (hx * speed - this.velX) * turn;
    this.velZ += (hz * speed - this.velZ) * turn;
    this.x += this.velX * dt;
    this.z += this.velZ * dt;

    const res = grid.resolveCircle(this.x, this.z, this.radius, torn);
    this.x = res.x;
    this.z = res.z;

    if (this.seesPlayer && dist < 8) this.faceTowards(dxp, dzp, dt * 8);
    else this.faceTowards(this.velX, this.velZ, dt * 7);
  }

  /* ---------------------------------------------------------------- death */

  private updateDeath(dt: number, grid: NavGrid): void {
    const m = this.model;
    this.deathT += dt;
    const t = this.deathT;
    if (this.deathKind === 'gib') {
      if (t > this.fallTime) this.retire();
      return;
    }

    // Momentum carries the body a little way as it goes down.
    this.x += this.pushX * dt;
    this.z += this.pushZ * dt;
    const drag = Math.pow(this.deathKind === 'launch' && !this.landed ? 0.6 : 0.01, dt);
    this.pushX *= drag;
    this.pushZ *= drag;
    const res = grid.resolveCircle(this.x, this.z, this.radius * 0.6);
    this.x = res.x;
    this.z = res.z;

    const f = Math.min(1, t / this.fallTime);
    // Falling accelerates: most of the rotation happens at the end.
    const g = f * f;
    let rx = 0;
    let rz = 0;
    let y = 0;
    const hound = this.kind === 'hound';

    switch (this.deathKind) {
      case 'back': {
        rx = -(HALF_PI - 0.08) * g;
        y = 0.3 * g;
        if (!hound) {
          m.body.rotation.set(-0.1 - 0.2 * ease(f * 2), 0, 0);
          m.head.rotation.set(-0.6 * ease(f * 3), 0, 0.2);
          m.armL.rotation.set(-1.32 - 1.4 * ease(f * 2.5), 0, -0.5 * f);
          m.armR.rotation.set(-1.32 - 1.2 * ease(f * 2.2), 0, 0.6 * f);
          m.legL.rotation.x = 0.35 * ease(f * 2);
          m.legR.rotation.x = -0.1 * ease(f * 2);
        }
        break;
      }
      case 'forward': {
        // Knees go first, then it pitches onto its face.
        const buckle = ease(t / 0.22);
        const pitch = Math.max(0, (t - 0.18) / (this.fallTime - 0.18));
        rx = (HALF_PI - 0.06) * Math.min(1, pitch * pitch);
        y = -0.35 * buckle * (1 - Math.min(1, pitch)) + 0.28 * Math.min(1, pitch);
        if (!hound) {
          m.body.rotation.set(0.5 * buckle, 0, 0);
          m.head.rotation.set(0.3 * buckle, 0, -0.15);
          m.armL.rotation.set(-1.32 - 1.1 * ease(pitch * 1.5), 0, -0.3);
          m.armR.rotation.set(-1.32 - 0.8 * ease(pitch * 1.5), 0, 0.25);
          m.legL.rotation.x = 0.6 * buckle;
          m.legR.rotation.x = 0.3 * buckle;
        }
        break;
      }
      case 'crumple': {
        // Drops to its knees, sways, then keels over sideways.
        const knees = ease(t / 0.32);
        const keel = Math.max(0, (t - 0.3) / (this.fallTime - 0.3));
        const k2 = Math.min(1, keel * keel);
        rz = this.fallSide * (HALF_PI - 0.12) * k2;
        rx = 0.25 * knees;
        y = hound ? -0.3 * knees : -0.95 * knees * (1 - k2) + 0.22 * k2;
        if (!hound) {
          m.body.rotation.set(0.45 * knees, 0, this.fallSide * 0.2 * knees);
          m.head.rotation.set(0.5 * knees, 0, this.fallSide * 0.45 * knees);
          m.armL.rotation.set(-1.32 + 1.0 * knees, 0, -0.2);
          m.armR.rotation.set(-1.32 + 0.8 * knees, 0, 0.2);
          m.legL.rotation.x = -1.25 * knees;
          m.legR.rotation.x = -1.1 * knees;
        } else {
          m.legL.rotation.x = 0.5 * knees;
          m.legR.rotation.x = -0.4 * knees;
          m.armL.rotation.x = 0.6 * knees;
          m.armR.rotation.x = -0.5 * knees;
        }
        break;
      }
      case 'launch': {
        // Thrown through the air, tumbling, and landing flat.
        if (!this.landed) {
          this.airVY -= 24 * dt;
          this.y += this.airVY * dt;
          this.spinAngle += this.spin * dt;
          if (this.y <= 0 && t > 0.08) {
            this.y = 0;
            this.landed = true;
            this.fallTime = t;
            this.landAngle = this.spinAngle;
          }
          rx = this.spinAngle;
        } else {
          // Settle onto its back from whatever angle it landed at.
          const settle = ease((t - this.fallTime) / 0.25);
          const target = -(HALF_PI - 0.08);
          rx = this.landAngle + (target - this.landAngle) * settle;
          y = 0.3 * settle;
        }
        if (!hound) {
          const flail = Math.sin(t * 22) * 0.5 * (this.landed ? 0 : 1);
          m.armL.rotation.set(-2.4 + flail, 0, -0.6);
          m.armR.rotation.set(-2.2 - flail, 0, 0.6);
          m.legL.rotation.x = 0.4 + flail * 0.5;
          m.legR.rotation.x = -0.3 - flail * 0.5;
          m.head.rotation.set(-0.4, 0, 0.2);
        }
        break;
      }
    }
    m.jaw.rotation.x = 0.55;

    // Lie still, then sink through the floor.
    const sinkAt = this.fallTime + LIE_TIME;
    if (t > sinkAt) y -= ((t - sinkAt) / SINK_TIME) * 1.4;
    if (t > sinkAt + SINK_TIME) {
      this.retire();
      return;
    }

    m.root.position.set(this.x, this.y + y, this.z);
    m.root.rotation.set(rx, this.yaw, rz);
    m.root.updateMatrix();
  }

  private faceTowards(dx: number, dz: number, rate: number): void {
    if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return;
    const want = Math.atan2(dx, dz);
    let delta = want - this.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.yaw += delta * Math.min(1, rate);
  }

  /** Pushes this enemy away from another that is overlapping it. */
  separate(other: Enemy, strength: number): void {
    const dx = this.x - other.x;
    const dz = this.z - other.z;
    const min = this.radius + other.radius;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min || d2 < 1e-6) return;
    const d = Math.sqrt(d2);
    const push = (min - d) * strength * 0.5;
    this.x += (dx / d) * push;
    this.z += (dz / d) * push;
    other.x -= (dx / d) * push;
    other.z -= (dz / d) * push;
  }

  private animate(dt: number, gait: number): void {
    const m = this.model;
    const moving = this.state === 'hunt' || this.state === 'approach';

    // Hit-reaction springs.
    this.flinchV += (-110 * this.flinch - 13 * this.flinchV) * dt;
    this.flinch = THREE.MathUtils.clamp(this.flinch + this.flinchV * dt, -0.9, 0.7);
    this.rollV += (-110 * this.roll - 13 * this.rollV) * dt;
    this.roll = THREE.MathUtils.clamp(this.roll + this.rollV * dt, -0.6, 0.6);
    this.headSnapV += (-160 * this.headSnap - 16 * this.headSnapV) * dt;
    this.headSnap = THREE.MathUtils.clamp(this.headSnap + this.headSnapV * dt, -1.1, 0.5);

    if (this.kind === 'hound') {
      // Gallop: front and back legs out of phase, body bounding.
      const g = Math.sin(this.phase * 1.6);
      m.legL.rotation.x = g * 0.9;
      m.legR.rotation.x = g * 0.9;
      m.armL.rotation.x = -g * 0.9;
      m.armR.rotation.x = -g * 0.9;
      m.body.position.y = 1.05 + Math.abs(g) * 0.16;
      m.body.rotation.set(g * 0.1 + this.flinch * 0.6, 0, this.roll);
      m.jaw.rotation.x = 0.3 + Math.abs(Math.sin(this.phase * 2)) * 0.4;
    } else {
      const s = Math.sin(this.phase);
      const c = Math.cos(this.phase);
      // Fast bodies break into a lurching run: arms pump instead of reaching.
      const run = THREE.MathUtils.clamp((gait - 4.2) / 1.2, 0, 1);
      const stride = moving ? 0.85 + run * 0.35 : 0.12;
      m.legL.rotation.x = s * stride;
      m.legR.rotation.x = -s * stride;
      m.body.rotation.z = c * (0.09 - run * 0.04) + this.roll;
      m.body.rotation.x = 0.22 + run * 0.2 + Math.abs(s) * 0.06 + this.flinch;
      m.body.position.y = 1.5 + Math.abs(s) * (0.08 + run * 0.06);
      m.head.rotation.z = -c * 0.16;
      m.head.rotation.x = -0.18 - run * 0.15 + s * 0.05 + this.headSnap;
      const reach = -1.32;
      const pump = -0.55;
      m.armL.rotation.x = reach + (pump - reach) * run + s * 0.9 * run + this.flinch * 1.2;
      m.armR.rotation.x = reach + (pump - reach) * run - s * 0.9 * run + this.flinch * 1.2;
      m.armL.rotation.z = c * 0.1;
      m.armR.rotation.z = -c * 0.1;
      m.jaw.rotation.x = 0.16 + Math.abs(c) * 0.2 + Math.max(0, -this.flinch) * 0.5;
    }

    // Attack / board-tearing swing overrides the arms for a beat.
    if (this.swing > 0) {
      this.swing = Math.max(0, this.swing - dt * 2.8);
      const a = Math.sin((1 - this.swing) * Math.PI);
      if (this.kind === 'hound') {
        m.body.rotation.x = -a * 0.5;
        m.jaw.rotation.x = 0.3 + a * 0.7;
      } else {
        m.armL.rotation.x = -1.32 - a * 1.5;
        m.armR.rotation.x = -1.32 - a * 1.5;
        m.body.rotation.x = 0.22 + a * 0.3 + this.flinch;
      }
    }

    m.root.position.set(this.x, this.y, this.z);
    m.root.rotation.set(0, this.yaw, 0);
    m.root.updateMatrix();
  }
}

/* ------------------------------------------------------------------- pool */

export class EnemyPool {
  readonly all: Enemy[] = [];
  readonly group = new THREE.Group();

  // Bodies stay on the floor for a couple of seconds after dying, so the pool
  // holds comfortably more than the most that can be alive at once.
  constructor(humanoids = 40, hounds = 14) {
    const outfits: Outfit[] = ['patient', 'civilian', 'orderly', 'patient', 'guard', 'civilian'];
    for (let i = 0; i < humanoids; i++) {
      const model = buildZombie({
        skin: i % 4,
        damage: i % 5,
        tall: 0.92 + (i % 7) * 0.026,
        wide: 0.94 + (i % 5) * 0.03,
        outfit: outfits[i % outfits.length],
        cloth: i % 7,
      });
      const e = new Enemy(model);
      this.all.push(e);
      this.group.add(model.root);
    }
    for (let i = 0; i < hounds; i++) {
      const e = new Enemy(buildHound());
      e.kind = 'hound';
      this.all.push(e);
      this.group.add(e.model.root);
    }
    for (const e of this.all) e.model.root.matrixAutoUpdate = false;
  }

  /** Grabs a free body of the right shape, or null when the pool is dry. */
  acquire(kind: EnemyKind): Enemy | null {
    const wantHound = kind === 'hound';
    for (const e of this.all) {
      if (e.active) continue;
      const isHound = e.model.height < 2.2;
      if (isHound === wantHound) return e;
    }
    return null;
  }

  get liveCount(): number {
    let n = 0;
    for (const e of this.all) if (e.active && e.state !== 'dead') n++;
    return n;
  }

  forEachLive(fn: (e: Enemy) => void): void {
    for (const e of this.all) if (e.active && e.state !== 'dead') fn(e);
  }

  /** O(n^2) separation over the live set. With a 26-enemy cap that is nothing. */
  resolveCrowding(grid: NavGrid, torn: Set<number>): void {
    const live: Enemy[] = [];
    for (const e of this.all) {
      if (e.active && e.state !== 'dead' && e.state !== 'approach' && e.state !== 'climb') {
        live.push(e);
      }
    }
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) live[i].separate(live[j], 0.55);
    }
    for (const e of live) {
      const res = grid.resolveCircle(e.x, e.z, e.radius, torn);
      e.x = res.x;
      e.z = res.z;
    }
  }

  /** The nuke: everything standing collapses where it stands. */
  killAll(): Enemy[] {
    const killed: Enemy[] = [];
    for (const e of this.all) {
      if (e.active && e.state !== 'dead') {
        e.applyDamage(e.health + 1, false, false, Math.random() - 0.5, Math.random() - 0.5);
        killed.push(e);
      }
    }
    return killed;
  }

  reset(): void {
    for (const e of this.all) e.retire();
  }
}

/** Ray/capsule test used for hitscan weapons. Returns distance along the ray. */
export function rayHitsEnemy(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  e: Enemy, maxDist: number,
): { dist: number; head: boolean } | null {
  // Closest approach between the ray and the enemy's vertical axis.
  const px = e.x - ox;
  const pz = e.z - oz;
  const alongFlat = px * dx + pz * dz;
  const flatLen2 = dx * dx + dz * dz;
  if (flatLen2 < 1e-9) return null;
  const t = Math.max(0, Math.min(maxDist, (alongFlat / flatLen2) * 1));

  // Step in a little from the closest flat point and test the true 3D distance.
  const hx = ox + dx * t;
  const hy = oy + dy * t;
  const hz = oz + dz * t;
  const flatDist = Math.hypot(hx - e.x, hz - e.z);
  if (flatDist > e.radius * 1.15) return null;
  const bottom = e.y + 0.1;
  const top = e.bodyTop;
  if (hy < bottom || hy > top) return null;

  const headBand = e.headY - (e.kind === 'hound' ? 0.32 : 0.42);
  return { dist: t, head: hy >= headBand };
}

