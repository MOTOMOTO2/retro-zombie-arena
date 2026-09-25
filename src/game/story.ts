/**
 * The story: four chapters, one per map, told in briefings before each run
 * and over the radio during it.
 *
 * Vireo Pharmaceuticals made Compound L - "Lazarus" - to stop people dying.
 * They trialled it at St. Mercy Asylum. It worked, in its way. Dr. Elias
 * Voss helped make it, and he is the voice on the radio talking you out of
 * the asylum, through the town, down through the ironworks to Sublevel 9,
 * where the first patient to take it is still waiting.
 */

import type { MapId } from '../world/mapdata.ts';

export type BossId = 'warden' | 'butcher' | 'furnace' | 'patient0';

/** Things that happen in a run that the radio has something to say about. */
export type StoryBeat = 'start' | 'power' | 'part' | 'parts' | 'built' | 'boss' | 'bossDown' | 'escaped';

export type Chapter = {
  map: MapId;
  number: number;
  title: string;
  /** One line for the map card. */
  blurb: string;
  /** The briefing, paragraph by paragraph. */
  briefing: string[];
  /** What the three parts build. */
  device: string;
  parts: [string, string, string];
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
    parts: ['VACUUM TUBE', 'AERIAL COIL', 'CRYSTAL OSCILLATOR'],
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
      'Voss can get a helicopter to you, but it needs something it can see from the air. Get the substation running, find the parts for an evac flare, and light up the sky.',
    ],
    device: 'EVAC FLARE',
    parts: ['FLARE PISTOL', 'MAGNESIUM FLARES', 'SIGNAL BATTERY'],
    boss: 'butcher',
    bossName: 'THE BUTCHER',
    bossNote: 'Otto Kessler kept the butcher’s shop on Main Street. He still has his cleaver, and his dogs.',
    exit: 'THE RAIL YARD GATE',
    ending: [
      'The flare burns out. The helicopter never comes — Voss watched it go down over the ridge, and it wasn’t the dead that shot it.',
      '“Vireo is cleaning up,” he says. “There’s only one way to end this. The source. Under the Ironworks.”',
    ],
    radio: {
      start: ['Hollow Creek. The water from St. Mercy ran straight into the reservoir. Find the substation and get the lights on.'],
      power: ['I can get a chopper to you, but it needs a signal. Find a flare pistol, magnesium flares and a battery for the beacon.'],
      part: ['That’s one. Keep moving.', 'Good. Don’t stay in one place too long.'],
      parts: ['That’s everything. Rig the flare at the workbench.'],
      built: ['Flare’s up! Every one of them for a mile saw that. Something big is coming down Main Street.'],
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
      'Get the turbines turning, find a detonator, a charge and a timer, and build a breaching charge. And stay clear of the furnaces. Something in there has been burning for weeks and has not died.',
    ],
    device: 'BREACHING CHARGE',
    parts: ['DETONATOR', 'DEMOLITION CHARGE', 'TIMER'],
    boss: 'furnace',
    bossName: 'THE FURNACE MAN',
    bossNote: 'A foundryman who turned and fell into the crucible. It did not kill him. Fire will not either.',
    exit: 'THE SERVICE LIFT',
    ending: [
      'The charge blows the lift doors off their rails. The Furnace Man is still smouldering as the cage drops into the dark.',
      'Voss is quiet on the radio for a long time. Then: “There’s something I didn’t tell you. Patient Zero was my son.”',
    ],
    radio: {
      start: ['The Ironworks. Vireo’s lift to Sublevel 9 is under the casting floor. Get the turbines turning first.'],
      power: ['The lift is sealed. You’ll have to blow it: find a detonator, a demolition charge and a timer.'],
      part: ['That’s one. Keep going.', 'Careful with that.'],
      parts: ['That’s the lot. Build the charge at the workbench. Carefully.'],
      built: ['Charge is set. Wait — the furnace doors are opening. That isn’t the charge.'],
      boss: ['The Furnace Man. Fire won’t hurt him. Everything else might.'],
      bossDown: ['The charge blew the lift doors. Get in the lift. Go!'],
    },
  },
  labs: {
    map: 'labs',
    number: 4,
    title: 'PATIENT ZERO',
    blurb: 'Where Compound L was made, and where the first patient is still waiting.',
    briefing: [
      'Sublevel 9. Compound L was made here, and first tested here — on Daniel Voss, nineteen and dying, whose father thought he could save him. Everything upstairs came from Daniel’s blood.',
      'Get the reactor online, gather the purge components and build the purge. It will flood the level with the counter-agent. It will also bring Daniel to you.',
    ],
    device: 'PURGE CANISTER',
    parts: ['COUNTER-AGENT', 'PRESSURE VALVE', 'ACCESS KEYCARD'],
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
      power: ['Now the purge: counter-agent, a pressure valve, and a keycard for the dispersal system.'],
      part: ['That’s one.', 'Keep going. He knows you’re here.'],
      parts: ['Build the purge at the workbench. When it goes off, he’ll come. He’ll feel it.'],
      built: ['The purge is primed. He’s awake. Daniel… I’m so sorry.'],
      boss: ['That’s Patient Zero. That’s my son. End it.'],
      bossDown: ['It’s over. The purge is spreading. Get to the surface lift!'],
    },
  },
};
