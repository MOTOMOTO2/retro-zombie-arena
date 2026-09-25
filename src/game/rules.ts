/**
 * Round scaling, scoring and perk/power-up definitions.
 *
 * The round curve deliberately follows the classic wave-survival shape: flat-ish
 * health for the first nine rounds, then a compounding ramp that eventually
 * outruns any weapon. All of it is pure maths so the balance is unit tested.
 */

export type EnemyKind = 'walker' | 'runner' | 'brute' | 'hound';

export type SpawnPlan = {
  round: number;
  /** Total enemies that must die to end the round. */
  total: number;
  /** Hard cap on how many are alive at once. */
  maxAlive: number;
  /** Seconds between spawns. */
  interval: number;
  health: number;
  /** Composition weights by enemy kind. */
  mix: { kind: EnemyKind; weight: number }[];
  isHoundRound: boolean;
};

export const HOUND_EVERY = 5;

export function isHoundRound(round: number): boolean {
  return round >= HOUND_EVERY && round % HOUND_EVERY === 0;
}

/** Enemy hit points for a round. 150 at round 1, 950 at round 9, then +10%/round. */
export function enemyHealth(round: number): number {
  if (round <= 9) return 50 + round * 100;
  return Math.round(950 * Math.pow(1.1, round - 9));
}

/** Hound rounds are short and sharp. */
export function houndHealth(round: number): number {
  return Math.round(enemyHealth(round) * 0.55);
}

export function enemyCount(round: number): number {
  if (isHoundRound(round)) return Math.min(30, 6 + Math.floor(round * 0.9));
  const extra = round > 9 ? Math.pow(round - 9, 1.55) : 0;
  return Math.min(74, Math.round(6 + (round - 1) * 4 + extra));
}

export function maxAlive(round: number): number {
  if (isHoundRound(round)) return Math.min(10, 4 + Math.floor(round / 4));
  return Math.min(26, 8 + Math.floor(round * 1.4));
}

export function spawnInterval(round: number): number {
  if (isHoundRound(round)) return Math.max(0.55, 2.4 - round * 0.09);
  return Math.max(0.22, 2.1 - round * 0.105);
}

/**
 * Base walk speed in world units per second (two units to the metre). A
 * round-one walker covers about 1.6 m/s - a purposeful shamble, not a stroll -
 * and by the late rounds most of them are jogging.
 */
export function enemySpeed(round: number, kind: EnemyKind): number {
  const ramp = Math.min(3.6, round * 0.17);
  switch (kind) {
    case 'walker':
      return 3.2 + ramp * 0.8;
    case 'runner':
      return 5.4 + ramp * 0.75;
    case 'brute':
      return 2.8 + ramp * 0.5;
    case 'hound':
      return 7.4 + Math.min(1.6, round * 0.05);
  }
}

export function enemyDamage(kind: EnemyKind): number {
  switch (kind) {
    case 'walker':
      return 32;
    case 'runner':
      return 34;
    case 'brute':
      return 58;
    case 'hound':
      return 28;
  }
}

/** Composition of a normal round: runners and brutes phase in as it gets late. */
export function roundMix(round: number): { kind: EnemyKind; weight: number }[] {
  if (isHoundRound(round)) return [{ kind: 'hound', weight: 1 }];
  const runner = round < 4 ? 0 : Math.min(0.65, (round - 3) * 0.075);
  const brute = round < 8 ? 0 : Math.min(0.22, (round - 7) * 0.025);
  const walker = Math.max(0.1, 1 - runner - brute);
  return [
    { kind: 'walker', weight: walker },
    { kind: 'runner', weight: runner },
    { kind: 'brute', weight: brute },
  ];
}

export function planRound(round: number): SpawnPlan {
  const hounds = isHoundRound(round);
  return {
    round,
    total: enemyCount(round),
    maxAlive: maxAlive(round),
    interval: spawnInterval(round),
    health: hounds ? houndHealth(round) : enemyHealth(round),
    mix: roundMix(round),
    isHoundRound: hounds,
  };
}

/* ------------------------------------------------------------------ scoring */

export const SCORE_HIT = 10;
export const SCORE_KILL = 60;
export const SCORE_HEADSHOT_KILL = 100;
export const SCORE_MELEE_KILL = 130;
export const SCORE_EXPLOSIVE_KILL = 50;
export const SCORE_REPAIR = 10;

export type KillKind = 'body' | 'head' | 'melee' | 'explosive';

export function scoreForKill(kind: KillKind, doublePoints: boolean): number {
  let base: number;
  switch (kind) {
    case 'head':
      base = SCORE_HEADSHOT_KILL;
      break;
    case 'melee':
      base = SCORE_MELEE_KILL;
      break;
    case 'explosive':
      base = SCORE_EXPLOSIVE_KILL;
      break;
    default:
      base = SCORE_KILL;
  }
  return doublePoints ? base * 2 : base;
}

