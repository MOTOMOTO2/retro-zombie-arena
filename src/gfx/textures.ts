/**
 * Every surface in the game is painted at runtime onto a small canvas and
 * uploaded with nearest-neighbour filtering. 128x128 sheets for the level and
 * 32-64px for props is the texture budget of a late-era software-lit shooter,
 * and it means the repository ships no binary art at all.
 *
 * Everything that can repeat is painted with wrap-around brushes, so the seams
 * between tiles disappear.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng.ts';

type Ctx = CanvasRenderingContext2D;

function rgb(v: number): string {
  return `#${v.toString(16).padStart(6, '0')}`;
}

/** Shifts a packed colour by a signed amount per channel, clamped. */
export function shade(v: number, amount: number): number {
  const r = Math.max(0, Math.min(255, ((v >> 16) & 255) + amount));
  const g = Math.max(0, Math.min(255, ((v >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (v & 255) + amount));
  return (r << 16) | (g << 8) | b;
}

function rgba(v: number, a: number): string {
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a.toFixed(3)})`;
}

/** A canvas plus a seeded brush set. Every brush wraps at the edges. */
class Painter {
  readonly c: HTMLCanvasElement;
  readonly x: Ctx;
  readonly size: number;
  readonly rng: Rng;

  constructor(size: number, seed: number) {
    this.size = size;
    this.c = document.createElement('canvas');
    this.c.width = size;
    this.c.height = size;
    const x = this.c.getContext('2d', { willReadFrequently: true });
    if (!x) throw new Error('2d canvas unavailable');
    x.imageSmoothingEnabled = false;
    this.x = x;
    this.rng = new Rng(seed);
  }

  fill(color: number | string): this {
    this.x.fillStyle = typeof color === 'number' ? rgb(color) : color;
    this.x.fillRect(0, 0, this.size, this.size);
    return this;
  }

  /** Draws fn at the origin and at every wrapped offset it might spill into. */
  private wrapped(x: number, y: number, r: number, fn: (ox: number, oy: number) => void): void {
    const s = this.size;
    for (const ox of [0, -s, s]) {
      if (ox === -s && x + r < s) continue;
      if (ox === s && x - r > 0) continue;
      for (const oy of [0, -s, s]) {
        if (oy === -s && y + r < s) continue;
        if (oy === s && y - r > 0) continue;
        fn(ox, oy);
      }
    }
  }

  rect(x: number, y: number, w: number, h: number, color: string): this {
    this.x.fillStyle = color;
    this.wrapped(x + w / 2, y + h / 2, Math.max(w, h), (ox, oy) => this.x.fillRect(x + ox, y + oy, w, h));
    return this;
  }

  /** Soft irregular stains: damp, soot, rust, blood. */
  blotches(color: number, alpha: number, count: number, minR: number, maxR: number): this {
    const s = this.size;
    for (let i = 0; i < count; i++) {
      const cx = this.rng.range(0, s);
      const cy = this.rng.range(0, s);
      const r = this.rng.range(minR, maxR);
      for (let k = 0; k < 4; k++) {
        const bx = cx + this.rng.range(-r, r) * 0.5;
        const by = cy + this.rng.range(-r, r) * 0.5;
        const br = r * this.rng.range(0.4, 0.8);
        this.wrapped(bx, by, br, (ox, oy) => {
          const g = this.x.createRadialGradient(bx + ox, by + oy, 0, bx + ox, by + oy, br);
          g.addColorStop(0, rgba(color, alpha));
          g.addColorStop(0.6, rgba(color, alpha * 0.55));
          g.addColorStop(1, rgba(color, 0));
          this.x.fillStyle = g;
          this.x.fillRect(bx + ox - br, by + oy - br, br * 2, br * 2);
        });
      }
    }
    return this;
  }

  /** Thin random-walk cracks. */
  cracks(color: string, count: number, length: number, downward = false): this {
    const s = this.size;
    this.x.fillStyle = color;
    for (let i = 0; i < count; i++) {
      let px = this.rng.int(s);
      let py = this.rng.int(s);
      for (let k = 0; k < length; k++) {
        this.x.fillRect(((px % s) + s) % s, ((py % s) + s) % s, 1, 1);
        px += this.rng.int(3) - 1;
        py += downward ? this.rng.int(2) : this.rng.int(3) - 1;
      }
    }
    return this;
  }

  /** Vertical drips and water streaks running down from the top edge. */
  streaks(color: number, alpha: number, count: number): this {
    const s = this.size;
    for (let i = 0; i < count; i++) {
      const x = this.rng.int(s);
      const w = 1 + this.rng.int(3);
      const len = this.rng.range(s * 0.2, s * 0.9);
      const y0 = this.rng.range(-s * 0.2, s * 0.3);
      const g = this.x.createLinearGradient(0, y0, 0, y0 + len);
      g.addColorStop(0, rgba(color, alpha));
      g.addColorStop(1, rgba(color, 0));
      this.x.fillStyle = g;
      this.x.fillRect(x, y0, w, len);
      if (x + w > s) this.x.fillRect(x - s, y0, w, len);
    }
    return this;
  }

  /** Per-pixel grain, done in one ImageData pass. */
  noise(amount: number, colour = 0.25): this {
    const s = this.size;
    const img = this.x.getImageData(0, 0, s, s);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (this.rng.next() - 0.5) * 2 * amount;
      const c = colour * amount;
      d[i] = Math.max(0, Math.min(255, d[i] + n + (this.rng.next() - 0.5) * c));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n + (this.rng.next() - 0.5) * c));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n + (this.rng.next() - 0.5) * c));
    }
    this.x.putImageData(img, 0, 0);
    return this;
  }

  /** Darkens toward one edge: grime collecting near the floor. */
  gradient(fromAlpha: number, toAlpha: number, color = 0x000000): this {
    const g = this.x.createLinearGradient(0, 0, 0, this.size);
    g.addColorStop(0, rgba(color, fromAlpha));
    g.addColorStop(1, rgba(color, toAlpha));
    this.x.fillStyle = g;
    this.x.fillRect(0, 0, this.size, this.size);
    return this;
  }
}

function finish(c: HTMLCanvasElement, repeat = 1): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.repeat.set(repeat, repeat);
  return tex;
}

/* ------------------------------------------------------------------ walls */

function brick(base: number, mortar: number, seed: number, bw = 16, bh = 8): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(mortar);
  const s = p.size;
  for (let row = 0; row < s / bh; row++) {
    const offset = row % 2 === 0 ? 0 : bw / 2;
    for (let col = -1; col < s / bw + 1; col++) {
      const bx = col * bw + offset;
      const by = row * bh;
      const tone = shade(base, Math.round(p.rng.range(-26, 20)));
      p.rect(bx + 1, by + 1, bw - 2, bh - 2, rgb(tone));
      p.rect(bx + 1, by + 1, bw - 2, 1, rgba(0xffffff, 0.09));
      p.rect(bx + 1, by + bh - 2, bw - 2, 1, rgba(0x000000, 0.28));
      if (p.rng.chance(0.12)) p.rect(bx + 2 + p.rng.int(bw - 6), by + 2, 3, 2, rgba(0x000000, 0.3));
    }
  }
  p.blotches(0x140c08, 0.2, 5, 12, 28);
  p.streaks(0x0a0806, 0.22, 8);
  p.noise(14);
  return p.c;
}

function stoneBlocks(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(shade(base, -44));
  const s = p.size;
  const rowH = 32;
  for (let row = 0; row < s / rowH; row++) {
    let x = row % 2 === 0 ? 0 : 20;
    while (x < s + 40) {
      const w = 28 + p.rng.int(24);
      const tone = shade(base, Math.round(p.rng.range(-18, 16)));
      p.rect(x + 2, row * rowH + 2, w - 3, rowH - 3, rgb(tone));
      p.rect(x + 2, row * rowH + 2, w - 3, 2, rgba(0xffffff, 0.08));
      p.rect(x + 2, row * rowH + rowH - 3, w - 3, 2, rgba(0x000000, 0.3));
      x += w;
    }
  }
  p.blotches(0x1a1c14, 0.18, 6, 14, 32);
  p.cracks(rgba(0x000000, 0.35), 5, 40);
  p.noise(16);
  return p.c;
}

function plaster(base: number, seed: number, crack: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(base);
  p.blotches(shade(base, 20), 0.2, 5, 18, 40);
  p.blotches(0x2a2418, 0.14, 5, 16, 38);
  p.streaks(0x3a3020, 0.2, 12);
  p.cracks(rgba(crack, 0.8), 5, 60, true);
  // A few flakes of paint gone, showing the grey render underneath.
  for (let i = 0; i < 3; i++) {
    const x = p.rng.int(128);
    const y = p.rng.int(128);
    const w = 3 + p.rng.int(9);
    const h = 2 + p.rng.int(6);
    p.rect(x, y, w, h, rgba(shade(base, -46), 0.9));
    p.rect(x, y + h, w, 1, rgba(0x000000, 0.25));
  }
  p.noise(10);
  return p.c;
}

function wallpaper(base: number, stripe: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(base);
  for (let x = 0; x < 128; x += 16) {
    p.rect(x, 0, 6, 128, rgb(stripe));
    p.rect(x + 9, 0, 1, 128, rgba(stripe, 0.7));
  }
  // Small diamond motif between the stripes.
  for (let y = 4; y < 128; y += 16) {
    for (let x = 11; x < 128; x += 16) {
      p.rect(x, y + 1, 1, 1, rgba(stripe, 0.9));
      p.rect(x - 1, y + 2, 3, 1, rgba(stripe, 0.9));
      p.rect(x, y + 3, 1, 1, rgba(stripe, 0.9));
    }
  }
  p.blotches(0x3a2a14, 0.16, 5, 14, 34);
  p.streaks(0x2a1e10, 0.22, 10);
  // Peeled strips hanging off, plaster showing through.
  for (let i = 0; i < 2; i++) {
    const x = p.rng.int(120);
    const y = p.rng.int(100);
    const w = 6 + p.rng.int(10);
    const h = 10 + p.rng.int(24);
    p.rect(x, y, w, h, rgb(0x8a8474));
    p.rect(x + w, y, 1, h, rgba(0x000000, 0.35));
  }
  p.noise(10);
  return p.c;
}

function tiles(base: number, grout: number, seed: number, t = 16, broken = 0.05): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(grout);
  for (let gy = 0; gy < 128 / t; gy++) {
    for (let gx = 0; gx < 128 / t; gx++) {
      if (p.rng.chance(broken)) {
        // A cracked, stained tile rather than a hole.
        p.rect(gx * t + 1, gy * t + 1, t - 1, t - 1, rgb(shade(base, -34)));
        p.rect(gx * t + 2, gy * t + t / 2, t - 3, 1, rgba(0x000000, 0.5));
        continue;
      }
      const tone = shade(base, Math.round(p.rng.range(-12, 10)));
      p.rect(gx * t + 1, gy * t + 1, t - 1, t - 1, rgb(tone));
      p.rect(gx * t + 1, gy * t + 1, t - 1, 1, rgba(0xffffff, 0.16));
      p.rect(gx * t + 1, gy * t + 1, 1, t - 1, rgba(0xffffff, 0.08));
      p.rect(gx * t + 1, gy * t + t - 1, t - 1, 1, rgba(0x000000, 0.18));
      if (p.rng.chance(0.08)) p.cracks(rgba(0x000000, 0.45), 1, 14);
    }
  }
  p.blotches(0x3a2a1a, 0.16, 5, 12, 28);
  p.streaks(0x2a2014, 0.2, 6);
  p.noise(8);
  return p.c;
}

function metalPanel(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(base);
  for (let i = 0; i < 128; i += 2) p.rect(0, i, 128, 1, rgba(0xffffff, i % 8 === 0 ? 0.05 : 0.02));
  // Panel seams + rivets.
  for (const v of [0, 64]) {
    p.rect(0, v, 128, 2, rgba(0x000000, 0.55));
    p.rect(v, 0, 2, 128, rgba(0x000000, 0.55));
    p.rect(0, v + 2, 128, 1, rgba(0xffffff, 0.1));
  }
  for (let y = 6; y < 128; y += 29) {
    for (const x of [6, 58, 70, 122]) {
      p.rect(x, y, 3, 3, rgb(shade(base, 50)));
      p.rect(x + 1, y + 2, 3, 2, rgba(0x000000, 0.45));
    }
  }
  p.blotches(0x6a3014, 0.24, 5, 8, 20);
  p.streaks(0x5a2a10, 0.26, 8);
  p.cracks(rgba(0xffffff, 0.12), 8, 18);
  p.noise(10);
  return p.c;
}

function woodPanel(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(shade(base, -40));
  const bw = 16;
  for (let i = 0; i < 128 / bw; i++) {
    const tone = shade(base, Math.round(p.rng.range(-18, 14)));
    p.rect(i * bw + 1, 0, bw - 2, 128, rgb(tone));
    p.rect(i * bw + 1, 0, 1, 128, rgba(0xffffff, 0.08));
    for (let g = 0; g < 9; g++) {
      const gx = i * bw + 2 + p.rng.int(bw - 4);
      p.rect(gx, p.rng.int(128), 1, 12 + p.rng.int(40), rgba(shade(tone, -30), 0.9));
    }
  }
  p.rect(0, 0, 128, 5, rgb(shade(base, -10)));
  p.rect(0, 5, 128, 1, rgba(0x000000, 0.5));
  p.blotches(0x140a04, 0.18, 5, 12, 28);
  p.noise(9);
  return p.c;
}

function hazard(seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(0x1a1a18);
  p.x.save();
  p.x.fillStyle = rgb(0xc9a22a);
  for (let i = -128; i < 256; i += 32) {
    p.x.beginPath();
    p.x.moveTo(i, 128);
    p.x.lineTo(i + 16, 128);
    p.x.lineTo(i + 16 + 128, 0);
    p.x.lineTo(i + 128, 0);
    p.x.closePath();
    p.x.fill();
  }
  p.x.restore();
  p.blotches(0x0a0806, 0.5, 10, 8, 26);
  p.cracks(rgba(0x000000, 0.4), 10, 30);
  p.noise(12);
  return p.c;
}

/* ----------------------------------------------------------------- floors */

function checker(a: number, b: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(0x1a1814);
  const t = 32;
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const tone = shade((gx + gy) % 2 === 0 ? a : b, Math.round(p.rng.range(-8, 8)));
      p.rect(gx * t + 1, gy * t + 1, t - 2, t - 2, rgb(tone));
      p.rect(gx * t + 1, gy * t + 1, t - 2, 1, rgba(0xffffff, 0.07));
    }
  }
  p.blotches(0x2a1c10, 0.18, 5, 14, 32);
  p.cracks(rgba(0x000000, 0.35), 4, 40);
  p.noise(9);
  return p.c;
}

function lino(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(shade(base, -36));
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      p.rect(gx * 64 + 1, gy * 64 + 1, 62, 62, rgb(shade(base, Math.round(p.rng.range(-8, 8)))));
    }
  }
  // Speckled terrazzo chips.
  for (let i = 0; i < 700; i++) {
    const v = p.rng.chance(0.5) ? shade(base, 30) : shade(base, -30);
    p.rect(p.rng.int(128), p.rng.int(128), 1, 1, rgba(v, 0.7));
  }
  p.blotches(0x1e1a14, 0.15, 6, 12, 30);
  p.noise(7);
  return p.c;
}

function woodFloor(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(shade(base, -50));
  const pw = 16;
  for (let row = 0; row < 128 / pw; row++) {
    let x = -p.rng.int(64);
    while (x < 128) {
      const len = 40 + p.rng.int(48);
      const tone = shade(base, Math.round(p.rng.range(-22, 16)));
      p.rect(x + 1, row * pw + 1, len - 2, pw - 2, rgb(tone));
      for (let g = 0; g < 4; g++) {
        p.rect(x + p.rng.int(len), row * pw + 2 + p.rng.int(pw - 4), 8 + p.rng.int(20), 1, rgba(shade(tone, -28), 0.9));
      }
      x += len;
    }
  }
  p.blotches(0x140a04, 0.16, 5, 12, 30);
  p.noise(8);
  return p.c;
}

function concrete(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(base);
  p.blotches(0x000000, 0.13, 8, 12, 36);
  p.blotches(shade(base, 30), 0.1, 5, 12, 30);
  p.cracks(rgba(0x000000, 0.45), 6, 60);
  p.rect(0, 0, 128, 1, rgba(0x000000, 0.35));
  p.rect(0, 0, 1, 128, rgba(0x000000, 0.35));
  p.noise(14);
  return p.c;
}

function grate(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(0x0b0c0d);
  for (let i = 0; i < 128; i += 8) {
    p.rect(i, 0, 5, 128, rgb(base));
    p.rect(i, 0, 1, 128, rgba(0xffffff, 0.12));
    p.rect(0, i, 128, 2, rgb(shade(base, -12)));
  }
  p.blotches(0x6a3014, 0.22, 6, 8, 18);
  p.noise(12);
  return p.c;
}

function flagstone(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(shade(base, -48));
  const cells = [[0, 0, 64, 48], [64, 0, 64, 32], [0, 48, 40, 48], [40, 48, 48, 48], [88, 32, 40, 64], [0, 96, 72, 32], [72, 96, 56, 32]];
  for (const [x, y, w, h] of cells) {
    p.rect(x + 2, y + 2, w - 3, h - 3, rgb(shade(base, Math.round(p.rng.range(-16, 14)))));
    p.rect(x + 2, y + 2, w - 3, 1, rgba(0xffffff, 0.08));
  }
  p.blotches(0x141810, 0.2, 6, 12, 30);
  p.cracks(rgba(0x000000, 0.35), 4, 40);
  p.noise(14);
  return p.c;
}

function dirt(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(base);
  p.blotches(shade(base, -30), 0.4, 14, 8, 30);
  p.blotches(shade(base, 24), 0.25, 10, 6, 20);
  for (let i = 0; i < 90; i++) {
    const x = p.rng.int(128);
    const y = p.rng.int(128);
    const s = 1 + p.rng.int(3);
    p.rect(x, y, s, s, rgb(shade(base, Math.round(p.rng.range(-10, 40)))));
    p.rect(x, y + s, s, 1, rgba(0x000000, 0.4));
  }
  p.noise(18);
  return p.c;
}

/* ------------------------------------------------------------ town & works */

function asphalt(seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(0x2e2e30);
  for (let i = 0; i < 1800; i++) p.rect(p.rng.int(128), p.rng.int(128), 1, 1, rgba(p.rng.chance(0.5) ? 0x5a5a5a : 0x141414, 0.6));
  p.blotches(0x0a0a0a, 0.3, 6, 10, 30);
  p.cracks(rgba(0x0a0a0a, 0.8), 6, 60);
  // A worn road marking.
  for (let y = 4; y < 128; y += 32) p.rect(62, y, 4, 16, rgba(0xc8b060, 0.35));
  p.noise(10);
  return p.c;
}

function cobble(seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(0x1e1c1a);
  for (let y = 0; y < 128; y += 10) {
    let x = (y / 10) % 2 === 0 ? 0 : -6;
    while (x < 128) {
      const w = 9 + p.rng.int(6);
      p.rect(x + 1, y + 1, w - 2, 8, rgb(shade(0x5a5650, Math.round(p.rng.range(-18, 14)))));
      p.rect(x + 1, y + 1, w - 2, 1, rgba(0xffffff, 0.1));
      x += w;
    }
  }
  p.blotches(0x0a0806, 0.25, 6, 12, 30);
  p.noise(10);
  return p.c;
}

function grass(seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(0x26341c);
  for (let i = 0; i < 2600; i++) {
    const c = p.rng.pick([0x3a4a24, 0x1a2412, 0x4a5a2c, 0x2e3a1c]);
    p.rect(p.rng.int(128), p.rng.int(128), 1, 1 + p.rng.int(3), rgb(c));
  }
  p.blotches(0x3a2e1e, 0.4, 6, 8, 24);
  p.noise(8);
  return p.c;
}

function gravel(seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(0x4a4640);
  for (let i = 0; i < 1400; i++) {
    const s = 1 + p.rng.int(3);
    p.rect(p.rng.int(128), p.rng.int(128), s, s, rgb(shade(0x5a5650, Math.round(p.rng.range(-30, 30)))));
  }
  p.blotches(0x1a1814, 0.3, 6, 10, 28);
  p.noise(10);
  return p.c;
}

/** Shopfront brick with a dark sash window in every bay. */
function facade(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed);
  p.x.drawImage(brick(base, 0x2e2824, seed + 1), 0, 0);
  for (const x of [14, 78]) {
    p.rect(x - 3, 30, 42, 58, rgb(0x2a2420));
    p.rect(x, 33, 36, 52, rgb(0x0c1018));
    p.rect(x + 17, 33, 2, 52, rgb(0x2a2420));
    p.rect(x, 58, 36, 2, rgb(0x2a2420));
    p.rect(x + 2, 35, 12, 6, rgba(0x6a7a9a, 0.3));
    p.rect(x - 4, 88, 44, 4, rgb(0x6a6258));
  }
  p.streaks(0x0a0806, 0.3, 8);
  p.noise(8);
  return p.c;
}

/** Painted clapboard siding, peeling. */
function siding(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(shade(base, -40));
  for (let y = 0; y < 128; y += 12) {
    p.rect(0, y, 128, 11, rgb(shade(base, Math.round(p.rng.range(-10, 10)))));
    p.rect(0, y + 10, 128, 2, rgba(0x000000, 0.35));
  }
  for (let i = 0; i < 8; i++) p.rect(p.rng.int(120), p.rng.int(120), 4 + p.rng.int(14), 2 + p.rng.int(6), rgb(0x6a5a44));
  p.streaks(0x2a2418, 0.3, 10);
  p.noise(8);
  return p.c;
}

/** Rusted corrugated steel sheeting. */
function corrugated(seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(0x4a4e50);
  for (let x = 0; x < 128; x += 8) {
    p.rect(x, 0, 4, 128, rgba(0xffffff, 0.08));
    p.rect(x + 5, 0, 2, 128, rgba(0x000000, 0.3));
  }
  p.blotches(0x7a3a14, 0.5, 9, 8, 26);
  p.streaks(0x6a2a0a, 0.5, 16);
  p.noise(10);
  return p.c;
}

/** Clean composite wall panels, with the odd bloody handprint. */
function labPanel(seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(0xb4bcc0);
  for (const v of [0, 64]) {
    p.rect(0, v, 128, 2, rgba(0x000000, 0.25));
    p.rect(v, 0, 2, 128, rgba(0x000000, 0.25));
  }
  p.rect(0, 100, 128, 6, rgb(0x2a6a8a));
  p.blotches(0x5a6a70, 0.12, 4, 12, 30);
  p.blotches(0x6a0806, 0.5, 2, 3, 7);
  p.noise(5);
  return p.c;
}

function labFloor(seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(0x5a6670);
  for (const v of [0, 64]) {
    p.rect(0, v, 128, 1, rgba(0xffffff, 0.12));
    p.rect(v, 0, 1, 128, rgba(0xffffff, 0.12));
  }
  p.blotches(0x2a3238, 0.2, 6, 12, 30);
  p.blotches(0x5a0806, 0.35, 2, 4, 10);
  p.noise(6);
  return p.c;
}

/** What the underground "windows" look out on: a vent shaft with a slow fan. */
function ventShaft(seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(0x101418);
  for (let i = 0; i < 128; i += 16) p.rect(0, i, 128, 2, rgb(0x1e262c));
  p.x.strokeStyle = '#2a343c';
  p.x.lineWidth = 6;
  p.x.beginPath();
  p.x.arc(64, 64, 40, 0, Math.PI * 2);
  p.x.stroke();
  p.x.fillStyle = '#1e262c';
  for (let i = 0; i < 4; i++) {
    p.x.save();
    p.x.translate(64, 64);
    p.x.rotate((i * Math.PI) / 2 + 0.3);
    p.x.fillRect(-6, 0, 12, 36);
    p.x.restore();
  }
  p.noise(8);
  return p.c;
}

/* --------------------------------------------------------------- ceilings */

function acoustic(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(base);
  // T-bar grid of a drop ceiling.
  for (const v of [0, 64]) {
    p.rect(0, v, 128, 3, rgb(0x8a8c88));
    p.rect(v, 0, 3, 128, rgb(0x8a8c88));
    p.rect(0, v + 3, 128, 1, rgba(0x000000, 0.3));
  }
  for (let i = 0; i < 900; i++) p.rect(p.rng.int(128), p.rng.int(128), 1, 1, rgba(0x000000, 0.14));
  p.blotches(0x6a4a20, 0.16, 3, 12, 28);
  p.noise(7);
  return p.c;
}

function beams(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(shade(base, -30));
  for (let i = 0; i < 128; i += 16) {
    p.rect(0, i + 1, 128, 14, rgb(shade(base, Math.round(p.rng.range(-14, 10)))));
    p.rect(0, i + 1, 128, 1, rgba(0xffffff, 0.06));
  }
  p.blotches(0x0a0604, 0.2, 5, 12, 30);
  p.noise(9);
  return p.c;
}

/* ------------------------------------------------------------------ props */

function planks(base: number, seed: number, vertical: boolean): HTMLCanvasElement {
  const p = new Painter(64, seed).fill(shade(base, -50));
  const pw = 10;
  for (let i = 0; i < 64 / pw + 1; i++) {
    const tone = shade(base, Math.round(p.rng.range(-24, 20)));
    if (vertical) p.rect(i * pw, 0, pw - 1, 64, rgb(tone));
    else p.rect(0, i * pw, 64, pw - 1, rgb(tone));
    for (let g = 0; g < 7; g++) {
      const off = p.rng.int(pw - 2) + 1;
      const c = rgba(shade(tone, -26), 1);
      if (vertical) p.rect(i * pw + off, p.rng.int(64), 1, p.rng.int(30) + 8, c);
      else p.rect(p.rng.int(64), i * pw + off, p.rng.int(30) + 8, 1, c);
    }
  }
  // Nail heads.
  for (let i = 0; i < 6; i++) p.rect(p.rng.int(62), p.rng.int(62), 2, 2, rgb(0x3a3a3a));
  p.noise(12);
  return p.c;
}

function securityDoor(seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed).fill(0x4a3a2c);
  // A heavy steel-banded wooden door, chained shut.
  for (let i = 0; i < 128; i += 16) {
    p.rect(i + 1, 0, 14, 128, rgb(shade(0x5a4430, Math.round(p.rng.range(-18, 14)))));
  }
  for (const y of [14, 60, 106]) {
    p.rect(0, y, 128, 9, rgb(0x3a3d40));
    p.rect(0, y, 128, 1, rgba(0xffffff, 0.2));
    for (let x = 6; x < 128; x += 20) p.rect(x, y + 3, 3, 3, rgb(0x8a8c8a));
  }
  p.blotches(0x6a3014, 0.45, 6, 6, 18);
  p.streaks(0x100804, 0.45, 12);
  p.noise(12);
  return p.c;
}

function crate(seed: number): HTMLCanvasElement {
  const p = new Painter(64, seed);
  p.x.drawImage(planks(0x7a5a34, seed + 1, false), 0, 0);
  p.rect(0, 0, 64, 6, rgb(0x5a4024));
  p.rect(0, 58, 64, 6, rgb(0x5a4024));
  p.rect(0, 0, 6, 64, rgb(0x5a4024));
  p.rect(58, 0, 6, 64, rgb(0x5a4024));
  p.x.strokeStyle = rgb(0x5a4024);
  p.x.lineWidth = 5;
  p.x.beginPath();
  p.x.moveTo(4, 4);
  p.x.lineTo(60, 60);
  p.x.stroke();
  p.x.fillStyle = rgba(0x1a1a1a, 0.7);
  p.x.font = 'bold 10px monospace';
  p.x.fillText('AMMO', 20, 36);
  p.noise(10);
  return p.c;
}

function fabric(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(64, seed).fill(base);
  for (let i = 0; i < 64; i += 4) p.rect(0, i, 64, 1, rgba(0x000000, 0.06));
  p.blotches(0x6a5a30, 0.3, 5, 6, 16);
  p.blotches(0x5a0a08, 0.5, 2, 4, 10);
  p.noise(10);
  return p.c;
}

function paperStack(seed: number): HTMLCanvasElement {
  const p = new Painter(64, seed).fill(0x8a7a5a);
  for (let y = 0; y < 64; y += 4) {
    p.rect(0, y, 64, 3, rgb(shade(0xc8bc9a, Math.round(p.rng.range(-30, 10)))));
  }
  for (let x = 0; x < 64; x += 16) p.rect(x, 0, 1, 64, rgba(0x000000, 0.3));
  p.noise(10);
  return p.c;
}

/** What you see through a window: a night sky, a treeline and the asylum fence. */
function nightSky(seed: number): HTMLCanvasElement {
  const p = new Painter(128, seed);
  const g = p.x.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#070a14');
  g.addColorStop(0.55, '#141c30');
  g.addColorStop(0.8, '#26304a');
  g.addColorStop(1, '#0c0e12');
  p.x.fillStyle = g;
  p.x.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 40; i++) p.rect(p.rng.int(128), p.rng.int(64), 1, 1, rgba(0xdfe6ff, p.rng.range(0.3, 0.9)));
  // Treeline: jagged silhouettes against the glow at the horizon.
  p.x.fillStyle = '#05060a';
  let x = 0;
  while (x < 128) {
    const w = 6 + p.rng.int(12);
    const h = 18 + p.rng.int(30);
    p.x.beginPath();
    p.x.moveTo(x, 128);
    p.x.lineTo(x + w / 2, 128 - h - 40);
    p.x.lineTo(x + w, 128);
    p.x.fill();
    p.x.fillRect(x, 100, w, 28);
    x += w - 2;
  }
  // The fence.
  for (let fx = 2; fx < 128; fx += 6) p.rect(fx, 88, 1, 40, '#020203');
  p.rect(0, 92, 128, 1, '#020203');
  p.rect(0, 104, 128, 1, '#020203');
  return p.c;
}

/* ------------------------------------------------------------- decoration */

function bloodSplat(seed: number): HTMLCanvasElement {
  const p = new Painter(32, seed);
  p.x.clearRect(0, 0, 32, 32);
  const cx = 16;
  const cy = 16;
  for (let i = 0; i < 34; i++) {
    const ang = p.rng.range(0, Math.PI * 2);
    const rad = p.rng.range(0, 9);
    const s = Math.max(1, Math.round(p.rng.range(2, 7)));
    p.x.fillStyle = `rgba(${Math.round(p.rng.range(80, 140))},6,8,${p.rng.range(0.55, 0.95).toFixed(2)})`;
    p.x.fillRect(Math.round(cx + Math.cos(ang) * rad), Math.round(cy + Math.sin(ang) * rad), s, s);
  }
  for (let i = 0; i < 18; i++) {
    const ang = p.rng.range(0, Math.PI * 2);
    const rad = p.rng.range(8, 15);
    p.x.fillStyle = `rgba(96,4,6,${p.rng.range(0.3, 0.8).toFixed(2)})`;
    p.x.fillRect(Math.round(cx + Math.cos(ang) * rad), Math.round(cy + Math.sin(ang) * rad), 2, 2);
  }
  return p.c;
}

function bulletHole(): HTMLCanvasElement {
  const p = new Painter(16, 1);
  p.x.clearRect(0, 0, 16, 16);
  p.x.fillStyle = 'rgba(30,26,22,0.75)';
  p.x.beginPath();
  p.x.arc(8, 8, 5.5, 0, Math.PI * 2);
  p.x.fill();
  p.x.fillStyle = 'rgba(8,7,6,0.95)';
  p.x.fillRect(6, 6, 4, 4);
  p.x.fillStyle = 'rgba(190,185,170,0.35)';
  p.x.fillRect(5, 4, 1, 1);
  p.x.fillRect(11, 10, 1, 1);
  return p.c;
}

/** A soft round glow for lamp halos and muzzle flashes. */
function glowSprite(): HTMLCanvasElement {
  const p = new Painter(32, 7);
  p.x.clearRect(0, 0, 32, 32);
  const g = p.x.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  p.x.fillStyle = g;
  p.x.fillRect(0, 0, 32, 32);
  return p.c;
}

/** A spiky star for the muzzle flash, painted white so it can be tinted. */
function flashSprite(seed: number): HTMLCanvasElement {
  const p = new Painter(64, seed);
  p.x.clearRect(0, 0, 64, 64);
  const spikes = 7;
  p.x.translate(32, 32);
  for (let layer = 0; layer < 3; layer++) {
    p.x.beginPath();
    for (let i = 0; i <= spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2 + layer * 0.4;
      const r = i % 2 === 0 ? p.rng.range(18, 31) * (1 - layer * 0.25) : p.rng.range(4, 9);
      if (i === 0) p.x.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else p.x.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    p.x.closePath();
    p.x.fillStyle = `rgba(255,255,255,${0.35 + layer * 0.3})`;
    p.x.fill();
  }
  p.x.setTransform(1, 0, 0, 1, 0, 0);
  return p.c;
}

/** Perk machine face: a bold colour block with a stencilled label. */
function perkFace(color: number, label: string, glyph: string): HTMLCanvasElement {
  const p = new Painter(64, label.length * 977 + color).fill(shade(color, -90));
  p.rect(4, 4, 56, 56, rgb(color));
  p.rect(4, 40, 56, 20, rgb(shade(color, -60)));
  p.x.fillStyle = 'rgba(0,0,0,0.85)';
  p.x.font = 'bold 26px monospace';
  p.x.textAlign = 'center';
  p.x.textBaseline = 'middle';
  p.x.fillText(glyph, 32, 24);
  p.x.fillStyle = '#f4efe2';
  p.x.font = 'bold 9px monospace';
  label.split(' ').forEach((w, i) => p.x.fillText(w, 32, 46 + i * 9));
  p.noise(8);
  return p.c;
}

/** The mystery box lid: crate boards with a big question mark burnt in. */
function mysteryLid(): HTMLCanvasElement {
  const p = new Painter(64, 0xb0c5);
  p.x.drawImage(planks(0x7d5a30, 0x4321, false), 0, 0);
  p.x.fillStyle = 'rgba(20,14,6,0.8)';
  p.x.font = 'bold 42px monospace';
  p.x.textAlign = 'center';
  p.x.textBaseline = 'middle';
  p.x.fillText('?', 32, 34);
  p.x.strokeStyle = 'rgba(210,170,70,0.65)';
  p.x.lineWidth = 2;
  p.x.strokeRect(3, 3, 58, 58);
  p.noise(8);
  return p.c;
}

/** Wall-buy placard: weapon name and price over a chalk outline. */
export function weaponPlacard(name: string, cost: number): HTMLCanvasElement {
  const p = new Painter(128, name.length * 131 + cost).fill('#20242a');
  p.rect(5, 5, 118, 118, '#2c3138');
  p.x.strokeStyle = 'rgba(232,226,206,0.8)';
  p.x.lineWidth = 3;
  p.x.beginPath();
  p.x.moveTo(16, 60);
  p.x.lineTo(104, 60);
  p.x.lineTo(104, 72);
  p.x.lineTo(70, 72);
  p.x.lineTo(64, 92);
  p.x.lineTo(52, 92);
  p.x.lineTo(56, 72);
  p.x.lineTo(16, 72);
  p.x.closePath();
  p.x.stroke();
  p.x.fillStyle = '#e8e2ce';
  p.x.font = 'bold 15px monospace';
  p.x.textAlign = 'center';
  p.x.textBaseline = 'middle';
  p.x.fillText(name.slice(0, 14), 64, 26);
  p.x.fillStyle = '#ffd84d';
  p.x.font = 'bold 19px monospace';
  p.x.fillText(`${cost}`, 64, 112);
  p.noise(6);
  return p.c;
}

/* ---------------------------------------------------------------- zombies */

/**
 * Zombie skin sheet. The body model maps every box to the whole sheet, so the
 * result is a mottled, blotchy hide rather than anything anatomical - which is
 * precisely how low-poly monsters of the era were textured.
 */
function zombieSkin(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(32, seed).fill(base);
  p.blotches(0x28401e, 0.4, 6, 3, 8);
  p.blotches(0x7a1012, 0.55, 4, 2, 6);
  p.blotches(0x120c0a, 0.4, 3, 2, 5);
  for (let i = 0; i < 5; i++) p.rect(p.rng.int(32), p.rng.int(32), p.rng.int(6) + 2, 1, rgba(0x96786e, 0.5));
  p.noise(22);
  return p.c;
}

/** Torn, filthy clothing: a flat colour with rips, grime and old blood. */
function zombieCloth(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(32, seed).fill(base);
  for (let i = 0; i < 32; i += 3) p.rect(0, i, 32, 1, rgba(0x000000, 0.08));
  p.blotches(0x1a140c, 0.45, 5, 3, 9);
  p.blotches(0x5a0806, 0.55, 3, 2, 6);
  for (let i = 0; i < 4; i++) {
    p.rect(p.rng.int(30), p.rng.int(30), 1 + p.rng.int(3), 2 + p.rng.int(5), rgba(0x0a0806, 0.8));
  }
  p.noise(14);
  return p.c;
}

/* ------------------------------------------------------------------- guns */

/** Oiled walnut, grain running along the stock. */
function gunWood(seed: number): HTMLCanvasElement {
  const p = new Painter(64, seed).fill(0x6a3c20);
  for (let y = 0; y < 64; y++) {
    const wave = Math.sin(y * 0.35) * 0.5 + 0.5;
    p.rect(0, y, 64, 1, rgba(wave > 0.6 ? 0x3a1e0c : 0x8a5430, 0.25 + wave * 0.2));
  }
  for (let i = 0; i < 26; i++) {
    const y = p.rng.int(64);
    p.rect(p.rng.int(64), y, 10 + p.rng.int(30), 1, rgba(0x2a1406, 0.55));
  }
  p.blotches(0x2a1406, 0.25, 3, 6, 14);
  p.noise(8);
  return p.c;
}

/** Diamond checkering for pistol grips and the like. */
function gunGrip(seed: number): HTMLCanvasElement {
  const p = new Painter(32, seed).fill(0x4a2a16);
  for (let y = 0; y < 32; y += 2) {
    for (let x = (y / 2) % 2; x < 32; x += 2) p.rect(x, y, 1, 1, rgba(0x1a0c04, 0.8));
  }
  p.noise(10);
  return p.c;
}

/** Worn blued steel: fine vertical brushing and bright edges where it has been handled. */
function gunMetal(seed: number): HTMLCanvasElement {
  const p = new Painter(32, seed).fill(0x9aa0a8);
  for (let x = 0; x < 32; x++) p.rect(x, 0, 1, 32, rgba(p.rng.chance(0.5) ? 0xffffff : 0x000000, p.rng.range(0.02, 0.08)));
  p.blotches(0x5a4a3a, 0.12, 2, 4, 9);
  p.noise(10);
  return p.c;
}

/** Heavy canvas for sleeves. */
function fabricWeave(base: number, seed: number): HTMLCanvasElement {
  const p = new Painter(32, seed).fill(base);
  for (let i = 0; i < 32; i += 2) {
    p.rect(0, i, 32, 1, rgba(0x000000, 0.12));
    p.rect(i, 0, 1, 32, rgba(0xffffff, 0.05));
  }
  p.blotches(0x1a1a10, 0.2, 3, 4, 10);
  p.noise(8);
  return p.c;
}

/** Pack-a-Punch camo: swirling violet and teal, painted over the metal. */
function papCamo(seed: number): HTMLCanvasElement {
  const p = new Painter(64, seed).fill(0x1a0a2a);
  for (let i = 0; i < 18; i++) {
    const c = p.rng.pick([0x6a2aa8, 0x2a8a9a, 0xa83ac8, 0x1a4a8a]);
    p.blotches(c, 0.85, 1, 6, 16);
  }
  for (let i = 0; i < 40; i++) p.rect(p.rng.int(64), p.rng.int(64), 2, 2, rgba(0x9afcff, 0.7));
  p.noise(10);
  return p.c;
}

/** Tier II camo: crimson and molten orange, cracked like cooling slag. */
function hellfireCamo(seed: number): HTMLCanvasElement {
  const p = new Painter(64, seed).fill(0x2a0806);
  for (let i = 0; i < 16; i++) p.blotches(p.rng.pick([0x9a1a0c, 0xd8501a, 0x6a0a06]), 0.85, 1, 5, 15);
  p.cracks(rgba(0xffc040, 0.9), 12, 26);
  p.noise(10);
  return p.c;
}

/** Tier III camo: burnished gold shot through with cyan. */
function aetherCamo(seed: number): HTMLCanvasElement {
  const p = new Painter(64, seed).fill(0x3a2a08);
  for (let i = 0; i < 16; i++) p.blotches(p.rng.pick([0xc89a2a, 0xf0d060, 0x8a6a18]), 0.85, 1, 6, 16);
  for (let i = 0; i < 30; i++) p.rect(p.rng.int(64), p.rng.int(64), 2, 1, rgba(0x6affff, 0.85));
  p.cracks(rgba(0x3affe8, 0.7), 6, 20);
  p.noise(8);
  return p.c;
}

/** Perforated steel for a shotgun heat shield. */
function perforated(seed: number): HTMLCanvasElement {
  const p = new Painter(32, seed).fill(0x2a2c30);
  for (let y = 2; y < 32; y += 8) {
    for (let x = 2; x < 32; x += 8) p.rect(x + ((y / 8) % 2) * 4, y, 4, 4, '#050505');
  }
  p.noise(6);
  return p.c;
}

/* ------------------------------------------------------------------ cache */

export type TextureSet = {
  plasterSick: THREE.CanvasTexture;
  plasterBlue: THREE.CanvasTexture;
  plasterWhite: THREE.CanvasTexture;
  wallpaper: THREE.CanvasTexture;
  brickRed: THREE.CanvasTexture;
  brickGrey: THREE.CanvasTexture;
  stone: THREE.CanvasTexture;
  metal: THREE.CanvasTexture;
  metalDark: THREE.CanvasTexture;
  tileGreen: THREE.CanvasTexture;
  tileBlue: THREE.CanvasTexture;
  tileWhite: THREE.CanvasTexture;
  woodPanel: THREE.CanvasTexture;
  hazard: THREE.CanvasTexture;

  floorChecker: THREE.CanvasTexture;
  floorLino: THREE.CanvasTexture;
  floorWood: THREE.CanvasTexture;
  floorConcrete: THREE.CanvasTexture;
  floorGrate: THREE.CanvasTexture;
  floorStone: THREE.CanvasTexture;
  floorTileWhite: THREE.CanvasTexture;
  floorDirt: THREE.CanvasTexture;
  ground: THREE.CanvasTexture;
  nightSky: THREE.CanvasTexture;
  asphalt: THREE.CanvasTexture;
  cobble: THREE.CanvasTexture;
  grass: THREE.CanvasTexture;
  gravel: THREE.CanvasTexture;
  facade: THREE.CanvasTexture;
  facadeGrey: THREE.CanvasTexture;
  siding: THREE.CanvasTexture;
  corrugated: THREE.CanvasTexture;
  labPanel: THREE.CanvasTexture;
  labFloor: THREE.CanvasTexture;
  ventShaft: THREE.CanvasTexture;

  ceilAcoustic: THREE.CanvasTexture;
  ceilConcrete: THREE.CanvasTexture;
  ceilWood: THREE.CanvasTexture;
  ceilMetal: THREE.CanvasTexture;

  wood: THREE.CanvasTexture;
  woodV: THREE.CanvasTexture;
  door: THREE.CanvasTexture;
  crate: THREE.CanvasTexture;
  sheet: THREE.CanvasTexture;
  paper: THREE.CanvasTexture;
  blood: THREE.CanvasTexture[];
  bullet: THREE.CanvasTexture;
  glow: THREE.CanvasTexture;
  flash: THREE.CanvasTexture[];
  mystery: THREE.CanvasTexture;
  zombieSkins: THREE.CanvasTexture[];
  zombieCloth: THREE.CanvasTexture[];
  houndSkin: THREE.CanvasTexture;
  gunWood: THREE.CanvasTexture;
  gunGrip: THREE.CanvasTexture;
  gunMetal: THREE.CanvasTexture;
  sleeve: THREE.CanvasTexture;
  camo: THREE.CanvasTexture;
  camo2: THREE.CanvasTexture;
  camo3: THREE.CanvasTexture;
  perforated: THREE.CanvasTexture;
};

let cache: TextureSet | null = null;

export function textures(): TextureSet {
  if (cache) return cache;
  cache = {
    plasterSick: finish(plaster(0x9a9270, 0x1003, 0x4a4436)),
    plasterBlue: finish(plaster(0x74828e, 0x1004, 0x3a4048)),
    plasterWhite: finish(plaster(0xa8a89c, 0x1011, 0x5a5a50)),
    wallpaper: finish(wallpaper(0x7a6a48, 0x5a3a2a, 0x1012)),
    brickRed: finish(brick(0x7e412c, 0x3b332c, 0x1001)),
    brickGrey: finish(brick(0x5c5f62, 0x33353a, 0x1002)),
    stone: finish(stoneBlocks(0x6a6660, 0x1013)),
    metal: finish(metalPanel(0x566068, 0x1006)),
    metalDark: finish(metalPanel(0x3a4046, 0x1014)),
    tileGreen: finish(tiles(0x5e7a62, 0x2a3028, 0x1005)),
    tileBlue: finish(tiles(0x7a929c, 0x3a4448, 0x1015)),
    tileWhite: finish(tiles(0xb4b8b0, 0x5a5c58, 0x1016, 16, 0.07)),
    woodPanel: finish(woodPanel(0x6a4428, 0x1017)),
    hazard: finish(hazard(0x1018)),

    floorChecker: finish(checker(0xb0a88c, 0x2c3a30, 0x1009)),
    floorLino: finish(lino(0x7a8274, 0x1019)),
    floorWood: finish(woodFloor(0x6a4a2c, 0x101a)),
    floorConcrete: finish(concrete(0x5c5a52, 0x100a)),
    floorGrate: finish(grate(0x525a60, 0x100b)),
    floorStone: finish(flagstone(0x5e5a54, 0x101b)),
    floorTileWhite: finish(tiles(0x9aa09c, 0x3a3c38, 0x101c, 32, 0.03)),
    floorDirt: finish(dirt(0x4a3e30, 0x101d)),
    ground: finish(dirt(0x2c3226, 0x101e)),
    nightSky: finish(nightSky(0x1025)),
    asphalt: finish(asphalt(0x1030)),
    cobble: finish(cobble(0x1031)),
    grass: finish(grass(0x1032)),
    gravel: finish(gravel(0x1033)),
    facade: finish(facade(0x7a4030, 0x1034)),
    facadeGrey: finish(facade(0x5e5a54, 0x1035)),
    siding: finish(siding(0x6a7a70, 0x1036)),
    corrugated: finish(corrugated(0x1037)),
    labPanel: finish(labPanel(0x1038)),
    labFloor: finish(labFloor(0x1039)),
    ventShaft: finish(ventShaft(0x103a)),

    ceilAcoustic: finish(acoustic(0x8a867a, 0x100c)),
    ceilConcrete: finish(concrete(0x403e38, 0x101f)),
    ceilWood: finish(beams(0x4a3420, 0x1020)),
    ceilMetal: finish(metalPanel(0x3a4046, 0x1021)),

    wood: finish(planks(0x6b4527, 0x1007, false)),
    woodV: finish(planks(0x6b4527, 0x1008, true)),
    door: finish(securityDoor(0x100d)),
    crate: finish(crate(0x1022)),
    sheet: finish(fabric(0x9a968a, 0x1023)),
    paper: finish(paperStack(0x1024)),
    blood: [finish(bloodSplat(0x2001)), finish(bloodSplat(0x2002)), finish(bloodSplat(0x2003))],
    bullet: finish(bulletHole()),
    glow: finish(glowSprite()),
    flash: [finish(flashSprite(0x5001)), finish(flashSprite(0x5002)), finish(flashSprite(0x5003))],
    mystery: finish(mysteryLid()),
    zombieSkins: [
      finish(zombieSkin(0x7a8a5e, 0x3001)),
      finish(zombieSkin(0x8a7e68, 0x3002)),
      finish(zombieSkin(0x6a7a6c, 0x3003)),
      finish(zombieSkin(0x928068, 0x3004)),
    ],
    zombieCloth: [
      finish(zombieCloth(0x4a5058, 0x3101)),
      finish(zombieCloth(0x5a4a38, 0x3102)),
      finish(zombieCloth(0x3e4a40, 0x3103)),
      finish(zombieCloth(0x584050, 0x3104)),
      finish(zombieCloth(0x8a887c, 0x3105)),
    ],
    houndSkin: finish(zombieSkin(0x584438, 0x3005)),
    gunWood: finish(gunWood(0x6001)),
    gunGrip: finish(gunGrip(0x6002)),
    gunMetal: finish(gunMetal(0x6003)),
    sleeve: finish(fabricWeave(0x4a4a34, 0x6004)),
    camo: finish(papCamo(0x6005)),
    camo2: finish(hellfireCamo(0x6007)),
    camo3: finish(aetherCamo(0x6008)),
    perforated: finish(perforated(0x6006)),
  };
  for (const t of [cache.blood, [cache.bullet, cache.glow], cache.flash].flat()) {
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
  }
  cache.glow.magFilter = THREE.LinearFilter;
  cache.glow.minFilter = THREE.LinearFilter;
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
