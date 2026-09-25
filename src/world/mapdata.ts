/**
 * THE ARENA - "St. Mercy Asylum", rebuilt from scratch every run.
 *
 * A layout is generated from a seed. Rooms are dropped into a coarse grid of
 * cells and joined to their neighbours by short corridors: a random spanning
 * tree plus extra links, so there is always at least one loop to train a horde
 * around. Then the rooms are themed and dressed with windows, wall guns, perk
 * machines, box pads, the power switch and Pack-a-Punch.
 *
 * The tile grid is still the single source of truth, so the geometry, the
 * navigation grid and the gameplay triggers can never drift apart - and every
 * layout is checked against the same rules the old hand-built map had to pass
 * before it is handed to the game. A seed that fails is simply re-rolled.
 */

import { Rng } from '../core/rng.ts';

export const TILE = 4; // world units per tile
export const MAP_W = 56;
export const MAP_H = 52;
export const WALL_H = 9;

export const T_VOID = 0;
export const T_FLOOR = 1;
export const T_WALL = 2;
export const T_DOOR = 3;
export const T_BARRICADE = 4;

/** Tiles of empty space kept around the whole asylum, so outer windows have room outside. */
const MARGIN = 4;

export type Rect = { x: number; z: number; w: number; h: number };

export type ThemeId =
  | 'admissions'
  | 'ward'
  | 'records'
  | 'furnace'
  | 'chapel'
  | 'armory'
  | 'catacombs'
  | 'morgue'
  | 'generator';

export type ZoneId = string;

export type ZoneDef = {
  id: ZoneId;
  theme: ThemeId;
  name: string;
  rect: Rect;
  /** Solid 1x1 columns inside the room. */
  pillars: { tx: number; tz: number }[];
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

/**
 * Anything that stands against a wall. `facing` is the yaw of the direction
 * pointing into the room: (sin(facing), cos(facing)). The wall is behind it.
 */
export type WallProp = { zone: ZoneId; tx: number; tz: number; facing: number };

export type WallBuyDef = WallProp & { weapon: string };
export type PerkDef = WallProp & { perk: string };

export type Layout = {
  seed: number;
  zones: ZoneDef[];
  corridors: Rect[];
  doors: DoorDef[];
  /** Zone pairs joined by an open archway rather than a door. */
  openLinks: [ZoneId, ZoneId][];
  barricades: BarricadeDef[];
  wallBuys: WallBuyDef[];
  perks: PerkDef[];
  /** The mystery box hops between these; index 0 is where it starts. */
  boxPads: WallProp[];
  powerSwitch: WallProp;
  pack: WallProp;
  spawn: { tx: number; tz: number; yaw: number };
  spawnZone: ZoneId;
  powerZone: ZoneId;
  /** The static tile map. Doors and barricades start solid. */
  tiles: Uint8Array;
  /** Per-tile index into `zones`, or -1 for corridors and solid space. */
  zoneIndex: Int16Array;
  /** Floor tiles gameplay props stand on or in front of; set dressing avoids them. */
  reserved: Set<number>;
};

const THEME_NAMES: Record<ThemeId, string[]> = {
  admissions: ['ADMISSIONS', 'RECEPTION', 'FRONT HALL'],
  ward: ['EAST WARD', 'WEST WARD', 'ISOLATION WARD', 'NIGHT WARD'],
  records: ['RECORDS', 'ARCHIVE', "DIRECTOR'S OFFICE"],
  furnace: ['FURNACE HALL', 'BOILER ROOM', 'ASH PIT'],
  chapel: ['CHAPEL', 'SANCTUARY', 'VESTRY'],
  armory: ['ARMORY', 'SECURITY WING', 'GUARD POST'],
  catacombs: ['CATACOMBS', 'OSSUARY', 'CRYPT'],
  morgue: ['MORGUE', 'AUTOPSY', 'COLD STORAGE'],
  generator: ['GENERATOR ROOM', 'POWER STATION', 'DYNAMO HALL'],
};

/** Rooms the run can begin in: somewhere that looks like a way in. */
const START_THEMES: ThemeId[] = ['admissions', 'ward', 'records'];
const OTHER_THEMES: ThemeId[] = [
  'furnace', 'chapel', 'armory', 'catacombs', 'morgue', 'ward', 'records', 'admissions',
];
/** Themes that suit freestanding columns. */
const PILLAR_THEMES = new Set<ThemeId>(['chapel', 'catacombs', 'generator', 'morgue', 'ward', 'furnace']);

/** The starting room always sells these two. */
const START_GUNS = ['boomstick'];
const START_SECOND = ['trench', 'grease'];
/** Spread over the rest of the asylum, one per room while they last. */
const OTHER_GUNS = ['nailrifle', 'longshot', 'scattergun', 'frag'];
const OTHER_PERKS = ['juggernog', 'speedcola', 'doubletap', 'staminup'];

/* ------------------------------------------------------------- helpers */

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

export function zoneAt(layout: Layout, tx: number, tz: number): ZoneId | null {
  if (tx < 0 || tz < 0 || tx >= MAP_W || tz >= MAP_H) return null;
  const i = layout.zoneIndex[tz * MAP_W + tx];
  return i >= 0 ? layout.zones[i].id : null;
}

export function getZone(layout: Layout, id: ZoneId): ZoneDef {
  const z = layout.zones.find((v) => v.id === id);
  if (!z) throw new Error(`unknown zone ${id}`);
  return z;
}

/** Unit vector pointing into the room for a wall prop. */
export function facingNormal(facing: number): { nx: number; nz: number } {
  return { nx: Math.round(Math.sin(facing)), nz: Math.round(Math.cos(facing)) };
}

function facingFor(nx: number, nz: number): number {
  return Math.atan2(nx, nz);
}

function fill(map: Uint8Array, r: Rect, value: number): void {
  for (let z = r.z; z < r.z + r.h; z++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (x < 0 || z < 0 || x >= MAP_W || z >= MAP_H) continue;
      map[z * MAP_W + x] = value;
    }
  }
}

