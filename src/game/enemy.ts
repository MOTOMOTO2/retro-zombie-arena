/**
 * The horde.
 *
 * Every enemy is a tiny state machine: walk in from outside, tear the boards off
 * a window, climb through, then follow the shared flow field to the player and
 * swing. Steering is flow field plus a separation push, so a crowd funnels
 * through doorways and spreads out in the open instead of stacking into one
 * conga line.
 */

import * as THREE from 'three';
import { NavGrid } from '../world/grid.ts';
import { TILE, tileCenter, worldToTile } from '../world/mapdata.ts';
import { buildHound, buildZombie, type ZombieModel } from '../gfx/models.ts';
import { Rng } from '../core/rng.ts';
import { enemyDamage, enemySpeed, type EnemyKind } from './rules.ts';
import type { BarricadeProp } from '../world/props.ts';

export type EnemyState = 'idle' | 'approach' | 'breach' | 'climb' | 'hunt' | 'attack' | 'dead';

export type HitResult = {
  killed: boolean;
  head: boolean;
  gibbed: boolean;
  damageDealt: number;
};

const UP = new THREE.Vector3(0, 1, 0);

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
  private phase = 0;
  private stateTimer = 0;
  private attackCooldown = 0;
  private swing = 0;
  private groanTimer = 0;
  private deadTimer = 0;
  private stuckTimer = 0;
  private lastDist = 0;
  private velX = 0;
  private velZ = 0;

  constructor(model: ZombieModel) {
    this.model = model;
    this.model.root.visible = false;
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
    this.speed = enemySpeed(round, kind) * rng.range(0.88, 1.12);
    this.radius = this.model.radius;
    this.target = barricade;
    this.state = barricade ? 'approach' : 'hunt';
    this.phase = rng.range(0, Math.PI * 2);
    this.stateTimer = 0;
    this.attackCooldown = rng.range(0, 0.4);
    this.swing = 0;
    this.groanTimer = rng.range(0.5, 4);
    this.deadTimer = 0;
    this.stuckTimer = 0;
    this.lastDist = 1e9;
    this.velX = 0;
    this.velZ = 0;
    this.model.root.visible = true;
    this.model.root.position.set(x, 0, z);
    this.model.root.rotation.set(0, 0, 0);
    this.model.root.scale.setScalar(1);
    this.model.body.rotation.set(0, 0, 0);
    this.model.head.rotation.set(0, 0, 0);
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

  applyDamage(amount: number, head: boolean, explosive: boolean): HitResult {
    if (this.state === 'dead') return { killed: false, head, gibbed: false, damageDealt: 0 };
    const before = this.health;
    this.health -= amount;
    const dealt = Math.min(before, amount);
    if (this.health > 0) {
      return { killed: false, head, gibbed: false, damageDealt: dealt };
    }
    // Massive overkill tears the body apart; so does anything explosive.
    const gibbed = explosive || amount > this.maxHealth * 1.8 || (head && amount > this.maxHealth);
    this.state = 'dead';
    this.deadTimer = gibbed ? 0.08 : 1.1;
    return { killed: true, head, gibbed, damageDealt: dealt };
  }

  /* --------------------------------------------------------------- update */

  update(
    dt: number, grid: NavGrid, px: number, pz: number, playerAlive: boolean,
    torn: Set<number>, onAttack: (e: Enemy, dmg: number) => void,
    onBoardBreak: (e: Enemy, b: BarricadeProp) => void,
    onGroan: (e: Enemy) => void,
  ): void {
    if (!this.active) return;

    if (this.state === 'dead') {
      this.deadTimer -= dt;
      // Crumple: fall forward and sink into the floor.
      const t = Math.max(0, Math.min(1, 1 - this.deadTimer / 1.1));
      this.model.root.rotation.x = -t * 1.45;
      this.model.root.position.y = -t * 0.9;
      if (this.deadTimer <= 0) this.retire();
      return;
    }

    this.phase += dt * (2.4 + this.speed * 0.55);
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

    this.animate(dt);
  }

  /** Walk from the outside spawn point up to the window. */
  private updateApproach(dt: number): void {
    const b = this.target;
    if (!b) {
      this.state = 'hunt';
      return;
    }
    const outside = {
      x: b.center.x + b.def.dx * TILE * 0.85,
      z: b.center.z + b.def.dz * TILE * 0.85,
    };
    const dx = outside.x - this.x;
    const dz = outside.z - this.z;
    const d = Math.hypot(dx, dz);
    this.faceTowards(dx, dz, dt);
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
      this.stateTimer = 0.62;
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
    const t = Math.min(1, this.stateTimer / 1.15);
    const from = {
      x: b.center.x + b.def.dx * TILE * 0.85,
      z: b.center.z + b.def.dz * TILE * 0.85,
    };
    this.x = from.x + (inside.x - from.x) * t;
    this.z = from.z + (inside.z - from.z) * t;
    this.y = Math.sin(t * Math.PI) * 1.05;
    this.faceTowards(-b.def.dx, -b.def.dz, dt * 4);
    if (t >= 1) {
      this.y = 0;
      this.target = null;
      this.state = 'hunt';
    }
  }

  private updateHunt(
    dt: number, grid: NavGrid, px: number, pz: number, playerAlive: boolean,
    torn: Set<number>, onAttack: (e: Enemy, dmg: number) => void,
  ): void {
    const dxp = px - this.x;
    const dzp = pz - this.z;
    const distToPlayer = Math.hypot(dxp, dzp);
    const reach = this.radius + (this.kind === 'hound' ? 1.5 : 1.35);

    this.attackCooldown -= dt;

    if (playerAlive && distToPlayer <= reach) {
      this.state = 'attack';
      this.faceTowards(dxp, dzp, dt * 6);
      if (this.attackCooldown <= 0) {
        this.attackCooldown = this.kind === 'hound' ? 0.95 : 1.25;
        this.swing = 1;
        onAttack(this, enemyDamage(this.kind));
      }
      return;
    }

    this.state = 'hunt';

    // Pick a heading: straight at the player when visible, otherwise the field.
    let hx = 0;
    let hz = 0;
    const canSee = distToPlayer < 26 && grid.lineOfSight(this.x, this.y + 2, px, pz);
    if (canSee && distToPlayer > 0.01) {
      hx = dxp / distToPlayer;
      hz = dzp / distToPlayer;
    } else {
      const { tx, tz } = worldToTile(this.x, this.z);
      const flow = grid.flowAt(tx, tz);
      if (flow && (flow.dx !== 0 || flow.dz !== 0)) {
        // Aim at the centre of the next tile so corners are cut cleanly.
        const next = tileCenter(tx + flow.dx, tz + flow.dz);
        const ndx = next.x - this.x;
        const ndz = next.z - this.z;
        const nd = Math.hypot(ndx, ndz) || 1;
        hx = ndx / nd;
        hz = ndz / nd;
      } else if (distToPlayer > 0.01) {
        hx = dxp / distToPlayer;
        hz = dzp / distToPlayer;
      }
    }

    const speed = this.speed * (this.state === 'hunt' ? 1 : 0.4);
    this.velX = hx * speed;
    this.velZ = hz * speed;
    this.x += this.velX * dt;
    this.z += this.velZ * dt;

    const res = grid.resolveCircle(this.x, this.z, this.radius, torn);
    this.x = res.x;
    this.z = res.z;

    // A zombie wedged on scenery for too long gets nudged sideways.
    if (distToPlayer > this.lastDist - 0.02) this.stuckTimer += dt;
    else this.stuckTimer = 0;
    this.lastDist = distToPlayer;
    if (this.stuckTimer > 1.2) {
      this.stuckTimer = 0;
      const side = Math.random() < 0.5 ? 1 : -1;
      const nudge = grid.resolveCircle(
        this.x + -hz * side * 1.4, this.z + hx * side * 1.4, this.radius, torn,
      );
      this.x = nudge.x;
      this.z = nudge.z;
    }

    if (hx !== 0 || hz !== 0) this.faceTowards(hx, hz, dt * 7);
  }

  private faceTowards(dx: number, dz: number, rate: number): void {
    if (dx === 0 && dz === 0) return;
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

  private animate(dt: number): void {
    const m = this.model;
    const moving = this.state === 'hunt' || this.state === 'approach';
    const swingAmp = moving ? 0.85 : 0.12;

    if (this.kind === 'hound') {
      // Gallop: front and back legs out of phase, body bounding.
      const g = Math.sin(this.phase * 1.6);
      m.legL.rotation.x = g * 0.9;
      m.legR.rotation.x = g * 0.9;
      m.armL.rotation.x = -g * 0.9;
      m.armR.rotation.x = -g * 0.9;
      m.body.position.y = 1.05 + Math.abs(g) * 0.16;
      m.body.rotation.x = g * 0.1;
      m.jaw.rotation.x = 0.3 + Math.abs(Math.sin(this.phase * 2)) * 0.4;
    } else {
      const s = Math.sin(this.phase);
      const c = Math.cos(this.phase);
      m.legL.rotation.x = s * swingAmp;
      m.legR.rotation.x = -s * swingAmp;
      // The lurch: shoulders roll opposite the hips, head lolls behind.
      m.body.rotation.z = c * 0.09;
      m.body.rotation.x = -0.13 + Math.abs(s) * 0.05;
      m.body.position.y = 1.5 + Math.abs(s) * 0.08;
      m.head.rotation.z = -c * 0.16;
      m.head.rotation.x = 0.12 + s * 0.05;
      m.armL.rotation.z = c * 0.1;
      m.armR.rotation.z = -c * 0.1;
      m.jaw.rotation.x = 0.16 + Math.abs(c) * 0.2;
    }

    // Attack / board-tearing swing overrides the arms for a beat.
    if (this.swing > 0) {
      this.swing = Math.max(0, this.swing - dt * 2.6);
      const a = Math.sin((1 - this.swing) * Math.PI);
      if (this.kind === 'hound') {
        m.body.rotation.x = -a * 0.5;
        m.jaw.rotation.x = 0.3 + a * 0.7;
      } else {
        m.armL.rotation.x = -1.32 - a * 1.5;
        m.armR.rotation.x = -1.32 - a * 1.5;
        m.body.rotation.x = -0.13 - a * 0.25;
      }
    }

    m.root.position.set(this.x, this.y, this.z);
    m.root.rotation.y = this.yaw;
    m.root.updateMatrix();
  }
}

/* ------------------------------------------------------------------- pool */

export class EnemyPool {
  readonly all: Enemy[] = [];
  readonly group = new THREE.Group();

  constructor(humanoids = 30, hounds = 12) {
    for (let i = 0; i < humanoids; i++) {
      const model = buildZombie({
        skin: i % 4,
        damage: i % 5,
        tall: 0.92 + (i % 7) * 0.026,
        wide: 0.94 + (i % 5) * 0.03,
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

  killAll(): Enemy[] {
    const killed: Enemy[] = [];
    for (const e of this.all) {
      if (e.active && e.state !== 'dead') {
        e.applyDamage(1e9, false, true);
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

const _tmp = new THREE.Vector3();

/** Screen-independent helper: world-space aim ray from a camera. */
export function cameraRay(camera: THREE.Camera): THREE.Vector3 {
  camera.getWorldDirection(_tmp);
  return _tmp;
}

export { UP };
