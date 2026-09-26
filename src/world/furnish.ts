/**
 * The furniture shop: helpers for placing pieces in a room and the pieces
 * themselves, shared by every map's set dressing.
 *
 * Pieces also declare themselves solid, and they do it without anyone having
 * to remember to: `pieceAt` watches the boxes a piece emits and keeps the ones
 * with real bulk at body height - a mattress, a workbench, a stack of crates -
 * then hands the room one box on the floor for the lot. Thin things (a privacy
 * screen, a drip stand, paper on the ground) never reach the threshold, so the
 * arena keeps its clean lines while the furniture you can see stops a body.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng.ts';
import { textures } from '../gfx/textures.ts';
import type { Batcher, MatSpec } from './batch.ts';
import type { Lighting } from './lighting.ts';
import {
  MAP_W,
  TILE,
  T_FLOOR,
  T_WALL,
  WALL_H,
  type Layout,
  type ZoneDef,
  tileAt,
  tileCenter,
} from './mapdata.ts';

/** A box on the floor nothing can walk through. Half-extents, world units. */
export type Solid = { x: number; z: number; hx: number; hz: number };

export type Room = {
  b: Batcher;
  zone: ZoneDef;
  layout: Layout;
  lighting: Lighting;
  rng: Rng;
  amb: THREE.Color;
  claimed: Set<number>;
  /** Where the furniture stops a body. Filled in as pieces are placed. */
  solids: Solid[];
};

/** Nothing is allowed to be wider than this, so no one piece walls a room off. */
const SOLID_CAP = 2.0;
/** A box only counts as furniture if it is this chunky, at about this height. */
const SOLID_MIN_THIN = 0.4;
const SOLID_MIN_WIDE = 0.8;
const SOLID_LOW = 0.25;
const SOLID_HIGH = 2.3;

/** Registers a solid box on the floor directly, for pieces built without `piece`. */
export function solidBox(r: Room, x: number, z: number, hx: number, hz: number): void {
  r.solids.push({ x, z, hx: Math.min(SOLID_CAP, hx), hz: Math.min(SOLID_CAP, hz) });
}

export type Put = (spec: MatSpec, sx: number, sy: number, sz: number, x: number, y: number, z: number, ry?: number, rx?: number, rz?: number) => void;

export const M = {
  wood: (): MatSpec => ({ map: textures().wood }),
  woodV: (): MatSpec => ({ map: textures().woodV }),
  metal: (): MatSpec => ({ map: textures().metal }),
  metalDark: (): MatSpec => ({ map: textures().metalDark }),
  sheet: (): MatSpec => ({ map: textures().sheet, uvScale: 3 }),
  paper: (): MatSpec => ({ map: textures().paper, uv: 'box' }),
  crate: (): MatSpec => ({ map: textures().crate, uv: 'box' }),
  stone: (): MatSpec => ({ map: textures().stone, uvScale: 3 }),
  flat: (c: number): MatSpec => ({ color: c }),
};

/* --------------------------------------------------------------- helpers */

export function free(r: Room, tx: number, tz: number): boolean {
  if (tileAt(r.layout.tiles, tx, tz) !== T_FLOOR) return false;
  const i = tz * MAP_W + tx;
  if (r.layout.reserved.has(i) || r.claimed.has(i)) return false;
  const rect = r.zone.rect;
  return tx >= rect.x && tz >= rect.z && tx < rect.x + rect.w && tz < rect.z + rect.h;
}

export function claim(r: Room, tx: number, tz: number): void {
  r.claimed.add(tz * MAP_W + tx);
}

/**
 * Places a piece of furniture in a tile-local frame: origin at the tile
 * centre, +z pointing into the room along `facing`, the wall at z = -TILE/2.
 */
export function piece(r: Room, tx: number, tz: number, facing: number, build: (put: Put, kit: Kit) => void): void {
  const c = tileCenter(tx, tz);
  pieceAt(r, c.x, c.z, facing, build);
}

/**
 * The rest of the toolkit inside a piece's frame: round things, things that
 * glow, and the light they throw.
 */
