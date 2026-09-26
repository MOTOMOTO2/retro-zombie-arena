/**
 * The horde's shared brain.
 *
 * Left to itself every body in the crowd walks the same flow field, which means
 * they all arrive down the same corridor in single file and you can hold a
 * doorway all night. This is what stops that.
 *
 * It keeps four goals and a flow field for each: the player, a point out to
 * either side of them, and a point up the road they are running down. Every
 * body is dealt a role a couple of times a second - come straight in, swing
 * round the left, swing round the right, or get in front and stand in the way -
 * and follows that goal's field until it is close enough to see the whites of
 * your eyes, at which point it drops the manoeuvre and charges. The ones
 * already in the fight are never reassigned; it is the back of the crowd, which
 * has room to move, that does the work.
 *
 * Bodies that can see you walk at where you are *going*, not where you are, and
 * flankers arc round the outside rather than queueing up behind whoever got
 * there first. A body sent to cut you off will stand in the road for a few
 * seconds waiting for you to come to it - but only a few, so the horde can
 * never stall into a standoff.
 *
 * How much of this is switched on depends on the round: the first two are the
 * dumb straight line the game always had, and it ramps from there, sooner in
 * the chapters that are already trying to kill you faster.
 */

import { FIELD_SLOTS, type NavGrid } from '../world/grid.ts';
import { tileCenter, worldToTile } from '../world/mapdata.ts';
import type { Enemy } from './enemy.ts';

/** What a body has been told to do about you. */
export type HordeRole = 'chase' | 'left' | 'right' | 'cutoff';

/** Which flow-field slot each role follows. */
export const ROLE_SLOT: Record<HordeRole, number> = { chase: 0, left: 1, right: 2, cutoff: 3 };

/** How far out to the side a flanking body is sent before it closes in. */
const FLANK_OUT = 11;
/** How far up the road a body is sent to get in front of you. */
const CUTOFF_AHEAD = 15;

/** Inside this, a body forgets whatever it was told and comes straight at you. */
export const COMMIT_RANGE = 9;
/** Within this of its own goal, a body counts as having arrived. */
export const GOAL_RANGE = 4.5;
/** Longest one will stand in your way waiting for you to walk into it. */
export const HOLD_SECONDS = 3;

/** Seconds between field rebuilds, and between deals of the roles. */
const FIELD_INTERVAL = 0.14;
const ROLE_INTERVAL = 0.4;

/** Where the player is and which way they are pointed. */
export type HordeTarget = {
  x: number;
  z: number;
  /** Unit vector on the floor for the way they are looking. */
  fx: number;
  fz: number;
};

/** One of the four goals: where it is, and whether its field is worth following. */
export type HordeGoal = { x: number; z: number; live: boolean };

/**
 * Which kinds will ever try to get in front of you. The heavy ones are the
 * anvil - far too slow to cut anybody off - so they never leave the straight
 * line, which is also what makes them read as heavy.
 */
export function manoeuvres(kind: Enemy['kind']): boolean {
  return kind !== 'tank' && kind !== 'brute' && kind !== 'crawler' && kind !== 'armoured';
}

export class Horde {
  /** How well they work together, 0 (straight line) to 1 (pincers). */
  cunning = 0;
  /** The player, as of the last tick. */
  px = 0;
  pz = 0;
  /** Their drift in world units a second, smoothed enough to lead. */
  vx = 0;
  vz = 0;
  /** Unit vector for the way they are heading: their drift, or their eyes. */
  dirX = 0;
  dirZ = 1;

  readonly goals: HordeGoal[] = [];

  private fieldTimer = 0;
  private roleTimer = 0;
  /** Which secondary slot gets rebuilt this tick. */
  private cursor = 1;
  private lastPx = 0;
  private lastPz = 0;
  private started = false;

  constructor() {
    for (let s = 0; s < FIELD_SLOTS; s++) this.goals.push({ x: 0, z: 0, live: false });
  }

  /** Forget everything: a new map, or a new run. */
  reset(): void {
    this.started = false;
    this.fieldTimer = 0;
    this.roleTimer = 0;
    this.cursor = 1;
    this.vx = 0;
    this.vz = 0;
    for (const g of this.goals) g.live = false;
  }

