/**
 * Bosses. Each is an Enemy with a much bigger body and a handful of moves on
 * top of the usual hunt: a ground slam, a charge, a leap, a lobbed fireball
 * or acid spit, and a roar that brings reinforcements. Every move is
 * telegraphed by a wind-up pose, so a player who is watching can get out of
 * the way (jumping clears a slam; sidestepping clears a charge).
 *
 * The boss decides what to do; the game supplies the consequences through
 * BossHooks, so this file has no idea about particles, sound or the player.
 */

import * as THREE from 'three';
import type { Rng } from '../core/rng.ts';
import { buildBoss, type BossModel } from '../gfx/bosses.ts';
import type { NavGrid } from '../world/grid.ts';
import type { BarricadeProp } from '../world/props.ts';
import { Enemy, type HitResult } from './enemy.ts';
import { enemyHealth, type EnemyKind } from './rules.ts';
import type { BossId } from './story.ts';

export type BossMove = 'slam' | 'charge' | 'leap' | 'throw';

export type BossHooks = {
  /** A ground slam centred on the boss. */
  slam(b: BossEnemy, radius: number, damage: number): void;
  /** Lobs something at a point on the ground. */
  lob(b: BossEnemy, kind: 'fireball' | 'acid', x: number, y: number, z: number, toX: number, toZ: number): void;
  summon(b: BossEnemy, kind: EnemyKind, count: number): void;
  roar(b: BossEnemy): void;
  /** Something the boss started is coming: the wind-up of a move. */
  telegraph(b: BossEnemy, move: BossMove): void;
  /** A charge or a landing caught the player. */
  strike(b: BossEnemy, damage: number, knock: number): void;
  /** A charge ran into a wall. */
  crash(b: BossEnemy): void;
};

export type BossSpec = {
  health: number;
  speed: number;
  /** Cooldown for each move it has, in seconds. */
  moves: Partial<Record<BossMove, number>>;
  /** A move only comes out once health drops below this fraction. */
  unlock?: Partial<Record<BossMove, number>>;
  throwKind?: 'fireball' | 'acid';
  /** Health fractions at which it roars for help, and who answers. */
  summonAt?: number[];
  summonKind?: EnemyKind;
  summonCount?: number;
  fireproof?: boolean;
  /** Colour of the light it carries, or 0 for none. */
  light: number;
};

export const BOSSES: Record<BossId, BossSpec> = {
  warden: {
    health: 22000, speed: 4.5, light: 0,
    moves: { slam: 5, charge: 7.5 },
  },
  butcher: {
    health: 30000, speed: 4.8, light: 0,
    moves: { slam: 6, leap: 6.5 },
    summonAt: [0.7, 0.35], summonKind: 'hound', summonCount: 4,
  },
  furnace: {
    health: 38000, speed: 4.1, light: 0xff7a2a, fireproof: true,
    moves: { slam: 5.5, throw: 3.4, charge: 10 },
    unlock: { charge: 0.5 },
    throwKind: 'fireball',
  },
  patient0: {
    health: 52000, speed: 5.0, light: 0x60ff90,
    moves: { throw: 3, leap: 7.5, slam: 6, charge: 8 },
    unlock: { charge: 0.4 },
    throwKind: 'acid',
    summonAt: [0.66, 0.33], summonKind: 'runner', summonCount: 5,
  },
};

/** Boss health scales with the round it turns up in, like everything else. */
export function bossHealth(id: BossId, round: number): number {
  return Math.round(BOSSES[id].health * Math.max(0.6, enemyHealth(round) / 950));
}

/** How long each move is telegraphed before it happens. */
const WINDUP: Record<BossMove, number> = { slam: 0.8, charge: 0.75, leap: 0.6, throw: 0.55 };

const CHARGE_SPEED = 21;
const CHARGE_TIME = 1.5;
const SLAM_RADIUS = 8;
const SLAM_DAMAGE = 50;
const LEAP_SLAM_RADIUS = 7;
const LEAP_SLAM_DAMAGE = 45;
const CHARGE_DAMAGE = 55;

type Action = 'none' | 'windup' | 'recover' | 'charge' | 'leap' | 'summon' | 'dazed';

export class BossEnemy extends Enemy {
  readonly id: BossId;
  readonly spec: BossSpec;
  readonly bossModel: BossModel;
  hooks: BossHooks | null = null;

  private action: Action = 'none';
  private actionT = 0;
  private actionDur = 0;
  private pending: BossMove | null = null;
  private readonly cooldowns = new Map<BossMove, number>();
  private summons = 0;
  private dirX = 0;
  private dirZ = 0;
  private fromX = 0;
  private fromZ = 0;
  private toX = 0;
  private toZ = 0;
  private pulse = 0;
  private dice: Rng | null = null;

