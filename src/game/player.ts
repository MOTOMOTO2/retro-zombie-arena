/**
 * Player state: movement, health, wallet, perks and the two-weapon inventory.
 *
 * Kept free of three.js so the rules stay readable - the game loop owns the
 * camera and simply mirrors these numbers onto it each frame.
 */

import { NavGrid } from '../world/grid.ts';
import {
  BASE_HEALTH,
  maxHealth as perkMaxHealth,
  moveSpeed,
  regenDelay,
  regenRate,
  sprintMultiplier,
  type PerkId,
} from './rules.ts';
import { fireInterval, getWeapon, reloadDuration, startingAmmo, type WeaponDef } from './weapons.ts';

export const PLAYER_RADIUS = 0.82;
export const EYE_HEIGHT = 3.05;
export const GRAVITY = 34;
export const JUMP_SPEED = 10.2;
export const MAX_SLOTS = 2;

export type Slot = {
  id: string;
  mag: number;
  reserve: number;
  packed: boolean;
};

export type FireOutcome =
  | { kind: 'none' }
  | { kind: 'dry' }
  | { kind: 'shoot'; def: WeaponDef; pellets: number }
  | { kind: 'melee' }
  | { kind: 'throw' };

export class Player {
  x = 0;
  z = 0;
  y = 0;
  vy = 0;
  yaw = 0;
  pitch = 0;

  health = BASE_HEALTH;
  points = 500;
  totalPoints = 500;
  kills = 0;
  headshots = 0;
  downs = 0;

  readonly perks = new Set<PerkId>();
  slots: Slot[] = [];
  activeSlot = 0;
  grenades = 0;
  hasGrenades = false;

  alive = true;
  grounded = true;
  sprinting = false;
  stamina = 1;

  /** Seconds since the last time something hurt us. */
  private sinceDamage = 99;
  private fireTimer = 0;
  private reloadTimer = 0;
  private reloadingSlot = -1;
  private shellReloadPending = false;
  private swapTimer = 0;
  private pendingSlot = -1;
  private meleeTimer = 0;
  private grenadeTimer = 0;
  /** Speed of the horizontal movement last frame, for bob and audio. */
  planarSpeed = 0;

  reset(x: number, z: number): void {
    this.x = x;
    this.z = z;
    this.y = 0;
    this.vy = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.health = BASE_HEALTH;
    this.points = 500;
    this.totalPoints = 500;
    this.kills = 0;
    this.headshots = 0;
    this.downs = 0;
    this.perks.clear();
    this.slots = [{ id: 'sidearm', ...startingAmmo(getWeapon('sidearm')), packed: false }];
    this.activeSlot = 0;
    this.grenades = 0;
    this.hasGrenades = false;
    this.alive = true;
    this.grounded = true;
    this.sprinting = false;
    this.stamina = 1;
    this.sinceDamage = 99;
    this.fireTimer = 0;
    this.reloadTimer = 0;
    this.reloadingSlot = -1;
    this.shellReloadPending = false;
    this.swapTimer = 0;
    this.pendingSlot = -1;
    this.meleeTimer = 0;
    this.grenadeTimer = 0;
  }

  get maxHealth(): number {
    return perkMaxHealth(this.perks.has('juggernog'));
  }

  get slot(): Slot {
    return this.slots[this.activeSlot];
  }

  get weapon(): WeaponDef {
    return getWeapon(this.slot.id);
  }

  get reloading(): boolean {
    return this.reloadTimer > 0;
  }

  get swapping(): boolean {
    return this.swapTimer > 0;
  }

  get busy(): boolean {
    return this.reloading || this.swapping || this.meleeTimer > 0 || this.grenadeTimer > 0;
  }

  get healthFraction(): number {
    return Math.max(0, this.health / this.maxHealth);
  }

  /* ------------------------------------------------------------ inventory */

  hasWeapon(id: string): number {
    return this.slots.findIndex((s) => s.id === id);
  }

