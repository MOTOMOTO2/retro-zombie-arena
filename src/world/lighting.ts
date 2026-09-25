/**
 * Static lighting, computed once per layout on the CPU.
 *
 * Lamps are point lights with a smooth finite falloff. Walls cast shadows: a
 * 2D ray march over the tile grid decides whether a lamp can see a point, so
 * light pools stay inside their room and spill out only through doorways and
 * windows. The result is written into vertex colours by the batcher, and a
 * per-tile probe grid carries the same light onto everything that moves.
 */

import * as THREE from 'three';
import {
  MAP_H,
  MAP_W,
  TILE,
  T_DOOR,
  T_FLOOR,
  T_WALL,
  type Layout,
  tileAt,
  zoneAt,
  getZone,
} from './mapdata.ts';
import { MOONLIGHT, lookIdAt, looks } from './themes.ts';

/** Where the moon hangs (the sky dome paints it in the same place). */
export const MOON_DIR = new THREE.Vector3(0.55, 0.62, -0.56).normalize();
/** Moonlight on anything open to the sky. */
const MOON_FILL = new THREE.Color(0.18, 0.22, 0.34);

export type BakeLight = {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  intensity: number;
  radius: number;
};

export class Lighting {
  readonly layout: Layout;
  readonly lights: BakeLight[] = [];
  /** Per tile: the lights whose radius could reach it. */
  private buckets: BakeLight[][] | null = null;
  private readonly ambientCache = new Map<string, THREE.Color>();
  /** Per tile: 1 where it is open to the sky. */
  private readonly skyTiles: Uint8Array;

  constructor(layout: Layout) {
    this.layout = layout;
    this.skyTiles = new Uint8Array(MAP_W * MAP_H);
    for (let tz = 0; tz < MAP_H; tz++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const t = tileAt(layout.tiles, tx, tz);
        if (t !== T_FLOOR && t !== T_DOOR) continue;
        if (looks()[lookIdAt(layout, tx, tz)].outdoor) this.skyTiles[tz * MAP_W + tx] = 1;
      }
    }
  }

  add(light: BakeLight): void {
    this.lights.push(light);
    this.buckets = null;
  }

  private bucket(tx: number, tz: number): BakeLight[] {
    if (!this.buckets) {
      this.buckets = Array.from({ length: MAP_W * MAP_H }, () => []);
      for (const L of this.lights) {
        const reach = Math.ceil(L.radius / TILE) + 1;
        const cx = Math.floor(L.x / TILE);
        const cz = Math.floor(L.z / TILE);
        for (let z = cz - reach; z <= cz + reach; z++) {
          for (let x = cx - reach; x <= cx + reach; x++) {
            if (x < 0 || z < 0 || x >= MAP_W || z >= MAP_H) continue;
            this.buckets[z * MAP_W + x].push(L);
          }
        }
      }
    }
    if (tx < 0 || tz < 0 || tx >= MAP_W || tz >= MAP_H) return [];
    return this.buckets[tz * MAP_W + tx];
  }

  /**
   * True when nothing solid stands between a lamp and a point. A point that
   * sits on the face of a wall counts as lit: the march only fails if it hits
   * a wall tile well before reaching its target.
   */
  visible(x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return true;
    const rx = dx / len;
    const rz = dz / len;
    let tx = Math.floor(x0 / TILE);
    let tz = Math.floor(z0 / TILE);
    const stepX = rx > 0 ? 1 : -1;
    const stepZ = rz > 0 ? 1 : -1;
    const invX = rx !== 0 ? Math.abs(TILE / rx) : Infinity;
    const invZ = rz !== 0 ? Math.abs(TILE / rz) : Infinity;
    let sideX = rx !== 0 ? (rx > 0 ? (tx + 1) * TILE - x0 : x0 - tx * TILE) / Math.abs(rx) : Infinity;
    let sideZ = rz !== 0 ? (rz > 0 ? (tz + 1) * TILE - z0 : z0 - tz * TILE) / Math.abs(rz) : Infinity;
    const map = this.layout.tiles;
    for (let guard = 0; guard < 64; guard++) {
      let t: number;
      if (sideX < sideZ) {
        t = sideX;
        sideX += invX;
        tx += stepX;
      } else {
        t = sideZ;
        sideZ += invZ;
        tz += stepZ;
      }
      if (t >= len - 0.25) return true;
      if (tileAt(map, tx, tz) === T_WALL) return false;
    }
    return true;
  }

  /** The bounce-light colour of whatever room contains a point. */
  ambientAt(x: number, z: number): THREE.Color {
    const tx = Math.floor(x / TILE);
    const tz = Math.floor(z / TILE);
    const t = tileAt(this.layout.tiles, tx, tz);
    const zone = zoneAt(this.layout, tx, tz);
    const key = t === 0 ? 'outside' : (zone ?? 'corridor');
    let c = this.ambientCache.get(key);
    if (!c) {
      if (key === 'outside') {
        c = MOONLIGHT.clone();
      } else {
        const look = looks()[zone ? getZone(this.layout, zone).theme : this.layout.corridorLook];
        c = new THREE.Color(look.ambient).multiplyScalar(look.ambientLevel);
      }
      this.ambientCache.set(key, c);
    }
    return c;
  }

  /**
   * Light arriving at a point. With a normal it is a wrapped Lambert term;
   * without one (n = 0,0,0) it is omnidirectional, which is what the probe
   * wants for bodies that face every way at once.
   */
  shade(
    px: number, py: number, pz: number,
    nx: number, ny: number, nz: number,
    ambient: THREE.Color, ao: number, out: THREE.Color,
  ): THREE.Color {
    out.setRGB(ambient.r * ao, ambient.g * ao, ambient.b * ao);
    const directional = nx !== 0 || ny !== 0 || nz !== 0;
    // Sample a hair off the surface so a wall face is judged from the room side.
    const sx = px + nx * 0.05;
    const sz = pz + nz * 0.05;
    const direct = 0.55 + 0.45 * ao;
    const stx = Math.floor(sx / TILE);
    const stz = Math.floor(sz / TILE);
    if (stx >= 0 && stz >= 0 && stx < MAP_W && stz < MAP_H && this.skyTiles[stz * MAP_W + stx]) {
      // The moon: soft, cold and from one side, so walls facing it read
      // lighter than the ones turned away.
      const facing = directional ? 0.35 + 0.65 * Math.max(0, nx * MOON_DIR.x + ny * MOON_DIR.y + nz * MOON_DIR.z) : 0.7;
      const m = facing * ao;
      out.r += MOON_FILL.r * m;
      out.g += MOON_FILL.g * m;
      out.b += MOON_FILL.b * m;
    }
    for (const L of this.bucket(stx, stz)) {
      const dx = L.x - px;
      const dy = L.y - py;
      const dz = L.z - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > L.radius * L.radius) continue;
      const d = Math.sqrt(d2) || 1e-4;
      let lambert = 0.75;
      if (directional) {
        const dot = (dx * nx + dy * ny + dz * nz) / d;
        if (dot <= -0.2) continue;
        lambert = 0.3 + 0.7 * Math.max(0, dot);
      }
      if (!this.visible(L.x, L.z, sx, sz)) continue;
      const fall = 1 - d / L.radius;
      const f = lambert * fall * fall * L.intensity * direct;
      out.r += L.color.r * f;
      out.g += L.color.g * f;
      out.b += L.color.b * f;
    }
    return out;
  }
}

