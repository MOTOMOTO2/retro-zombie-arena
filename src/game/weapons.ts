/**
 * Weapon table. Everything here is plain data so the balance can be unit tested.
 * The models live in gfx/guns.ts, keyed by the same ids.
 */

export type FireMode = 'semi' | 'auto' | 'burst';
export type ProjectileKind =
  | 'hitscan' | 'rocket' | 'plasma' | 'cone' | 'grenade'
  /** Lightning that jumps from body to body. */
  | 'chain'
  /** A cone of frost that freezes what it touches. */
  | 'frost'
  /** A short-range stream of fire that sets bodies alight. */
  | 'flame';

/** How rare a gun is out of the mystery box, and the colour it glows when it comes up. */
export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

export const RARITY_INFO: Record<Rarity, { name: string; color: number; odds: number }> = {
  common: { name: 'COMMON', color: 0xd8d4c8, odds: 0.45 },
  rare: { name: 'RARE', color: 0x4aa8ff, odds: 0.32 },
  epic: { name: 'EPIC', color: 0xb45cff, odds: 0.18 },
  legendary: { name: 'LEGENDARY', color: 0xffc23a, odds: 0.05 },
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
  /** Non-zero when the mystery box can give it; the odds come from its rarity. */
  boxWeight: number;
  rarity: Rarity;
  /** Audio character. */
  voice: { freq: number; noise: number; decay: number; body: number };
  tracer: number;
};

const GLOW = 0x54ffd5;