/** Every void tile that touches floor (8-way) becomes wall, so the shell never has a hole. */
function wrapWalls(map: Uint8Array): void {
  for (let z = 0; z < MAP_H; z++) {
    for (let x = 0; x < MAP_W; x++) {
      if (map[z * MAP_W + x] !== T_VOID) continue;
      let touchesFloor = false;
      for (let dz = -1; dz <= 1 && !touchesFloor; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (tileAt(map, x + dx, z + dz) === T_FLOOR) {
            touchesFloor = true;
            break;
          }
        }
      }
      if (touchesFloor) map[z * MAP_W + x] = T_WALL;
    }
  }
}

/** Flood fill over walkable floor. Doors and barricades count as solid. */
export function floodFloor(map: Uint8Array, startTx: number, startTz: number): Set<number> {
  const seen = new Set<number>();
  if (tileAt(map, startTx, startTz) !== T_FLOOR) return seen;
  const stack = [startTz * MAP_W + startTx];
  seen.add(stack[0]);
  while (stack.length) {
    const cur = stack.pop() as number;
    const cx = cur % MAP_W;
    const cz = (cur / MAP_W) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (tileAt(map, nx, nz) !== T_FLOOR) continue;
      const ni = nz * MAP_W + nx;
      if (seen.has(ni)) continue;
      seen.add(ni);
      stack.push(ni);
    }
  }
  return seen;
}

/* ----------------------------------------------------------- generation */

type Cell = { col: number; row: number; x0: number; z0: number; x1: number; z1: number };
type Edge = { a: number; b: number; horizontal: boolean };

/** Picks a span [lo, lo+len) that covers [coreLo, coreHi) and stays inside [min, max). */
function span(
  rng: Rng, min: number, max: number, coreLo: number, coreHi: number, minLen: number, maxLen: number,
): [number, number] {
  const hiLen = Math.min(maxLen, max - min);
  const loLen = Math.max(minLen, coreHi - coreLo);
  const len = loLen + rng.int(Math.max(1, hiLen - loLen + 1));
  const loStart = Math.max(min, coreHi - len);
  const hiStart = Math.min(coreLo, max - len);
  const start = loStart + rng.int(Math.max(1, hiStart - loStart + 1));
  return [start, len];
}

