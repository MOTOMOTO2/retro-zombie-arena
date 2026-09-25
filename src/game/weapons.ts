/**
 * Weapon table. Everything here is plain data so the balance can be unit tested
 * and the view models can be built procedurally - no art assets in the repo.
 */

export type FireMode = 'semi' | 'auto' | 'burst';
export type ProjectileKind = 'hitscan' | 'rocket' | 'plasma' | 'cone' | 'grenade';

/** One box of a low-poly view model, in view-model space (metres). */
export type ModelPart = {
  size: [number, number, number];
  pos: [number, number, number];
  color: number;
  /** Optional Euler rotation in radians. */
  rot?: [number, number, number];
  /** Parts flagged as the slide/bolt animate on fire. */
  slide?: boolean;
};

export type WeaponDef = {
  id: string;
  name: string;
  kind: ProjectileKind;
  mode: FireMode;
  /** Damage per bullet (or per pellet for shotguns). */
  damage: number;
  pellets: number;
  /** Cone half-angle in radians. */
  spread: number;
  /** Extra spread while moving/hip-firing under stress. */
  bloom: number;
  rpm: number;
  magSize: number;
  reserveMax: number;
  reloadTime: number;
  /** Shotguns reload shell by shell. */
  shellReload: boolean;
  range: number;
  headMult: number;
  /** Splash radius/damage for explosives (0 for none). */
  splashRadius: number;
  splashDamage: number;
  /** Recoil kick in radians applied to the camera. */
  kick: number;
  shake: number;
  /** Buy prices; wallCost of 0 means box-only. */
  wallCost: number;
  ammoCost: number;
  /** Relative odds of coming out of the mystery box (0 = never). */
  boxWeight: number;
  /** Audio character. */
  voice: { freq: number; noise: number; decay: number; body: number };
  tracer: number;
  parts: ModelPart[];
  /** Muzzle position in view-model space, for flash + tracer origin. */
  muzzle: [number, number, number];
};

const GUNMETAL = 0x2b2f33;
const DARKMETAL = 0x1b1e21;
const WOOD = 0x6b4527;
const BRASS = 0xb08d3a;
const RUST = 0x7a3b22;
const PLASTIC = 0x3a3f45;
const GLOW = 0x54ffd5;