  constructor(id: BossId) {
    const model = buildBoss(id);
    super(model);
    this.id = id;
    this.spec = BOSSES[id];
    this.bossModel = model;
    model.root.matrixAutoUpdate = false;
  }

  override get isBoss(): boolean {
    return true;
  }

  override get fireproof(): boolean {
    return Boolean(this.spec.fireproof);
  }

  /** A boss never wanders off to be recycled. */
  override get lost(): boolean {
    return false;
  }

  /** Dazed after running into a wall: it takes extra damage. */
  get dazed(): boolean {
    return this.action === 'dazed';
  }

  /** What it is doing, for the HUD and tests. */
  get currentAction(): Action {
    return this.action;
  }

  get healthFraction(): number {
    return Math.max(0, this.health / Math.max(1, this.maxHealth));
  }

  /** Brings it in through a window, or straight into the hunt when there is none. */
  begin(x: number, z: number, health: number, barricade: BarricadeProp | null, rng: Rng, hooks: BossHooks): void {
    this.spawn('brute', x, z, health, 1, barricade, rng);
    this.speed = this.spec.speed;
    this.hooks = hooks;
    this.dice = rng;
    this.action = 'none';
    this.pending = null;
    this.summons = 0;
    this.cooldowns.clear();
    // Nothing fancy for the first few seconds: let the player get a look at it.
    for (const [move, cd] of Object.entries(this.spec.moves) as [BossMove, number][]) {
      this.cooldowns.set(move, cd * 0.6 + rng.range(0, 1.5));
    }
  }

  override applyDamage(amount: number, head: boolean, explosive: boolean, dirX = 0, dirZ = 0): HitResult {
    const dealt = amount * (this.dazed ? 1.5 : 1);
    // No ice-statue finish for a boss: a killing blow thaws it first.
    if (dealt >= this.health) this.frozen = 0;
    const res = super.applyDamage(dealt, head, explosive, dirX, dirZ);
    if (res.killed) {
      this.deathKind = 'crumple';
      this.fallTime = 1.7;
      this.pushX = 0;
      this.pushZ = 0;
      this.action = 'none';
      this.y = 0;
      this.model.root.visible = true;
    } else {
      // Bullets barely move it, and never stop it swinging.
      this.pushX *= 0.06;
      this.pushZ *= 0.06;
      this.stagger = 0;
      this.flinchV *= 0.35;
      this.rollV *= 0.35;
      this.headSnapV *= 0.5;
    }
    return { ...res, gibbed: false, shattered: false };
  }

  /** Rips the boards off in a hurry. */
  protected override updateBreach(dt: number, onBoardBreak: (e: Enemy, b: BarricadeProp) => void): void {
    super.updateBreach(dt, onBoardBreak);
    this.stateTimer = Math.min(this.stateTimer, 0.18);
  }

  protected override updateHunt(
    dt: number, grid: NavGrid, px: number, pz: number, playerAlive: boolean,
    torn: Set<number>, onAttack: (e: Enemy, dmg: number) => void,
  ): void {
    for (const [k, v] of this.cooldowns) this.cooldowns.set(k, v - dt);
    this.stagger = 0;

    if (this.action !== 'none') {
      this.runAction(dt, grid, px, pz, torn);
      return;
    }
    if (!playerAlive) {
      super.updateHunt(dt, grid, px, pz, playerAlive, torn, onAttack);
      return;
    }

    // Roar for help as it gets hurt.
    const at = this.spec.summonAt ?? [];
    if (this.summons < at.length && this.healthFraction <= at[this.summons]) {
      this.summons++;
      this.start('summon', 1.4);
      this.hooks?.roar(this);
      return;
    }

    const dist = Math.hypot(px - this.x, pz - this.z);
    const move = this.chooseMove(dist);
    if (move) {
      this.pending = move;
      this.start('windup', WINDUP[move] * (this.enraged ? 0.75 : 1));
      this.hooks?.telegraph(this, move);
      return;
    }
    super.updateHunt(dt, grid, px, pz, playerAlive, torn, onAttack);
  }

  /** Below a third of its health it is faster and winds up quicker. */
  get enraged(): boolean {
    return this.healthFraction < 0.33;
  }

  private chooseMove(dist: number): BossMove | null {
    const ready: BossMove[] = [];
    for (const [move] of Object.entries(this.spec.moves) as [BossMove, number][]) {
      if ((this.cooldowns.get(move) ?? 0) > 0) continue;
      const gate = this.spec.unlock?.[move];
      if (gate !== undefined && this.healthFraction > gate) continue;
      const ok =
        move === 'slam' ? dist < 7 :
        move === 'charge' ? this.seesPlayer && dist > 11 && dist < 42 :
        move === 'leap' ? this.seesPlayer && dist > 10 && dist < 34 :
        this.seesPlayer && dist > 8 && dist < 46;
      if (ok) ready.push(move);
    }
    if (!ready.length) return null;
    return this.dice ? this.dice.pick(ready) : ready[0];
  }

