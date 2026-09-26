/**
 * The story: four chapters, one per map, told in briefings before each run
 * and over the radio during it.
 *
 * Vireo Pharmaceuticals made Compound L - "Lazarus" - to stop people dying.
 * They trialled it at St. Mercy Asylum. It worked, in its way. Dr. Elias
 * Voss helped make it, and he is the voice on the radio talking you out of
 * the asylum, through the town, down through the ironworks to Sublevel 9,
 * where the first patient to take it is still waiting.
 *
 * Every chapter ends the same way - its boss, then the way out - but the job
 * before that is its own, and each one asks more of you than the last.
 */

import type { MapId } from '../world/mapdata.ts';

export type BossId = 'warden' | 'butcher' | 'furnace' | 'patient0';

/**
 * One job on the way to the boss.
 * - power: flip the power switch.
 * - parts: pick up each named part from its crate (any time, in any order).
 * - build: put the parts together at the station.
 * - valves: open all three valves around the map before the pressure runs
 *   out; the clock starts at the first, and if it runs out they all shut.
 * - harvest: kill this many near the station.
 * - defend: stay near the station this long while the horde throws itself at it.
 */
export type StepDef =
  | { kind: 'power'; text: string }
  | { kind: 'parts'; names: string[] }
  | { kind: 'build' }
  | { kind: 'valves'; name: string; window: number }
  | { kind: 'harvest'; kills: number; text: string }
  | { kind: 'defend'; seconds: number };

export type StepKind = StepDef['kind'];

/** Things that happen in a run that the radio has something to say about. */
export type StoryBeat =
  | 'start' | 'power' | 'part' | 'parts' | 'built'
  | 'valve' | 'valves' | 'valvesLost'
  | 'harvest' | 'harvestHalf' | 'harvested'
  | 'defend' | 'defendHalf' | 'defended'
  | 'boss' | 'bossDown' | 'escaped';

export type Chapter = {
  map: MapId;
  number: number;
  title: string;
  /** One line for the map card. */
  blurb: string;
  /** The briefing, paragraph by paragraph. */
  briefing: string[];
  /** What stands at the station: the thing that is built, fed or defended. */
  device: string;
  /** The jobs before the boss, in order. */
  steps: StepDef[];
  boss: BossId;
  bossName: string;
  /** One line about the boss, for the briefing. */
  bossNote: string;
  /** Where you leave by. */
  exit: string;
  /** What happens after you get out. */
  ending: string[];
  radio: Partial<Record<StoryBeat, string[]>>;
};

export const RADIO_NAME = 'DR. VOSS';

/** Reaching this round on a map also unlocks the next, for players who would rather just survive. */
export const UNLOCK_ROUND = 15;

/** How many valves a valves step has to open. */
export const VALVE_COUNT = 3;

/** How close to the station counts as defending it, or feeding it, in world units. */
export const STATION_RADIUS = 14;

/** How much harder a chapter is than the first: 0 to 3. */
export function threatOf(c: Chapter): number {
  return c.number - 1;
}

/** The beats a chapter's jobs can produce that Voss must have something to say about. */
export function beatsFor(steps: StepDef[]): StoryBeat[] {
  const out: StoryBeat[] = ['start', 'boss', 'bossDown'];
  for (const s of steps) {
    if (s.kind === 'power') out.push('power');
    if (s.kind === 'parts') out.push(s.names.length > 1 ? 'part' : 'parts', 'parts');
    if (s.kind === 'build') out.push('built');
    if (s.kind === 'valves') out.push('valve', 'valves', 'valvesLost');
    if (s.kind === 'harvest') out.push('harvestHalf', 'harvested');
    if (s.kind === 'defend') out.push('defendHalf', 'defended');
  }
  return [...new Set(out)];
}