export type Kit = {
  /** A cylinder; 'y' stands it up, 'x' and 'z' lay it along those local axes. */
  cyl(spec: MatSpec, rTop: number, rBottom: number, h: number, x: number, y: number, z: number, axis?: 'x' | 'y' | 'z', segments?: number): void;
  glow(color: THREE.Color, sx: number, sy: number, sz: number, x: number, y: number, z: number): void;
  /** A glowing cylinder: liquid in a tank, a lantern, a reactor band. */
  glowCyl(color: THREE.Color, r: number, h: number, x: number, y: number, z: number, axis?: 'x' | 'y' | 'z', segments?: number): void;
  light(x: number, y: number, z: number, color: number, intensity: number, radius: number): void;
};

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

/** Like piece, but with its origin anywhere rather than on a tile centre. */
export function pieceAt(r: Room, cx: number, cz: number, facing: number, build: (put: Put, kit: Kit) => void): void {
  const cos = Math.cos(facing);
  const sin = Math.sin(facing);
  const wx = (x: number, z: number): number => cx + x * cos + z * sin;
  const wz = (x: number, z: number): number => cz - x * sin + z * cos;
  const rot = (axis: 'x' | 'y' | 'z'): [number, number] => (axis === 'y' ? [0, 0] : axis === 'x' ? [0, Math.PI / 2] : [Math.PI / 2, 0]);
  const kit: Kit = {
    cyl(spec, rTop, rBottom, h, x, y, z, axis = 'y', segments = 8) {
      const [rx, rz] = rot(axis);
      r.b.cylinder(spec, r.amb, rTop, rBottom, h, segments, wx(x, z), y, wz(x, z), rx, rz, facing);
    },
    glow(color, sx, sy, sz, x, y, z) {
      const geo = new THREE.BoxGeometry(sx, sy, sz);
      const q = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, facing);
      r.b.glow(geo, new THREE.Matrix4().compose(new THREE.Vector3(wx(x, z), y, wz(x, z)), q, ONE), color);
      geo.dispose();
    },
    glowCyl(color, rad, h, x, y, z, axis = 'y', segments = 8) {
      const [rx, rz] = rot(axis);
      const geo = new THREE.CylinderGeometry(rad, rad, h, segments);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, facing, rz, 'YXZ'));
      r.b.glow(geo, new THREE.Matrix4().compose(new THREE.Vector3(wx(x, z), y, wz(x, z)), q, ONE), color);
      geo.dispose();
    },
    light(x, y, z, color, intensity, radius) {
      r.lighting.add({ x: wx(x, z), y, z: wz(x, z), color: new THREE.Color(color), intensity, radius });
    },
  };
  // The bounding box of everything solid this piece puts at body height.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  build((spec, sx, sy, sz, x, y, z, ry = 0, rx = 0, rz = 0) => {
    r.b.box(spec, r.amb, sx, sy, sz, wx(x, z), y, wz(x, z), facing + ry, rx, rz);
    const chunky = Math.min(sx, sz) >= SOLID_MIN_THIN && Math.max(sx, sz) >= SOLID_MIN_WIDE;
    if (!chunky || y - sy / 2 > SOLID_HIGH || y + sy / 2 < SOLID_LOW) return;
    const a = facing + ry;
    const ex = Math.abs(Math.cos(a)) * sx / 2 + Math.abs(Math.sin(a)) * sz / 2;
    const ez = Math.abs(Math.sin(a)) * sx / 2 + Math.abs(Math.cos(a)) * sz / 2;
    const bx = wx(x, z);
    const bz = wz(x, z);
    minX = Math.min(minX, bx - ex);
    maxX = Math.max(maxX, bx + ex);
    minZ = Math.min(minZ, bz - ez);
    maxZ = Math.max(maxZ, bz + ez);
  }, kit);
  if (minX > maxX) return;
  // Pulled in a little, so a body brushes past furniture rather than snagging.
  const hx = Math.min(SOLID_CAP, (maxX - minX) / 2) * 0.92;
  const hz = Math.min(SOLID_CAP, (maxZ - minZ) / 2) * 0.92;
  if (hx > 0.25 && hz > 0.25) r.solids.push({ x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, hx, hz });
}

/** The tile in front of a wall tile, one step into the room. */
export function ahead(w: { tx: number; tz: number; facing: number }, steps = 1): { tx: number; tz: number } {
  return { tx: w.tx + Math.round(Math.sin(w.facing)) * steps, tz: w.tz + Math.round(Math.cos(w.facing)) * steps };
}

