/**
 * Round scaling, scoring and perk/power-up definitions.
 *
 * The round curve deliberately follows the classic wave-survival shape: flat-ish
 * health for the first nine rounds, then a compounding ramp that eventually
 * outruns any weapon. All of it is pure maths so the balance is unit tested.
 *
 * On top of the round sits the chapter's threat: 0 in the asylum, 3 in
 * Sublevel 9. Each step makes the horde tougher, quicker, harder-hitting and
 * more numerous, and brings the runners and brutes in earlier.
 */

export type EnemyKind =
  | 'walker' | 'runner' | 'brute' | 'hound'
  /** Legless: drags itself along the floor, low and easy to miss. */
  | 'crawler'
  /** Riot padding and a helmet: shrugs off body shots, goes down to the head. */
  | 'armoured'
  /** Hangs back and lobs bile that leaves the floor burning. */
  | 'spitter'
  /** Swollen with gas: bursts when it dies, and takes the crowd with it. */
  | 'bomber'
  /** Head and shoulders above the rest, slow, and worth four ordinary kills. */
  | 'tank';

/**
 * What each kind is, how it is built out of the shared body, and what it does
 * differently. `tint` multiplies the room light on the model, `scale` resizes
 * it, and `lean` pitches the whole body forward - the crawler drags.
 */
export type EnemyInfo = {
  kind: EnemyKind;
  name: string;
  /** Health as a multiple of the round's baseline. */
  health: number;
  tint: [number, number, number];
  scale: number;
  lean: number;
  /** Body shots do this much; the head always takes the full amount. */
  bodyArmour: number;
  /** Stops at this range and throws instead of closing, 0 for everything else. */
  range: number;
  /** Radius of the burst when it dies, 0 for everything else. */
  burst: number;
  /** Kill score is multiplied by this: the big ones are worth going after. */
  score: number;
  /** Which pooled body it is built from. */
  build: EnemyBuild;
};

/** The three shapes the enemy pool keeps bodies for. */
export type EnemyBuild = 'humanoid' | 'hound' | 'tank';

export const ENEMY_INFO: Record<EnemyKind, EnemyInfo> = {
  walker: {
    kind: 'walker', name: 'SHAMBLER', health: 1, tint: [1, 1, 1], scale: 1,
    lean: 0, bodyArmour: 1, range: 0, burst: 0, score: 1, build: 'humanoid',
  },
  runner: {
    kind: 'runner', name: 'SPRINTER', health: 0.82, tint: [1.14, 0.92, 0.88], scale: 0.94,
    lean: 0.1, bodyArmour: 1, range: 0, burst: 0, score: 1, build: 'humanoid',
  },
  brute: {
    kind: 'brute', name: 'BRUTE', health: 2.4, tint: [1.12, 0.7, 0.64], scale: 1.32,
    lean: 0, bodyArmour: 0.85, range: 0, burst: 0, score: 1, build: 'humanoid',
  },
  hound: {
    kind: 'hound', name: 'HELLHOUND', health: 1, tint: [1, 1, 1], scale: 1,
    lean: 0, bodyArmour: 1, range: 0, burst: 0, score: 1, build: 'hound',
  },
  crawler: {
    kind: 'crawler', name: 'CRAWLER', health: 0.55, tint: [0.8, 0.94, 0.76], scale: 0.96,
    lean: 1.15, bodyArmour: 1, range: 0, burst: 0, score: 1, build: 'humanoid',
  },
  armoured: {
    kind: 'armoured', name: 'ARMOURED', health: 2.1, tint: [0.7, 0.84, 1.08], scale: 1.08,
    lean: 0, bodyArmour: 0.4, range: 0, burst: 0, score: 1, build: 'humanoid',
  },
  spitter: {
    kind: 'spitter', name: 'SPITTER', health: 1.15, tint: [0.7, 1.28, 0.68], scale: 1.02,
    lean: 0, bodyArmour: 1, range: 17, burst: 0, score: 1, build: 'humanoid',
  },
  bomber: {
    kind: 'bomber', name: 'BLOATER', health: 0.9, tint: [1.22, 1.18, 0.58], scale: 1.16,
    lean: 0, bodyArmour: 1, range: 0, burst: 7.5, score: 1, build: 'humanoid',
  },
  tank: {
    kind: 'tank', name: 'TANK', health: 5.5, tint: [0.82, 0.68, 0.6], scale: 1.34,
    lean: 0.14, bodyArmour: 0.6, range: 0, burst: 0, score: 4, build: 'tank',
  },
};

