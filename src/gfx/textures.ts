/**
 * Every surface in the game is painted at runtime onto a small canvas and
 * uploaded with nearest-neighbour filtering. 64x64 and 128x128 sheets with a
 * squashed palette is exactly the texture budget the early 3D shooters had, and
 * it means the repository ships no binary art at all.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng.ts';

type Ctx = CanvasRenderingContext2D;

function canvas(size: number): { c: HTMLCanvasElement; x: Ctx } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const x = c.getContext('2d', { willReadFrequently: false });
  if (!x) throw new Error('2d canvas unavailable');
  x.imageSmoothingEnabled = false;
  return { c, x };
}

function rgb(v: number): string {
  return `#${v.toString(16).padStart(6, '0')}`;
}

/** Shifts a packed colour by a signed amount per channel, clamped. */
function shade(v: number, amount: number): number {
  const r = Math.max(0, Math.min(255, ((v >> 16) & 255) + amount));
  const g = Math.max(0, Math.min(255, ((v >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (v & 255) + amount));
  return (r << 16) | (g << 8) | b;
}

/** Salt-and-pepper grain: the cheapest way to make flat fills look like 1999. */
function grain(x: Ctx, size: number, rng: Rng, amount: number, density = 0.5): void {
  for (let i = 0; i < size * size * density; i++) {
    const px = rng.int(size);
    const py = rng.int(size);
    const d = Math.round(rng.range(-amount, amount));
    x.fillStyle = d > 0 ? `rgba(255,255,255,${d / 255})` : `rgba(0,0,0,${-d / 255})`;
    x.fillRect(px, py, 1, 1);
  }
}

/** Irregular blotches, used for damp, rust and scorch. */
function stains(x: Ctx, size: number, rng: Rng, color: string, count: number, max: number): void {
  x.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const cx = rng.int(size);
    const cy = rng.int(size);
    const r = rng.range(2, max);
    for (let a = 0; a < 22; a++) {
      const ang = (a / 22) * Math.PI * 2;
      const rr = r * rng.range(0.4, 1);
      x.fillRect(
        Math.round(cx + Math.cos(ang) * rr * 0.5),
        Math.round(cy + Math.sin(ang) * rr * 0.5),
        Math.max(1, Math.round(rr * 0.6)),
        Math.max(1, Math.round(rr * 0.6)),
      );
    }
  }
}

function finish(c: HTMLCanvasElement, repeat = 1): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 1;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.repeat.set(repeat, repeat);
  return tex;
}

/* ------------------------------------------------------------------ walls */

function brick(base: number, mortar: number, seed: number): HTMLCanvasElement {
  const size = 64;
  const { c, x } = canvas(size);
  const rng = new Rng(seed);
  x.fillStyle = rgb(mortar);
  x.fillRect(0, 0, size, size);

  const bh = 8;
  const bw = 16;
  for (let row = 0; row < size / bh; row++) {
    const offset = row % 2 === 0 ? 0 : bw / 2;
    for (let col = -1; col < size / bw + 1; col++) {
      const bx = col * bw + offset;
      const by = row * bh;
      x.fillStyle = rgb(shade(base, Math.round(rng.range(-22, 18))));
      x.fillRect(bx + 1, by + 1, bw - 2, bh - 2);
      // top-left highlight, bottom-right shadow: fake bevel
      x.fillStyle = 'rgba(255,255,255,0.08)';
      x.fillRect(bx + 1, by + 1, bw - 2, 1);
      x.fillStyle = 'rgba(0,0,0,0.25)';
      x.fillRect(bx + 1, by + bh - 2, bw - 2, 1);
    }
  }
  stains(x, size, rng, 'rgba(20,12,8,0.30)', 5, 9);
  grain(x, size, rng, 26, 0.55);
  return c;
}

function plaster(base: number, seed: number, crackColor: number): HTMLCanvasElement {
  const size = 64;
  const { c, x } = canvas(size);
  const rng = new Rng(seed);
  x.fillStyle = rgb(base);
  x.fillRect(0, 0, size, size);
  stains(x, size, rng, 'rgba(30,26,18,0.22)', 8, 14);
  stains(x, size, rng, 'rgba(120,110,90,0.12)', 5, 10);

  // Peeling cracks: random walks.
  x.fillStyle = rgb(crackColor);
  for (let i = 0; i < 5; i++) {
    let px = rng.int(size);
    let py = rng.int(size);
    for (let s = 0; s < 40; s++) {
      x.fillRect(px, py, 1, 1);
      px = (px + rng.int(3) - 1 + size) % size;
      py = (py + rng.int(3)) % size;
    }
  }
  grain(x, size, rng, 22, 0.6);
  return c;
}