function shuffle<T>(rng: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function connectedCells(present: boolean[], cols: number, rows: number): boolean {
  const start = present.indexOf(true);
  if (start < 0) return false;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const c = stack.pop() as number;
    const col = c % cols;
    const row = (c / cols) | 0;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const n = nr * cols + nc;
      if (!present[n] || seen.has(n)) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return seen.size === present.filter(Boolean).length;
}

/** Floor tiles along a room's inside edge that have plain wall directly behind them. */
function wallSlots(map: Uint8Array, zone: ZoneDef): { tx: number; tz: number; nx: number; nz: number }[] {
  const r = zone.rect;
  const out: { tx: number; tz: number; nx: number; nz: number }[] = [];
  const consider = (tx: number, tz: number, nx: number, nz: number): void => {
    if (tileAt(map, tx, tz) !== T_FLOOR) return;
    if (tileAt(map, tx - nx, tz - nz) !== T_WALL) return;
    // Keep clear of corridor mouths and other openings on either side.
    const lx = Math.abs(nz);
    const lz = Math.abs(nx);
    for (const s of [-1, 1]) {
      if (tileAt(map, tx - nx + lx * s, tz - nz + lz * s) !== T_WALL) return;
    }
    out.push({ tx, tz, nx, nz });
  };
  // Corners are skipped: a prop there would sit awkwardly across two walls.
  for (let tz = r.z + 1; tz < r.z + r.h - 1; tz++) {
    consider(r.x, tz, 1, 0);
    consider(r.x + r.w - 1, tz, -1, 0);
  }
  for (let tx = r.x + 1; tx < r.x + r.w - 1; tx++) {
    consider(tx, r.z, 0, 1);
    consider(tx, r.z + r.h - 1, 0, -1);
  }
  return out;
}

/** True when the three tiles outside a window (and either side of them) are empty space. */
function clearOutside(map: Uint8Array, wx: number, wz: number, dx: number, dz: number): boolean {
  const lx = Math.abs(dz);
  const lz = Math.abs(dx);
  for (let step = 1; step <= 3; step++) {
    for (let lat = -1; lat <= 1; lat++) {
      const x = wx + dx * step + lx * lat;
      const z = wz + dz * step + lz * lat;
      if (x < 0 || z < 0 || x >= MAP_W || z >= MAP_H) return false;
      if (map[z * MAP_W + x] !== T_VOID) return false;
    }
  }
  return true;
}

function tryGenerate(seed: number, rng: Rng): Layout | null {
  /* -- 1. the cell grid ------------------------------------------------ */
  const [cols, rows] = rng.pick([[3, 2], [2, 3], [3, 3], [3, 3]] as [number, number][]);
  const present = new Array<boolean>(cols * rows).fill(true);
  if (cols * rows === 9) {
    // Knock out one or two cells. Losing the middle one leaves a ring of rooms
    // around an empty courtyard, which is the best training loop there is.
    const drops = 1 + rng.int(2);
    for (let tries = 0, dropped = 0; dropped < drops && tries < 30; tries++) {
      const c = rng.int(9);
      if (!present[c]) continue;
      present[c] = false;
      if (connectedCells(present, cols, rows)) dropped++;
      else present[c] = true;
    }
  }

  const usableW = MAP_W - MARGIN * 2;
  const usableH = MAP_H - MARGIN * 2;
  const cells: (Cell | null)[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (!present[i]) {
        cells.push(null);
        continue;
      }
      cells.push({
        col,
        row,
        x0: MARGIN + Math.round((col * usableW) / cols),
        x1: MARGIN + Math.round(((col + 1) * usableW) / cols),
        z0: MARGIN + Math.round((row * usableH) / rows),
        z1: MARGIN + Math.round(((row + 1) * usableH) / rows),
      });
    }
  }

  /* -- 2. rooms: each one covers its cell's core so neighbours line up -- */
  const rooms = new Map<number, Rect>();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (!c) continue;
    const coreX = Math.floor((c.x0 + c.x1) / 2) - 2;
    const coreZ = Math.floor((c.z0 + c.z1) / 2) - 2;
    const [x, w] = span(rng, c.x0 + 1, c.x1 - 1, coreX, coreX + 5, 8, 15);
    const [z, h] = span(rng, c.z0 + 1, c.z1 - 1, coreZ, coreZ + 5, 8, 15);
    rooms.set(i, { x, z, w, h });
  }

  /* -- 3. the graph: spanning tree + extra links for loops ------------- */
  const edges: Edge[] = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (!c) continue;
    if (c.col + 1 < cols && cells[i + 1]) edges.push({ a: i, b: i + 1, horizontal: true });
    if (c.row + 1 < rows && cells[i + cols]) edges.push({ a: i, b: i + cols, horizontal: false });
  }
  shuffle(rng, edges);
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x) as number;
    return x;
  };
  const chosen: Edge[] = [];
  const spare: Edge[] = [];
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) {
      parent.set(ra, rb);
      chosen.push(e);
    } else {
      spare.push(e);
    }
  }
  if (!spare.length) return null;
  // At least one loop, usually two or three.
  chosen.push(spare[0]);
  for (let i = 1; i < spare.length; i++) if (rng.chance(0.55)) chosen.push(spare[i]);

  const roomIds = [...rooms.keys()];
  const adj = new Map<number, number[]>(roomIds.map((id) => [id, []]));
  for (const e of chosen) {
    (adj.get(e.a) as number[]).push(e.b);
    (adj.get(e.b) as number[]).push(e.a);
  }
  const depthFrom = (start: number): Map<number, number> => {
    const d = new Map([[start, 0]]);
    const q = [start];
    while (q.length) {
      const cur = q.shift() as number;
      for (const n of adj.get(cur) as number[]) {
        if (d.has(n)) continue;
        d.set(n, (d.get(cur) as number) + 1);
        q.push(n);
      }
    }
    return d;
  };

  /* -- 4. start and power rooms, then themes ----------------------------- */
  const startCandidates = roomIds.filter((id) => (adj.get(id) as number[]).length >= 2);
  if (!startCandidates.length) return null;
  const startCell = startCandidates[rng.weighted(startCandidates.map((id) => (adj.get(id) as number[]).length ** 2))];
  const depth = depthFrom(startCell);
  const maxDepth = Math.max(...depth.values());
  const farthest = roomIds.filter((id) => depth.get(id) === maxDepth);
  const powerCell = rng.pick(farthest);

  const themes = new Map<number, ThemeId>();
  themes.set(startCell, rng.pick(START_THEMES));
  themes.set(powerCell, 'generator');
  const pool = shuffle(rng, OTHER_THEMES.filter((t) => t !== themes.get(startCell)));
  for (const id of roomIds) {
    if (themes.has(id)) continue;
    themes.set(id, pool.length ? (pool.shift() as ThemeId) : rng.pick(OTHER_THEMES));
  }

  const usedNames = new Set<string>();
  const zones: ZoneDef[] = [];
  const zoneOfCell = new Map<number, ZoneDef>();
  for (const id of roomIds) {
    const theme = themes.get(id) as ThemeId;
    const names = THEME_NAMES[theme].filter((n) => !usedNames.has(n));
    const name = names.length ? rng.pick(names) : `${THEME_NAMES[theme][0]} ${zones.length + 1}`;
    usedNames.add(name);
    const zone: ZoneDef = { id: `z${id}`, theme, name, rect: rooms.get(id) as Rect, pillars: [] };
    zones.push(zone);
    zoneOfCell.set(id, zone);
  }

  /* -- 5. corridors and doors -------------------------------------------- */
  const corridors: Rect[] = [];
  const doorDefs: DoorDef[] = [];
  const openLinks: [ZoneId, ZoneId][] = [];
  for (const e of chosen) {
    const A = rooms.get(e.a) as Rect;
    const B = rooms.get(e.b) as Rect;
    const za = zoneOfCell.get(e.a) as ZoneDef;
    const zb = zoneOfCell.get(e.b) as ZoneDef;
    let rect: Rect;
    let door: Rect;
    if (e.horizontal) {
      const lo = Math.max(A.z, B.z) + 1;
      const hi = Math.min(A.z + A.h, B.z + B.h) - 4;
      if (hi < lo) return null;
      const cz = lo + rng.int(hi - lo + 1);
      rect = { x: A.x + A.w, z: cz, w: B.x - (A.x + A.w), h: 3 };
      door = { x: rect.x + rng.int(rect.w), z: cz, w: 1, h: 3 };
    } else {
      const lo = Math.max(A.x, B.x) + 1;
      const hi = Math.min(A.x + A.w, B.x + B.w) - 4;
      if (hi < lo) return null;
      const cx = lo + rng.int(hi - lo + 1);
      rect = { x: cx, z: A.z + A.h, w: 3, h: B.z - (A.z + A.h) };
      door = { x: cx, z: rect.z + rng.int(rect.h), w: 3, h: 1 };
    }
    if (rect.w < 1 || rect.h < 1) return null;
    corridors.push(rect);

    const touchesStart = e.a === startCell || e.b === startCell;
    if (!touchesStart && rng.chance(0.2)) {
      openLinks.push([za.id, zb.id]);
      continue;
    }
    const far = (depth.get(e.a) as number) >= (depth.get(e.b) as number) ? za : zb;
    const d = Math.max(depth.get(e.a) as number, depth.get(e.b) as number);
    const cost = Math.min(1500, 500 + 250 * (d + rng.int(2)));
    doorDefs.push({
      id: `d${doorDefs.length}`,
      cost,
      rect: door,
      axis: e.horizontal ? 'z' : 'x',
      connects: [za.id, zb.id],
      label: far.name,
    });
  }

  /* -- 6. pillars -------------------------------------------------------- */
  for (const zone of zones) {
    const r = zone.rect;
    if (!PILLAR_THEMES.has(zone.theme) || r.w < 11 || r.h < 11 || !rng.chance(0.65)) continue;
    const style = rng.int(3);
    if (style === 0) {
      for (const [px, pz] of [[r.x + 3, r.z + 3], [r.x + r.w - 4, r.z + 3], [r.x + 3, r.z + r.h - 4], [r.x + r.w - 4, r.z + r.h - 4]]) {
        zone.pillars.push({ tx: px, tz: pz });
      }
    } else if (style === 1 && r.w >= 12 && r.h >= 12) {
      const cx = r.x + (r.w >> 1) - 1;
      const cz = r.z + (r.h >> 1) - 1;
      for (const [px, pz] of [[cx, cz], [cx + 1, cz], [cx, cz + 1], [cx + 1, cz + 1]]) zone.pillars.push({ tx: px, tz: pz });
    } else {
      const along = r.w >= r.h;
      const n = 3;
      for (let i = 0; i < n; i++) {
        const t = (i + 1) / (n + 1);
        zone.pillars.push(along
          ? { tx: r.x + Math.round(t * (r.w - 1)), tz: r.z + (r.h >> 1) }
          : { tx: r.x + (r.w >> 1), tz: r.z + Math.round(t * (r.h - 1)) });
      }
    }
  }

  /* -- 7. the tile map ----------------------------------------------------- */
  const tiles = new Uint8Array(MAP_W * MAP_H).fill(T_VOID);
  for (const zone of zones) fill(tiles, zone.rect, T_FLOOR);
  for (const c of corridors) fill(tiles, c, T_FLOOR);
  wrapWalls(tiles);
  for (const zone of zones) for (const p of zone.pillars) tiles[p.tz * MAP_W + p.tx] = T_WALL;
  for (const d of doorDefs) fill(tiles, d.rect, T_DOOR);

  const zoneIndex = new Int16Array(MAP_W * MAP_H).fill(-1);
  zones.forEach((zone, i) => {
    const r = zone.rect;
    for (let z = r.z; z < r.z + r.h; z++) for (let x = r.x; x < r.x + r.w; x++) zoneIndex[z * MAP_W + x] = i;
  });

  /* -- 8. windows ----------------------------------------------------------- */
  const startZone = zoneOfCell.get(startCell) as ZoneDef;
  const powerZone = zoneOfCell.get(powerCell) as ZoneDef;
  const barricades: BarricadeDef[] = [];
  for (const zone of zones) {
    const want = zone === startZone ? 3 + rng.int(2) : zone === powerZone ? 2 : 2 + rng.int(2);
    const slots = shuffle(rng, wallSlots(tiles, zone)).filter((s) =>
      clearOutside(tiles, s.tx - s.nx, s.tz - s.nz, -s.nx, -s.nz));
    const picked: { tx: number; tz: number }[] = [];
    for (const s of slots) {
      if (picked.length >= want) break;
      if (picked.some((p) => Math.abs(p.tx - s.tx) + Math.abs(p.tz - s.tz) < 3)) continue;
      picked.push(s);
      const wx = s.tx - s.nx;
      const wz = s.tz - s.nz;
      tiles[wz * MAP_W + wx] = T_BARRICADE;
      barricades.push({ id: `b${barricades.length}`, zone: zone.id, tx: wx, tz: wz, dx: -s.nx, dz: -s.nz });
    }
  }
  if (barricades.filter((b) => b.zone === startZone.id).length < 2) return null;

  /* -- 9. props -------------------------------------------------------------- */
  const reserved = new Set<number>();
  const reserve = (tx: number, tz: number): void => {
    reserved.add(tz * MAP_W + tx);
  };
  // Keep the floor in front of every window clear.
  for (const b of barricades) {
    const ix = b.tx - b.dx;
    const iz = b.tz - b.dz;
    const lx = Math.abs(b.dz);
    const lz = Math.abs(b.dx);
    for (const s of [-1, 0, 1]) {
      reserve(ix + lx * s, iz + lz * s);
      reserve(ix - b.dx + lx * s, iz - b.dz + lz * s);
    }
  }
  for (const d of doorDefs) {
    // And the approach to every door.
    for (let z = d.rect.z - 1; z <= d.rect.z + d.rect.h; z++) {
      for (let x = d.rect.x - 1; x <= d.rect.x + d.rect.w; x++) reserve(x, z);
    }
  }

  const slotsByZone = new Map<ZoneId, { tx: number; tz: number; nx: number; nz: number }[]>();
  for (const zone of zones) slotsByZone.set(zone.id, shuffle(rng, wallSlots(tiles, zone)));

  const takeSlot = (zone: ZoneDef): WallProp | null => {
    const slots = slotsByZone.get(zone.id) as { tx: number; tz: number; nx: number; nz: number }[];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (reserved.has(s.tz * MAP_W + s.tx)) continue;
      slots.splice(i, 1);
      // The prop, its neighbours along the wall, and the tile in front of it.
      const lx = Math.abs(s.nz);
      const lz = Math.abs(s.nx);
      for (const k of [-1, 0, 1]) reserve(s.tx + lx * k, s.tz + lz * k);
      reserve(s.tx + s.nx, s.tz + s.nz);
      return { zone: zone.id, tx: s.tx, tz: s.tz, facing: facingFor(s.nx, s.nz) };
    }
    return null;
  };

  const powerSwitch = takeSlot(powerZone);
  const pack = takeSlot(powerZone);
  if (!powerSwitch || !pack) return null;

  const perks: PerkDef[] = [];
  const revive = takeSlot(startZone);
  if (!revive) return null;
  perks.push({ ...revive, perk: 'revive' });

  const wallBuys: WallBuyDef[] = [];
  for (const weapon of [...START_GUNS, rng.pick(START_SECOND)]) {
    const slot = takeSlot(startZone);
    if (!slot) return null;
    wallBuys.push({ ...slot, weapon });
  }

  const others = shuffle(rng, zones.filter((z) => z !== startZone && z !== powerZone));
  const perkQueue = shuffle(rng, [...OTHER_PERKS]);
  for (let i = 0; perkQueue.length && i < others.length * 2; i++) {
    const slot = takeSlot(others[i % others.length]);
    if (slot) perks.push({ ...slot, perk: perkQueue.shift() as string });
  }
  if (perkQueue.length) return null;

  const second = wallBuys[1].weapon === 'trench' ? 'grease' : 'trench';
  const gunQueue = shuffle(rng, [...OTHER_GUNS, second]);
  const gunRooms = [powerZone, ...others];
  for (let i = 0; gunQueue.length && i < gunRooms.length; i++) {
    const slot = takeSlot(gunRooms[i]);
    if (slot) wallBuys.push({ ...slot, weapon: gunQueue.shift() as string });
  }

  const boxPads: WallProp[] = [];
  for (const zone of [startZone, ...others]) {
    const slot = takeSlot(zone);
    if (slot) boxPads.push(slot);
  }
  if (boxPads.length < 3 || boxPads[0].zone !== startZone.id) return null;

  /* -- 10. where the player wakes up -------------------------------------- */
  const r = startZone.rect;
  const cx = r.x + (r.w >> 1);
  const cz = r.z + (r.h >> 1);
  let spawnTile: { tx: number; tz: number } | null = null;
  for (let rad = 0; rad < 6 && !spawnTile; rad++) {
    for (let dz = -rad; dz <= rad && !spawnTile; dz++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const tx = cx + dx;
        const tz = cz + dz;
        if (tileAt(tiles, tx, tz) !== T_FLOOR || reserved.has(tz * MAP_W + tx)) continue;
        spawnTile = { tx, tz };
        break;
      }
    }
  }
  if (!spawnTile) return null;
  reserve(spawnTile.tx, spawnTile.tz);
  // Face the cheapest way out.
  const firstDoor = doorDefs
    .filter((d) => d.connects.includes(startZone.id))
    .sort((a, b) => a.cost - b.cost)[0];
  let yaw = Math.PI;
  if (firstDoor) {
    const dxw = firstDoor.rect.x + firstDoor.rect.w / 2 - (spawnTile.tx + 0.5);
    const dzw = firstDoor.rect.z + firstDoor.rect.h / 2 - (spawnTile.tz + 0.5);
    yaw = Math.atan2(-dxw, -dzw);
  }

  return {
    seed,
    zones,
    corridors,
    doors: doorDefs,
    openLinks,
    barricades,
    wallBuys,
    perks,
    boxPads,
    powerSwitch,
    pack,
    spawn: { tx: spawnTile.tx, tz: spawnTile.tz, yaw },
    spawnZone: startZone.id,
    powerZone: powerZone.id,
    tiles,
    zoneIndex,
    reserved,
  };
}