/** Free tiles in the room at least `gap` tiles apart from each other, in random order. */
export function scatter(r: Room, margin: number, gap: number, count: number): { tx: number; tz: number }[] {
  const spots = r.rng.shuffle(interior(r, margin));
  const out: { tx: number; tz: number }[] = [];
  for (const s of spots) {
    if (out.length >= count) break;
    if (out.some((o) => Math.max(Math.abs(o.tx - s.tx), Math.abs(o.tz - s.tz)) < gap)) continue;
    out.push(s);
  }
  return out;
}

/** The tile nearest the middle of the room with its neighbours free too. */
export function centrePiece(r: Room, reach: number): { tx: number; tz: number } | null {
  const rect = r.zone.rect;
  const mx = rect.x + rect.w / 2 - 0.5;
  const mz = rect.z + rect.h / 2 - 0.5;
  const spots = interior(r, reach + 1).sort((a, b) =>
    Math.hypot(a.tx - mx, a.tz - mz) - Math.hypot(b.tx - mx, b.tz - mz));
  for (const s of spots.slice(0, 12)) {
    let ok = true;
    for (let dz = -reach; dz <= reach && ok; dz++) {
      for (let dx = -reach; dx <= reach && ok; dx++) ok = free(r, s.tx + dx, s.tz + dz);
    }
    if (ok) return s;
  }
  return null;
}

/** Claims a square of tiles around a centre. */
export function claimArea(r: Room, tx: number, tz: number, reach: number): void {
  for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) claim(r, tx + dx, tz + dz);
}

/** Floor tiles along the room's walls that have plain wall behind them. */
export function wallTiles(r: Room): { tx: number; tz: number; facing: number }[] {
  const rect = r.zone.rect;
  const out: { tx: number; tz: number; facing: number }[] = [];
  const add = (tx: number, tz: number, nx: number, nz: number): void => {
    if (!free(r, tx, tz)) return;
    if (tileAt(r.layout.tiles, tx - nx, tz - nz) !== T_WALL) return;
    out.push({ tx, tz, facing: Math.atan2(nx, nz) });
  };
  for (let tz = rect.z + 1; tz < rect.z + rect.h - 1; tz++) {
    add(rect.x, tz, 1, 0);
    add(rect.x + rect.w - 1, tz, -1, 0);
  }
  for (let tx = rect.x + 1; tx < rect.x + rect.w - 1; tx++) {
    add(tx, rect.z, 0, 1);
    add(tx, rect.z + rect.h - 1, 0, -1);
  }
  return out;
}

export function interior(r: Room, margin: number): { tx: number; tz: number }[] {
  const rect = r.zone.rect;
  const out: { tx: number; tz: number }[] = [];
  for (let tz = rect.z + margin; tz < rect.z + rect.h - margin; tz++) {
    for (let tx = rect.x + margin; tx < rect.x + rect.w - margin; tx++) {
      if (free(r, tx, tz)) out.push({ tx, tz });
    }
  }
  return out;
}

export function glowBox(r: Room, color: THREE.Color, sx: number, sy: number, sz: number, x: number, y: number, z: number): void {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  r.b.glow(geo, new THREE.Matrix4().makeTranslation(x, y, z), color);
  geo.dispose();
}

/** Loose papers, rubble and the odd bone: the floor of a building nobody cleans. */
export function debris(r: Room, count: number, kinds: ('paper' | 'rubble' | 'bone')[]): void {
  const spots = interior(r, 0);
  for (let i = 0; i < count && spots.length; i++) {
    const s = spots[r.rng.int(spots.length)];
    const c = tileCenter(s.tx, s.tz);
    const x = c.x + r.rng.range(-1.6, 1.6);
    const z = c.z + r.rng.range(-1.6, 1.6);
    const kind = r.rng.pick(kinds);
    if (kind === 'paper') {
      r.b.box(M.flat(0xb8ae90), r.amb, r.rng.range(0.5, 0.8), 0.02, r.rng.range(0.6, 0.9), x, 0.03, z, r.rng.range(0, 3));
    } else if (kind === 'rubble') {
      const s2 = r.rng.range(0.25, 0.6);
      r.b.box(M.flat(0x5a5650), r.amb, s2, s2 * 0.6, s2 * 0.8, x, s2 * 0.3, z, r.rng.range(0, 3), r.rng.range(-0.3, 0.3));
    } else {
      r.b.box(M.flat(0xcfc7ad), r.amb, 0.16, 0.16, r.rng.range(0.7, 1.1), x, 0.08, z, r.rng.range(0, 3));
    }
  }
}