  /**
   * Adds a weapon. Fills the empty slot if there is one, otherwise replaces the
   * weapon currently in hand - the same rule the source material uses.
   */
  giveWeapon(id: string, packed = false): 'added' | 'replaced' | 'refilled' {
    const def = getWeapon(id);
    const existing = this.hasWeapon(id);
    if (existing >= 0 && this.slots[existing].packed === packed) {
      const s = this.slots[existing];
      s.mag = def.magSize;
      s.reserve = def.reserveMax;
      this.activeSlot = existing;
      return 'refilled';
    }
    const fresh: Slot = { id, ...startingAmmo(def), packed };
    if (this.slots.length < MAX_SLOTS) {
      this.slots.push(fresh);
      this.activeSlot = this.slots.length - 1;
      return 'added';
    }
    this.slots[this.activeSlot] = fresh;
    return 'replaced';
  }

  /** Wall-buy ammo refill. Returns false when the reserve is already full. */
  refillAmmo(id: string): boolean {
    const i = this.hasWeapon(id);
    if (i < 0) return false;
    const def = getWeapon(id);
    const s = this.slots[i];
    if (s.reserve >= def.reserveMax && s.mag >= def.magSize) return false;
    s.reserve = def.reserveMax;
    return true;
  }

  maxAmmo(): void {
    for (const s of this.slots) {
      const def = getWeapon(s.id);
      s.reserve = def.reserveMax;
    }
    if (this.hasGrenades) this.grenades = 4;
  }

  spend(cost: number): boolean {
    if (this.points < cost) return false;
    this.points -= cost;
    return true;
  }

  award(points: number): void {
    this.points += points;
    this.totalPoints += points;
  }

  /* -------------------------------------------------------------- damage */

  takeDamage(amount: number): boolean {
    if (!this.alive) return false;
    this.health -= amount;
    this.sinceDamage = 0;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.downs++;
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ movement */

  updateMovement(
    dt: number, grid: NavGrid,
    input: { forward: number; strafe: number; sprint: boolean; jump: boolean },
  ): { landed: boolean; bumped: boolean } {
    const wantSprint = input.sprint && input.forward > 0.1 && this.stamina > 0.02;
    this.sprinting = wantSprint;

    if (wantSprint) {
      this.stamina = Math.max(0, this.stamina - dt * (this.perks.has('staminup') ? 0.16 : 0.28));
    } else {
      this.stamina = Math.min(1, this.stamina + dt * 0.22);
    }

    const base = moveSpeed(this.perks.has('staminup'));
    const speed = base * (wantSprint ? sprintMultiplier(this.perks.has('staminup')) : 1);

    // Camera-relative movement.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let dx = input.strafe * cos - input.forward * sin;
    let dz = -input.strafe * sin - input.forward * cos;
    const len = Math.hypot(dx, dz);
    if (len > 1) {
      dx /= len;
      dz /= len;
    }

    const airControl = this.grounded ? 1 : 0.55;
    this.x += dx * speed * airControl * dt;
    this.z += dz * speed * airControl * dt;
    this.planarSpeed = Math.hypot(dx, dz) * speed;

    const res = grid.resolveCircle(this.x, this.z, PLAYER_RADIUS);
    this.x = res.x;
    this.z = res.z;

    if (input.jump && this.grounded) {
      this.vy = JUMP_SPEED;
      this.grounded = false;
    }

    let landed = false;
    if (!this.grounded) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        this.y = 0;
        this.vy = 0;
        this.grounded = true;
        landed = true;
      }
    }

