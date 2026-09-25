/**
 * THE ARENA - "St. Mercy Asylum"
 *
 * The level is a tile grid generated deterministically from rectangles so the
 * geometry, the navigation grid and the gameplay triggers can never drift apart.
 * Rooms are joined in a ring, which is what makes zombie-training possible.
 */

export const TILE = 4; // world units per tile
export const MAP_W = 48;
export const MAP_H = 40;
export const WALL_H = 9;

export const T_VOID = 0;
export const T_FLOOR = 1;
export const T_WALL = 2;
export const T_DOOR = 3;
export const T_BARRICADE = 4;

export type Rect = { x: number; z: number; w: number; h: number };

export type ZoneId = 'lobby' | 'furnace' | 'chapel' | 'armory' | 'catacombs' | 'power';

export type ZoneDef = {
  id: ZoneId;
  name: string;
  rect: Rect;
  /** Wall tint and light colour, fed to the renderer for per-room mood. */
  tint: number;
  lightColor: number;
};

export type DoorDef = {
  id: string;
  cost: number;
  /** Tiles the door body occupies (all solid while locked). */
  rect: Rect;
  /** Which way the leaf spans: 'x' is left-right, 'z' is front-back. */
  axis: 'x' | 'z';
  /** The two zones this door joins, used for spawn activation. */
  connects: [ZoneId, ZoneId];
  label: string;
};

export type BarricadeDef = {
  id: string;
  zone: ZoneId;
  /** The wall tile that gets torn open. */
  tx: number;
  tz: number;
  /** Direction the zombies come from, in tile offsets. */
  dx: number;
  dz: number;
};

export type WallBuyDef = {
  weapon: string;
  zone: ZoneId;
  /** Floor tile the player stands on; the panel hangs on the wall behind it. */
  tx: number;
  tz: number;
  /** Yaw of the panel normal: direction = (sin(facing), cos(facing)), pointing into the room. */
  facing: number;
};

export type PerkDef = {
  perk: string;
  zone: ZoneId;
  tx: number;
  tz: number;
  facing: number;
};

export const ZONES: ZoneDef[] = [
  { id: 'lobby', name: 'ADMISSIONS', rect: { x: 18, z: 25, w: 12, h: 12 }, tint: 0x6a6252, lightColor: 0xffd9a0 },
  { id: 'furnace', name: 'FURNACE HALL', rect: { x: 3, z: 22, w: 12, h: 14 }, tint: 0x7a4a34, lightColor: 0xff7a3c },
  { id: 'chapel', name: 'CHAPEL', rect: { x: 18, z: 7, w: 13, h: 13 }, tint: 0x5c6478, lightColor: 0xaecbff },
  { id: 'armory', name: 'ARMORY', rect: { x: 34, z: 21, w: 11, h: 14 }, tint: 0x5f6350, lightColor: 0xcfe08a },
  { id: 'catacombs', name: 'CATACOMBS', rect: { x: 3, z: 4, w: 11, h: 13 }, tint: 0x4a4658, lightColor: 0x9a86ff },
  { id: 'power', name: 'GENERATOR', rect: { x: 34, z: 4, w: 11, h: 12 }, tint: 0x5a5a5a, lightColor: 0x7affd0 },
];

/** Corridors are carved after rooms; each one is a plain floor rectangle. */
export const CORRIDORS: Rect[] = [
  { x: 14, z: 29, w: 5, h: 3 }, // lobby     <-> furnace
  { x: 22, z: 19, w: 3, h: 7 }, // lobby     <-> chapel
  { x: 29, z: 27, w: 6, h: 3 }, // lobby     <-> armory
  { x: 13, z: 11, w: 6, h: 3 }, // chapel    <-> catacombs
  { x: 30, z: 9, w: 5, h: 3 }, //  chapel    <-> power
  { x: 7, z: 16, w: 3, h: 7 }, //  catacombs <-> furnace
  { x: 38, z: 15, w: 3, h: 7 }, // power     <-> armory
];