export function ceilingPipes(r: Room, count: number): void {
  const rect = r.zone.rect;
  const alongX = rect.w >= rect.h;
  for (let i = 0; i < count; i++) {
    const off = 0.8 + i * 0.9;
    const y = WALL_H - 0.5 - (i % 2) * 0.45;
    if (alongX) {
      const z = rect.z * TILE + off;
      r.b.cylinder(M.metalDark(), r.amb, 0.22, 0.22, rect.w * TILE, 6, (rect.x + rect.w / 2) * TILE, y, z, 0, Math.PI / 2);
    } else {
      const x = rect.x * TILE + off;
      r.b.cylinder(M.metalDark(), r.amb, 0.22, 0.22, rect.h * TILE, 6, x, y, (rect.z + rect.h / 2) * TILE, Math.PI / 2);
    }
  }
}

export function ceilingBeams(r: Room, spec: MatSpec): void {
  const rect = r.zone.rect;
  const alongX = rect.w < rect.h;
  const n = alongX ? rect.h : rect.w;
  for (let i = 1; i < n; i += 2) {
    if (alongX) {
      r.b.box(spec, r.amb, rect.w * TILE, 0.7, 0.6, (rect.x + rect.w / 2) * TILE, WALL_H - 0.35, (rect.z + i) * TILE);
    } else {
      r.b.box(spec, r.amb, 0.6, 0.7, rect.h * TILE, (rect.x + i) * TILE, WALL_H - 0.35, (rect.z + rect.h / 2) * TILE);
    }
  }
}

/* ------------------------------------------------------------- furniture */

export function filingCabinet(put: Put, x = 0): void {
  put(M.flat(0x4a5057), 1.3, 2.7, 1.1, x, 1.35, -1.35);
  for (let d = 0; d < 3; d++) {
    put(M.flat(0x3a4046), 1.1, 0.72, 0.06, x, 0.5 + d * 0.85, -0.78);
    put(M.flat(0x9a9a92), 0.4, 0.08, 0.08, x, 0.7 + d * 0.85, -0.74);
  }
}

export function bed(put: Put, rng: Rng): void {
  const frame = M.flat(0x6a7078);
  // Pipe headboard against the wall, mattress running into the room.
  put(frame, 2.1, 2.2, 0.12, 0, 1.1, -1.6);
  put(frame, 0.12, 2.2, 0.12, -1.0, 1.1, -1.6);
  put(frame, 0.12, 2.2, 0.12, 1.0, 1.1, -1.6);
  put(frame, 2.0, 0.18, 4.2, 0, 0.95, 0.4);
  for (const [lx, lz] of [[-0.95, 2.4], [0.95, 2.4], [-0.95, -1.5], [0.95, -1.5]]) put(frame, 0.12, 0.95, 0.12, lx, 0.47, lz);
  put(M.sheet(), 1.9, 0.35, 4.0, 0, 1.2, 0.4, rng.range(-0.04, 0.04));
  put(M.sheet(), 1.2, 0.25, 0.7, 0, 1.45, -1.15);
  if (rng.chance(0.4)) put(M.flat(0x5a1a14), 0.9, 0.04, 1.2, rng.range(-0.3, 0.3), 1.39, rng.range(0, 1.5));
}

export function screen(put: Put): void {
  // Tri-fold privacy screen.
  const frame = M.flat(0x7a8088);
  for (let i = -1; i <= 1; i++) {
    const a = i * 0.5;
    const x = i * 1.1;
    const z = Math.abs(i) * 0.3;
    put(frame, 1.2, 0.08, 0.08, x, 3.4, z, a);
    put(frame, 1.2, 0.08, 0.08, x, 0.4, z, a);
    put(M.sheet(), 1.1, 2.9, 0.04, x, 1.9, z, a);
  }
}