/**
 * The same light, sampled at chest height on every tile. Zombies and the other
 * moving things read it so a body under a lamp is bright, one in a dark corner
 * is dark, and a body in the furnace hall glows orange.
 */
export class LightProbe {
  private readonly rgb: Float32Array;
  private readonly open: Uint8Array;

  constructor(lighting: Lighting) {
    const n = MAP_W * MAP_H;
    this.rgb = new Float32Array(n * 3);
    this.open = new Uint8Array(n);
    const c = new THREE.Color();
    const map = lighting.layout.tiles;
    for (let tz = 0; tz < MAP_H; tz++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const i = tz * MAP_W + tx;
        if (map[i] === T_WALL) continue;
        this.open[i] = 1;
        const x = (tx + 0.5) * TILE;
        const z = (tz + 0.5) * TILE;
        lighting.shade(x, 2.6, z, 0, 0, 0, lighting.ambientAt(x, z), 1, c);
        this.rgb[i * 3] = c.r;
        this.rgb[i * 3 + 1] = c.g;
        this.rgb[i * 3 + 2] = c.b;
      }
    }
  }

  /** Bilinear sample that ignores wall tiles, so bodies near walls do not go dark. */
  sample(x: number, z: number, out: THREE.Color): THREE.Color {
    const fx = x / TILE - 0.5;
    const fz = z / TILE - 0.5;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const ax = fx - x0;
    const az = fz - z0;
    let r = 0;
    let g = 0;
    let b = 0;
    let w = 0;
    for (let k = 0; k < 4; k++) {
      const tx = x0 + (k & 1);
      const tz = z0 + (k >> 1);
      if (tx < 0 || tz < 0 || tx >= MAP_W || tz >= MAP_H) continue;
      const i = tz * MAP_W + tx;
      if (!this.open[i]) continue;
      const wt = ((k & 1) ? ax : 1 - ax) * ((k >> 1) ? az : 1 - az) + 1e-4;
      r += this.rgb[i * 3] * wt;
      g += this.rgb[i * 3 + 1] * wt;
      b += this.rgb[i * 3 + 2] * wt;
      w += wt;
    }
    if (w <= 0) return out.copy(MOONLIGHT);
    return out.setRGB(r / w, g / w, b / w);
  }
}
