/**
 * The goal of a run: get the power on, find three parts, build the chapter's
 * device at the workbench, survive what that brings, and get out.
 *
 * Pure state and transitions, no rendering, so the whole chain is unit
 * tested. Every transition returns the story beats it produced, which the
 * game turns into radio chatter and banners.
 */

import type { MapId } from '../world/mapdata.ts';
import { CHAPTERS, type Chapter, type StoryBeat } from './story.ts';

/** Seconds between building the device and the boss arriving. */
export const BOSS_DELAY = 14;

export type QuestStage = 'power' | 'parts' | 'build' | 'boss' | 'escape' | 'done';

export type Objective = { text: string; done: boolean };

export type BossState = 'none' | 'coming' | 'alive' | 'dead';

export class Quest {
  readonly chapter: Chapter;
  power = false;
  readonly parts: boolean[] = [false, false, false];
  built = false;
  boss: BossState = 'none';
  /** Seconds until the boss arrives, while it is on its way. */
  bossTimer = 0;
  escaped = false;

  constructor(map: MapId) {
    this.chapter = CHAPTERS[map];
  }

  get partsFound(): number {
    return this.parts.filter(Boolean).length;
  }

  get allParts(): boolean {
    return this.partsFound === this.parts.length;
  }

  /** What the player should be doing now. Parts can be picked up before the power is on. */
  get stage(): QuestStage {
    if (this.escaped) return 'done';
    if (this.boss === 'dead') return 'escape';
    if (this.built) return 'boss';
    if (!this.power) return 'power';
    return this.allParts ? 'build' : 'parts';
  }

  /** The objective list for the HUD. */
  objectives(): Objective[] {
    const c = this.chapter;
    if (this.boss === 'dead') return [{ text: `ESCAPE THROUGH ${c.exit}`, done: this.escaped }];
    if (this.boss === 'alive') return [{ text: `KILL ${c.bossName}`, done: false }];
    if (this.built) return [{ text: 'SOMETHING IS COMING…', done: false }];
    return [
      { text: 'RESTORE THE POWER', done: this.power },
      { text: `FIND THE PARTS  ${this.partsFound}/${this.parts.length}`, done: this.allParts },
      { text: `BUILD THE ${c.device}`, done: false },
    ];
  }

  powerOn(): StoryBeat[] {
    if (this.power) return [];
    this.power = true;
    return ['power'];
  }

  takePart(i: number): StoryBeat[] {
    if (i < 0 || i >= this.parts.length || this.parts[i]) return [];
    this.parts[i] = true;
    return [this.allParts ? 'parts' : 'part'];
  }

  get canBuild(): boolean {
    return this.power && this.allParts && !this.built;
  }

  build(): StoryBeat[] {
    if (!this.canBuild) return [];
    this.built = true;
    this.boss = 'coming';
    this.bossTimer = BOSS_DELAY;
    return ['built'];
  }

  /**
   * Counts down to the boss. True once it is due, and on every tick after
   * until the game reports it has arrived (it may have to wait for a window).
   */
  tick(dt: number): boolean {
    if (this.boss !== 'coming') return false;
    this.bossTimer = Math.max(0, this.bossTimer - dt);
    return this.bossTimer <= 0;
  }

  bossArrived(): StoryBeat[] {
    if (this.boss !== 'coming') return [];
    this.boss = 'alive';
    return ['boss'];
  }

  bossKilled(): StoryBeat[] {
    if (this.boss !== 'alive') return [];
    this.boss = 'dead';
    return ['bossDown'];
  }

  get canEscape(): boolean {
    return this.boss === 'dead' && !this.escaped;
  }

  escape(): StoryBeat[] {
    if (!this.canEscape) return [];
    this.escaped = true;
    return ['escaped'];
  }

  /** What Voss says about a beat; `n` picks between alternatives. */
  radioLine(beat: StoryBeat, n = 0): string | null {
    const lines = this.chapter.radio[beat];
    if (!lines || !lines.length) return null;
    return lines[n % lines.length];
  }
}