/** What a bloater's burst does to the player standing in the middle of it. */
export const BOMBER_DAMAGE = 55;
/** And to everything else caught in it. */
export const BOMBER_SPLASH = 420;

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

/** The hardest chapter's threat. */
export const MAX_THREAT = 3;

/**
 * Enemy hit points for a round. 150 at round 1, 950 at round 9, then +10%/round,
 * and a fifth more for each step of threat.
 */
export function enemyHealth(round: number, threat = 0): number {
  const base = round <= 9 ? 50 + round * 100 : 950 * Math.pow(1.1, round - 9);
  return Math.round(base * (1 + 0.2 * threat));
}

/**
 * How well the horde works together, 0 to 1. The first couple of rounds are the
 * dumb straight line at you the game has always had; from there they start
 * splitting off to come round the sides and to get in front of you, and a
 * chapter that is already trying harder to kill you gets there sooner.
 */
export function hordeCunning(round: number, threat = 0): number {
  return Math.max(0, Math.min(1, (round - 2) / 8 + threat * 0.12));
}

/** Hound rounds are short and sharp. */
export function houndHealth(round: number, threat = 0): number {
  return Math.round(enemyHealth(round, threat) * 0.55);
}

export function enemyCount(round: number, threat = 0): number {
  const more = 1 + 0.12 * threat;
  if (isHoundRound(round)) return Math.min(30 + threat * 2, Math.round((6 + Math.floor(round * 0.9)) * more));
  const extra = round > 9 ? Math.pow(round - 9, 1.55) : 0;
  return Math.min(74 + threat * 5, Math.round((6 + (round - 1) * 4 + extra) * more));
}

export function maxAlive(round: number, threat = 0): number {
  if (isHoundRound(round)) return Math.min(10 + threat, 4 + Math.floor(round / 4) + threat);
  // The pool holds forty bodies, and the dead linger a moment: never more than 28 up at once.
  return Math.min(26 + Math.min(2, threat), 8 + Math.floor(round * 1.4) + threat * 2);
}

export function spawnInterval(round: number, threat = 0): number {
  const quicker = 1 - 0.07 * threat;
  if (isHoundRound(round)) return Math.max(0.5, (2.4 - round * 0.09) * quicker);
  return Math.max(0.2, (2.1 - round * 0.105) * quicker);
}

/**
 * Base walk speed in world units per second (two units to the metre). A
 * round-one walker covers about 1.6 m/s - a purposeful shamble, not a stroll -
 * and by the late rounds most of them are jogging.
 */
export function enemySpeed(round: number, kind: EnemyKind, threat = 0): number {
  const ramp = Math.min(3.6, round * 0.17);
  const quicker = 1 + 0.05 * threat;
  switch (kind) {
    case 'walker':
      return (3.2 + ramp * 0.8) * quicker;
    case 'runner':
      return (5.4 + ramp * 0.75) * quicker;
    case 'brute':
      return (2.8 + ramp * 0.5) * quicker;
    case 'hound':
      return (7.4 + Math.min(1.6, round * 0.05)) * quicker;
    case 'crawler':
      return (2.4 + ramp * 0.45) * quicker;
    case 'armoured':
      return (2.9 + ramp * 0.45) * quicker;
    case 'spitter':
      return (3.0 + ramp * 0.5) * quicker;
    case 'bomber':
      return (3.7 + ramp * 0.7) * quicker;
    case 'tank':
      // The slowest thing on the map. You can walk away from one; the trick is
      // that by the time it arrives the rest of the horde has you standing still.
      return (2.2 + ramp * 0.3) * quicker;
  }
}

