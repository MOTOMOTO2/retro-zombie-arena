/**
 * The horde.
 *
 * Every enemy is a tiny state machine: walk in from outside, tear the boards off
 * a window, climb through, then hunt the player and swing.
 *
 * Hunting thinks a few times a second and moves every frame. With the target in
 * plain sight (checked with a ray down the middle and one along each shoulder,
 * so a body never tries to squeeze past a corner it cannot fit round) it walks
 * at where the player is *going*; otherwise it follows a flow field, looking a
 * few tiles ahead and heading for the farthest point it can walk straight to, so
 * paths cut corners smoothly instead of stepping tile by tile. One that has been
 * lost far away and out of sight for too long is recycled back to a window near
 * the player, so the horde never loses interest.
 *
 * Which field it follows is not its own decision: the shared brain in horde.ts
 * deals every body a role - come straight in, swing round one side, or get in
 * front and stand in the way - and each role has its own goal and its own field.
 * A body only abandons its orders once it is close enough to charge. See that
 * file for how the crowd splits itself up.
 *
 * A body that stops making progress does not just shove sideways and hope: it
 * picks the best neighbouring tile that something its size could actually stand
 * in and commits to walking there for a moment, which is what gets it round the
 * end of a crate rather than along the side of one forever.
 *
 * There are eight kinds of them, and they are not just numbers: each one is
 * built out of the same body at its own size, tint and stoop, so a crowd reads
 * at a glance. Crawlers drag along the floor with their head about a metre up,
 * armoured bodies shrug off anything that is not a headshot, spitters stop
 * short and throw bile, bloaters burst when they go down, and a tank is half
 * again as tall as the rest, shrugs off the shoves that stagger them, shoulders
 * them out of its way and pays four times over.
 *
 * Hit tests treat the body as a capped cylinder along its spine rather than a
 * vertical one at its feet, so a stooped body is hittable where it looks like it
 * is. See `rayHitsEnemy` at the bottom of the file.
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
import { ENEMY_INFO, enemyDamage, enemySpeed, type EnemyBuild, type EnemyKind } from './rules.ts';
import {
  COMMIT_RANGE, GOAL_RANGE, HOLD_SECONDS, MANOEUVRE_SECONDS, ROLE_SLOT,
  type Horde, type HordeRole,
} from './horde.ts';
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

/** Hits start registering this far up the spine: below it is ankle. */
const BODY_FOOT = 0.1;

/** How far ahead of you a body aims when it can see you moving. */
const LEAD_SECONDS = 0.85;
/** How wide a flanker swings, and the range inside which it stops bothering. */
const ARC_ANGLE = 0.8;
const ARC_FROM = 5;
/** No progress for this long and it goes looking for a way round. */
const STUCK_SECONDS = 0.7;
/** How long it commits to that way round before consulting the field again. */
const DETOUR_SECONDS = 1.1;