export const WEAPONS: Record<string, WeaponDef> = {
  knife: {
    id: 'knife', name: 'TRENCH KNIFE', kind: 'hitscan', mode: 'semi',
    damage: 210, pellets: 1, spread: 0.05, bloom: 0, rpm: 90,
    magSize: 1, reserveMax: 1, reloadTime: 0, shellReload: false,
    range: 3.2, headMult: 1.2, splashRadius: 0, splashDamage: 0,
    kick: 0.01, shake: 0.2, wallCost: 0, ammoCost: 0, boxWeight: 0, rarity: 'common',
    voice: { freq: 180, noise: 0.8, decay: 0.09, body: 0.2 }, tracer: 0,
  },

  sidearm: {
    id: 'sidearm', name: 'PEACEKEEPER .45', kind: 'hitscan', mode: 'semi',
    damage: 60, pellets: 1, spread: 0.008, bloom: 0.02, rpm: 420,
    magSize: 8, reserveMax: 96, reloadTime: 1.35, shellReload: false,
    range: 90, headMult: 2.2, splashRadius: 0, splashDamage: 0,
    kick: 0.026, shake: 0.5, wallCost: 0, ammoCost: 250, boxWeight: 0, rarity: 'common',
    voice: { freq: 300, noise: 0.55, decay: 0.16, body: 0.7 }, tracer: 0xffe08a,
  },

  boomstick: {
    id: 'boomstick', name: 'BOOMSTICK', kind: 'hitscan', mode: 'semi',
    damage: 58, pellets: 9, spread: 0.115, bloom: 0.01, rpm: 190,
    magSize: 2, reserveMax: 40, reloadTime: 2.1, shellReload: false,
    range: 34, headMult: 1.5, splashRadius: 0, splashDamage: 0,
    kick: 0.085, shake: 2.4, wallCost: 1200, ammoCost: 600, boxWeight: 8, rarity: 'common',
    voice: { freq: 120, noise: 0.95, decay: 0.34, body: 1 }, tracer: 0xffc266,
  },

  trench: {
    id: 'trench', name: 'TRENCH BROOM', kind: 'hitscan', mode: 'auto',
    damage: 44, pellets: 1, spread: 0.022, bloom: 0.05, rpm: 780,
    magSize: 30, reserveMax: 300, reloadTime: 1.9, shellReload: false,
    range: 60, headMult: 1.6, splashRadius: 0, splashDamage: 0,
    kick: 0.019, shake: 0.55, wallCost: 1400, ammoCost: 700, boxWeight: 10, rarity: 'common',
    voice: { freq: 250, noise: 0.7, decay: 0.12, body: 0.6 }, tracer: 0xffd27a,
  },

  grease: {
    id: 'grease', name: 'GREASE GUN', kind: 'hitscan', mode: 'auto',
    damage: 62, pellets: 1, spread: 0.028, bloom: 0.045, rpm: 600,
    magSize: 40, reserveMax: 320, reloadTime: 2.05, shellReload: false,
    range: 65, headMult: 1.7, splashRadius: 0, splashDamage: 0,
    kick: 0.024, shake: 0.7, wallCost: 1500, ammoCost: 750, boxWeight: 9, rarity: 'common',
    voice: { freq: 205, noise: 0.72, decay: 0.15, body: 0.75 }, tracer: 0xffcf66,
  },

  nailrifle: {
    id: 'nailrifle', name: 'NAIL RIFLE', kind: 'hitscan', mode: 'auto',
    damage: 95, pellets: 1, spread: 0.012, bloom: 0.035, rpm: 620,
    magSize: 30, reserveMax: 300, reloadTime: 2.2, shellReload: false,
    range: 110, headMult: 2.4, splashRadius: 0, splashDamage: 0,
    kick: 0.03, shake: 0.85, wallCost: 1500, ammoCost: 750, boxWeight: 10, rarity: 'rare',
    voice: { freq: 230, noise: 0.62, decay: 0.18, body: 0.85 }, tracer: 0xfff0b0,
  },

  longshot: {
    id: 'longshot', name: 'LONGSHOT .303', kind: 'hitscan', mode: 'semi',
    damage: 420, pellets: 1, spread: 0.002, bloom: 0.06, rpm: 58,
    magSize: 5, reserveMax: 70, reloadTime: 2.7, shellReload: false,
    range: 220, headMult: 3, splashRadius: 0, splashDamage: 0,
    kick: 0.1, shake: 2, wallCost: 1600, ammoCost: 800, boxWeight: 7, rarity: 'rare',
    voice: { freq: 150, noise: 0.6, decay: 0.42, body: 1 }, tracer: 0xfff6d0,
  },

  scattergun: {
    id: 'scattergun', name: 'SCATTERGUN', kind: 'hitscan', mode: 'auto',
    damage: 40, pellets: 8, spread: 0.095, bloom: 0.02, rpm: 270,
    magSize: 8, reserveMax: 72, reloadTime: 0.45, shellReload: true,
    range: 40, headMult: 1.4, splashRadius: 0, splashDamage: 0,
    kick: 0.055, shake: 1.6, wallCost: 1800, ammoCost: 900, boxWeight: 8, rarity: 'rare',
    voice: { freq: 135, noise: 0.9, decay: 0.26, body: 0.95 }, tracer: 0xffc266,
  },

  ripper: {
    id: 'ripper', name: 'THE RIPPER', kind: 'hitscan', mode: 'auto',
    damage: 52, pellets: 1, spread: 0.035, bloom: 0.02, rpm: 1150,
    magSize: 150, reserveMax: 600, reloadTime: 5.2, shellReload: false,
    range: 90, headMult: 1.5, splashRadius: 0, splashDamage: 0,
    kick: 0.014, shake: 0.9, wallCost: 0, ammoCost: 0, boxWeight: 6, rarity: 'epic',
    voice: { freq: 190, noise: 0.85, decay: 0.09, body: 0.8 }, tracer: 0xffb84d,
  },

  plasma: {
    id: 'plasma', name: 'PLASMA LANCE', kind: 'plasma', mode: 'semi',
    damage: 500, pellets: 1, spread: 0.004, bloom: 0, rpm: 180,
    magSize: 20, reserveMax: 180, reloadTime: 3.1, shellReload: false,
    range: 140, headMult: 1, splashRadius: 5.5, splashDamage: 300,
    kick: 0.05, shake: 1.5, wallCost: 0, ammoCost: 0, boxWeight: 3, rarity: 'epic',
    voice: { freq: 620, noise: 0.25, decay: 0.3, body: 0.5 }, tracer: GLOW,
  },

  hellfire: {
    id: 'hellfire', name: 'HELLFIRE M9', kind: 'rocket', mode: 'semi',
    damage: 900, pellets: 1, spread: 0.006, bloom: 0, rpm: 42,
    magSize: 1, reserveMax: 14, reloadTime: 3.0, shellReload: false,
    range: 200, headMult: 1, splashRadius: 8, splashDamage: 650,
    kick: 0.11, shake: 3, wallCost: 0, ammoCost: 0, boxWeight: 4, rarity: 'epic',
    voice: { freq: 110, noise: 0.8, decay: 0.5, body: 1 }, tracer: 0xff7a2a,
  },

  thunder: {
    id: 'thunder', name: 'THUNDERCLAP', kind: 'cone', mode: 'semi',
    damage: 4000, pellets: 1, spread: 0, bloom: 0, rpm: 50,
    magSize: 2, reserveMax: 10, reloadTime: 2.6, shellReload: false,
    range: 22, headMult: 1, splashRadius: 0, splashDamage: 0,
    kick: 0.13, shake: 4, wallCost: 0, ammoCost: 0, boxWeight: 2, rarity: 'epic',
    voice: { freq: 70, noise: 0.9, decay: 0.7, body: 1 }, tracer: 0x9fd8ff,
  },

  /* ------------------------------------------------ legendary box weapons */

  stormcaller: {
    id: 'stormcaller', name: 'STORMCALLER', kind: 'chain', mode: 'semi',
    // splashRadius is how far a bolt can jump; splashDamage is how many bodies it can take.
    damage: 2600, pellets: 1, spread: 0.004, bloom: 0, rpm: 70,
    magSize: 3, reserveMax: 27, reloadTime: 3.0, shellReload: false,
    range: 80, headMult: 1, splashRadius: 12, splashDamage: 10,
    kick: 0.07, shake: 2.2, wallCost: 0, ammoCost: 0, boxWeight: 1, rarity: 'legendary',
    voice: { freq: 820, noise: 0.7, decay: 0.45, body: 0.6 }, tracer: 0xa8e0ff,
  },

  wintershowl: {
    id: 'wintershowl', name: "WINTER'S HOWL", kind: 'frost', mode: 'semi',
    damage: 260, pellets: 1, spread: 0, bloom: 0, rpm: 160,
    magSize: 12, reserveMax: 96, reloadTime: 2.8, shellReload: false,
    range: 20, headMult: 1, splashRadius: 0, splashDamage: 0,
    kick: 0.04, shake: 1.2, wallCost: 0, ammoCost: 0, boxWeight: 1, rarity: 'legendary',
    voice: { freq: 1400, noise: 0.95, decay: 0.35, body: 0.2 }, tracer: 0xbfe8ff,
  },

  dragonfire: {
    id: 'dragonfire', name: 'DRAGONFIRE', kind: 'flame', mode: 'auto',
    damage: 60, pellets: 1, spread: 0, bloom: 0, rpm: 900,
    magSize: 120, reserveMax: 480, reloadTime: 2.6, shellReload: false,
    range: 15, headMult: 1, splashRadius: 0, splashDamage: 0,
    kick: 0.004, shake: 0.25, wallCost: 0, ammoCost: 0, boxWeight: 1, rarity: 'legendary',
    voice: { freq: 90, noise: 1, decay: 0.08, body: 0.1 }, tracer: 0xff8a2a,
  },

  frag: {
    id: 'frag', name: 'FRAG GRENADE', kind: 'grenade', mode: 'semi',
    damage: 0, pellets: 1, spread: 0, bloom: 0, rpm: 60,
    magSize: 1, reserveMax: 4, reloadTime: 0.8, shellReload: false,
    range: 40, headMult: 1, splashRadius: 8.5, splashDamage: 850,
    kick: 0.02, shake: 0.3, wallCost: 250, ammoCost: 250, boxWeight: 0, rarity: 'common',
    voice: { freq: 90, noise: 0.9, decay: 0.6, body: 1 }, tracer: 0,
  },
};