/**
 * Checks a layout against every rule the game relies on. Returns a list of
 * problems; an empty list means the layout is playable.
 */
export function validateLayout(L: Layout): string[] {
  const errs: string[] = [];
  const map = L.tiles;
  const at = (x: number, z: number): number => tileAt(map, x, z);

  if (at(L.spawn.tx, L.spawn.tz) !== T_FLOOR) errs.push('player spawn is not floor');
  if (zoneAt(L, L.spawn.tx, L.spawn.tz) !== L.spawnZone) errs.push('player spawn is outside the start room');

  for (const b of L.barricades) {
    if (at(b.tx, b.tz) !== T_BARRICADE) errs.push(`${b.id} is not a barricade tile`);
    if (at(b.tx - b.dx, b.tz - b.dz) !== T_FLOOR) errs.push(`${b.id} does not open into the room`);
    if (at(b.tx + b.dx, b.tz + b.dz) === T_FLOOR) errs.push(`${b.id} opens into another room`);
    if (zoneAt(L, b.tx - b.dx, b.tz - b.dz) !== b.zone) errs.push(`${b.id} is not in its zone`);
  }
  if (L.barricades.filter((b) => b.zone === L.spawnZone).length < 2) errs.push('start room has too few windows');

  const occupied = new Map<number, string>();
  const stand = (what: string, p: WallProp, needWall: boolean): void => {
    if (at(p.tx, p.tz) !== T_FLOOR) errs.push(`${what} is inside geometry`);
    const key = p.tz * MAP_W + p.tx;
    const other = occupied.get(key);
    if (other) errs.push(`${what} shares a tile with ${other}`);
    occupied.set(key, what);
    if (zoneAt(L, p.tx, p.tz) !== p.zone) errs.push(`${what} is not in its zone`);
    if (needWall) {
      const { nx, nz } = facingNormal(p.facing);
      if (Math.abs(nx) + Math.abs(nz) !== 1) errs.push(`${what} has a diagonal facing`);
      if (at(p.tx - nx, p.tz - nz) !== T_WALL) errs.push(`${what} has no wall behind it`);
    }
  };
  for (const w of L.wallBuys) stand(`wall buy ${w.weapon}`, w, true);
  for (const p of L.perks) stand(`perk ${p.perk}`, p, true);
  L.boxPads.forEach((p, i) => stand(`box pad ${i}`, p, true));
  stand('power switch', L.powerSwitch, true);
  stand('pack-a-punch', L.pack, true);

  if (L.powerSwitch.zone !== L.powerZone || L.pack.zone !== L.powerZone) errs.push('power room is missing its machines');
  if (!L.perks.some((p) => p.perk === 'revive' && p.zone === L.spawnZone)) errs.push('no quick revive in the start room');
  if (!L.wallBuys.some((w) => w.weapon === 'boomstick' && w.zone === L.spawnZone)) errs.push('no starter shotgun');
  if (new Set(L.perks.map((p) => p.perk)).size !== 5) errs.push('not every perk was placed');
  if (!L.boxPads.length || L.boxPads[0].zone !== L.spawnZone) errs.push('the box does not start in the start room');

  for (const d of L.doors) {
    for (let z = d.rect.z; z < d.rect.z + d.rect.h; z++) {
      for (let x = d.rect.x; x < d.rect.x + d.rect.w; x++) {
        if (at(x, z) !== T_DOOR) errs.push(`${d.id} is not a door tile`);
      }
    }
    const nx = d.axis === 'z' ? 1 : 0;
    const nz = d.axis === 'z' ? 0 : 1;
    if (at(d.rect.x - nx, d.rect.z - nz) !== T_FLOOR) errs.push(`${d.id} front face is blocked`);
    if (at(d.rect.x + nx * d.rect.w, d.rect.z + nz * d.rect.h) !== T_FLOOR) errs.push(`${d.id} back face is blocked`);
  }

  // Sealed until a door is bought...
  for (const t of floodFloor(map, L.spawn.tx, L.spawn.tz)) {
    const z = zoneAt(L, t % MAP_W, (t / MAP_W) | 0);
    if (z !== null && z !== L.spawnZone) {
      errs.push('start room leaks into another zone');
      break;
    }
  }

  // ...and fully connected once they all are.
  const open = Uint8Array.from(map);
  for (const d of L.doors) fill(open, d.rect, T_FLOOR);
  const reach = floodFloor(open, L.spawn.tx, L.spawn.tz);
  for (const zone of L.zones) {
    const r = zone.rect;
    let found = false;
    for (let z = r.z; z < r.z + r.h && !found; z++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (reach.has(z * MAP_W + x)) {
          found = true;
          break;
        }
      }
    }
    if (!found) errs.push(`${zone.name} is unreachable with all doors open`);
  }
  const mustReach: [string, WallProp][] = [
    ...L.wallBuys.map((w): [string, WallProp] => [`wall buy ${w.weapon}`, w]),
    ...L.perks.map((p): [string, WallProp] => [`perk ${p.perk}`, p]),
    ...L.boxPads.map((p, i): [string, WallProp] => [`box pad ${i}`, p]),
    ['power switch', L.powerSwitch],
    ['pack-a-punch', L.pack],
  ];
  for (const [what, p] of mustReach) {
    if (!reach.has(p.tz * MAP_W + p.tx)) errs.push(`${what} is unreachable`);
  }

  return errs;
}

/** A fresh seed for a new run: small enough to read out loud. */
export function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 999_999);
}

/**
 * Builds a playable layout for a seed. The same seed always gives the same
 * asylum. Seeds whose first roll breaks a rule are re-rolled deterministically.
 */
export function generateLayout(seed: number): Layout {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rng = new Rng((seed * 2654435761 + attempt * 0x9e3779b9) >>> 0);
    const layout = tryGenerate(seed, rng);
    if (layout && validateLayout(layout).length === 0) return layout;
  }
  throw new Error(`could not generate a playable layout for seed ${seed}`);
}

/** Debug helper: renders the tile map as ASCII. */
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