function tiledWall(base: number, seed: number): HTMLCanvasElement {
  const size = 64;
  const { c, x } = canvas(size);
  const rng = new Rng(seed);
  x.fillStyle = rgb(shade(base, -40));
  x.fillRect(0, 0, size, size);
  const t = 8;
  for (let gy = 0; gy < size / t; gy++) {
    for (let gx = 0; gx < size / t; gx++) {
      const missing = rng.chance(0.06);
      if (missing) continue;
      x.fillStyle = rgb(shade(base, Math.round(rng.range(-16, 14))));
      x.fillRect(gx * t + 1, gy * t + 1, t - 1, t - 1);
      x.fillStyle = 'rgba(255,255,255,0.10)';
      x.fillRect(gx * t + 1, gy * t + 1, t - 1, 1);
    }
  }
  stains(x, size, rng, 'rgba(60,24,16,0.30)', 6, 11);
  grain(x, size, rng, 18, 0.45);
  return c;
}

function metalPanel(base: number, seed: number): HTMLCanvasElement {
  const size = 64;
  const { c, x } = canvas(size);
  const rng = new Rng(seed);
  x.fillStyle = rgb(base);
  x.fillRect(0, 0, size, size);
  for (let i = 0; i < size; i += 2) {
    x.fillStyle = `rgba(255,255,255,${i % 8 === 0 ? 0.07 : 0.03})`;
    x.fillRect(0, i, size, 1);
  }
  // Panel seams + rivets.
  x.fillStyle = 'rgba(0,0,0,0.5)';
  x.fillRect(0, 31, size, 2);
  x.fillRect(31, 0, 2, size);
  for (const [px, py] of [
    [4, 4], [59, 4], [4, 59], [59, 59], [36, 4], [4, 36], [36, 36], [59, 36], [36, 59],
  ]) {
    x.fillStyle = rgb(shade(base, 50));
    x.fillRect(px, py, 2, 2);
    x.fillStyle = 'rgba(0,0,0,0.45)';
    x.fillRect(px + 1, py + 1, 2, 2);
  }
  stains(x, size, rng, 'rgba(112,52,20,0.35)', 7, 10);
  grain(x, size, rng, 20, 0.5);
  return c;
}

function planks(base: number, seed: number, vertical: boolean): HTMLCanvasElement {
  const size = 64;
  const { c, x } = canvas(size);
  const rng = new Rng(seed);
  x.fillStyle = rgb(shade(base, -50));
  x.fillRect(0, 0, size, size);
  const pw = 10;
  for (let i = 0; i < size / pw + 1; i++) {
    const tone = shade(base, Math.round(rng.range(-24, 20)));
    x.fillStyle = rgb(tone);
    if (vertical) x.fillRect(i * pw, 0, pw - 1, size);
    else x.fillRect(0, i * pw, size, pw - 1);
    // Grain lines along the plank.
    x.fillStyle = rgb(shade(tone, -26));
    for (let g = 0; g < 7; g++) {
      const off = rng.int(pw - 2) + 1;
      if (vertical) x.fillRect(i * pw + off, rng.int(size), 1, rng.int(30) + 8);
      else x.fillRect(rng.int(size), i * pw + off, rng.int(30) + 8, 1);
    }
  }
  grain(x, size, rng, 22, 0.5);
  return c;
}

/* ----------------------------------------------------------------- floors */

function floorTiles(base: number, seed: number): HTMLCanvasElement {
  const size = 64;
  const { c, x } = canvas(size);
  const rng = new Rng(seed);
  x.fillStyle = rgb(shade(base, -46));
  x.fillRect(0, 0, size, size);
  const t = 16;
  for (let gy = 0; gy < size / t; gy++) {
    for (let gx = 0; gx < size / t; gx++) {
      const dark = (gx + gy) % 2 === 0;
      x.fillStyle = rgb(shade(base, (dark ? -14 : 8) + Math.round(rng.range(-10, 10))));
      x.fillRect(gx * t + 1, gy * t + 1, t - 2, t - 2);
      if (rng.chance(0.25)) {
        x.fillStyle = 'rgba(0,0,0,0.3)';
        x.fillRect(gx * t + rng.int(t - 4) + 2, gy * t + rng.int(t - 4) + 2, 3, 2);
      }
    }
  }
  stains(x, size, rng, 'rgba(40,16,10,0.28)', 6, 14);
  grain(x, size, rng, 20, 0.55);
  return c;
}

function concreteFloor(base: number, seed: number): HTMLCanvasElement {
  const size = 64;
  const { c, x } = canvas(size);
  const rng = new Rng(seed);
  x.fillStyle = rgb(base);
  x.fillRect(0, 0, size, size);
  stains(x, size, rng, 'rgba(0,0,0,0.20)', 10, 16);
  stains(x, size, rng, 'rgba(90,86,74,0.14)', 6, 12);
  x.fillStyle = 'rgba(0,0,0,0.35)';
  for (let i = 0; i < 4; i++) {
    let px = rng.int(size);
    let py = rng.int(size);
    for (let s = 0; s < 50; s++) {
      x.fillRect(px, py, 1, 1);
      px = (px + rng.int(3) - 1 + size) % size;
      py = (py + rng.int(3) - 1 + size) % size;
    }
  }
  grain(x, size, rng, 24, 0.7);
  return c;
}