  private start(action: Action, duration: number): void {
    this.action = action;
    this.actionT = 0;
    this.actionDur = duration;
    this.velX = 0;
    this.velZ = 0;
  }

  private cool(move: BossMove): void {
    const cd = this.spec.moves[move] ?? 5;
    this.cooldowns.set(move, cd * (this.enraged ? 0.7 : 1));
  }

  private runAction(dt: number, grid: NavGrid, px: number, pz: number, torn: Set<number>): void {
    this.actionT += dt;
    const done = this.actionT >= this.actionDur;
    switch (this.action) {
      case 'windup':
        this.faceTowards(px - this.x, pz - this.z, dt * 7);
        if (done && this.pending) this.execute(this.pending, grid, px, pz);
        break;
      case 'recover':
        if (done) this.action = 'none';
        break;
      case 'summon':
        if (done) {
          const kind = this.spec.summonKind;
          if (kind) this.hooks?.summon(this, kind, this.spec.summonCount ?? 3);
          this.action = 'none';
        }
        break;
      case 'dazed':
        if (done) this.action = 'none';
        break;
      case 'charge': {
        const step = CHARGE_SPEED * (this.enraged ? 1.15 : 1) * dt;
        const res = grid.resolveCircle(this.x + this.dirX * step, this.z + this.dirZ * step, this.radius, torn);
        const moved = Math.hypot(res.x - this.x, res.z - this.z);
        this.x = res.x;
        this.z = res.z;
        this.velX = this.dirX * CHARGE_SPEED;
        this.velZ = this.dirZ * CHARGE_SPEED;
        if (Math.hypot(px - this.x, pz - this.z) < this.radius + 1.6) {
          this.hooks?.strike(this, CHARGE_DAMAGE, 22);
          this.start('recover', 0.7);
        } else if (moved < step * 0.3 && this.actionT > 0.15) {
          this.hooks?.crash(this);
          this.start('dazed', 1.9);
        } else if (done) {
          this.start('recover', 0.5);
        }
        break;
      }
      case 'leap': {
        const t = Math.min(1, this.actionT / this.actionDur);
        this.x = this.fromX + (this.toX - this.fromX) * t;
        this.z = this.fromZ + (this.toZ - this.fromZ) * t;
        this.y = Math.sin(t * Math.PI) * (4 + this.actionDur * 2);
        if (done) {
          this.y = 0;
          const res = grid.resolveCircle(this.x, this.z, this.radius, torn);
          this.x = res.x;
          this.z = res.z;
          this.hooks?.slam(this, LEAP_SLAM_RADIUS, LEAP_SLAM_DAMAGE);
          this.start('recover', 0.8);
        }
        break;
      }
      default:
        this.action = 'none';
    }
  }

  private execute(move: BossMove, grid: NavGrid, px: number, pz: number): void {
    this.cool(move);
    this.pending = null;
    switch (move) {
      case 'slam':
        this.hooks?.slam(this, SLAM_RADIUS, SLAM_DAMAGE);
        this.start('recover', 0.9);
        break;
      case 'charge': {
        const d = Math.hypot(px - this.x, pz - this.z) || 1;
        this.dirX = (px - this.x) / d;
        this.dirZ = (pz - this.z) / d;
        this.yaw = Math.atan2(this.dirX, this.dirZ);
        this.start('charge', CHARGE_TIME);
        break;
      }
      case 'leap': {
        // Only somewhere it can see and reach in a straight line.
        let tx = px;
        let tz = pz;
        const d = Math.hypot(tx - this.x, tz - this.z);
        if (d > 32) {
          tx = this.x + ((tx - this.x) / d) * 32;
          tz = this.z + ((tz - this.z) / d) * 32;
        }
        if (!grid.lineOfSight(this.x, this.z, tx, tz)) {
          this.start('recover', 0.3);
          break;
        }
        this.fromX = this.x;
        this.fromZ = this.z;
        this.toX = tx;
        this.toZ = tz;
        this.yaw = Math.atan2(tx - this.x, tz - this.z);
        this.start('leap', 0.55 + Math.min(32, d) / 45);
        break;
      }
      case 'throw': {
        const kind = this.spec.throwKind ?? 'fireball';
        const handX = this.x + Math.sin(this.yaw) * 1.2 + Math.cos(this.yaw) * 1.1;
        const handZ = this.z + Math.cos(this.yaw) * 1.2 - Math.sin(this.yaw) * 1.1;
        const handY = this.model.height * 0.85;
        const volley = this.enraged || this.healthFraction < 0.5 ? 3 : 1;
        for (let i = 0; i < volley; i++) {
          const off = (i - (volley - 1) / 2) * 4.5;
          const sx = Math.cos(this.yaw) * off;
          const sz = -Math.sin(this.yaw) * off;
          this.hooks?.lob(this, kind, handX, handY, handZ, px + sx, pz + sz);
        }
        this.start('recover', 0.5);
        break;
      }
    }
  }

