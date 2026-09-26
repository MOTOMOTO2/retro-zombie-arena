/**
 * What the player has unlocked and their best run on each map, kept in
 * localStorage. The rules are pure so they are unit tested; only load and
 * save touch storage.
 */

import type { MapId } from '../world/mapdata.ts';
import { MAP_ORDER } from '../world/maps.ts';
import { UNLOCK_ROUND } from './story.ts';

const KEY = 'rza.progress.v1';

export type MapRecord = {
  bestRound: number;
  bestKills: number;
  bestPoints: number;
  /** Escaped at least once. */
  escaped: boolean;
  /** Fewest rounds it took to escape. */
  fastestEscape: number;
};

export type Progress = {
  unlocked: MapId[];
  records: Partial<Record<MapId, MapRecord>>;
};

export type RunResult = { round: number; kills: number; points: number; escaped: boolean };

export function defaultProgress(): Progress {
  return { unlocked: [MAP_ORDER[0]], records: {} };
}

export function isUnlocked(p: Progress, map: MapId): boolean {
  return map === MAP_ORDER[0] || p.unlocked.includes(map);
}

/** The map after this one, if any. */
export function nextMap(map: MapId): MapId | null {
  const i = MAP_ORDER.indexOf(map);
  return i >= 0 && i + 1 < MAP_ORDER.length ? MAP_ORDER[i + 1] : null;
}

/** The map before this one, whose run unlocks it. */
export function previousMap(map: MapId): MapId | null {
  const i = MAP_ORDER.indexOf(map);
  return i > 0 ? MAP_ORDER[i - 1] : null;
}

/**
 * Records a run. Escaping a map, or surviving to UNLOCK_ROUND on it, opens
 * the next one. Returns the map that was unlocked by this run, if any, and
 * whether it set a new best round.
 */
export function recordRun(p: Progress, map: MapId, r: RunResult): { unlocked: MapId | null; best: boolean } {
  const prev = p.records[map];
  const rec: MapRecord = prev
    ? { ...prev }
    : { bestRound: 0, bestKills: 0, bestPoints: 0, escaped: false, fastestEscape: 0 };
  const best = r.round > rec.bestRound || (r.round === rec.bestRound && r.points > rec.bestPoints);
  if (best) {
    rec.bestRound = r.round;
    rec.bestKills = r.kills;
    rec.bestPoints = r.points;
  }
  if (r.escaped) {
    rec.escaped = true;
    rec.fastestEscape = rec.fastestEscape ? Math.min(rec.fastestEscape, r.round) : r.round;
  }
  p.records[map] = rec;

  let unlocked: MapId | null = null;
  const next = nextMap(map);
  if (next && !isUnlocked(p, next) && (r.escaped || r.round >= UNLOCK_ROUND)) {
    p.unlocked.push(next);
    unlocked = next;
  }
  return { unlocked, best };
}

/** A whole number from stored data, whatever it turns out to be. */
function count(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A record as this build understands it. Saved progress outlives the build that
 * wrote it, and a half-written or hand-edited entry would otherwise put NaN and
 * undefined straight onto the chapter cards, so every field is rebuilt here.
 */
function cleanRecord(raw: unknown): MapRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const escaped = r.escaped === true;
  return {
    bestRound: count(r.bestRound),
    bestKills: count(r.bestKills),
    bestPoints: count(r.bestPoints),
    escaped,
    // A map can only have a fastest escape if it was ever escaped.
    fastestEscape: escaped ? count(r.fastestEscape) : 0,
  };
}

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultProgress();
    const parsed = JSON.parse(raw) as Partial<Progress>;
    const p = defaultProgress();
    if (Array.isArray(parsed.unlocked)) {
      for (const m of parsed.unlocked) if (MAP_ORDER.includes(m) && !p.unlocked.includes(m)) p.unlocked.push(m);
    }
    for (const m of MAP_ORDER) {
      const rec = cleanRecord(parsed.records?.[m]);
      if (rec) p.records[m] = rec;
    }
    return p;
  } catch {
    return defaultProgress();
  }
}

export function saveProgress(p: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private browsing: progress lasts the session */
  }
}