export const DOORS: DoorDef[] = [
  {
    id: 'd_furnace', cost: 750, rect: { x: 15, z: 29, w: 1, h: 3 }, axis: 'z',
    connects: ['lobby', 'furnace'], label: 'FURNACE HALL',
  },
  {
    id: 'd_chapel', cost: 1000, rect: { x: 22, z: 23, w: 3, h: 1 }, axis: 'x',
    connects: ['lobby', 'chapel'], label: 'CHAPEL STAIRS',
  },
  {
    id: 'd_armory', cost: 1250, rect: { x: 32, z: 27, w: 1, h: 3 }, axis: 'z',
    connects: ['lobby', 'armory'], label: 'ARMORY',
  },
  {
    id: 'd_catacombs', cost: 1000, rect: { x: 16, z: 11, w: 1, h: 3 }, axis: 'z',
    connects: ['chapel', 'catacombs'], label: 'CATACOMBS',
  },
  {
    id: 'd_power', cost: 1500, rect: { x: 32, z: 9, w: 1, h: 3 }, axis: 'z',
    connects: ['chapel', 'power'], label: 'GENERATOR ROOM',
  },
  {
    id: 'd_cata_furnace', cost: 1250, rect: { x: 7, z: 19, w: 3, h: 1 }, axis: 'x',
    connects: ['catacombs', 'furnace'], label: 'ASH TUNNEL',
  },
  {
    id: 'd_power_armory', cost: 1500, rect: { x: 38, z: 18, w: 3, h: 1 }, axis: 'x',
    connects: ['power', 'armory'], label: 'SERVICE LIFT',
  },
];

export const BARRICADES: BarricadeDef[] = [
  { id: 'b_lobby_s1', zone: 'lobby', tx: 21, tz: 37, dx: 0, dz: 1 },
  { id: 'b_lobby_s2', zone: 'lobby', tx: 27, tz: 37, dx: 0, dz: 1 },
  { id: 'b_lobby_e', zone: 'lobby', tx: 30, tz: 34, dx: 1, dz: 0 },
  { id: 'b_lobby_w', zone: 'lobby', tx: 17, tz: 26, dx: -1, dz: 0 },

  { id: 'b_furnace_w1', zone: 'furnace', tx: 2, tz: 26, dx: -1, dz: 0 },
  { id: 'b_furnace_w2', zone: 'furnace', tx: 2, tz: 32, dx: -1, dz: 0 },
  { id: 'b_furnace_s', zone: 'furnace', tx: 9, tz: 36, dx: 0, dz: 1 },

  { id: 'b_chapel_n1', zone: 'chapel', tx: 21, tz: 6, dx: 0, dz: -1 },
  { id: 'b_chapel_n2', zone: 'chapel', tx: 27, tz: 6, dx: 0, dz: -1 },
  { id: 'b_chapel_e', zone: 'chapel', tx: 31, tz: 16, dx: 1, dz: 0 },
  { id: 'b_chapel_w', zone: 'chapel', tx: 17, tz: 16, dx: -1, dz: 0 },

  { id: 'b_armory_e1', zone: 'armory', tx: 45, tz: 25, dx: 1, dz: 0 },
  { id: 'b_armory_e2', zone: 'armory', tx: 45, tz: 31, dx: 1, dz: 0 },
  { id: 'b_armory_s', zone: 'armory', tx: 39, tz: 35, dx: 0, dz: 1 },

  { id: 'b_cata_w', zone: 'catacombs', tx: 2, tz: 9, dx: -1, dz: 0 },
  { id: 'b_cata_n', zone: 'catacombs', tx: 8, tz: 3, dx: 0, dz: -1 },

  { id: 'b_power_n', zone: 'power', tx: 39, tz: 3, dx: 0, dz: -1 },
  { id: 'b_power_e', zone: 'power', tx: 45, tz: 10, dx: 1, dz: 0 },
];

export const WALL_BUYS: WallBuyDef[] = [
  { weapon: 'boomstick', zone: 'lobby', tx: 18, tz: 34, facing: Math.PI / 2 },
  { weapon: 'trench', zone: 'lobby', tx: 29, tz: 30, facing: -Math.PI / 2 },
  { weapon: 'grease', zone: 'furnace', tx: 3, tz: 29, facing: Math.PI / 2 },
  { weapon: 'nailrifle', zone: 'chapel', tx: 18, tz: 8, facing: Math.PI / 2 },
  { weapon: 'longshot', zone: 'catacombs', tx: 13, tz: 8, facing: -Math.PI / 2 },
  { weapon: 'scattergun', zone: 'armory', tx: 44, tz: 28, facing: -Math.PI / 2 },
  { weapon: 'frag', zone: 'chapel', tx: 30, tz: 18, facing: -Math.PI / 2 },
  { weapon: 'trench', zone: 'power', tx: 34, tz: 12, facing: Math.PI / 2 },
];