  protected override animate(dt: number, gait: number): void {
    super.animate(dt, gait);
    const m = this.model;
    const t = this.actionDur > 0 ? Math.min(1, this.actionT / this.actionDur) : 1;
    switch (this.action) {
      case 'windup': {
        if (this.pending === 'slam') {
          // Both fists up over the head.
          m.armL.rotation.set(-1.32 - 1.7 * t, 0, -0.25 * t);
          m.armR.rotation.set(-1.32 - 1.7 * t, 0, 0.25 * t);
          m.body.rotation.x = 0.22 - 0.4 * t;
          m.head.rotation.x = -0.4 * t;
        } else if (this.pending === 'charge') {
          // Head down, shoulders forward, pawing the ground.
          m.body.rotation.x = 0.22 + 0.5 * t;
          m.head.rotation.x = 0.35 * t;
          m.armL.rotation.set(-0.3, 0, -0.4);
          m.armR.rotation.set(-0.3, 0, 0.4);
          m.legL.rotation.x = Math.sin(this.actionT * 18) * 0.4 * t;
        } else if (this.pending === 'leap') {
          // A deep crouch.
          m.body.rotation.x = 0.22 + 0.6 * t;
          m.legL.rotation.x = -0.7 * t;
          m.legR.rotation.x = -0.7 * t;
          m.armL.rotation.set(-0.2 * t, 0, -0.5 * t);
          m.armR.rotation.set(-0.2 * t, 0, 0.5 * t);
        } else if (this.pending === 'throw') {
          // Right arm drawn back.
          m.armR.rotation.set(-1.32 - 1.9 * t, 0, 0.3);
          m.body.rotation.y = -0.4 * t;
        }
        break;
      }
      case 'recover': {
        // Fists in the floor after a slam, or the follow-through of a throw.
        const k = 1 - t;
        m.armL.rotation.x = -1.32 + 0.9 * k;
        m.armR.rotation.x = -1.32 + 0.9 * k;
        m.body.rotation.x = 0.22 + 0.45 * k;
        m.body.rotation.y = 0;
        break;
      }
      case 'charge':
        m.body.rotation.x = 0.75;
        m.head.rotation.x = 0.3;
        m.armL.rotation.set(-0.2 + Math.sin(this.phase * 2) * 0.6, 0, -0.3);
        m.armR.rotation.set(-0.2 - Math.sin(this.phase * 2) * 0.6, 0, 0.3);
        break;
      case 'leap':
        m.armL.rotation.set(-2.7, 0, -0.3);
        m.armR.rotation.set(-2.7, 0, 0.3);
        m.legL.rotation.x = -0.9;
        m.legR.rotation.x = 0.4;
        m.body.rotation.x = 0.1;
        break;
      case 'summon': {
        // Arms flung wide, head thrown back.
        const k = Math.sin(t * Math.PI);
        m.armL.rotation.set(-1.2, 0, -1.3 * k);
        m.armR.rotation.set(-1.2, 0, 1.3 * k);
        m.body.rotation.x = 0.22 - 0.45 * k;
        m.head.rotation.x = -0.7 * k;
        m.jaw.rotation.x = 0.2 + 0.7 * k;
        break;
      }
      case 'dazed':
        m.body.rotation.z = Math.sin(this.actionT * 5) * 0.25;
        m.body.rotation.x = 0.5;
        m.head.rotation.set(0.6, 0, Math.sin(this.actionT * 3) * 0.4);
        m.armL.rotation.set(-0.2, 0, -0.2);
        m.armR.rotation.set(-0.2, 0, 0.2);
        break;
      default:
        break;
    }
    if (this.action !== 'windup' || this.pending !== 'throw') m.body.rotation.y = 0;

    // Glowing parts breathe, faster and brighter as it gets angrier.
    this.pulse += dt * (this.enraged ? 9 : 3.5);
    const glow = 0.8 + 0.25 * Math.sin(this.pulse) + (this.enraged ? 0.35 : 0);
    for (const g of this.bossModel.glows) g.mat.color.copy(g.base).multiplyScalar(glow);
  }

  /** Where its light should sit. */
  lightPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.x, this.y + this.model.height * 0.6, this.z);
  }
}