/** The eight tiles round a body, for picking a way out of a wedge. */
const AROUND: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export type HitResult = {
  killed: boolean;
  head: boolean;
  gibbed: boolean;
  /** Killed while frozen: it burst into ice. */
  shattered: boolean;
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
  /** The chapter's threat when it spawned: it hits harder the higher it is. */
  threat = 0;
  speed = 3;
  radius = 0.7;
  /** How big this body is against the model it was built from. */
  sizeScale = 1;
  /** Forward pitch of the whole body: a crawler drags along at over a radian. */
  lean = 0;
  /** Body shots are multiplied by this; the head always takes the lot. */
  bodyArmour = 1;
  /** A spitter holds this far off and throws; everything else closes in. */
  standoff = 0;
  /** A bloater bursts this wide when it dies. */
  burst = 0;
  /** Seconds until this body can throw again. */
  throwTimer = 0;

  state: EnemyState = 'idle';
  /** Barricade this enemy is coming through, if any. */
  target: BarricadeProp | null = null;
  /** 1 on the frame a bullet lands, fading to 0; the renderer brightens the body with it. */
  hitFlash = 0;
  /** Seconds left frozen solid: no moving, no swinging, and a kill shatters it. */
  frozen = 0;
  /** Seconds left on fire, and the damage per second the game applies for it. */
  burning = 0;
  burnDps = 0;
  /** Seconds left twitching from electricity: stunned where it stands. */
  shocked = 0;
  /** Bosses get a health bar, a name and their own AI. */
  get isBoss(): boolean {
    return false;
  }
  /** Fire does nothing to it. */
  get fireproof(): boolean {
    return false;
  }
  /** Whether it had the player in plain sight at its last think. */
  seesPlayer = false;
  deathKind: DeathKind = 'back';
  /** Which pooled shape this body was built from. The pool sets it once. */
  build: EnemyBuild = 'humanoid';

  /** What the horde has told it to do about you. */
  role: HordeRole = 'chase';
  /** Which flow field it is following right now. */
  protected slot = ROLE_SLOT.chase;
  /** True once it has given up manoeuvring and is coming straight at you. */
  protected direct = true;
  /** True while it is standing in your way instead of closing in. */
  protected blocking = false;
  /** Seconds it has been standing there. It will not wait forever. */
  protected holdTime = 0;
  /** Seconds it has been working toward its current orders, reached or not. */
  protected roleTime = 0;
  /** Which way a flanker swings: 1 one side, -1 the other, 0 not a flanker. */
  protected arc = 0;
  /** Whether there is actually room to swing that way. */
  protected arcOk = false;
  /** Where to aim ahead of the player, as an offset from them. */
  protected leadX = 0;
  protected leadZ = 0;
  /** Seconds left walking a way round something it got wedged on. */
  protected detour = 0;
  /** Which way round it is trying to go: it keeps a side until that works. */
  protected wallSide = 0;
  /** Path cost when the detour began, to tell afterwards whether it helped. */
  protected detourDist = -1;

  protected phase = 0;
  protected stateTimer = 0;
  protected attackCooldown = 0;
  protected swing = 0;
  protected groanTimer = 0;
  protected velX = 0;
  protected velZ = 0;

  // Pursuit.
  protected thinkTimer = 0;
  protected hasWaypoint = false;
  protected wpX = 0;
  protected wpZ = 0;
  protected lastX = 0;
  protected lastZ = 0;
  protected stuckTime = 0;
  protected lostTime = 0;
  /** Path distance (in tiles) to the player at the last think, for measuring progress. */
  protected lastFieldDist = -1;

  // Hit reactions: springs for the body and head, plus a stagger and a shove.
  protected flinch = 0;
  protected flinchV = 0;
  protected roll = 0;
  protected rollV = 0;
  protected headSnap = 0;
  protected headSnapV = 0;
  protected stagger = 0;
  protected pushX = 0;
  protected pushZ = 0;

  // Death.
  protected deathT = 0;
  protected fallTime = 0.7;
  protected fallSide = 1;
  protected fallDir = 1;
  protected airVY = 0;
  protected spin = 0;
  protected spinAngle = 0;
  protected landAngle = 0;
  protected landed = false;

  constructor(model: ZombieModel) {
    this.model = model;
    this.model.root.visible = false;
    // Yaw first, then the fall pitch and roll in the body's own frame.
    this.model.root.rotation.order = 'YXZ';
  }

  spawn(
    kind: EnemyKind, x: number, z: number, health: number, round: number,
    barricade: BarricadeProp | null, rng: Rng, threat = 0,
  ): void {
    this.kind = kind;
    this.active = true;
    this.threat = threat;
    this.x = x;
    this.z = z;
    this.y = 0;
    this.health = health;
    this.maxHealth = health;
    const info = ENEMY_INFO[kind];
    this.speed = enemySpeed(round, kind, threat) * rng.range(0.9, 1.12);
    this.sizeScale = info.scale * rng.range(0.96, 1.05);
    this.lean = info.lean;
    this.bodyArmour = info.bodyArmour;
    this.standoff = info.range;
    this.burst = info.burst;
    this.throwTimer = rng.range(1.2, 3);
    this.radius = this.model.radius * (this.lean > 0.5 ? 0.85 : this.sizeScale);
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
    this.frozen = 0;
    this.burning = 0;
    this.burnDps = 0;
    this.shocked = 0;
    this.thinkTimer = rng.range(0, 0.1);
    this.hasWaypoint = false;
    this.seesPlayer = false;
    this.role = 'chase';
    this.slot = ROLE_SLOT.chase;
    this.direct = true;
    this.blocking = false;
    this.holdTime = 0;
    this.roleTime = 0;
    this.arc = 0;
    this.arcOk = false;
    this.leadX = 0;
    this.leadZ = 0;
    this.detour = 0;
    this.wallSide = 0;
    this.detourDist = -1;
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
    m.root.scale.setScalar(this.sizeScale);
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
    this.lean = 0;
    this.model.root.visible = false;
    this.model.root.scale.setScalar(1);
  }

  /* ------------------------------------------------------------- geometry */

  /**
   * Unit vector up the spine: straight up for anything standing, pitched
   * forward for anything stooped. Everything else about the body's shape hangs
   * off this, which is what makes a crawler hittable where it looks like it is.
   */
  get axisX(): number {
    return Math.sin(this.yaw) * Math.sin(this.lean);
  }

  get axisY(): number {
    return Math.cos(this.lean);
  }

  get axisZ(): number {
    return Math.cos(this.yaw) * Math.sin(this.lean);
  }

  /** Length of the spine. Nothing is ever shorter than this to shoot at. */
  get spine(): number {
    return Math.max(0.9, this.model.height * this.sizeScale);
  }

  /** How far up the spine the head end starts. */
  get headFrom(): number {
    return this.model.headHeight * this.sizeScale - (this.kind === 'hound' ? 0.32 : 0.42);
  }

  /** Body radius for hit tests: a shade more forgiving than it walks. */
  get hitRadius(): number {
    return this.radius * 1.15;
  }

  /**
   * Where the body is drawn. The model pivots at the floor, so pitching one onto
   * its front swings the whole of it out in front of that pivot - a crawler's
   * head ends up better than a metre ahead of the point it navigates by. Half
   * the reach is taken back off here, which leaves a stooped body straddling
   * that point instead of trailing behind its own head. Upright, it is a no-op.
   */
  get drawX(): number {
    return this.x - this.axisX * this.spine * 0.5;
  }

  get drawZ(): number {
    return this.z - this.axisZ * this.spine * 0.5;
  }

  /** Where the head actually is. */
  get headX(): number {
    return this.drawX + this.axisX * this.model.headHeight * this.sizeScale;
  }

  get headY(): number {
    return this.y + this.axisY * this.model.headHeight * this.sizeScale;
  }

  get headZ(): number {
    return this.drawZ + this.axisZ * this.model.headHeight * this.sizeScale;
  }

  /** How high off the floor the body reaches. */
  get bodyTop(): number {
    return this.y + this.axisY * this.spine;
  }

  /**
   * Rough mass, from how big it is. Bodies shove each other apart in proportion
   * to it, so a tank walks through a crowd of shamblers and they part for it.
   */
  get mass(): number {
    const s = this.sizeScale;
    return s * s * s;
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
    if (this.state === 'dead') return { killed: false, head, gibbed: false, shattered: false, headless: false, damageDealt: 0 };
    // Padding and a helmet: only the head takes the full amount.
    if (!head && this.bodyArmour < 1) amount *= this.bodyArmour;
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
      // Weight: the flinch, the stagger and the shove all scale down with size,
      // so a magazine that stops a shambler dead barely slows a tank.
      const heft = 1 / Math.max(0.6, this.sizeScale);
      const kick = (3 + frac * 16) * heft;
      this.flinchV += kick * (along === 0 ? -1 : along);
      this.rollV += -kick * 0.7 * across + (Math.random() - 0.5) * 2;
      if (head) this.headSnapV += -14 - frac * 10;
      this.stagger = Math.max(this.stagger, (0.1 + frac * 0.55) * heft);
      const shove = (1.2 + frac * 11) * heft;
      this.pushX += dirX * shove;
      this.pushZ += dirZ * shove;
      return { killed: false, head, gibbed: false, shattered: false, headless: false, damageDealt: dealt };
    }

    // Down it goes.
    const overkill = amount / Math.max(1, this.maxHealth);
    const shattered = this.frozen > 0;
    const gibbed = shattered || (explosive ? overkill > 2.5 : overkill > 3.5);
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
    this.frozen = 0;
    this.shocked = 0;
    return { killed: true, head, gibbed, shattered, headless, damageDealt: dealt };
  }

  /* --------------------------------------------------------------- update */

  update(
    dt: number, grid: NavGrid, px: number, pz: number, playerAlive: boolean,
    torn: Set<number>, onAttack: (e: Enemy, dmg: number) => void,
    onBoardBreak: (e: Enemy, b: BarricadeProp) => void,
    onGroan: (e: Enemy) => void,
    onThrow: (e: Enemy, toX: number, toZ: number) => void = () => {},
    horde: Horde | null = null,
  ): void {
    if (!this.active) return;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 9);

    if (this.state === 'dead') {
      this.updateDeath(dt, grid);
      return;
    }

    if (this.burning > 0) this.burning = Math.max(0, this.burning - dt);
    if (this.shocked > 0) {
      // Locked up and twitching.
      this.shocked = Math.max(0, this.shocked - dt);
      const m = this.model;
      const j = (a: number): number => (Math.random() - 0.5) * a;
      m.body.rotation.set(0.1 + j(0.35), j(0.2), j(0.35));
      m.head.rotation.set(j(0.6), j(0.5), j(0.5));
      m.armL.rotation.x += j(0.8);
      m.armR.rotation.x += j(0.8);
      m.root.position.set(this.x + j(0.08), this.y, this.z + j(0.08));
      m.root.updateMatrix();
      return;
    }
    if (this.frozen > 0) {
      // Frozen solid in whatever pose it was caught in.
      this.frozen = Math.max(0, this.frozen - dt);
      this.velX = 0;
      this.velZ = 0;
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
        this.updateHunt(dt, grid, px, pz, playerAlive, torn, onAttack, onThrow, horde);
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
  protected updateApproach(dt: number): void {
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
  protected updateBreach(dt: number, onBoardBreak: (e: Enemy, b: BarricadeProp) => void): void {
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
  protected updateClimb(dt: number): void {
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
  protected clearPath(grid: NavGrid, x0: number, z0: number, x1: number, z1: number): boolean {
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

  /**
   * As `clearPath`, but it also refuses to walk through the furniture. Seeing
   * and shooting over a crate is fine; walking through one is what used to leave
   * a body grinding against the side of it until something else pushed it free.
   */
  protected walkPath(grid: NavGrid, x0: number, z0: number, x1: number, z1: number): boolean {
    // Furniture first: it is a few array reads against three raycasts.
    return grid.fillClear(x0, z0, x1, z1) && this.clearPath(grid, x0, z0, x1, z1);
  }

  /** Follows one flow field a few tiles ahead and keeps the farthest point it can walk straight to. */
  protected pickWaypoint(grid: NavGrid, slot: number): void {
    const here = worldToTile(this.x, this.z);
    let flow = grid.flowAt(here.tx, here.tz, slot);
    this.hasWaypoint = false;
    if (!flow) {
      // Shoved off the field (into a doorway edge, say): head for the best open neighbour.
      let best = -1;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const d = grid.distanceAt(here.tx + dx, here.tz + dz, slot);
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
      if (i > 0 && !this.walkPath(grid, this.x, this.z, c.x, c.z)) break;
      this.wpX = c.x;
      this.wpZ = c.z;
      this.hasWaypoint = true;
      flow = grid.flowAt(cx, cz, slot);
    }
  }

  /**
   * The horde tells a body which of its goals to work toward. Fresh orders get a
   * fresh clock; the hold budget deliberately does not reset here, so a body
   * cannot get another few seconds of standing about by being re-dealt the same
   * job it has already spent its patience on.
   */
  setRole(role: HordeRole): void {
    if (role === this.role) return;
    this.role = role;
    this.roleTime = 0;
  }

  /**
   * Reads its orders: which field to follow, whether it has committed to
   * charging, which way a flanker swings, and whether it is standing in the way.
   */
  protected chooseGoal(horde: Horde | null, dist: number, interval: number): void {
    this.slot = ROLE_SLOT.chase;
    this.direct = true;
    this.blocking = false;
    this.arc = 0;
    if (!horde || this.role === 'chase') {
      this.roleTime = 0;
      return;
    }
    const goal = horde.goals[ROLE_SLOT[this.role]];
    if (!goal.live) return;
    // Close enough to smell you: the manoeuvre is over, whatever it was, and
    // both clocks start again for whenever it is next sent out wide.
    if (dist < COMMIT_RANGE) {
      this.holdTime = 0;
      this.roleTime = 0;
      return;
    }
    this.roleTime += interval;
    const arrived = Math.hypot(goal.x - this.x, goal.z - this.z) < GOAL_RANGE;
    if (!arrived) {
      // A manoeuvre that has not worked in a few seconds is not going to.
      if (this.roleTime > MANOEUVRE_SECONDS) return;
      this.slot = ROLE_SLOT[this.role];
      this.direct = false;
    }
    if (this.role === 'left') this.arc = 1;
    else if (this.role === 'right') this.arc = -1;
    else if (arrived) {
      // In position, in the road you were about to take, and it makes you come
      // to it - but only for a few seconds, so the horde never stalls.
      this.holdTime += interval;
      if (this.holdTime < HOLD_SECONDS && this.seesPlayer) this.blocking = true;
    }
  }

  /**
   * Wedged against something, and going round it.
   *
   * The field routes round the furniture, but a body can still end up flat
   * against the side of a desk that only half fills its tile, driving into it at
   * full speed with the flow pointing straight through it. So it picks a
   * neighbouring tile it could genuinely set off toward - tested against the
   * actual solids, not just the tile map - and commits to walking there for a
   * moment. Candidates are scored on path cost with a thumb on the scale for
   * carrying on round the same side and against doubling back, which is what
   * turns a jitter along the face of a crate into a walk round the end of it. The
   * side is kept until it stops helping, and then swapped.
   */
  protected unwedge(grid: NavGrid): void {
    this.stuckTime = 0;
    if (this.wallSide === 0) this.wallSide = Math.random() < 0.5 ? 1 : -1;
    const here = worldToTile(this.x, this.z);

    // The heading it was trying to take, to measure the candidates against.
    let hx = this.hasWaypoint ? this.wpX - this.x : 0;
    let hz = this.hasWaypoint ? this.wpZ - this.z : 0;
    let hd = Math.hypot(hx, hz);
    if (hd < 1e-3) {
      hx = Math.sin(this.yaw);
      hz = Math.cos(this.yaw);
      hd = 1;
    }
    hx /= hd;
    hz /= hd;

    const step = this.radius + 0.8;
    let best = Number.POSITIVE_INFINITY;
    let found = false;
    for (const [dx, dz] of AROUND) {
      const tx = here.tx + dx;
      const tz = here.tz + dz;
      const d = grid.distanceAt(tx, tz, this.slot);
      if (d < 0) continue;
      // A tile packed with furniture is no use: that is what it is stuck on.
      if (grid.fillAt(tx, tz) >= 2) continue;
      const len = Math.hypot(dx, dz);
      const ux = dx / len;
      const uz = dz / len;
      // Nor is the far side of a desk, to a body pressed against the near side.
      if (grid.blocked(this.x + ux * step, this.z + uz * step, this.radius * 0.85)) continue;
      const along = ux * hx + uz * hz;
      const across = (ux * -hz + uz * hx) * this.wallSide;
      const score = d - across * 3 - along * 2;
      if (score >= best) continue;
      best = score;
      const c = tileCenter(tx, tz);
      this.wpX = c.x;
      this.wpZ = c.z;
      found = true;
    }

    if (!found) {
      // Properly boxed in: try the other way round, and shoulder that way.
      this.wallSide = -this.wallSide;
      this.pushX += -hz * this.wallSide * 3;
      this.pushZ += hx * this.wallSide * 3;
      return;
    }
    this.hasWaypoint = true;
    this.direct = false;
    this.detour = DETOUR_SECONDS;
    this.detourDist = grid.distanceAt(here.tx, here.tz, ROLE_SLOT.chase);
    // And a shove along the way out, to break contact with whatever it is on.
    const ex = this.wpX - this.x;
    const ez = this.wpZ - this.z;
    const ed = Math.hypot(ex, ez) || 1;
    this.pushX += (ex / ed) * 2.4;
    this.pushZ += (ez / ed) * 2.4;
  }

  /** A few times a second: can it see you, where next, is it stuck, is it lost. */
  protected think(
    grid: NavGrid, px: number, pz: number, dist: number, interval: number,
    horde: Horde | null = null,
  ): void {
    const moved = Math.hypot(this.x - this.lastX, this.z - this.lastZ);
    this.lastX = this.x;
    this.lastZ = this.z;
    if (moved < this.speed * interval * 0.25) this.stuckTime += interval;
    else this.stuckTime = Math.max(0, this.stuckTime - interval * 2);

    this.seesPlayer = dist < 48 && this.clearPath(grid, this.x, this.z, px, pz);
    this.chooseGoal(horde, dist, interval);
    const here = worldToTile(this.x, this.z);

    // Where to put its feet: straight at you once it has committed and can see
    // you, otherwise down whichever field its orders point it at.
    if (this.detour > 0) {
      this.detour -= interval;
      this.direct = false;
      if (Math.hypot(this.wpX - this.x, this.wpZ - this.z) < 1.4) this.detour = 0;
      if (this.detour <= 0) {
        // Did going round that way get it any nearer? If not, try the other.
        const now = grid.distanceAt(here.tx, here.tz, ROLE_SLOT.chase);
        if (this.detourDist >= 0 && now >= 0 && now >= this.detourDist) this.wallSide = -this.wallSide;
        this.detourDist = -1;
      }
    } else if (this.direct && this.seesPlayer) {
      this.hasWaypoint = false;
    } else {
      this.pickWaypoint(grid, this.slot);
    }

    // Lead you: a body that can see you move walks to meet you rather than
    // trailing along behind. Only if the ground it would cut across is clear.
    this.leadX = 0;
    this.leadZ = 0;
    const drift = horde ? Math.hypot(horde.vx, horde.vz) : 0;
    if (horde && drift > 1 && this.direct && this.seesPlayer && this.standoff <= 0) {
      const ahead = Math.min(LEAD_SECONDS, dist / Math.max(2, this.speed)) * horde.cunning;
      const lx = px + horde.vx * ahead;
      const lz = pz + horde.vz * ahead;
      if (this.walkPath(grid, this.x, this.z, lx, lz)) {
        this.leadX = lx - px;
        this.leadZ = lz - pz;
      }
    }

    // And whether a flanker has room to swing the way it was told to.
    this.arcOk = false;
    if (this.arc !== 0 && this.seesPlayer && dist > ARC_FROM) {
      const hx = (px - this.x) / dist;
      const hz = (pz - this.z) / dist;
      const cs = Math.cos(this.arc * ARC_ANGLE);
      const sn = Math.sin(this.arc * ARC_ANGLE);
      const look = Math.min(7, dist - 1);
      this.arcOk = grid.clearWalk(
        this.x, this.z,
        this.x + (hx * cs - hz * sn) * look,
        this.z + (hx * sn + hz * cs) * look,
      );
    }

    // Lost means far away, out of sight and getting no closer along the path.
    // A body that is still making its way over keeps going. Always measured on
    // the player's own field, whatever this one is currently following.
    const fieldDist = grid.distanceAt(here.tx, here.tz, ROLE_SLOT.chase);
    const closing = fieldDist >= 0 && this.lastFieldDist >= 0 && fieldDist < this.lastFieldDist;
    if (fieldDist >= 0) this.lastFieldDist = fieldDist;
    if (this.seesPlayer || dist <= LOST_DISTANCE) this.lostTime = 0;
    else if (closing) this.lostTime = Math.max(0, this.lostTime - interval * 4);
    else this.lostTime += interval;

    if (this.stuckTime > STUCK_SECONDS && this.stagger <= 0 && this.detour <= 0) this.unwedge(grid);
  }

  protected updateHunt(
    dt: number, grid: NavGrid, px: number, pz: number, playerAlive: boolean,
    torn: Set<number>, onAttack: (e: Enemy, dmg: number) => void,
    onThrow: (e: Enemy, toX: number, toZ: number) => void = () => {},
    horde: Horde | null = null,
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
        // A tank winds up slowly. It does not need to be quick about it.
        this.attackCooldown = this.kind === 'hound' ? 0.95 : this.kind === 'tank' ? 1.75 : 1.2;
        this.swing = 1;
        onAttack(this, enemyDamage(this.kind, this.threat));
      }
      const res = grid.resolveCircle(this.x, this.z, this.radius, torn);
      this.x = res.x;
      this.z = res.z;
      return;
    }

    this.state = 'hunt';
    this.throwTimer -= dt;

    // A spitter that can see you stops well short and throws instead. It only
    // holds its ground while it has a shot; lose sight of it and it closes in
    // like everything else.
    if (playerAlive && this.standoff > 0 && this.seesPlayer && dist < this.standoff && dist > 5) {
      this.velX *= 0.86;
      this.velZ *= 0.86;
      this.faceTowards(dxp, dzp, dt * 5);
      if (this.throwTimer <= 0 && this.stagger <= 0) {
        this.throwTimer = 2.6 + Math.random() * 1.6;
        this.swing = 1;
        onThrow(this, px, pz);
      }
      this.thinkTimer -= dt;
      if (this.thinkTimer <= 0) {
        const interval = 0.12 + Math.random() * 0.08;
        this.thinkTimer = interval;
        this.think(grid, px, pz, dist, interval, horde);
      }
      this.phase += dt * 1.4;
      const held = grid.resolveCircle(this.x, this.z, this.radius, torn);
      this.x = held.x;
      this.z = held.z;
      return;
    }

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      const interval = 0.1 + Math.random() * 0.07;
      this.thinkTimer = interval;
      this.think(grid, px, pz, dist, interval, horde);
    }

    // In position in the road you were about to take: it holds there and makes
    // you come to it rather than walking into the crossfire of its own crowd.
    if (this.blocking && playerAlive) {
      const settle = Math.pow(0.02, dt);
      this.velX *= settle;
      this.velZ *= settle;
      this.x += this.velX * dt;
      this.z += this.velZ * dt;
      this.faceTowards(dxp, dzp, dt * 5);
      const stand = grid.resolveCircle(this.x, this.z, this.radius, torn);
      this.x = stand.x;
      this.z = stand.z;
      return;
    }

    // Heading: where you are going, once it has committed and can see you;
    // otherwise the waypoint the last think picked off its own field.
    let tx = px + this.leadX;
    let tz = pz + this.leadZ;
    if (!(this.direct && this.seesPlayer) && this.hasWaypoint) {
      tx = this.wpX;
      tz = this.wpZ;
    }
    const hx0 = tx - this.x;
    const hz0 = tz - this.z;
    const hd = Math.hypot(hx0, hz0) || 1;
    let hx = hx0 / hd;
    let hz = hz0 / hd;

    // Flankers come at you round the outside instead of queueing up behind
    // whoever got there first, and straighten out as they close in.
    if (this.arc !== 0 && this.arcOk && this.direct && this.seesPlayer && dist > ARC_FROM) {
      const a = this.arc * ARC_ANGLE * Math.min(1, (dist - ARC_FROM) / 8);
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const rx = hx * cs - hz * sn;
      hz = hx * sn + hz * cs;
      hx = rx;
    }

    // Far behind and out of sight, the dead hurry to catch up - up to twice
    // as fast across the far side of a big map, where nobody can see them do it.
    const catchUp = !this.seesPlayer && dist > 22 ? Math.min(2, 1 + (dist - 22) / 32) : 1;
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

  protected updateDeath(dt: number, grid: NavGrid): void {
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

    m.root.position.set(this.drawX, this.y + y, this.drawZ);
    m.root.rotation.set(this.lean > 0.5 ? Math.max(rx, this.lean) : rx, this.yaw, rz);
    m.root.updateMatrix();
  }

  protected faceTowards(dx: number, dz: number, rate: number): void {
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
    // Split the push by weight rather than down the middle, so the big ones
    // shoulder their way through the crowd and the crowd gives way to them.
    const total = this.mass + other.mass;
    const overlap = (min - d) * strength;
    const mine = overlap * (other.mass / total);
    const theirs = overlap * (this.mass / total);
    this.x += (dx / d) * mine;
    this.z += (dz / d) * mine;
    other.x -= (dx / d) * theirs;
    other.z -= (dz / d) * theirs;
  }

  protected animate(dt: number, gait: number): void {
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

    // Crawlers are the same body pitched onto its front, dragging. The pitch is
    // about the feet, so the draw position steps back under the body to keep it
    // straddling the point it navigates - and is shot - by.
    m.root.position.set(this.drawX, this.y, this.drawZ);
    m.root.rotation.set(this.lean, this.yaw, 0);
    m.root.updateMatrix();
  }
}

/* ------------------------------------------------------------------- pool */

export class EnemyPool {
  readonly all: Enemy[] = [];
  readonly group = new THREE.Group();

  /** The boss in play, if any. It lives in `all` while it is here. */
  boss: Enemy | null = null;

  // Bodies stay on the floor for a couple of seconds after dying, so the pool
  // holds comfortably more than the most that can be alive at once. Tanks have
  // their own bodies - slab shoulders, plated forearms - and stay rare enough
  // that a handful of them is plenty.
  constructor(humanoids = 40, hounds = 14, tanks = 4) {
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
      e.build = 'hound';
      this.all.push(e);
      this.group.add(e.model.root);
    }
    for (let i = 0; i < tanks; i++) {
      const model = buildZombie({
        skin: i % 4,
        damage: 0,
        tall: 1.08 + (i % 3) * 0.03,
        wide: 1.5 + (i % 2) * 0.06,
        outfit: 'guard',
        cloth: 3,
        bulk: true,
      });
      const e = new Enemy(model);
      e.kind = 'tank';
      e.build = 'tank';
      this.all.push(e);
      this.group.add(model.root);
    }
    for (const e of this.all) e.model.root.matrixAutoUpdate = false;
  }

  /** Grabs a free body of the right shape, or null when the pool is dry. */
  acquire(kind: EnemyKind): Enemy | null {
    const want = ENEMY_INFO[kind].build;
    for (const e of this.all) {
      if (e.active || e.isBoss) continue;
      if (e.build === want) return e;
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
      for (let j = i + 1; j < live.length; j++) live[i].separate(live[j], 0.8);
    }
    for (const e of live) {
      const res = grid.resolveCircle(e.x, e.z, e.radius, torn);
      e.x = res.x;
      e.z = res.z;
    }
  }

  /** Brings a boss into play. */
  addBoss(b: Enemy): void {
    this.removeBoss();
    this.boss = b;
    this.all.push(b);
    this.group.add(b.model.root);
  }

  /** Takes the boss out of play entirely. */
  removeBoss(): void {
    const b = this.boss;
    if (!b) return;
    b.retire();
    this.all.splice(this.all.indexOf(b), 1);
    this.group.remove(b.model.root);
    this.boss = null;
  }

  /** The nuke: everything standing collapses where it stands. Bosses shrug it off. */
  killAll(): Enemy[] {
    const killed: Enemy[] = [];
    for (const e of this.all) {
      if (e.active && e.state !== 'dead' && !e.isBoss) {
        e.applyDamage(e.health + 1, false, false, Math.random() - 0.5, Math.random() - 0.5);
        killed.push(e);
      }
    }
    return killed;
  }

  reset(): void {
    this.removeBoss();
    for (const e of this.all) e.retire();
  }
}

/**
 * Ray against a body, for hitscan weapons. The body is a cylinder capped at the
 * ankles and the crown of the head, lying along its spine - so upright it is the
 * plain vertical cylinder it always was, and stooped it lies along the body.
 *
 * That last part is the whole point. A crawler is the ordinary body pitched more
 * than a radian onto its front about its feet, which puts the head it draws over
 * a metre in front of the point it stands on. Testing a vertical cylinder there
 * meant shooting the head you could see did nothing at all, while shooting the
 * empty floor behind it scored a headshot.
 *
 * Returns how far along the ray the body is entered, and whether that is the
 * head end of it.
 */
export function rayHitsEnemy(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  e: Enemy, maxDist: number,
): { dist: number; head: boolean } | null {
  const ax = e.axisX;
  const ay = e.axisY;
  const az = e.axisZ;
  // The muzzle, relative to the foot of the spine.
  const wx = ox - e.drawX;
  const wy = oy - e.y;
  const wz = oz - e.drawZ;
  // How much of each runs along the spine, and what is left over across it.
  const du = dx * ax + dy * ay + dz * az;
  const wu = wx * ax + wy * ay + wz * az;
  const rdx = dx - du * ax;
  const rdy = dy - du * ay;
  const rdz = dz - du * az;
  const rwx = wx - wu * ax;
  const rwy = wy - wu * ay;
  const rwz = wz - wu * az;

  // The stretch of the ray inside the barrel of the cylinder.
  const r = e.hitRadius;
  const a = rdx * rdx + rdy * rdy + rdz * rdz;
  const b = 2 * (rwx * rdx + rwy * rdy + rwz * rdz);
  const c = rwx * rwx + rwy * rwy + rwz * rwz - r * r;
  let near = -Infinity;
  let far = Infinity;
  if (a > 1e-9) {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    near = (-b - root) / (2 * a);
    far = (-b + root) / (2 * a);
  } else if (c > 0) {
    // Sighted straight down the spine, and outside it.
    return null;
  }

  // Narrowed to the stretch between the two caps.
  const crown = e.spine;
  if (Math.abs(du) > 1e-9) {
    const t0 = (BODY_FOOT - wu) / du;
    const t1 = (crown - wu) / du;
    near = Math.max(near, Math.min(t0, t1));
    far = Math.min(far, Math.max(t0, t1));
  } else if (wu < BODY_FOOT || wu > crown) {
    return null;
  }

  const enter = Math.max(near, 0);
  if (enter > far || enter > maxDist) return null;

  // Which end of the body was hit goes by where the ray runs closest to the
  // spine, not by where it crosses the surface. A body lying nearly along the
  // line of fire is entered at the flank and left through the head; what the
  // crosshair was over is the head, and that is what the shot should read as.
  // For anything standing up the two are the same point anyway.
  let closest = enter;
  if (a > 1e-9) closest = Math.min(far, Math.max(enter, -b / (2 * a)));
  const up = Math.min(crown, Math.max(BODY_FOOT, wu + closest * du));
  return { dist: enter, head: up >= e.headFrom };
}