  update(
    dt: number, grid: NavGrid, torn: Set<number>,
    target: HordeTarget, enemies: readonly Enemy[], cunning: number,
  ): void {
    this.cunning = Math.max(0, Math.min(1, cunning));
    if (!this.started) {
      this.started = true;
      this.lastPx = target.x;
      this.lastPz = target.z;
    }
    // Drift from where they were a moment ago, smoothed hard: raw frame-to-frame
    // movement jitters far too much to aim at.
    if (dt > 1e-4) {
      const k = Math.min(1, dt * 5);
      this.vx += ((target.x - this.lastPx) / dt - this.vx) * k;
      this.vz += ((target.z - this.lastPz) / dt - this.vz) * k;
    }
    this.lastPx = target.x;
    this.lastPz = target.z;
    this.px = target.x;
    this.pz = target.z;

    // The way they are going: their drift while they are moving, the way they
    // are looking while they are standing still.
    let dx = this.vx;
    let dz = this.vz;
    let d = Math.hypot(dx, dz);
    if (d < 1.5) {
      dx = target.fx;
      dz = target.fz;
      d = Math.hypot(dx, dz);
    }
    if (d > 1e-4) {
      this.dirX = dx / d;
      this.dirZ = dz / d;
    }

    this.fieldTimer -= dt;
    if (this.fieldTimer <= 0) {
      this.fieldTimer = FIELD_INTERVAL;
      // The player's own field every tick - everything falls back to it - and
      // one of the three manoeuvring fields in turn.
      this.rebuild(grid, torn, ROLE_SLOT.chase, target.x, target.z);
      const slot = this.cursor;
      this.cursor = 1 + (this.cursor % (FIELD_SLOTS - 1));
      if (this.cunning <= 0.02) {
        this.goals[slot].live = false;
      } else if (slot === ROLE_SLOT.left) {
        this.rebuild(grid, torn, slot, target.x - this.dirZ * FLANK_OUT, target.z + this.dirX * FLANK_OUT);
      } else if (slot === ROLE_SLOT.right) {
        this.rebuild(grid, torn, slot, target.x + this.dirZ * FLANK_OUT, target.z - this.dirX * FLANK_OUT);
      } else {
        this.rebuild(grid, torn, slot, target.x + this.dirX * CUTOFF_AHEAD, target.z + this.dirZ * CUTOFF_AHEAD);
      }
    }

    this.roleTimer -= dt;
    if (this.roleTimer <= 0) {
      this.roleTimer = ROLE_INTERVAL;
      this.assign(enemies);
    }
  }

  /** Distance from the player to a body, on the floor. */
  distTo(e: Enemy): number {
    return Math.hypot(e.x - this.px, e.z - this.pz);
  }

  /**
   * Rebuilds one slot's field toward a point. The point itself is often inside a
   * wall - eleven metres to your left may well be the next room - so it is
   * nudged to the nearest tile a body could stand in first, and the slot goes
   * dark when there is nowhere near it to stand at all.
   */
  private rebuild(grid: NavGrid, torn: Set<number>, slot: number, wantX: number, wantZ: number): void {
    const goal = this.goals[slot];
    const t = worldToTile(wantX, wantZ);
    const open = grid.nearestOpen(t.tx, t.tz, torn);
    if (!open || !grid.buildFlowField(open.tx, open.tz, torn, slot)) {
      goal.live = false;
      return;
    }
    const c = tileCenter(open.tx, open.tz);
    goal.x = c.x;
    goal.z = c.z;
    goal.live = true;
  }

  /**
   * Deals the roles out. Nearest first, so whoever is already swinging at you
   * keeps doing that, and the bodies with room to move are the ones sent wide.
   */
  private assign(enemies: readonly Enemy[]): void {
    const crowd: Enemy[] = [];
    for (const e of enemies) {
      if (!e.active || e.isBoss) continue;
      if (e.state !== 'hunt' && e.state !== 'attack') continue;
      crowd.push(e);
    }
    if (!crowd.length) return;
    crowd.sort((a, b) => this.distTo(a) - this.distTo(b));

    let flanks = Math.round(crowd.length * 0.42 * this.cunning);
    let cuts = Math.round(crowd.length * 0.26 * this.cunning);
    let left = 0;
    let right = 0;

    for (const e of crowd) {
      const d = this.distTo(e) || 1;
      if (d < COMMIT_RANGE) {
        e.setRole('chase');
        continue;
      }
      // How far up the road it already is, and which side of it it is on.
      const ahead = ((e.x - this.px) * this.dirX + (e.z - this.pz) * this.dirZ) / d;
      const across = (e.x - this.px) * -this.dirZ + (e.z - this.pz) * this.dirX;
      const nimble = manoeuvres(e.kind);
      if (cuts > 0 && nimble && (ahead > -0.1 || e.kind === 'runner' || e.kind === 'hound')) {
        e.setRole('cutoff');
        cuts--;
        continue;
      }
      if (flanks > 0) {
        // Each one takes the side it is already on, unless that side is getting
        // crowded - a pincer wants a body in each claw.
        let goLeft = across >= 0;
        if (left > right + 1) goLeft = false;
        else if (right > left + 1) goLeft = true;
        if (goLeft) left++;
        else right++;
        e.setRole(goLeft ? 'left' : 'right');
        flanks--;
        continue;
      }
      if (cuts > 0 && nimble) {
        e.setRole('cutoff');
        cuts--;
        continue;
      }
      e.setRole('chase');
    }
  }
}