export function scoreForHit(doublePoints: boolean): number {
  return doublePoints ? SCORE_HIT * 2 : SCORE_HIT;
}

/** Arcade flourish the source material does not have: a survival bonus. */
export function roundBonus(round: number): number {
  return 50 + round * 25;
}

/* -------------------------------------------------------------------- perks */

export type PerkId = 'revive' | 'juggernog' | 'speedcola' | 'doubletap' | 'staminup';

export type PerkInfo = {
  id: PerkId;
  name: string;
  tagline: string;
  cost: number;
  color: number;
  /** Quick Revive is the only machine that runs off the emergency circuit. */
  needsPower: boolean;
};

export const PERK_INFO: Record<PerkId, PerkInfo> = {
  revive: {
    id: 'revive', name: 'QUICK REVIVE', tagline: 'REGENERATE FASTER',
    cost: 1500, color: 0x4fc3f7, needsPower: false,
  },
  juggernog: {
    id: 'juggernog', name: 'JUGGERNOG', tagline: 'TAKE MORE PUNISHMENT',
    cost: 2500, color: 0xef5350, needsPower: true,
  },
  speedcola: {
    id: 'speedcola', name: 'SPEED COLA', tagline: 'RELOAD FASTER',
    cost: 3000, color: 0x66bb6a, needsPower: true,
  },
  doubletap: {
    id: 'doubletap', name: 'DOUBLE TAP', tagline: 'FIRE FASTER, HIT HARDER',
    cost: 2000, color: 0xffa726, needsPower: true,
  },
  staminup: {
    id: 'staminup', name: 'STAMIN-UP', tagline: 'RUN FASTER, LONGER',
    cost: 2000, color: 0xab47bc, needsPower: true,
  },
};

export const BASE_HEALTH = 100;
export const JUGGERNOG_HEALTH = 260;

export function maxHealth(hasJuggernog: boolean): number {
  return hasJuggernog ? JUGGERNOG_HEALTH : BASE_HEALTH;
}

/** Seconds of no damage before health starts coming back. */
export function regenDelay(hasRevive: boolean): number {
  return hasRevive ? 1.7 : 3.4;
}

/** Health per second once regeneration kicks in. */
export function regenRate(hasRevive: boolean, max: number): number {
  return (max / 3.2) * (hasRevive ? 1.9 : 1);
}

export function moveSpeed(hasStaminUp: boolean): number {
  return hasStaminUp ? 8.4 : 7.1;
}

export function sprintMultiplier(hasStaminUp: boolean): number {
  return hasStaminUp ? 1.55 : 1.42;
}

/* --------------------------------------------------------------- power-ups */

export type PowerUpId = 'maxammo' | 'instakill' | 'doublepoints' | 'nuke' | 'carpenter';

export type PowerUpInfo = {
  id: PowerUpId;
  name: string;
  color: number;
  /** Seconds the effect lasts; 0 means it fires once. */
  duration: number;
  weight: number;
};

export const POWERUPS: Record<PowerUpId, PowerUpInfo> = {
  maxammo: { id: 'maxammo', name: 'MAX AMMO', color: 0xffe14d, duration: 0, weight: 26 },
  instakill: { id: 'instakill', name: 'INSTA-KILL', color: 0xff4d4d, duration: 30, weight: 22 },
  doublepoints: { id: 'doublepoints', name: 'DOUBLE POINTS', color: 0x4dd2ff, duration: 30, weight: 22 },
  nuke: { id: 'nuke', name: 'NUKE', color: 0x9dff4d, duration: 0, weight: 18 },
  carpenter: { id: 'carpenter', name: 'CARPENTER', color: 0xd9a066, duration: 0, weight: 12 },
};

export const POWERUP_IDS: PowerUpId[] = Object.keys(POWERUPS) as PowerUpId[];
export const NUKE_SCORE = 400;
export const CARPENTER_SCORE = 200;
export const POWERUP_LIFETIME = 25;

/** Roughly one drop per 45 kills, with a hard floor between drops. */
export const DROP_CHANCE = 0.022;
export const DROP_MIN_GAP = 12; // kills

export const MYSTERY_BOX_COST = 950;
/** After this many pulls the box packs up and moves on. */
export const BOX_MOVE_MIN = 4;
export const BOX_MOVE_MAX = 9;

/* ----------------------------------------------------------- pack-a-punch */

// Pack-a-Punch tiers, costs and names live with the weapon table in weapons.ts.