export const PERKS: PerkDef[] = [
  { perk: 'revive', zone: 'lobby', tx: 20, tz: 26, facing: Math.PI },
  { perk: 'juggernog', zone: 'furnace', tx: 12, tz: 24, facing: Math.PI },
  { perk: 'speedcola', zone: 'chapel', tx: 28, tz: 9, facing: Math.PI },
  { perk: 'doubletap', zone: 'armory', tx: 36, tz: 23, facing: Math.PI },
  { perk: 'staminup', zone: 'catacombs', tx: 5, tz: 15, facing: 0 },
];

/** The mystery box hops between these pads when a teddy bear ends a roll. */
export const BOX_PADS: { zone: ZoneId; tx: number; tz: number }[] = [
  { zone: 'lobby', tx: 24, tz: 34 },
  { zone: 'furnace', tx: 7, tz: 32 },
  { zone: 'chapel', tx: 24, tz: 13 },
  { zone: 'armory', tx: 41, tz: 31 },
  { zone: 'catacombs', tx: 9, tz: 13 },
];

/** Flipping the power switch enables the perk machines and the service lift. */
export const POWER_SWITCH = { zone: 'power' as ZoneId, tx: 44, tz: 7, facing: -Math.PI / 2 };

export const PLAYER_SPAWN = { tx: 24, tz: 31 };

function fill(map: Uint8Array, r: Rect, value: number): void {
  for (let z = r.z; z < r.z + r.h; z++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (x < 0 || z < 0 || x >= MAP_W || z >= MAP_H) continue;
      map[z * MAP_W + x] = value;
    }
  }
}

/**
 * Builds the static tile map. Doors and barricades start solid; the running game
 * flips them to floor when they are bought or torn down.
 */
export function buildTileMap(): Uint8Array {
  const map = new Uint8Array(MAP_W * MAP_H).fill(T_VOID);

  for (const zone of ZONES) fill(map, zone.rect, T_FLOOR);
  for (const c of CORRIDORS) fill(map, c, T_FLOOR);

  // Wrap every floor tile in wall so the shell can never have a hole in it.
  for (let z = 0; z < MAP_H; z++) {
    for (let x = 0; x < MAP_W; x++) {
      if (map[z * MAP_W + x] !== T_VOID) continue;
      let touchesFloor = false;
      for (let dz = -1; dz <= 1 && !touchesFloor; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= MAP_W || nz >= MAP_H) continue;
          if (map[nz * MAP_W + nx] === T_FLOOR) {
            touchesFloor = true;
            break;
          }
        }
      }
      if (touchesFloor) map[z * MAP_W + x] = T_WALL;
    }
  }

  for (const d of DOORS) fill(map, d.rect, T_DOOR);
  for (const b of BARRICADES) map[b.tz * MAP_W + b.tx] = T_BARRICADE;

  return map;
}

export function tileAt(map: Uint8Array, tx: number, tz: number): number {
  if (tx < 0 || tz < 0 || tx >= MAP_W || tz >= MAP_H) return T_VOID;
  return map[tz * MAP_W + tx];
}

/** World-space centre of a tile. */
export function tileCenter(tx: number, tz: number): { x: number; z: number } {
  return { x: (tx + 0.5) * TILE, z: (tz + 0.5) * TILE };
}

export function worldToTile(x: number, z: number): { tx: number; tz: number } {
  return { tx: Math.floor(x / TILE), tz: Math.floor(z / TILE) };
}

export function zoneAt(tx: number, tz: number): ZoneId | null {
  for (const zone of ZONES) {
    const r = zone.rect;
    if (tx >= r.x && tx < r.x + r.w && tz >= r.z && tz < r.z + r.h) return zone.id;
  }
  return null;
}

export function getZone(id: ZoneId): ZoneDef {
  const z = ZONES.find((v) => v.id === id);
  if (!z) throw new Error(`unknown zone ${id}`);
  return z;
}

/** Debug helper: renders the tile map as ASCII. Used by the test suite. */
export function mapToAscii(map: Uint8Array): string {
  const glyphs = [' ', '.', '#', 'D', 'B'];
  const rows: string[] = [];
  for (let z = 0; z < MAP_H; z++) {
    let line = '';
    for (let x = 0; x < MAP_W; x++) line += glyphs[map[z * MAP_W + x]] ?? '?';
    rows.push(line);
  }
  return rows.join('\n');
}
