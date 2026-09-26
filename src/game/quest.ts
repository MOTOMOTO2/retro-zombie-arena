/**
 * The goal of a run: work through the chapter's jobs (see story.ts), survive
 * the boss that brings, and get out.
 *
 * Pure state and transitions, no rendering, so every chain is unit tested.
 * Every transition returns the story beats it produced, which the game turns
 * into radio chatter, banners and callouts.
 */

import type { MapId } from '../world/mapdata.ts';
import { CHAPTERS, VALVE_COUNT, threatOf, type Chapter, type StepDef, type StepKind, type StoryBeat } from './story.ts';

/** Seconds between the last job being done and the boss arriving. */
export const BOSS_DELAY = 14;

export type QuestStage = StepKind | 'boss' | 'escape' | 'done';

/**
 * A line of the objective list. `progress` is the part that ticks over (a
 * count, a clock) and `alert` marks it urgent; neither makes the line flash.
 */
export type Objective = { text: string; done: boolean; progress?: string; alert?: boolean };

export type BossState = 'none' | 'coming' | 'alive' | 'dead';

type StepOf<K extends StepKind> = Extract<StepDef, { kind: K }>;

function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class Quest {
  readonly chapter: Chapter;
  power = false;
  /** One flag per part this chapter needs; empty if it needs none. */
  readonly parts: boolean[];
  built = false;
  /** One flag per valve, if this chapter has valves to open. */
  readonly valves: boolean[];
  /** Seconds left to open the rest of the valves, once the first is open. */
  valveTimer = 0;
  /** Kills made near the station, for a harvest. */
  kills = 0;
  /** Seconds spent defending the station. */
  held = 0;
  /** Whether the player was near the station at the last tick. */
  near = false;
  boss: BossState = 'none';
  /** Seconds until the boss arrives, while it is on its way. */
  bossTimer = 0;
  escaped = false;

  constructor(map: MapId) {
    this.chapter = CHAPTERS[map];
    this.parts = new Array<boolean>(this.step('parts')?.names.length ?? 0).fill(false);
    this.valves = new Array<boolean>(this.step('valves') ? VALVE_COUNT : 0).fill(false);
  }

  /** The chapter's step of a kind, if it has one. */
  step<K extends StepKind>(kind: K): StepOf<K> | undefined {
    return this.chapter.steps.find((s): s is StepOf<K> => s.kind === kind);
  }

  get threat(): number {
    return threatOf(this.chapter);
  }

  get partNames(): string[] {
    return this.step('parts')?.names ?? [];
  }

  get partsFound(): number {
    return this.parts.filter(Boolean).length;
  }

  get allParts(): boolean {
    return this.partsFound === this.parts.length;
  }

  get valvesOpen(): number {
    return this.valves.filter(Boolean).length;
  }

  private done(s: StepDef): boolean {
    switch (s.kind) {
      case 'power':
        return this.power;
      case 'parts':
        return this.allParts;
      case 'build':
        return this.built;
      case 'valves':
        return this.valvesOpen === this.valves.length;
      case 'harvest':
        return this.kills >= s.kills;
      case 'defend':
        return this.held >= s.seconds;
    }
  }

  /** The first job not yet done, or null once they all are. */
  get current(): StepDef | null {
    return this.chapter.steps.find((s) => !this.done(s)) ?? null;
  }

  /** What the player should be doing now. Parts can be picked up early, but the rest go in order. */
  get stage(): QuestStage {
    if (this.escaped) return 'done';
    if (this.boss === 'dead') return 'escape';
    if (this.boss !== 'none') return 'boss';
    return this.current?.kind ?? 'boss';
  }

  /** Whether the station's device is there to see: built, or ready and waiting for its job. */
  get deviceOn(): boolean {
    if (this.step('build')) return this.built;
    const steps = this.chapter.steps;
    const first = steps.findIndex((s) => s.kind === 'harvest' || s.kind === 'defend');
    return first >= 0 && steps.slice(0, first).every((s) => this.done(s));
  }

  /** The objective list for the HUD. */
  objectives(): Objective[] {
    const c = this.chapter;
    if (this.boss === 'dead') return [{ text: `ESCAPE THROUGH ${c.exit}`, done: this.escaped }];
    if (this.boss === 'alive') return [{ text: `KILL ${c.bossName}`, done: false }];
    if (this.boss === 'coming') return [{ text: 'SOMETHING IS COMING…', done: false }];
    const now = this.current;
    return c.steps.map((s): Objective => {
      const done = this.done(s);
      const live = s === now;
      switch (s.kind) {
        case 'power':
          return { text: s.text, done };
        case 'parts':
          return {
            text: s.names.length === 1 ? `FIND THE ${s.names[0]}` : `FIND THE PARTS  ${this.partsFound}/${s.names.length}`,
            done,
          };
        case 'build':
          return { text: `BUILD THE ${c.device}`, done };
        case 'valves':
          return {
            text: `OPEN THE ${s.name}S  ${this.valvesOpen}/${this.valves.length}`,
            done,
            progress: live && this.valveTimer > 0 ? clock(this.valveTimer) : undefined,
            alert: live && this.valveTimer > 0 && this.valveTimer < 15,
          };
        case 'harvest':
          return { text: s.text, done, progress: live ? `${Math.min(this.kills, s.kills)}/${s.kills}` : undefined };
        case 'defend':
          return {
            text: `DEFEND THE ${c.device}`,
            done,
            progress: live ? (this.near ? clock(s.seconds - this.held) : 'GET BACK TO IT') : undefined,
            alert: live && !this.near,
          };
      }
    });
  }

  /** After a job is done: the boss sets off once the last one is, and a new job may announce itself. */
  private advance(): StoryBeat[] {
    const next = this.current;
    if (!next) {
      if (this.boss === 'none') {
        this.boss = 'coming';
        this.bossTimer = BOSS_DELAY;
      }
      return [];
    }
    if (next.kind === 'harvest') return ['harvest'];
    if (next.kind === 'defend') return ['defend'];
    return [];
  }

  /** Whether a job is the one in hand. */
  private live(kind: StepKind): boolean {
    return this.boss === 'none' && this.current?.kind === kind;
  }

  powerOn(): StoryBeat[] {
    if (this.power) return [];
    this.power = true;
    return ['power', ...this.advance()];
  }

  takePart(i: number): StoryBeat[] {
    if (i < 0 || i >= this.parts.length || this.parts[i]) return [];
    this.parts[i] = true;
    if (!this.allParts) return ['part'];
    return ['parts', ...this.advance()];
  }

  get canBuild(): boolean {
    return Boolean(this.step('build')) && this.live('build');
  }

  build(): StoryBeat[] {
    if (!this.canBuild) return [];
    this.built = true;
    return ['built', ...this.advance()];
  }

  get canOpenValves(): boolean {
    return this.live('valves');
  }

  /** Opens a valve. The first one starts the clock on the rest. */
  openValve(i: number): StoryBeat[] {
    const s = this.step('valves');
    if (!s || !this.canOpenValves || i < 0 || i >= this.valves.length || this.valves[i]) return [];
    this.valves[i] = true;
    if (this.valvesOpen === 1) this.valveTimer = s.window;
    if (this.valvesOpen < this.valves.length) return ['valve'];
    this.valveTimer = 0;
    return ['valves', ...this.advance()];
  }

  /** A kill near the station, while it is hungry. */
  harvest(): StoryBeat[] {
    const s = this.step('harvest');
    if (!s || !this.live('harvest')) return [];
    this.kills++;
    if (this.kills >= s.kills) return ['harvested', ...this.advance()];
    return this.kills === Math.ceil(s.kills / 2) ? ['harvestHalf'] : [];
  }

  get harvesting(): boolean {
    return this.live('harvest');
  }

  get defending(): boolean {
    return this.live('defend');
  }

  /**
   * Runs the clocks: the valve pressure, the defence (which only counts while
   * the player is near the station) and the boss on its way.
   */
  tick(dt: number, nearStation = false): StoryBeat[] {
    this.near = nearStation;
    const beats: StoryBeat[] = [];
    if (this.live('valves') && this.valveTimer > 0) {
      this.valveTimer = Math.max(0, this.valveTimer - dt);
      if (this.valveTimer <= 0) {
        this.valves.fill(false);
        beats.push('valvesLost');
      }
    }
    const d = this.step('defend');
    if (d && this.live('defend') && nearStation) {
      const half = d.seconds / 2;
      const before = this.held;
      this.held = Math.min(d.seconds, this.held + dt);
      if (before < half && this.held >= half && this.held < d.seconds) beats.push('defendHalf');
      if (this.held >= d.seconds) beats.push('defended', ...this.advance());
    }
    if (this.boss === 'coming') this.bossTimer = Math.max(0, this.bossTimer - dt);
    return beats;
  }

  /** True once the boss is due, until the game reports it has arrived (it may have to wait for a window). */
  get bossDue(): boolean {
    return this.boss === 'coming' && this.bossTimer <= 0;
  }

  /** Does every job at once and sets the boss on its way. Used by the smoke test, and handy when debugging. */
  completeSteps(): void {
    this.power = true;
    this.parts.fill(true);
    this.valves.fill(true);
    this.built = Boolean(this.step('build'));
    this.kills = this.step('harvest')?.kills ?? 0;
    this.held = this.step('defend')?.seconds ?? 0;
    this.valveTimer = 0;
    this.advance();
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
