/**
 * The HUD is plain DOM on top of the canvas: it stays crisp while the 3D view
 * stays chunky, which is exactly the split the console shooters of the era used.
 */

import {
  MAP_H,
  MAP_W,
  TILE,
  T_BARRICADE,
  T_DOOR,
  T_FLOOR,
  worldToTile,
} from '../world/mapdata.ts';
import { PERK_INFO, type PerkId } from './rules.ts';

const PERK_LETTER: Record<PerkId, string> = {
  revive: '+',
  juggernog: 'JUG',
  speedcola: 'SPD',
  doubletap: 'x2',
  staminup: 'RUN',
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing HUD element #${id}`);
  return node as T;
}

export type MinimapBlip = { x: number; z: number; color: string; size?: number };

export class Hud {
  private readonly root = el('hud');
  private readonly pointsEl = el('points');
  private readonly deltaEl = el('points-delta');
  private readonly roundEl = el('round');
  private readonly pipsEl = el('round-pips');
  private readonly healthBar = el('health-bar');
  private readonly staminaBar = el('stamina-bar');
  private readonly weaponName = el('weapon-name');
  private readonly magEl = el('mag');
  private readonly reserveEl = el('reserve');
  private readonly ammoEl = el('ammo');
  private readonly nadesEl = el('nades');
  private readonly perkRow = el('perk-row');
  private readonly promptEl = el('prompt');
  private readonly toastEl = el('toast');
  private readonly bannerEl = el('banner');
  private readonly hitEl = el('hitmarker');
  private readonly ringEl = el('damage-ring');
  private readonly lowHealthEl = el('low-health');
  private readonly timersEl = el('powerup-timers');
  private readonly crosshairEl = el('crosshair');
  private readonly minimap = el<HTMLCanvasElement>('minimap');
  private readonly mmCtx: CanvasRenderingContext2D;

  private deltaTimer = 0;
  private deltaValue = 0;
  private toastTimer = 0;
  private bannerTimer = 0;
  private hitTimer = 0;
  private ringTimer = 0;
  private shownPerks = '';

  constructor() {
    const ctx = this.minimap.getContext('2d');
    if (!ctx) throw new Error('minimap canvas unavailable');
    this.mmCtx = ctx;
    this.mmCtx.imageSmoothingEnabled = false;
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
  }

  setPoints(points: number): void {
    this.pointsEl.textContent = String(points);
  }

  /** Floats a +/- number under the wallet. Repeated gains stack up. */
  pointsDelta(amount: number): void {
    if (amount === 0) return;
    if (this.deltaTimer > 0 && Math.sign(amount) === Math.sign(this.deltaValue)) {
      this.deltaValue += amount;
    } else {
      this.deltaValue = amount;
    }
    this.deltaTimer = 1.1;
    this.deltaEl.textContent = `${this.deltaValue > 0 ? '+' : ''}${this.deltaValue}`;
    this.deltaEl.classList.toggle('minus', this.deltaValue < 0);
    this.deltaEl.classList.add('show');
  }

  setRound(round: number): void {
    this.roundEl.textContent = String(round);
    const pips = Math.min(round, 12);
    if (this.pipsEl.childElementCount !== pips) {
      this.pipsEl.replaceChildren(
        ...Array.from({ length: pips }, () => document.createElement('i')),
      );
    }
  }

  setHealth(fraction: number): void {
    const pct = Math.max(0, Math.min(1, fraction)) * 100;
    this.healthBar.style.width = `${pct}%`;
    this.healthBar.classList.toggle('hurt', fraction < 0.4);
    const wounded = fraction < 0.35;
    this.lowHealthEl.classList.toggle('on', wounded);
    this.lowHealthEl.style.opacity = wounded ? String((0.35 - fraction) * 2.4) : '0';
  }

  setStamina(fraction: number): void {
    this.staminaBar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }

  setWeapon(name: string, mag: number, reserve: number, magSize: number): void {
    this.weaponName.textContent = name;
    this.magEl.textContent = String(mag);
    this.reserveEl.textContent = String(reserve);
    this.ammoEl.classList.toggle('low', mag <= Math.max(1, Math.ceil(magSize * 0.25)));
  }

  setGrenades(n: number, unlocked: boolean): void {
    this.nadesEl.style.opacity = unlocked ? '0.75' : '0.25';
    const b = this.nadesEl.querySelector('b');
    if (b) b.textContent = String(n);
  }