export const WEAPONS: Record<string, WeaponDef> = {
  knife: {
    id: 'knife', name: 'TRENCH KNIFE', kind: 'hitscan', mode: 'semi',
    damage: 210, pellets: 1, spread: 0.05, bloom: 0, rpm: 90,
    magSize: 1, reserveMax: 1, reloadTime: 0, shellReload: false,
    range: 3.2, headMult: 1.2, splashRadius: 0, splashDamage: 0,
    kick: 0.01, shake: 0.2, wallCost: 0, ammoCost: 0, boxWeight: 0,
    voice: { freq: 180, noise: 0.8, decay: 0.09, body: 0.2 }, tracer: 0,
    muzzle: [0, 0, -0.5],
    parts: [
      { size: [0.05, 0.16, 0.5], pos: [0, 0, -0.26], color: 0xc9d1d9 },
      { size: [0.09, 0.1, 0.24], pos: [0, -0.02, 0.1], color: 0x3a2a1c },
      { size: [0.16, 0.05, 0.06], pos: [0, 0.01, -0.02], color: BRASS },
    ],
  },

  sidearm: {
    id: 'sidearm', name: 'PEACEKEEPER .45', kind: 'hitscan', mode: 'semi',
    damage: 60, pellets: 1, spread: 0.008, bloom: 0.02, rpm: 420,
    magSize: 8, reserveMax: 96, reloadTime: 1.35, shellReload: false,
    range: 90, headMult: 2.2, splashRadius: 0, splashDamage: 0,
    kick: 0.026, shake: 0.5, wallCost: 0, ammoCost: 250, boxWeight: 0,
    voice: { freq: 300, noise: 0.55, decay: 0.16, body: 0.7 }, tracer: 0xffe08a,
    muzzle: [0, 0.03, -0.55],
    parts: [
      { size: [0.1, 0.11, 0.62], pos: [0, 0.05, -0.2], color: GUNMETAL, slide: true },
      { size: [0.08, 0.1, 0.5], pos: [0, -0.04, -0.16], color: DARKMETAL },
      { size: [0.1, 0.3, 0.14], pos: [0, -0.2, 0.08], color: 0x35251a, rot: [0.22, 0, 0] },
      { size: [0.03, 0.04, 0.05], pos: [0, 0.12, -0.46], color: 0x7c848c },
    ],
  },

  boomstick: {
    id: 'boomstick', name: 'BOOMSTICK', kind: 'hitscan', mode: 'semi',
    damage: 58, pellets: 9, spread: 0.115, bloom: 0.01, rpm: 190,
    magSize: 2, reserveMax: 40, reloadTime: 2.1, shellReload: false,
    range: 34, headMult: 1.5, splashRadius: 0, splashDamage: 0,
    kick: 0.085, shake: 2.4, wallCost: 1200, ammoCost: 600, boxWeight: 8,
    voice: { freq: 120, noise: 0.95, decay: 0.34, body: 1 }, tracer: 0xffc266,
    muzzle: [0, 0.02, -0.95],
    parts: [
      { size: [0.16, 0.09, 1.1], pos: [0, 0.04, -0.42], color: DARKMETAL },
      { size: [0.2, 0.14, 0.44], pos: [0, -0.01, 0.16], color: WOOD },
      { size: [0.11, 0.26, 0.13], pos: [0, -0.2, 0.3], color: WOOD, rot: [0.3, 0, 0] },
      { size: [0.18, 0.03, 0.5], pos: [0, 0.1, -0.6], color: 0x50361f },
    ],
  },

  trench: {
    id: 'trench', name: 'TRENCH BROOM', kind: 'hitscan', mode: 'auto',
    damage: 44, pellets: 1, spread: 0.022, bloom: 0.05, rpm: 780,
    magSize: 30, reserveMax: 300, reloadTime: 1.9, shellReload: false,
    range: 60, headMult: 1.6, splashRadius: 0, splashDamage: 0,
    kick: 0.019, shake: 0.55, wallCost: 1400, ammoCost: 700, boxWeight: 10,
    voice: { freq: 250, noise: 0.7, decay: 0.12, body: 0.6 }, tracer: 0xffd27a,
    muzzle: [0, 0.03, -0.78],
    parts: [
      { size: [0.1, 0.12, 0.9], pos: [0, 0.03, -0.3], color: GUNMETAL },
      { size: [0.09, 0.26, 0.11], pos: [0, -0.16, -0.08], color: DARKMETAL },
      { size: [0.1, 0.28, 0.12], pos: [0, -0.18, 0.24], color: WOOD, rot: [0.26, 0, 0] },
      { size: [0.2, 0.09, 0.3], pos: [0, -0.02, 0.28], color: WOOD },
      { size: [0.06, 0.06, 0.3], pos: [0, 0.11, -0.62], color: 0x14171a },
    ],
  },

  grease: {
    id: 'grease', name: 'GREASE GUN', kind: 'hitscan', mode: 'auto',
    damage: 62, pellets: 1, spread: 0.028, bloom: 0.045, rpm: 600,
    magSize: 40, reserveMax: 320, reloadTime: 2.05, shellReload: false,
    range: 65, headMult: 1.7, splashRadius: 0, splashDamage: 0,
    kick: 0.024, shake: 0.7, wallCost: 1500, ammoCost: 750, boxWeight: 9,
    voice: { freq: 205, noise: 0.72, decay: 0.15, body: 0.75 }, tracer: 0xffcf66,
    muzzle: [0, 0.02, -0.72],
    parts: [
      { size: [0.11, 0.11, 0.8], pos: [0, 0.02, -0.26], color: 0x33383d },
      { size: [0.08, 0.36, 0.1], pos: [0, -0.22, -0.02], color: DARKMETAL },
      { size: [0.1, 0.24, 0.11], pos: [0, -0.16, 0.24], color: PLASTIC, rot: [0.24, 0, 0] },
      { size: [0.05, 0.05, 0.36], pos: [0, 0.1, -0.5], color: 0x1a1d20 },
    ],
  },

  nailrifle: {
    id: 'nailrifle', name: 'NAIL RIFLE', kind: 'hitscan', mode: 'auto',
    damage: 95, pellets: 1, spread: 0.012, bloom: 0.035, rpm: 620,
    magSize: 30, reserveMax: 300, reloadTime: 2.2, shellReload: false,
    range: 110, headMult: 2.4, splashRadius: 0, splashDamage: 0,
    kick: 0.03, shake: 0.85, wallCost: 1500, ammoCost: 750, boxWeight: 10,
    voice: { freq: 230, noise: 0.62, decay: 0.18, body: 0.85 }, tracer: 0xfff0b0,
    muzzle: [0, 0.04, -1.0],
    parts: [
      { size: [0.1, 0.13, 1.05], pos: [0, 0.03, -0.35], color: 0x2e3338 },
      { size: [0.09, 0.3, 0.12], pos: [0, -0.2, -0.1], color: RUST },
      { size: [0.12, 0.26, 0.14], pos: [0, -0.16, 0.26], color: PLASTIC, rot: [0.24, 0, 0] },
      { size: [0.22, 0.1, 0.34], pos: [0, 0.0, 0.3], color: 0x232629 },
      { size: [0.07, 0.07, 0.4], pos: [0, 0.11, -0.78], color: 0x15181b },
      { size: [0.03, 0.09, 0.05], pos: [0, 0.16, -0.5], color: 0x8b949e },
    ],
  },

  longshot: {
    id: 'longshot', name: 'LONGSHOT .303', kind: 'hitscan', mode: 'semi',
    damage: 420, pellets: 1, spread: 0.002, bloom: 0.06, rpm: 58,
    magSize: 5, reserveMax: 70, reloadTime: 2.7, shellReload: false,
    range: 220, headMult: 3, splashRadius: 0, splashDamage: 0,
    kick: 0.1, shake: 2, wallCost: 1600, ammoCost: 800, boxWeight: 7,
    voice: { freq: 150, noise: 0.6, decay: 0.42, body: 1 }, tracer: 0xfff6d0,
    muzzle: [0, 0.04, -1.25],
    parts: [
      { size: [0.09, 0.1, 1.4], pos: [0, 0.04, -0.5], color: 0x26292c },
      { size: [0.16, 0.14, 0.9], pos: [0, -0.04, 0.1], color: WOOD },
      { size: [0.11, 0.26, 0.13], pos: [0, -0.18, 0.34], color: WOOD, rot: [0.2, 0, 0] },
      { size: [0.08, 0.08, 0.42], pos: [0, 0.17, -0.28], color: 0x14171a },
      { size: [0.05, 0.05, 0.14], pos: [0.09, 0.06, 0.05], color: 0x8b949e, rot: [0, 0, 0.5] },
    ],
  },

  scattergun: {
    id: 'scattergun', name: 'SCATTERGUN', kind: 'hitscan', mode: 'auto',
    damage: 40, pellets: 8, spread: 0.095, bloom: 0.02, rpm: 270,
    magSize: 8, reserveMax: 72, reloadTime: 0.45, shellReload: true,
    range: 40, headMult: 1.4, splashRadius: 0, splashDamage: 0,
    kick: 0.055, shake: 1.6, wallCost: 1800, ammoCost: 900, boxWeight: 8,
    voice: { freq: 135, noise: 0.9, decay: 0.26, body: 0.95 }, tracer: 0xffc266,
    muzzle: [0, 0.02, -0.98],
    parts: [
      { size: [0.12, 0.12, 1.1], pos: [0, 0.05, -0.4], color: 0x2a2e32 },
      { size: [0.14, 0.14, 0.7], pos: [0, -0.06, -0.24], color: 0x1f2225 },
      { size: [0.13, 0.3, 0.14], pos: [0, -0.2, 0.12], color: PLASTIC },
      { size: [0.12, 0.26, 0.13], pos: [0, -0.16, 0.34], color: PLASTIC, rot: [0.22, 0, 0] },
      { size: [0.2, 0.06, 0.28], pos: [0, 0.14, -0.2], color: 0x3a3f45 },
    ],
  },

  ripper: {
    id: 'ripper', name: 'THE RIPPER', kind: 'hitscan', mode: 'auto',
    damage: 52, pellets: 1, spread: 0.035, bloom: 0.02, rpm: 1150,
    magSize: 150, reserveMax: 600, reloadTime: 5.2, shellReload: false,
    range: 90, headMult: 1.5, splashRadius: 0, splashDamage: 0,
    kick: 0.014, shake: 0.9, wallCost: 0, ammoCost: 0, boxWeight: 6,
    voice: { freq: 190, noise: 0.85, decay: 0.09, body: 0.8 }, tracer: 0xffb84d,
    muzzle: [0, 0.0, -1.15],
    parts: [
      { size: [0.26, 0.26, 1.0], pos: [0, 0.0, -0.5], color: 0x22262a },
      { size: [0.07, 0.07, 1.25], pos: [-0.07, 0.07, -0.6], color: 0x101315 },
      { size: [0.07, 0.07, 1.25], pos: [0.07, 0.07, -0.6], color: 0x101315 },
      { size: [0.07, 0.07, 1.25], pos: [0, -0.09, -0.6], color: 0x101315 },
      { size: [0.34, 0.3, 0.44], pos: [0, -0.02, 0.18], color: 0x2e3338 },
      { size: [0.14, 0.3, 0.14], pos: [0, -0.22, 0.34], color: PLASTIC },
      { size: [0.3, 0.26, 0.3], pos: [0.28, -0.1, 0.2], color: RUST },
    ],
  },

  plasma: {
    id: 'plasma', name: 'PLASMA LANCE', kind: 'plasma', mode: 'semi',
    damage: 500, pellets: 1, spread: 0.004, bloom: 0, rpm: 180,
    magSize: 20, reserveMax: 180, reloadTime: 3.1, shellReload: false,
    range: 140, headMult: 1, splashRadius: 5.5, splashDamage: 300,
    kick: 0.05, shake: 1.5, wallCost: 0, ammoCost: 0, boxWeight: 3,
    voice: { freq: 620, noise: 0.25, decay: 0.3, body: 0.5 }, tracer: GLOW,
    muzzle: [0, 0.02, -0.95],
    parts: [
      { size: [0.16, 0.18, 0.9], pos: [0, 0.03, -0.32], color: 0x2a3b35 },
      { size: [0.1, 0.1, 0.42], pos: [0, 0.03, -0.86], color: GLOW },
      { size: [0.26, 0.26, 0.3], pos: [0, 0.06, 0.1], color: 0x1d2b27 },
      { size: [0.12, 0.3, 0.13], pos: [0, -0.2, 0.18], color: 0x16211e },
      { size: [0.06, 0.2, 0.2], pos: [0.13, 0.12, -0.1], color: GLOW },
      { size: [0.06, 0.2, 0.2], pos: [-0.13, 0.12, -0.1], color: GLOW },
    ],
  },

  hellfire: {
    id: 'hellfire', name: 'HELLFIRE M9', kind: 'rocket', mode: 'semi',
    damage: 900, pellets: 1, spread: 0.006, bloom: 0, rpm: 42,
    magSize: 1, reserveMax: 14, reloadTime: 3.0, shellReload: false,
    range: 200, headMult: 1, splashRadius: 8, splashDamage: 650,
    kick: 0.11, shake: 3, wallCost: 0, ammoCost: 0, boxWeight: 4,
    voice: { freq: 110, noise: 0.8, decay: 0.5, body: 1 }, tracer: 0xff7a2a,
    muzzle: [0, 0.04, -1.1],
    parts: [
      { size: [0.2, 0.2, 1.5], pos: [0, 0.06, -0.4], color: 0x35402c },
      { size: [0.14, 0.14, 0.4], pos: [0, 0.06, -1.05], color: 0xb33b1e },
      { size: [0.1, 0.28, 0.12], pos: [0, -0.16, 0.16], color: 0x1f2418 },
      { size: [0.24, 0.06, 0.3], pos: [0, 0.2, -0.1], color: 0x232a1c },
      { size: [0.05, 0.14, 0.05], pos: [0.08, 0.2, -0.5], color: 0x8b949e },
    ],
  },

  thunder: {
    id: 'thunder', name: 'THUNDERCLAP', kind: 'cone', mode: 'semi',
    damage: 4000, pellets: 1, spread: 0, bloom: 0, rpm: 50,
    magSize: 2, reserveMax: 10, reloadTime: 2.6, shellReload: false,
    range: 22, headMult: 1, splashRadius: 0, splashDamage: 0,
    kick: 0.13, shake: 4, wallCost: 0, ammoCost: 0, boxWeight: 2,
    voice: { freq: 70, noise: 0.9, decay: 0.7, body: 1 }, tracer: 0x9fd8ff,
    muzzle: [0, 0.0, -1.0],
    parts: [
      { size: [0.3, 0.3, 0.7], pos: [0, 0.02, -0.2], color: 0x3a3f4a },
      { size: [0.44, 0.44, 0.34], pos: [0, 0.02, -0.68], color: 0x58607a },
      { size: [0.52, 0.52, 0.1], pos: [0, 0.02, -0.86], color: 0x9fd8ff },
      { size: [0.12, 0.3, 0.13], pos: [0, -0.2, 0.12], color: 0x24282f },
      { size: [0.1, 0.1, 0.5], pos: [0.19, 0.16, -0.3], color: 0x9fd8ff },
      { size: [0.1, 0.1, 0.5], pos: [-0.19, 0.16, -0.3], color: 0x9fd8ff },
    ],
  },

  frag: {
    id: 'frag', name: 'FRAG GRENADE', kind: 'grenade', mode: 'semi',
    damage: 0, pellets: 1, spread: 0, bloom: 0, rpm: 60,
    magSize: 1, reserveMax: 4, reloadTime: 0.8, shellReload: false,
    range: 40, headMult: 1, splashRadius: 8.5, splashDamage: 850,
    kick: 0.02, shake: 0.3, wallCost: 250, ammoCost: 250, boxWeight: 0,
    voice: { freq: 90, noise: 0.9, decay: 0.6, body: 1 }, tracer: 0,
    muzzle: [0, 0, -0.4],
    parts: [
      { size: [0.22, 0.28, 0.22], pos: [0, -0.02, -0.15], color: 0x3c4a2c },
      { size: [0.1, 0.08, 0.1], pos: [0, 0.16, -0.15], color: 0x8b949e },
    ],
  },
};