function grate(base: number, seed: number): HTMLCanvasElement {
  const size = 64;
  const { c, x } = canvas(size);
  const rng = new Rng(seed);
  x.fillStyle = '#0b0c0d';
  x.fillRect(0, 0, size, size);
  x.fillStyle = rgb(base);
  for (let i = 0; i < size; i += 8) {
    x.fillRect(i, 0, 5, size);
    x.fillRect(0, i, size, 2);
  }
  stains(x, size, rng, 'rgba(112,52,20,0.4)', 8, 9);
  grain(x, size, rng, 26, 0.5);
  return c;
}

/* ------------------------------------------------------------- decoration */

function bloodSplat(seed: number): HTMLCanvasElement {
  const size = 32;
  const { c, x } = canvas(size);
  const rng = new Rng(seed);
  x.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  for (let i = 0; i < 34; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const rad = rng.range(0, 9);
    const s = Math.max(1, Math.round(rng.range(2, 7)));
    x.fillStyle = `rgba(${Math.round(rng.range(80, 140))},6,8,${rng.range(0.55, 0.95).toFixed(2)})`;
    x.fillRect(Math.round(cx + Math.cos(ang) * rad), Math.round(cy + Math.sin(ang) * rad), s, s);
  }
  for (let i = 0; i < 18; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const rad = rng.range(8, 15);
    x.fillStyle = `rgba(96,4,6,${rng.range(0.3, 0.8).toFixed(2)})`;
    x.fillRect(Math.round(cx + Math.cos(ang) * rad), Math.round(cy + Math.sin(ang) * rad), 2, 2);
  }
  return c;
}