export function ivStand(put: Put, x: number, z: number): void {
  const m = M.flat(0x8a9098);
  put(m, 0.08, 3.6, 0.08, x, 1.8, z);
  put(m, 0.9, 0.06, 0.06, x, 3.5, z);
  put(M.flat(0x9ab8a8), 0.35, 0.55, 0.15, x + 0.35, 3.1, z);
  put(m, 0.8, 0.06, 0.8, x, 0.06, z);
}

export function shelf(put: Put, rng: Rng): void {
  const w = M.wood();
  put(w, 3.4, 5.4, 0.12, 0, 2.7, -1.85);
  put(w, 0.14, 5.4, 1.2, -1.65, 2.7, -1.3);
  put(w, 0.14, 5.4, 1.2, 1.65, 2.7, -1.3);
  for (let s = 0; s < 5; s++) {
    const y = 0.2 + s * 1.25;
    put(w, 3.3, 0.12, 1.2, 0, y, -1.3);
    let x = -1.5;
    while (x < 1.4) {
      const bw = rng.range(0.25, 0.7);
      if (rng.chance(0.8)) {
        const box = rng.chance(0.5);
        put(box ? M.flat(0x8a7a5a) : M.flat([0x5a2a1e, 0x2a3a4a, 0x3a4a2a, 0x6a5a3a][rng.int(4)]),
          bw - 0.05, box ? 0.7 : rng.range(0.7, 1.0), box ? 1.0 : 0.8, x + bw / 2, y + 0.45, -1.3, 0, 0, box ? 0 : rng.range(-0.1, 0.1));
      }
      x += bw;
    }
  }
}

export function desk(put: Put, rng: Rng): void {
  const w = M.wood();
  put(w, 3.2, 0.14, 1.7, 0, 1.55, 0);
  put(w, 0.14, 1.5, 1.6, -1.5, 0.75, 0);
  put(w, 0.14, 1.5, 1.6, 1.5, 0.75, 0);
  put(w, 1.0, 1.4, 1.5, 1.0, 0.75, 0);
  put(M.paper(), 0.9, rng.range(0.1, 0.4), 1.1, rng.range(-1, 0.3), 1.72, rng.range(-0.3, 0.3), rng.range(-0.3, 0.3));
  // Chair, knocked askew.
  put(w, 1.0, 0.1, 1.0, rng.range(-0.6, 0.6), 0.9, 1.4, rng.range(-0.6, 0.6));
  put(w, 1.0, 1.2, 0.1, rng.range(-0.6, 0.6), 1.5, 1.9, rng.range(-0.6, 0.6));
}

export function pew(put: Put, len: number): void {
  const w = M.wood();
  put(w, len, 0.2, 1.0, 0, 0.95, 0);
  put(w, len, 1.3, 0.16, 0, 1.6, 0.55);
  put(w, 0.16, 1.9, 1.1, -len / 2, 0.95, 0.05);
  put(w, 0.16, 1.9, 1.1, len / 2, 0.95, 0.05);
}

export function crateStack(put: Put, rng: Rng): void {
  const n = 1 + rng.int(3);
  for (let i = 0; i < n; i++) {
    const s = rng.range(1.3, 1.7);
    put(M.crate(), s, s, s, rng.range(-0.4, 0.4), s / 2 + i * 1.35, rng.range(-0.8, -0.2), rng.range(-0.3, 0.3));
  }
}

export function rack(put: Put): void {
  const m = M.metalDark();
  put(m, 3.4, 0.15, 0.8, 0, 3.4, -1.5);
  put(m, 3.4, 0.15, 0.8, 0, 1.2, -1.5);
  put(m, 0.12, 4.2, 0.8, -1.65, 2.1, -1.5);
  put(m, 0.12, 4.2, 0.8, 1.65, 2.1, -1.5);
  for (let i = 0; i < 5; i++) {
    // Rifles standing in the rack: stock, receiver, barrel.
    const x = -1.3 + i * 0.65;
    put(M.flat(0x5a3a22), 0.16, 1.2, 0.35, x, 1.9, -1.55, 0, 0.1);
    put(M.flat(0x2a2c2e), 0.12, 1.8, 0.14, x, 3.1, -1.6, 0, 0.1);
  }
}