export function enemyDamage(kind: EnemyKind, threat = 0): number {
  const base = {
    walker: 32, runner: 34, brute: 58, hound: 28,
    crawler: 26, armoured: 40, spitter: 22, bomber: 30, tank: 88,
  }[kind];
  return Math.round(base * (1 + 0.1 * threat));
}

/** Health for one body: the round's baseline, scaled by what kind it is. */
export function healthFor(kind: EnemyKind, round: number, threat = 0): number {
  if (kind === 'hound') return houndHealth(round, threat);
  return Math.round(enemyHealth(round, threat) * ENEMY_INFO[kind].health);
}

/**
 * Composition of a normal round: runners and brutes phase in as it gets late,
 * and a round and a half earlier for each step of threat.
 */
export function roundMix(round: number, threat = 0): { kind: EnemyKind; weight: number }[] {
  if (isHoundRound(round)) return [{ kind: 'hound', weight: 1 }];
  const r = round + threat * 1.5;
  /** Nothing at all until `from`, then a share that grows and levels off. */
  const ramp = (from: number, per: number, cap: number): number =>
    (r < from ? 0 : Math.min(cap, (r - from + 1) * per));
  const runner = ramp(4, 0.075, 0.36);
  const crawler = ramp(3, 0.03, 0.1);
  const bomber = ramp(5, 0.025, 0.09);
  const spitter = ramp(6, 0.022, 0.08);
  const armoured = ramp(7, 0.022, 0.09);
  const brute = ramp(8, 0.025, 0.11);
  // Tanks stay rare however late it gets: two at once is a bad afternoon.
  const tank = ramp(10, 0.014, 0.055);
  // Those caps come to 0.885, so there are always shamblers in the crowd.
  const walker = 1 - runner - crawler - bomber - spitter - armoured - brute - tank;
  return [
    { kind: 'walker', weight: walker },
    { kind: 'runner', weight: runner },
    { kind: 'crawler', weight: crawler },
    { kind: 'bomber', weight: bomber },
    { kind: 'spitter', weight: spitter },
    { kind: 'armoured', weight: armoured },
    { kind: 'brute', weight: brute },
    { kind: 'tank', weight: tank },
  ];
}

export function planRound(round: number, threat = 0): SpawnPlan {
  const hounds = isHoundRound(round);
  return {
    round,
    total: enemyCount(round, threat),
    maxAlive: maxAlive(round, threat),
    interval: spawnInterval(round, threat),
    health: hounds ? houndHealth(round, threat) : enemyHealth(round, threat),
    mix: roundMix(round, threat),
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

/**
 * What a kill pays. `multiplier` is the dead thing's own worth from
 * `ENEMY_INFO.score`: one for the rank and file, four for a tank.
 */
export function scoreForKill(kind: KillKind, doublePoints: boolean, multiplier = 1): number {
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
  return Math.round(base * multiplier) * (doublePoints ? 2 : 1);
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

/**
 * Power-up drops: no drop at all until this many kills since the last one, and
 * then this chance per kill. That works out at roughly one drop per 24 kills -
 * the twelve dead it takes to arm the roll, plus about twelve more to win it.
 */
export const DROP_CHANCE = 0.085;
export const DROP_MIN_GAP = 12; // kills
/** However well the rolls go, a round only gives up so much. */
export const DROPS_PER_ROUND = 4;

export const MYSTERY_BOX_COST = 950;

/* ------------------------------------------------------------------- traps */

/** What it costs to throw a trap's switch. */
export const TRAP_COST = 1000;
/** How long it runs for, and how long it has to cool down afterwards. */
export const TRAP_SECONDS = 26;
export const TRAP_COOLDOWN = 22;

/**
 * Damage a trap does per second. Pinned to the round's health, so it always
 * takes an ordinary body down in about a third of a second: murderous early,
 * and still worth a thousand points once nothing one-shots anything any more.
 */
export function trapDamage(round: number, threat = 0): number {
  return enemyHealth(round, threat) * 3.2;
}
/** After this many pulls the box packs up and moves on. */
export const BOX_MOVE_MIN = 4;
export const BOX_MOVE_MAX = 9;

/* ----------------------------------------------------------- pack-a-punch */

// Pack-a-Punch tiers, costs and names live with the weapon table in weapons.ts.
