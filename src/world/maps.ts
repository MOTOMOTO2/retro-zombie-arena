/**
 * The four maps. Each is a generation profile: every run on a map builds a new
 * layout from a fresh seed, but the footprint, the openness and the kinds of
 * room come from here.
 */

import type { MapId, MapProfile } from './mapdata.ts';

/** The order maps unlock in: finish one to open the next. */
export const MAP_ORDER: MapId[] = ['asylum', 'town', 'foundry', 'labs'];

export const MAPS: Record<MapId, MapProfile> = {
  asylum: {
    id: 'asylum',
    name: 'ST. MERCY ASYLUM',
    size: [82, 76],
    shapes: [[4, 3], [3, 4], [4, 3]],
    drops: [0, 2],
    room: [9, 18],
    merges: [0, 1],
    corridorWidth: [3, 4],
    archwayChance: 0.25,
    loopChance: 0.5,
    startThemes: ['admissions', 'ward', 'records'],
    powerTheme: 'generator',
    themes: ['furnace', 'chapel', 'armory', 'catacombs', 'morgue', 'ward', 'records', 'admissions'],
    corridorLook: 'corridor',
    windows: [2, 4],
    boxes: 1,
  },
  town: {
    id: 'town',
    name: 'HOLLOW CREEK',
    size: [94, 94],
    shapes: [[4, 4], [4, 3], [3, 4]],
    drops: [1, 3],
    room: [12, 20],
    merges: [1, 2],
    corridorWidth: [4, 6],
    archwayChance: 0.45,
    loopChance: 0.6,
    startThemes: ['street'],
    powerTheme: 'generator',
    themes: ['square', 'house', 'store', 'chapel', 'garage', 'cemetery', 'street', 'house'],
    corridorLook: 'alley',
    names: {
      generator: ['SUBSTATION', 'POWER PLANT'],
      chapel: ["ST. JUDE'S CHURCH", 'CHAPEL OF REST'],
    },
    windows: [2, 5],
    boxes: 2,
  },
  foundry: {
    id: 'foundry',
    name: 'VIREO IRONWORKS',
    size: [94, 90],
    shapes: [[4, 3], [3, 3], [4, 4]],
    drops: [0, 2],
    room: [13, 22],
    merges: [1, 3],
    corridorWidth: [4, 6],
    archwayChance: 0.4,
    loopChance: 0.6,
    startThemes: ['loading'],
    powerTheme: 'generator',
    themes: ['foundry', 'warehouse', 'yard', 'furnace', 'armory', 'records', 'foundry', 'warehouse'],
    corridorLook: 'service',
    names: {
      generator: ['TURBINE HALL', 'BOILER HOUSE'],
      records: ["FOREMAN'S OFFICE", 'TIME OFFICE'],
      armory: ['SECURITY', 'GATEHOUSE'],
    },
    windows: [2, 5],
    boxes: 2,
  },
  labs: {
    id: 'labs',
    name: 'VIREO LABS: SUBLEVEL 9',
    size: [90, 90],
    shapes: [[4, 4], [4, 3]],
    drops: [1, 3],
    room: [10, 18],
    merges: [0, 2],
    corridorWidth: [3, 5],
    archwayChance: 0.3,
    loopChance: 0.55,
    startThemes: ['lab'],
    powerTheme: 'reactor',
    themes: ['containment', 'servers', 'cryo', 'morgue', 'ward', 'lab', 'armory', 'containment'],
    corridorLook: 'labhall',
    names: {
      ward: ['MEDICAL BAY', 'SICK BAY'],
      morgue: ['DISSECTION', 'PATHOLOGY'],
      armory: ['SECURITY STATION', 'BLAST DOOR'],
    },
    windows: [2, 4],
    boxes: 2,
  },
};