export function locker(put: Put, x: number): void {
  put(M.flat(0x4a5a4e), 1.2, 4.2, 1.2, x, 2.1, -1.3);
  put(M.flat(0x2a3a2e), 0.05, 3.9, 0.06, x, 2.1, -0.68);
  for (let i = 0; i < 4; i++) put(M.flat(0x1a2420), 0.8, 0.06, 0.04, x, 3.6 - i * 0.12, -0.68);
}

export function coffin(put: Put, rng: Rng): void {
  const s = M.stone();
  put(s, 1.8, 1.3, 4.0, 0, 0.65, 0);
  put(s, 2.0, 0.3, 4.2, rng.range(-0.3, 0.3), 1.45, rng.range(-0.4, 0.4), rng.range(-0.15, 0.15));
}

export function autopsyTable(put: Put, rng: Rng): void {
  const steel = M.flat(0x9aa4a8);
  put(M.flat(0x6a7278), 0.8, 1.6, 0.8, 0, 0.8, 0);
  put(steel, 2.0, 0.14, 4.4, 0, 1.7, 0);
  put(steel, 2.1, 0.2, 0.1, 0, 1.8, 2.2);
  put(steel, 2.1, 0.2, 0.1, 0, 1.8, -2.2);
  if (rng.chance(0.7)) {
    // A body under a sheet.
    put(M.sheet(), 1.3, 0.5, 3.4, 0, 2.0, 0.1);
    put(M.sheet(), 0.7, 0.45, 0.6, 0, 2.05, -1.55);
    if (rng.chance(0.5)) put(M.flat(0x8a7a68), 0.25, 0.2, 0.8, 0.8, 1.85, 0.6, 0.3);
  }
}

export function drawerWall(put: Put): void {
  const steel = M.flat(0x8a9296);
  put(M.flat(0x5a6266), 3.9, 5.4, 0.9, 0, 2.7, -1.6);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      put(steel, 1.15, 1.5, 0.08, -1.25 + col * 1.25, 1.0 + row * 1.7, -1.13);
      put(M.flat(0x3a3e40), 0.4, 0.1, 0.12, -1.25 + col * 1.25, 1.5 + row * 1.7, -1.06);
    }
  }
}

export function generatorUnit(r: Room, tx: number, tz: number, facing: number): void {
  const c = tileCenter(tx, tz);
  piece(r, tx, tz, facing, (put) => {
    put(M.metal(), 3.4, 3.2, 2.6, 0, 1.6, -0.6);
    put(M.metalDark(), 3.6, 0.3, 2.8, 0, 0.15, -0.6);
    put(M.metalDark(), 2.8, 1.2, 0.3, 0, 2.2, 0.8);
    put(M.flat(0x8a2a1a), 0.9, 0.9, 0.2, -0.9, 2.3, 0.9);
    // Exhaust stack to the ceiling.
    put(M.metalDark(), 0.6, WALL_H - 3.2, 0.6, 1.2, 3.2 + (WALL_H - 3.2) / 2, -1.2);
  });
  // A control panel glow and the light it throws.
  const cos = Math.cos(facing);
  const sin = Math.sin(facing);
  const lx = 0.6;
  const lz = 0.98;
  glowBox(r, new THREE.Color(0.4, 2.6, 1.3), 0.5, 0.35, 0.12, c.x + lx * cos + lz * sin, 2.3, c.z - lx * sin + lz * cos);
  r.lighting.add({ x: c.x + sin * 2.2, y: 2.4, z: c.z + cos * 2.2, color: new THREE.Color(0x60ffb0), intensity: 1.1, radius: 7 });
}

export function drum(r: Room, x: number, z: number): void {
  const col = r.rng.pick([0x8a2a1a, 0x9a7a1a, 0x2a4a6a]);
  solidBox(r, x, z, 0.7, 0.7);
  r.b.cylinder(M.flat(col), r.amb, 0.75, 0.75, 2.0, 8, x, 1.0, z);
  r.b.cylinder(M.flat(0x2a2a2a), r.amb, 0.78, 0.78, 0.1, 8, x, 1.4, z);
  r.b.cylinder(M.flat(0x2a2a2a), r.amb, 0.78, 0.78, 0.1, 8, x, 0.6, z);
}