export const CHAPTERS: Record<MapId, Chapter> = {
  asylum: {
    map: 'asylum',
    number: 1,
    title: 'ADMISSION',
    blurb: 'Wake up in a locked ward with no memory and a radio that knows your name.',
    briefing: [
      'You wake on a gurney in St. Mercy Asylum with a hospital band on your wrist and three weeks missing from your memory. The other patients are in the corridors. They are not patients any more.',
      'A radio on the nurses’ station crackles. The man on it calls himself Dr. Voss. He says he can get you out — if you can get the generator running and build his signal booster.',
    ],
    device: 'SIGNAL BOOSTER',
    steps: [
      { kind: 'power', text: 'RESTORE THE POWER' },
      { kind: 'parts', names: ['VACUUM TUBE', 'AERIAL COIL', 'CRYSTAL OSCILLATOR'] },
      { kind: 'build' },
    ],
    boss: 'warden',
    bossName: 'THE WARDEN',
    bossNote: 'Head orderly Grimsby. First to volunteer for the trial. He still has the gate keys.',
    exit: 'THE FRONT GATE',
    ending: [
      'The Warden goes down and the gate keys go with you. Behind you, St. Mercy burns.',
      'Ahead are the lights of Hollow Creek, and Voss is back on the radio: the asylum’s water runs straight into the town reservoir. The town has been drinking it for a week.',
    ],
    radio: {
      start: ['If you can hear this, you’re alive. Good. Find the generator — nothing in St. Mercy works without it.'],
      power: ['Power’s up. Now my booster: a vacuum tube, an aerial coil and a crystal oscillator. They’re somewhere in the wards.'],
      part: ['That’s one. Keep looking.', 'Got it. Watch your back in there.'],
      parts: ['That’s all three. Get them to the workbench and wire it up.'],
      built: ['Booster’s live. I can hear you clearly now — and so can something else. Brace yourself.'],
      boss: ['That’s Grimsby. The Warden. He had the gate keys. Put him down!'],
      bossDown: ['He’s down! Take the keys and get to the front gate!'],
    },
  },
  town: {
    map: 'town',
    number: 2,
    title: 'OUTBREAK',
    blurb: 'The town drank the water. Main Street is a graveyard and the graveyard is empty.',
    briefing: [
      'Hollow Creek drank the water from St. Mercy for a week before anyone noticed the patients were missing. Now Main Street is a graveyard, and the graveyard is empty.',
      'Voss can get a helicopter to you, but it needs a signal it can lock on to. Get the substation running, find a flare pistol and a battery, build the evac beacon — and keep the dead off it for a full minute while it transmits. Every one of them in town will hear it.',
    ],
    device: 'EVAC BEACON',
    steps: [
      { kind: 'power', text: 'GET THE SUBSTATION RUNNING' },
      { kind: 'parts', names: ['FLARE PISTOL', 'SIGNAL BATTERY'] },
      { kind: 'build' },
      { kind: 'defend', seconds: 60 },
    ],
    boss: 'butcher',
    bossName: 'THE BUTCHER',
    bossNote: 'Otto Kessler kept the butcher’s shop on Main Street. He still has his cleaver, and his dogs.',
    exit: 'THE RAIL YARD GATE',
    ending: [
      'The beacon burns out. The helicopter never comes — Voss watched it go down over the ridge, and it wasn’t the dead that shot it.',
      '“Vireo is cleaning up,” he says. “There’s only one way to end this. The source. Under the Ironworks.”',
    ],
    radio: {
      start: ['Hollow Creek. The water from St. Mercy ran straight into the reservoir. Find the substation and get the lights on.'],
      power: ['I can get a chopper to you, but it needs a signal. Find a flare pistol and a battery for the beacon.'],
      part: ['That’s one. Keep moving.', 'Good. Don’t stay in one place too long.'],
      parts: ['That’s both. Rig the beacon at the workbench.'],
      built: ['Beacon’s transmitting! It needs a full minute to lock on — stay close and keep them off it!'],
      defendHalf: ['Halfway there! Hold on!'],
      defended: ['Signal locked — the chopper’s coming! Wait… something big is coming down Main Street.'],
      boss: ['That’s Kessler. The Butcher. Mind the cleaver — and his dogs.'],
      bossDown: ['The chopper’s down. Vireo shot it down. There’s a freight line at the rail yard — go, now!'],
    },
  },
  foundry: {
    map: 'foundry',
    number: 3,
    title: 'THE FURNACE',
    blurb: 'Vireo’s front company. Under the casting floor, a lift shaft nine levels deep.',
    briefing: [
      'The Vireo Ironworks never made much iron. Under the casting floor there is a lift shaft nine levels deep, and it has been welded shut from the inside.',
      'The old crucible can cut through the welds. Get the turbines turning, then open all three steam valves before the pressure bleeds away — they slam shut if you are too slow. Then feed the crucible. It burns anything, and the dead burn well: kill them close to it. And stay clear of the furnaces. Something in there has been burning for weeks and has not died.',
    ],
    device: 'CRUCIBLE',
    steps: [
      { kind: 'power', text: 'START THE TURBINES' },
      { kind: 'valves', name: 'STEAM VALVE', window: 75 },
      { kind: 'harvest', kills: 20, text: 'FEED THE CRUCIBLE' },
    ],
    boss: 'furnace',
    bossName: 'THE FURNACE MAN',
    bossNote: 'A foundryman who turned and fell into the crucible. It did not kill him. Fire will not either.',
    exit: 'THE SERVICE LIFT',
    ending: [
      'The crucible cuts the lift doors off their rails. The Furnace Man is still smouldering as the cage drops into the dark.',
      'Voss is quiet on the radio for a long time. Then: “There’s something I didn’t tell you. Patient Zero was my son.”',
    ],
    radio: {
      start: ['The Ironworks. Vireo’s lift to Sublevel 9 is under the casting floor, welded shut. Get the turbines turning first.'],
      power: ['Turbines are up. Now the crucible: three steam valves, all open at once. The pressure won’t hold long — move fast.'],
      valve: ['One open. Keep going — the pressure’s dropping!', 'Two! One more!'],
      valvesLost: ['The pressure’s gone — they’ve all slammed shut. Open them again, faster!'],
      valves: ['Crucible’s lit! Now it needs fuel. They burn — kill them close to it.'],
      harvestHalf: ['It’s getting hot. Keep feeding it!'],
      harvested: ['That’s enough heat to cut the welds. Wait — the furnace doors are opening. That isn’t me.'],
      boss: ['The Furnace Man. Fire won’t hurt him. Everything else might.'],
      bossDown: ['The welds are cut. Get in the lift. Go!'],
    },
  },
  labs: {
    map: 'labs',
    number: 4,
    title: 'PATIENT ZERO',
    blurb: 'Where Compound L was made, and where the first patient is still waiting.',
    briefing: [
      'Sublevel 9. Compound L was made here, and first tested here — on Daniel Voss, nineteen and dying, whose father thought he could save him. Everything upstairs came from Daniel’s blood.',
      'Bring the reactor online and find an access keycard for the dispersal system. Open all three dispersal vents before the seals re-engage, then hold the purge for ninety seconds while it primes. It will flood the level with the counter-agent. It will also bring Daniel to you.',
    ],
    device: 'PURGE',
    steps: [
      { kind: 'power', text: 'BRING THE REACTOR ONLINE' },
      { kind: 'parts', names: ['ACCESS KEYCARD'] },
      { kind: 'valves', name: 'DISPERSAL VENT', window: 50 },
      { kind: 'defend', seconds: 90 },
    ],
    boss: 'patient0',
    bossName: 'PATIENT ZERO',
    bossNote: 'Daniel Voss. The first to take Compound L, and the source of everything since.',
    exit: 'THE SURFACE LIFT',
    ending: [
      'The purge floods Sublevel 9. Patient Zero falls and does not get up, and all through the valley above, the dead lie down with him.',
      'Voss is waiting at the top of the lift. He doesn’t say anything. He doesn’t have to.',
    ],
    radio: {
      start: ['Sublevel 9. This is where it started. Get the reactor online — the purge system needs it.'],
      power: ['Reactor’s up. The dispersal controls are locked — find an access keycard.'],
      parts: ['That’s the keycard. Now the three dispersal vents — all of them, fast, before the seals re-engage.'],
      valve: ['Vent open! Keep moving!', 'Two! Last one!'],
      valvesLost: ['The seals re-engaged. Again — faster!'],
      valves: ['Vents are open. The purge is priming — ninety seconds, and they’ll feel it. Keep them off it!'],
      defendHalf: ['Halfway. He knows. He’s coming.'],
      defended: ['The purge is primed. He’s awake. Daniel… I’m so sorry.'],
      boss: ['That’s Patient Zero. That’s my son. End it.'],
      bossDown: ['It’s over. The purge is spreading. Get to the surface lift!'],
    },
  },
};