/** Weapons that can come out of the mystery box. */
export const BOX_POOL: string[] = Object.values(WEAPONS)
  .filter((w) => w.boxWeight > 0)
  .map((w) => w.id);

/**
 * Odds for each gun in BOX_POOL: a rarity is rolled first (45% common, 32%
 * rare, 18% epic, 5% legendary), then a gun within it. Guns in `exclude` -
 * what the player is already carrying - never come up, like the source
 * material; their share goes to the rest of their tier.
 */
export function boxWeights(exclude: readonly string[] = []): number[] {
  const counts: Record<Rarity, number> = { common: 0, rare: 0, epic: 0, legendary: 0 };
  for (const id of BOX_POOL) if (!exclude.includes(id)) counts[WEAPONS[id].rarity]++;
  return BOX_POOL.map((id) => {
    if (exclude.includes(id)) return 0;
    const r = WEAPONS[id].rarity;
    return RARITY_INFO[r].odds / counts[r];
  });
}

/* ------------------------------------------------------------ pack-a-punch */

/** Pack-a-Punch goes three tiers deep. */
export const PAP_MAX = 3;
/**
 * Cost to go from tier i to tier i + 1. Tier I used to be 5000, which on this
 * round curve meant plenty of runs never saw a packed gun at all; at 3000 the
 * first upgrade lands about when the wall guns stop keeping up.
 */