/** Weapons that can come out of the mystery box, with their odds. */
export const BOX_POOL: string[] = Object.values(WEAPONS)
  .filter((w) => w.boxWeight > 0)
  .map((w) => w.id);

export function boxWeights(): number[] {
  return BOX_POOL.map((id) => WEAPONS[id].boxWeight);
}

export function getWeapon(id: string): WeaponDef {
  const w = WEAPONS[id];
  if (!w) throw new Error(`unknown weapon ${id}`);
  return w;
}

/** Seconds between shots, after Double Tap. */
export function fireInterval(def: WeaponDef, doubleTap: boolean): number {
  const rpm = def.rpm * (doubleTap ? 1.33 : 1);
  return 60 / rpm;
}

/** Reload duration after Speed Cola. */
export function reloadDuration(def: WeaponDef, speedCola: boolean): number {
  return def.reloadTime * (speedCola ? 0.55 : 1);
}

/** Final per-pellet damage for one hit. */
export function shotDamage(
  def: WeaponDef,
  opts: { head: boolean; doubleTap: boolean; instaKill: boolean; packed: boolean },
): number {
  if (opts.instaKill && def.kind !== 'grenade') return 1e6;
  let dmg = def.damage;
  if (opts.packed) dmg *= 2.4;
  if (opts.doubleTap) dmg *= 1.15;
  if (opts.head) dmg *= def.headMult;
  return dmg;
}

/** Ammo the player starts with when they first buy or find a weapon. */
export function startingAmmo(def: WeaponDef): { mag: number; reserve: number } {
  return { mag: def.magSize, reserve: Math.round(def.reserveMax * 0.66) };
}
