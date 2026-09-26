/**
 * Combat read-outs over the horde: a small health bar above anything that has
 * been hurt, and the damage each hit did, popping off the body and rising away.
 *
 * Both are plain DOM like the rest of the HUD, placed each frame by projecting
 * a point in the world through the camera, so they stay crisp over the chunky
 * 3D. Every element is made up front and reused.
 */

import * as THREE from 'three';
import type { NavGrid } from '../world/grid.ts';
import type { Enemy } from './enemy.ts';

/** Past this (world units), bars are not worth the clutter. */
const BAR_RANGE = 64;
/** How long the lost chunk of a bar hangs on before it drains away. */
const CHIP_HOLD = 0.35;
const POP_LIFE = 0.9;
const POP_COUNT = 40;
/** Hits on one body closer together than this add up: a shotgun blast is one number. */
const MERGE = 0.16;
/** Fire ticks every frame; its numbers collect for longer. */
const BURN_MERGE = 0.5;

export type HitKind = 'body' | 'head' | 'burn';

type Bar = {
  el: HTMLDivElement;
  fill: HTMLElement;
  chip: HTMLElement;
  enemy: Enemy;
  opacity: number;
  chipFrac: number;
  lastHit: number;
  tone: string;
  sees: boolean;
  seeTimer: number;
};

type Pop = {
  el: HTMLDivElement;
  enemy: Enemy | null;
  x: number;
  y: number;
  z: number;
  /** Which way it drifts across the screen, clear of the health bar: -1 or 1. */
  side: number;
  age: number;
  value: number;
  shown: number;
  kind: HitKind;
  killed: boolean;
};

/** Green, then amber, then red as it runs down. */
function tone(frac: number): string {
  return frac > 0.55 ? '#7bd14a' : frac > 0.25 ? '#ffc84d' : '#d22f26';
}

export class EnemyTags {
  /** Whether hurt enemies show a health bar. */
  showBars = true;
  /** Whether hits show the damage they did. */
  showNumbers = true;

  private readonly bars: Bar[] = [];
  private readonly barOf = new Map<Enemy, Bar>();
  private readonly pops: Pop[] = [];
  private readonly v = new THREE.Vector3();
  private readonly screen = { x: 0, y: 0 };
  private clock = 0;
  private nextSide = 1;

  constructor(root: HTMLElement, enemies: readonly Enemy[]) {
    for (const enemy of enemies) {
      const el = document.createElement('div');
      el.className = 'ztag';
      const chip = document.createElement('i');
      chip.className = 'chip';
      const fill = document.createElement('i');
      fill.className = 'fill';
      el.append(chip, fill);
      root.append(el);
      const bar: Bar = { el, fill, chip, enemy, opacity: 0, chipFrac: 1, lastHit: -9, tone: '', sees: false, seeTimer: 0 };
      this.bars.push(bar);
      this.barOf.set(enemy, bar);
    }
    for (let i = 0; i < POP_COUNT; i++) {
      const el = document.createElement('div');
      el.className = 'dmg';
      root.append(el);
      this.pops.push({ el, enemy: null, x: 0, y: 0, z: 0, side: 1, age: POP_LIFE, value: 0, shown: -1, kind: 'body', killed: false });
    }
  }

  /** Something took damage at a point in the world. */
  hit(e: Enemy, amount: number, kind: HitKind, killed: boolean, at: { x: number; y: number; z: number }): void {
    const bar = this.barOf.get(e);
    if (bar) bar.lastHit = this.clock;
    if (!this.showNumbers || amount <= 0) return;

    // Still collecting for this body? Add to that number instead of stacking a new one.
    for (const p of this.pops) {
      if (p.enemy !== e || (p.kind === 'burn') !== (kind === 'burn')) continue;
      if (p.age < (kind === 'burn' ? BURN_MERGE : MERGE)) {
        p.value += amount;
        p.killed ||= killed;
        if (kind === 'head') p.kind = 'head';
        this.style(p);
        return;
      }
    }

    let pop = this.pops[0];
    for (const p of this.pops) {
      if (p.age >= POP_LIFE) {
        pop = p;
        break;
      }
      if (p.age > pop.age) pop = p;
    }
    pop.enemy = e;
    pop.value = amount;
    pop.kind = kind;
    pop.killed = killed;
    pop.age = 0;
    pop.shown = -1;
    pop.x = at.x;
    pop.y = at.y + 0.2;
    pop.z = at.z;
    // Alternate sides, so a burst of hits fans out instead of stacking.
    this.nextSide = -this.nextSide;
    pop.side = this.nextSide;
    this.style(pop);
  }

  /** Hides everything, for a new run. */
  clear(): void {
    for (const b of this.bars) {
      b.opacity = 0;
      b.chipFrac = 1;
      b.lastHit = -9;
      b.el.style.display = 'none';
    }
    for (const p of this.pops) {
      p.age = POP_LIFE;
      p.enemy = null;
      p.el.style.display = 'none';
    }
  }