export const PAP_COSTS = [3000, 5000, 7000];

export function papCost(tier: number): number {
  return PAP_COSTS[Math.min(PAP_COSTS.length - 1, Math.max(0, tier))];
}

/** Damage multiplier for each tier. */
const PAP_DAMAGE = [1, 2.4, 3.6, 5];

export function papMultiplier(tier: number): number {
  return PAP_DAMAGE[Math.min(PAP_MAX, Math.max(0, tier))];
}

/** Magazine size at a tier: half again at I and II, double at III. */
export function magFor(def: WeaponDef, tier: number): number {
  if (tier <= 0) return def.magSize;
  if (def.magSize <= 2) return def.magSize + (tier >= 3 ? 1 : 0);
  return Math.round(def.magSize * (tier >= 3 ? 2 : 1.5));
}

export function reserveFor(def: WeaponDef, tier: number): number {
  return Math.round(def.reserveMax * [1, 1.5, 2, 2.5][Math.min(3, Math.max(0, tier))]);
}

/**
 * Tier II and III guns carry an elemental ammo mod that sometimes goes off
 * when a round lands - rolled once, at tier II.
 */
export type AmmoMod = 'deadwire' | 'blastfurnace' | 'cryofreeze';

export const AMMO_MODS: Record<AmmoMod, { name: string; color: number; blurb: string }> = {
  deadwire: { name: 'DEAD WIRE', color: 0x8fd8ff, blurb: 'lightning arcs to nearby bodies' },
  blastfurnace: { name: 'BLAST FURNACE', color: 0xff8a3a, blurb: 'sets the crowd around the target alight' },
  cryofreeze: { name: 'CRYOFREEZE', color: 0xbfeaff, blurb: 'freezes the target and its neighbours' },
};

export const AMMO_MOD_IDS = Object.keys(AMMO_MODS) as AmmoMod[];

/** Chance a landed round triggers the mod, and how long before it can again. */
export function modChance(tier: number): { chance: number; cooldown: number } {
  if (tier >= 3) return { chance: 0.2, cooldown: 0.6 };
  if (tier >= 2) return { chance: 0.12, cooldown: 1.0 };
  return { chance: 0, cooldown: 0 };
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

/** Final per-pellet damage for one hit. `tier` is the Pack-a-Punch tier, 0-3. */
export function shotDamage(
  def: WeaponDef,
  opts: { head: boolean; doubleTap: boolean; instaKill: boolean; tier: number },
): number {
  if (opts.instaKill && def.kind !== 'grenade') return 1e6;
  let dmg = def.damage;
  dmg *= PAP_DAMAGE[Math.min(PAP_MAX, Math.max(0, opts.tier))];
  if (opts.doubleTap) dmg *= 1.15;
  if (opts.head) dmg *= def.headMult;
  return dmg;
}

/** Ammo the player starts with when they first buy or find a weapon. */
export function startingAmmo(def: WeaponDef, tier = 0): { mag: number; reserve: number } {
  return { mag: magFor(def, tier), reserve: Math.round(reserveFor(def, tier) * 0.66) };
}

/** The name a gun goes by at each Pack-a-Punch tier. */
export function tierName(name: string, tier: number): string {
  return tier <= 0 ? name : `${name} ${'★'.repeat(Math.min(PAP_MAX, tier))}`;
}