    return { landed, bumped: res.hitWall };
  }

  /* ------------------------------------------------------------- weapons */

  /** Advances all the weapon timers and finishes any pending reload/swap. */
  tickWeapons(dt: number, onEvent: (e: 'reloaded' | 'shell' | 'swapped' | 'melee-hit') => void): void {
    this.fireTimer = Math.max(0, this.fireTimer - dt);

    if (this.meleeTimer > 0) {
      const before = this.meleeTimer;
      this.meleeTimer = Math.max(0, this.meleeTimer - dt);
      if (before > 0.18 && this.meleeTimer <= 0.18) onEvent('melee-hit');
    }
    if (this.grenadeTimer > 0) this.grenadeTimer = Math.max(0, this.grenadeTimer - dt);

    if (this.swapTimer > 0) {
      this.swapTimer = Math.max(0, this.swapTimer - dt);
      if (this.swapTimer === 0 && this.pendingSlot >= 0) {
        this.activeSlot = this.pendingSlot;
        this.pendingSlot = -1;
        onEvent('swapped');
      }
    }

    if (this.reloadTimer > 0) {
      this.reloadTimer = Math.max(0, this.reloadTimer - dt);
      if (this.reloadTimer === 0 && this.reloadingSlot >= 0) {
        const s = this.slots[this.reloadingSlot];
        if (s) {
          const def = getWeapon(s.id);
          if (def.shellReload) {
            const need = Math.min(1, def.magSize - s.mag, s.reserve);
            s.mag += need;
            s.reserve -= need;
            onEvent('shell');
            if (s.mag < def.magSize && s.reserve > 0 && this.shellReloadPending) {
              this.reloadTimer = reloadDuration(def, this.perks.has('speedcola'));
              return;
            }
          } else {
            const need = Math.min(def.magSize - s.mag, s.reserve);
            s.mag += need;
            s.reserve -= need;
            onEvent('reloaded');
          }
        }
        this.reloadingSlot = -1;
        this.shellReloadPending = false;
      }
    }
  }

  canFire(): boolean {
    return this.alive && this.fireTimer <= 0 && !this.busy;
  }

  tryFire(): FireOutcome {
    if (!this.alive) return { kind: 'none' };
    const def = this.weapon;

    // Firing out of a shell-by-shell reload interrupts it, like a real pump gun.
    if (this.reloading && def.shellReload && this.slot.mag > 0) {
      this.reloadTimer = 0;
      this.reloadingSlot = -1;
      this.shellReloadPending = false;
    }
    if (!this.canFire()) return { kind: 'none' };

    const s = this.slot;
    if (s.mag <= 0) {
      this.fireTimer = 0.22;
      return { kind: 'dry' };
    }

    s.mag--;
    this.fireTimer = fireInterval(def, this.perks.has('doubletap'));
    return { kind: 'shoot', def, pellets: def.pellets };
  }

  tryReload(): boolean {
    if (!this.alive || this.busy) return false;
    const def = this.weapon;
    const s = this.slot;
    if (s.mag >= def.magSize || s.reserve <= 0) return false;
    this.reloadTimer = reloadDuration(def, this.perks.has('speedcola'));
    this.reloadingSlot = this.activeSlot;
    this.shellReloadPending = def.shellReload;
    return true;
  }

  /** Duration of the reload currently running, for the view-model pose. */
  get reloadRemaining(): number {
    return this.reloadTimer;
  }

  trySwap(to?: number): boolean {
    if (!this.alive || this.busy || this.slots.length < 2) return false;
    const next = to ?? (this.activeSlot + 1) % this.slots.length;
    if (next === this.activeSlot || next < 0 || next >= this.slots.length) return false;
    this.pendingSlot = next;
    this.swapTimer = 0.55;
    return true;
  }

  get swapRemaining(): number {
    return this.swapTimer;
  }

  tryMelee(): boolean {
    if (!this.alive || this.busy || this.meleeTimer > 0) return false;
    this.meleeTimer = 0.52;
    return true;
  }

  tryGrenade(): boolean {
    if (!this.alive || this.busy || this.grenades <= 0) return false;
    this.grenades--;
    this.grenadeTimer = 0.7;
    return true;
  }

  /* -------------------------------------------------------------- health */

  tickHealth(dt: number): void {
    if (!this.alive) return;
    this.sinceDamage += dt;
    const delay = regenDelay(this.perks.has('revive'));
    if (this.sinceDamage < delay) return;
    const max = this.maxHealth;
    if (this.health >= max) return;
    this.health = Math.min(max, this.health + regenRate(this.perks.has('revive'), max) * dt);
  }
}