  update(dt: number, camera: THREE.Camera, eye: { x: number; z: number }, grid: NavGrid): void {
    this.clock += dt;
    camera.updateMatrixWorld();
    const w = window.innerWidth;
    const h = window.innerHeight;

    for (const b of this.bars) {
      const e = b.enemy;
      const alive = e.active && e.state !== 'dead';
      const frac = e.active ? Math.max(0, Math.min(1, e.health / Math.max(1, e.maxHealth))) : 0;
      // A body back from the pool at full health starts clean.
      if (alive && frac >= 1) {
        b.chipFrac = 1;
        if (b.opacity > 0) this.hideBar(b);
        continue;
      }
      if (b.opacity <= 0 && (!alive || !this.showBars)) continue;

      const dist = Math.hypot(e.x - eye.x, e.z - eye.z);
      b.seeTimer -= dt;
      if (b.seeTimer <= 0) {
        b.sees = dist < BAR_RANGE && grid.lineOfSight(eye.x, eye.z, e.x, e.z);
        b.seeTimer = 0.12;
      }
      const on = this.project(camera, e.x, e.bodyTop + 0.45, e.z, w, h);
      const want = alive && this.showBars && b.sees && on ? 1 : 0;
      // Dying bars empty and then fade; new ones pop straight in.
      b.opacity = want > b.opacity ? 1 : Math.max(0, b.opacity - dt * (alive ? 6 : 3.5));
      if (b.opacity <= 0 || !on) {
        this.hideBar(b);
        continue;
      }

      if (this.clock - b.lastHit > CHIP_HOLD) b.chipFrac = Math.max(frac, b.chipFrac - dt * 1.3);
      b.chipFrac = Math.max(b.chipFrac, frac);
      const t = tone(frac);
      if (t !== b.tone) {
        b.tone = t;
        b.fill.style.background = t;
      }
      b.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
      b.chip.style.transform = `scaleX(${b.chipFrac.toFixed(3)})`;
      const scale = Math.max(0.5, Math.min(1.1, 0.35 + 9 / Math.max(1, dist)));
      b.el.style.display = 'block';
      b.el.style.opacity = b.opacity.toFixed(2);
      b.el.style.transform = `translate(${this.screen.x.toFixed(1)}px, ${this.screen.y.toFixed(1)}px) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    }

    for (const p of this.pops) {
      if (p.age >= POP_LIFE) continue;
      p.age += dt;
      const k = p.age / POP_LIFE;
      const rise = 1 - (1 - k) * (1 - k);
      const on = p.age < POP_LIFE && this.project(camera, p.x, p.y + 1.2 * rise, p.z, w, h);
      if (!on) {
        p.el.style.display = 'none';
        if (p.age >= POP_LIFE) p.enemy = null;
        continue;
      }
      const dist = Math.hypot(p.x - eye.x, p.z - eye.z);
      // It lands big and settles, then fades on the way up.
      const pop = p.age < 0.1 ? 1.7 - p.age * 7 : 1;
      const near = Math.max(0.6, Math.min(1.25, 0.45 + 8 / Math.max(1, dist)));
      const x = this.screen.x + p.side * (26 + 34 * rise) * near;
      p.el.style.display = 'block';
      p.el.style.opacity = (k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45).toFixed(2);
      p.el.style.transform = `translate(${x.toFixed(1)}px, ${this.screen.y.toFixed(1)}px) translate(-50%, -50%) scale(${(pop * near).toFixed(3)})`;
    }
  }

  /** How many bars and numbers are on screen. Used by the smoke test. */
  get visible(): { bars: number; numbers: number } {
    let bars = 0;
    let numbers = 0;
    for (const b of this.bars) if (b.el.style.display === 'block') bars++;
    for (const p of this.pops) if (p.el.style.display === 'block') numbers++;
    return { bars, numbers };
  }

  private hideBar(b: Bar): void {
    b.opacity = 0;
    if (b.el.style.display !== 'none') b.el.style.display = 'none';
  }

  private style(p: Pop): void {
    const value = Math.max(1, Math.round(p.value));
    if (value !== p.shown) {
      p.shown = value;
      p.el.textContent = String(value);
    }
    p.el.className = `dmg ${p.kind}${p.killed ? ' kill' : ''}`;
  }

  /**
   * Projects a world point to CSS pixels in `this.screen`. False when it is
   * behind the camera (where the projection flips) or well off screen.
   */
  private project(camera: THREE.Camera, x: number, y: number, z: number, w: number, h: number): boolean {
    const v = this.v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    if (v.z > -0.3) return false;
    v.applyMatrix4(camera.projectionMatrix);
    if (v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2) return false;
    this.screen.x = (v.x * 0.5 + 0.5) * w;
    this.screen.y = (-v.y * 0.5 + 0.5) * h;
    return true;
  }
}