function bulletHole(): HTMLCanvasElement {
  const size = 16;
  const { c, x } = canvas(size);
  x.clearRect(0, 0, size, size);
  x.fillStyle = 'rgba(30,26,22,0.75)';
  x.beginPath();
  x.arc(8, 8, 5.5, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = 'rgba(8,7,6,0.95)';
  x.fillRect(6, 6, 4, 4);
  x.fillStyle = 'rgba(190,185,170,0.35)';
  x.fillRect(5, 4, 1, 1);
  x.fillRect(11, 10, 1, 1);
  return c;
}

/** Perk machine face: a bold colour block with a stencilled label. */
function perkFace(color: number, label: string, glyph: string): HTMLCanvasElement {
  const size = 64;
  const { c, x } = canvas(size);
  const rng = new Rng(label.length * 977 + color);
  x.fillStyle = rgb(shade(color, -90));
  x.fillRect(0, 0, size, size);
  x.fillStyle = rgb(color);
  x.fillRect(4, 4, size - 8, size - 8);
  x.fillStyle = rgb(shade(color, -60));
  x.fillRect(4, 40, size - 8, 20);

  x.fillStyle = 'rgba(0,0,0,0.85)';
  x.font = 'bold 26px monospace';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(glyph, size / 2, 24);

  x.fillStyle = '#f4efe2';
  x.font = 'bold 9px monospace';
  const words = label.split(' ');
  words.forEach((w, i) => x.fillText(w, size / 2, 46 + i * 9));
  grain(x, size, rng, 16, 0.3);
  return c;
}

/** The mystery box lid: crate boards with a big question mark burnt in. */
function mysteryLid(): HTMLCanvasElement {
  const size = 64;
  const { c, x } = canvas(size);
  const rng = new Rng(0xb0c5);
  x.drawImage(planks(0x7d5a30, 0x4321, false), 0, 0);
  x.fillStyle = 'rgba(20,14,6,0.8)';
  x.font = 'bold 42px monospace';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('?', size / 2, size / 2 + 2);
  x.strokeStyle = 'rgba(210,170,70,0.65)';
  x.lineWidth = 2;
  x.strokeRect(3, 3, size - 6, size - 6);
  grain(x, size, rng, 18, 0.4);
  return c;
}

/** Wall-buy placard: weapon name over a stencil silhouette. */
export function weaponPlacard(name: string, cost: number): HTMLCanvasElement {
  const size = 128;
  const { c, x } = canvas(size);
  const rng = new Rng(name.length * 131 + cost);
  x.fillStyle = '#20242a';
  x.fillRect(0, 0, size, size);
  x.fillStyle = '#2c3138';
  x.fillRect(5, 5, size - 10, size - 10);

  // Chalk outline of a gun.
  x.strokeStyle = 'rgba(232,226,206,0.8)';
  x.lineWidth = 3;
  x.beginPath();
  x.moveTo(16, 60);
  x.lineTo(104, 60);
  x.lineTo(104, 72);
  x.lineTo(70, 72);
  x.lineTo(64, 92);
  x.lineTo(52, 92);
  x.lineTo(56, 72);
  x.lineTo(16, 72);
  x.closePath();
  x.stroke();

  x.fillStyle = '#e8e2ce';
  x.font = 'bold 15px monospace';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(name.slice(0, 14), size / 2, 26);
  x.fillStyle = '#ffd84d';
  x.font = 'bold 19px monospace';
  x.fillText(`${cost}`, size / 2, 112);
  grain(x, size, rng, 14, 0.25);
  return c;
}

/* ---------------------------------------------------------------- zombies */

/**
 * Zombie skin sheet. The body model maps every box to the whole sheet, so the
 * result is a mottled, blotchy hide rather than anything anatomical - which is
 * precisely how low-poly monsters of the era were textured.
 */
function zombieSkin(base: number, seed: number): HTMLCanvasElement {
  const size = 32;
  const { c, x } = canvas(size);
  const rng = new Rng(seed);
  x.fillStyle = rgb(base);
  x.fillRect(0, 0, size, size);
  stains(x, size, rng, 'rgba(40,60,34,0.35)', 7, 8);
  stains(x, size, rng, 'rgba(120,20,22,0.45)', 5, 6);
  stains(x, size, rng, 'rgba(18,14,12,0.4)', 4, 5);
  // Exposed ribs / torn flesh streaks.
  x.fillStyle = 'rgba(150,120,110,0.5)';
  for (let i = 0; i < 5; i++) x.fillRect(rng.int(size), rng.int(size), rng.int(6) + 2, 1);
  grain(x, size, rng, 34, 0.9);
  return c;
}

/* ------------------------------------------------------------------ cache */

export type TextureSet = {
  brickRed: THREE.CanvasTexture;
  brickGrey: THREE.CanvasTexture;
  plasterSick: THREE.CanvasTexture;
  plasterBlue: THREE.CanvasTexture;
  tileWall: THREE.CanvasTexture;
  metal: THREE.CanvasTexture;
  wood: THREE.CanvasTexture;
  woodV: THREE.CanvasTexture;
  floorTile: THREE.CanvasTexture;
  floorConcrete: THREE.CanvasTexture;
  floorGrate: THREE.CanvasTexture;
  ceiling: THREE.CanvasTexture;
  door: THREE.CanvasTexture;
  blood: THREE.CanvasTexture[];
  bullet: THREE.CanvasTexture;
  mystery: THREE.CanvasTexture;
  zombieSkins: THREE.CanvasTexture[];
  houndSkin: THREE.CanvasTexture;
};

let cache: TextureSet | null = null;

export function textures(): TextureSet {
  if (cache) return cache;
  cache = {
    brickRed: finish(brick(0x7a3f2c, 0x3b332c, 0x1001)),
    brickGrey: finish(brick(0x55585c, 0x33353a, 0x1002)),
    plasterSick: finish(plaster(0x8d8a6d, 0x1003, 0x4a4436)),
    plasterBlue: finish(plaster(0x6e7a88, 0x1004, 0x3a4048)),
    tileWall: finish(tiledWall(0x9aa79c, 0x1005)),
    metal: finish(metalPanel(0x4c5157, 0x1006)),
    wood: finish(planks(0x6b4527, 0x1007, false)),
    woodV: finish(planks(0x6b4527, 0x1008, true)),
    floorTile: finish(floorTiles(0x6d6a5e, 0x1009)),
    floorConcrete: finish(concreteFloor(0x55534c, 0x100a)),
    floorGrate: finish(grate(0x4a4f54, 0x100b)),
    ceiling: finish(concreteFloor(0x35332e, 0x100c)),
    door: finish(metalPanel(0x5a4432, 0x100d)),
    blood: [finish(bloodSplat(0x2001)), finish(bloodSplat(0x2002)), finish(bloodSplat(0x2003))],
    bullet: finish(bulletHole()),
    mystery: finish(mysteryLid()),
    zombieSkins: [
      finish(zombieSkin(0x6f7a58, 0x3001)),
      finish(zombieSkin(0x7d7360, 0x3002)),
      finish(zombieSkin(0x5e6b63, 0x3003)),
      finish(zombieSkin(0x86745e, 0x3004)),
    ],
    houndSkin: finish(zombieSkin(0x3a2f28, 0x3005)),
  };
  for (const t of [cache.blood, [cache.bullet]].flat()) {
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
  }
  return cache;
}

export function perkTexture(color: number, label: string, glyph: string): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(perkFace(color, label, glyph));
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapLinearFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function placardTexture(name: string, cost: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(weaponPlacard(name, cost));
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapLinearFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
