/**
 * Spoken lines: the announcer calling the drops, and the player's own callouts.
 *
 * Words are the one thing the game does not synthesise at runtime. The lines
 * are listed in voicelines.json and baked ahead of time into public/voice/ by
 * tools/voices.py, which runs an open, expressive neural text-to-speech model
 * offline and keeps the liveliest take of each line that still says it right. Here
 * they are fetched and decoded when the audio starts, and a take is picked each
 * time a line is called for.
 */

import LINES from './voicelines.json';

export type AnnouncerLine = keyof typeof LINES.announcer.lines;
export type PlayerLine = keyof typeof LINES.player.lines;
type Speaker = keyof typeof LINES;

/**
 * How chatty the player is: the chance a moment gets a line at all, and how
 * long before the same moment can get one again. Urgent lines cut off whatever
 * the player was saying; the rest wait for a gap.
 */
export const CALLOUT_PACE: Record<PlayerLine, { chance: number; cooldown: number; urgent?: boolean }> = {
  reload: { chance: 0.3, cooldown: 18 },
  empty: { chance: 1, cooldown: 10 },
  grenade: { chance: 0.5, cooldown: 8 },
  roundStart: { chance: 0.7, cooldown: 0 },
  roundClear: { chance: 0.7, cooldown: 0 },
  hurt: { chance: 1, cooldown: 20 },
  headshot: { chance: 0.18, cooldown: 12 },
  multikill: { chance: 0.9, cooldown: 6 },
  legendary: { chance: 1, cooldown: 0, urgent: true },
  teddy: { chance: 1, cooldown: 0, urgent: true },
  perk: { chance: 1, cooldown: 0 },
  packed: { chance: 1, cooldown: 0, urgent: true },
  boss: { chance: 1, cooldown: 0, urgent: true },
  bossDown: { chance: 1, cooldown: 0, urgent: true },
  objective: { chance: 0.9, cooldown: 8 },
  defend: { chance: 1, cooldown: 20 },
  setback: { chance: 1, cooldown: 6 },
};

/** Seconds of quiet the player leaves between one line and the next. */
export const CALLOUT_GAP = 4;

export class VoiceBank {
  private readonly takes = new Map<string, AudioBuffer[]>();
  private readonly lastTake = new Map<string, number>();
  private loading: Promise<void> | null = null;

  /** Fetches and decodes every line. Safe to call again; a line that fails is just never heard. */
  load(ctx: BaseAudioContext): Promise<void> {
    this.loading ??= Promise.all(
      (Object.keys(LINES) as Speaker[]).flatMap((speaker) =>
        Object.entries(LINES[speaker].lines).flatMap(([event, texts]) =>
          texts.map(async (_text, n) => {
            try {
              const res = await fetch(`voice/${speaker}-${event}-${n}.mp3`);
              if (!res.ok) return;
              const buf = await ctx.decodeAudioData(await res.arrayBuffer());
              const key = `${speaker}.${event}`;
              const list = this.takes.get(key) ?? [];
              list[n] = buf;
              this.takes.set(key, list);
            } catch {
              /* offline or undecodable: the game plays on without it */
            }
          }),
        ),
      ),
    ).then(() => undefined);
    return this.loading;
  }

  /** How many takes are ready to play. */
  get loaded(): number {
    let n = 0;
    for (const list of this.takes.values()) n += list.filter(Boolean).length;
    return n;
  }

  /** A take of the line, never the same one twice running when there is a choice. */
  pick(speaker: 'announcer', line: AnnouncerLine): AudioBuffer | null;
  pick(speaker: 'player', line: PlayerLine): AudioBuffer | null;
  pick(speaker: Speaker, line: string): AudioBuffer | null {
    const key = `${speaker}.${line}`;
    const list = this.takes.get(key)?.filter(Boolean);
    if (!list?.length) return null;
    const last = this.lastTake.get(key) ?? -1;
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === last) i = (i + 1) % list.length;
    this.lastTake.set(key, i);
    return list[i];
  }
}