  setPerks(perks: PerkId[]): void {
    const key = perks.join(',');
    if (key === this.shownPerks) return;
    this.shownPerks = key;
    this.perkRow.replaceChildren(
      ...perks.map((p) => {
        const d = document.createElement('div');
        d.className = 'perk';
        d.textContent = PERK_LETTER[p];
        d.style.background = `#${PERK_INFO[p].color.toString(16).padStart(6, '0')}`;
        d.title = PERK_INFO[p].name;
        return d;
      }),
    );
  }

  setPrompt(text: string | null, affordable = true): void {
    if (!text) {
      this.promptEl.classList.remove('show');
      return;
    }
    this.promptEl.innerHTML = text;
    this.promptEl.classList.add('show');
    this.promptEl.classList.toggle('poor', !affordable);
  }

  toast(text: string, color = '#ffc84d', seconds = 2.2): void {
    this.toastEl.textContent = text;
    this.toastEl.style.color = color;
    this.toastEl.classList.remove('show');
    void this.toastEl.offsetWidth; // restart the CSS animation
    this.toastEl.classList.add('show');
    this.toastTimer = seconds;
  }

  banner(text: string, seconds = 2.4, color = '#d22f26'): void {
    this.bannerEl.textContent = text;
    this.bannerEl.style.color = color;
    this.bannerEl.classList.remove('show');
    void this.bannerEl.offsetWidth;
    this.bannerEl.classList.add('show');
    this.bannerTimer = seconds;
  }

  hitmarker(kill: boolean): void {
    this.hitEl.classList.remove('fade');
    this.hitEl.classList.add('show');
    this.hitEl.classList.toggle('kill', kill);
    this.hitTimer = kill ? 0.22 : 0.12;
  }

  damageFlash(): void {
    this.ringEl.style.opacity = '1';
    this.ringTimer = 0.45;
  }

  setCrosshair(visible: boolean): void {
    this.crosshairEl.classList.toggle('hide', !visible);
  }

  setPowerupTimers(list: { name: string; color: string; seconds: number }[]): void {
    this.timersEl.replaceChildren(
      ...list.map((p) => {
        const d = document.createElement('div');
        d.className = 'pw';
        d.style.color = p.color;
        d.textContent = `${p.name} ${Math.ceil(p.seconds)}`;
        return d;
      }),
    );
  }

  toggleMap(on: boolean): void {
    this.minimap.classList.toggle('hidden', !on);
  }

  get mapVisible(): boolean {
    return !this.minimap.classList.contains('hidden');
  }

  /** Top-down view. Only rooms the player has opened are drawn. */
  drawMinimap(
    tiles: Uint8Array, px: number, pz: number, yaw: number, blips: MinimapBlip[],
  ): void {
    const ctx = this.mmCtx;
    const w = this.minimap.width;
    const h = this.minimap.height;
    const scale = Math.min(w / MAP_W, h / MAP_H);
    const ox = (w - MAP_W * scale) / 2;
    const oy = (h - MAP_H * scale) / 2;

    ctx.clearRect(0, 0, w, h);
    for (let tz = 0; tz < MAP_H; tz++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const t = tiles[tz * MAP_W + tx];
        if (t === 0) continue;
        if (t === T_FLOOR) ctx.fillStyle = '#2f3a2c';
        else if (t === T_DOOR) ctx.fillStyle = '#7a5a20';
        else if (t === T_BARRICADE) ctx.fillStyle = '#6b3b1c';
        else ctx.fillStyle = '#14161a';
        ctx.fillRect(
          Math.floor(ox + tx * scale), Math.floor(oy + tz * scale),
          Math.ceil(scale), Math.ceil(scale),
        );
      }
    }

    for (const b of blips) {
      const t = worldToTile(b.x, b.z);
      ctx.fillStyle = b.color;
      const s = (b.size ?? 1) * scale;
      ctx.fillRect(ox + t.tx * scale - s / 2 + scale / 2, oy + t.tz * scale - s / 2 + scale / 2, s, s);
    }

    // Player arrow.
    const p = { x: ox + (px / TILE) * scale, y: oy + (pz / TILE) * scale };
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-yaw);
    ctx.fillStyle = '#ffc84d';
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(4, 5);
    ctx.lineTo(0, 2.5);
    ctx.lineTo(-4, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  update(dt: number): void {
    if (this.deltaTimer > 0) {
      this.deltaTimer -= dt;
      if (this.deltaTimer <= 0) this.deltaEl.classList.remove('show');
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('show');
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.bannerEl.classList.remove('show');
    }
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) {
        this.hitEl.classList.remove('show');
        this.hitEl.classList.add('fade');
      }
    }
    if (this.ringTimer > 0) {
      this.ringTimer -= dt;
      if (this.ringTimer <= 0) this.ringEl.style.opacity = '0';
    }
  }
}
