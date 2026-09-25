/**
 * Tiny deterministic RNG (mulberry32). Deterministic RNG keeps the mystery box,
 * power-up drops and spawn picks reproducible, which makes them testable.
 */
export class Rng {
  private s: number;

  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n) % Math.max(1, n);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  /** Picks an index from a list of non-negative weights. */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return 0;
    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= Math.max(0, weights[i]);
      if (roll <= 0) return i;
    }
    return weights.length - 1;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** Shared instance for cosmetic, non-gameplay randomness. */
export const fxRng = new Rng(0x1337c0de);
