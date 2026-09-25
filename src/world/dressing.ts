/**
 * Room dressing. Purely visual - the horde and the player walk through all of
 * it, because solid clutter would turn an arcade arena into a snag-fest - but
 * it is what makes a room read as a chapel or a morgue at a glance.
 *
 * Everything is merged into the level's batches and baked by the same lamps,
 * and a few pieces bring their own light: the furnace's firebox, altar
 * candles, desk lamps, the generator's control panels.
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
  type ThemeId,
  type ZoneDef,
  tileAt,
  tileCenter,
} from './mapdata.ts';
import type { Dresser } from './build.ts';

type Room = {
  b: Batcher;
  zone: ZoneDef;
  layout: Layout;
  lighting: Lighting;
  rng: Rng;
  amb: THREE.Color;
  claimed: Set<number>;
};

type Put = (spec: MatSpec, sx: number, sy: number, sz: number, x: number, y: number, z: number, ry?: number, rx?: number, rz?: number) => void;

const M = {
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

function free(r: Room, tx: number, tz: number): boolean {
  if (tileAt(r.layout.tiles, tx, tz) !== T_FLOOR) return false;
  const i = tz * MAP_W + tx;
  if (r.layout.reserved.has(i) || r.claimed.has(i)) return false;
  const rect = r.zone.rect;
  return tx >= rect.x && tz >= rect.z && tx < rect.x + rect.w && tz < rect.z + rect.h;
}

function claim(r: Room, tx: number, tz: number): void {
  r.claimed.add(tz * MAP_W + tx);
}

/**
 * Places a piece of furniture in a tile-local frame: origin at the tile
 * centre, +z pointing into the room along `facing`, the wall at z = -TILE/2.
 */
function piece(r: Room, tx: number, tz: number, facing: number, build: (put: Put) => void): void {
  const c = tileCenter(tx, tz);
  const cos = Math.cos(facing);
  const sin = Math.sin(facing);
  build((spec, sx, sy, sz, x, y, z, ry = 0, rx = 0, rz = 0) => {
    const wx = c.x + x * cos + z * sin;
    const wz = c.z - x * sin + z * cos;
    r.b.box(spec, r.amb, sx, sy, sz, wx, y, wz, facing + ry, rx, rz);
  });
}

/** Floor tiles along the room's walls that have plain wall behind them. */
function wallTiles(r: Room): { tx: number; tz: number; facing: number }[] {
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

function interior(r: Room, margin: number): { tx: number; tz: number }[] {
  const rect = r.zone.rect;
  const out: { tx: number; tz: number }[] = [];
  for (let tz = rect.z + margin; tz < rect.z + rect.h - margin; tz++) {
    for (let tx = rect.x + margin; tx < rect.x + rect.w - margin; tx++) {
      if (free(r, tx, tz)) out.push({ tx, tz });
    }
  }
  return out;
}

function glowBox(r: Room, color: THREE.Color, sx: number, sy: number, sz: number, x: number, y: number, z: number): void {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  r.b.glow(geo, new THREE.Matrix4().makeTranslation(x, y, z), color);
  geo.dispose();
}

/** Loose papers, rubble and the odd bone: the floor of a building nobody cleans. */
function debris(r: Room, count: number, kinds: ('paper' | 'rubble' | 'bone')[]): void {
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

function ceilingPipes(r: Room, count: number): void {
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

function ceilingBeams(r: Room, spec: MatSpec): void {
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

function filingCabinet(put: Put, x = 0): void {
  put(M.flat(0x4a5057), 1.3, 2.7, 1.1, x, 1.35, -1.35);
  for (let d = 0; d < 3; d++) {
    put(M.flat(0x3a4046), 1.1, 0.72, 0.06, x, 0.5 + d * 0.85, -0.78);
    put(M.flat(0x9a9a92), 0.4, 0.08, 0.08, x, 0.7 + d * 0.85, -0.74);
  }
}

function bed(put: Put, rng: Rng): void {
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

function screen(put: Put): void {
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

function ivStand(put: Put, x: number, z: number): void {
  const m = M.flat(0x8a9098);
  put(m, 0.08, 3.6, 0.08, x, 1.8, z);
  put(m, 0.9, 0.06, 0.06, x, 3.5, z);
  put(M.flat(0x9ab8a8), 0.35, 0.55, 0.15, x + 0.35, 3.1, z);
  put(m, 0.8, 0.06, 0.8, x, 0.06, z);
}

function shelf(put: Put, rng: Rng): void {
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

function desk(put: Put, rng: Rng): void {
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

function pew(put: Put, len: number): void {
  const w = M.wood();
  put(w, len, 0.2, 1.0, 0, 0.95, 0);
  put(w, len, 1.3, 0.16, 0, 1.6, 0.55);
  put(w, 0.16, 1.9, 1.1, -len / 2, 0.95, 0.05);
  put(w, 0.16, 1.9, 1.1, len / 2, 0.95, 0.05);
}

function crateStack(put: Put, rng: Rng): void {
  const n = 1 + rng.int(3);
  for (let i = 0; i < n; i++) {
    const s = rng.range(1.3, 1.7);
    put(M.crate(), s, s, s, rng.range(-0.4, 0.4), s / 2 + i * 1.35, rng.range(-0.8, -0.2), rng.range(-0.3, 0.3));
  }
}

function rack(put: Put): void {
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

function locker(put: Put, x: number): void {
  put(M.flat(0x4a5a4e), 1.2, 4.2, 1.2, x, 2.1, -1.3);
  put(M.flat(0x2a3a2e), 0.05, 3.9, 0.06, x, 2.1, -0.68);
  for (let i = 0; i < 4; i++) put(M.flat(0x1a2420), 0.8, 0.06, 0.04, x, 3.6 - i * 0.12, -0.68);
}

function coffin(put: Put, rng: Rng): void {
  const s = M.stone();
  put(s, 1.8, 1.3, 4.0, 0, 0.65, 0);
  put(s, 2.0, 0.3, 4.2, rng.range(-0.3, 0.3), 1.45, rng.range(-0.4, 0.4), rng.range(-0.15, 0.15));
}

function autopsyTable(put: Put, rng: Rng): void {
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

function drawerWall(put: Put): void {
  const steel = M.flat(0x8a9296);
  put(M.flat(0x5a6266), 3.9, 5.4, 0.9, 0, 2.7, -1.6);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      put(steel, 1.15, 1.5, 0.08, -1.25 + col * 1.25, 1.0 + row * 1.7, -1.13);
      put(M.flat(0x3a3e40), 0.4, 0.1, 0.12, -1.25 + col * 1.25, 1.5 + row * 1.7, -1.06);
    }
  }
}

function generatorUnit(r: Room, tx: number, tz: number, facing: number): void {
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

function drum(r: Room, x: number, z: number): void {
  const col = r.rng.pick([0x8a2a1a, 0x9a7a1a, 0x2a4a6a]);
  r.b.cylinder(M.flat(col), r.amb, 0.75, 0.75, 2.0, 8, x, 1.0, z);
  r.b.cylinder(M.flat(0x2a2a2a), r.amb, 0.78, 0.78, 0.1, 8, x, 1.4, z);
  r.b.cylinder(M.flat(0x2a2a2a), r.amb, 0.78, 0.78, 0.1, 8, x, 0.6, z);
}

/* ---------------------------------------------------------------- themes */

function dressAdmissions(r: Room): void {
  const rect = r.zone.rect;
  // Reception counter across the middle of the room.
  const spots = interior(r, 2).filter((s) => Math.abs(s.tx - (rect.x + rect.w / 2)) < 2 && Math.abs(s.tz - (rect.z + rect.h / 2)) < 2);
  const s = spots.find((p) => free(r, p.tx - 1, p.tz) && free(r, p.tx + 1, p.tz));
  if (s) {
    const c = tileCenter(s.tx, s.tz);
    r.b.box(M.woodV(), r.amb, 9, 2.1, 1.3, c.x, 1.05, c.z);
    r.b.box(M.flat(0x3a2a1a), r.amb, 9.4, 0.18, 1.7, c.x, 2.15, c.z);
    r.b.box(M.paper(), r.amb, 1.0, 0.3, 1.2, c.x - 2.5, 2.4, c.z, 0.2);
    r.b.box(M.flat(0x1a1a1a), r.amb, 0.9, 0.7, 0.8, c.x + 2.2, 2.6, c.z, -0.3);
    for (const dx of [-1, 0, 1]) claim(r, s.tx + dx, s.tz);
  }
  for (const w of wallTiles(r)) {
    const roll = r.rng.next();
    if (roll < 0.25) {
      piece(r, w.tx, w.tz, w.facing, (put) => {
        filingCabinet(put, -0.8);
        filingCabinet(put, 0.6);
      });
      claim(r, w.tx, w.tz);
    } else if (roll < 0.42) {
      // A row of waiting-room chairs.
      piece(r, w.tx, w.tz, w.facing, (put) => {
        for (let i = -1; i <= 1; i++) {
          put(M.flat(0x4a5a4a), 1.0, 0.15, 1.0, i * 1.15, 1.0, -1.1);
          put(M.flat(0x4a5a4a), 1.0, 1.1, 0.12, i * 1.15, 1.6, -1.6);
          put(M.flat(0x2a2a2a), 0.08, 1.0, 0.08, i * 1.15, 0.5, -0.7);
        }
      });
      claim(r, w.tx, w.tz);
    }
  }
  debris(r, 14, ['paper', 'paper', 'rubble']);
}

function dressWard(r: Room): void {
  for (const w of wallTiles(r)) {
    const front = { tx: w.tx + Math.round(Math.sin(w.facing)), tz: w.tz + Math.round(Math.cos(w.facing)) };
    if (r.rng.chance(0.55) && free(r, front.tx, front.tz)) {
      piece(r, w.tx, w.tz, w.facing, (put) => {
        bed(put, r.rng);
        if (r.rng.chance(0.5)) ivStand(put, 1.6, -0.8);
      });
      claim(r, w.tx, w.tz);
      claim(r, front.tx, front.tz);
    }
  }
  for (const s of interior(r, 3)) {
    if (r.rng.chance(0.08)) {
      piece(r, s.tx, s.tz, r.rng.range(0, Math.PI * 2), (put) => screen(put));
      claim(r, s.tx, s.tz);
    }
  }
  debris(r, 10, ['paper', 'rubble']);
}

function dressRecords(r: Room): void {
  for (const w of wallTiles(r)) {
    if (r.rng.chance(0.6)) {
      piece(r, w.tx, w.tz, w.facing, (put) => shelf(put, r.rng));
      claim(r, w.tx, w.tz);
    }
  }
  for (const s of interior(r, 2)) {
    if (r.rng.chance(0.1)) {
      const facing = r.rng.int(4) * (Math.PI / 2);
      piece(r, s.tx, s.tz, facing, (put) => desk(put, r.rng));
      claim(r, s.tx, s.tz);
      // A desk lamp still burning.
      const c = tileCenter(s.tx, s.tz);
      glowBox(r, new THREE.Color(4, 3, 1.6), 0.3, 0.3, 0.3, c.x - Math.cos(facing) * 1.2, 2.2, c.z + Math.sin(facing) * 1.2);
      r.lighting.add({ x: c.x, y: 2.6, z: c.z, color: new THREE.Color(0xffc070), intensity: 0.9, radius: 7 });
    }
  }
  ceilingBeams(r, M.wood());
  debris(r, 22, ['paper']);
}

function dressFurnace(r: Room): void {
  const rect = r.zone.rect;
  const candidates = interior(r, 2);
  const pick = candidates.sort((a, b) =>
    Math.hypot(a.tx - rect.x - rect.w / 2, a.tz - rect.z - rect.h / 2) -
    Math.hypot(b.tx - rect.x - rect.w / 2, b.tz - rect.z - rect.h / 2))[0];
  if (pick) {
    const c = tileCenter(pick.tx, pick.tz);
    r.b.cylinder(M.metal(), r.amb, 1.9, 1.9, 5.4, 10, c.x, 2.7, c.z);
    r.b.cylinder(M.metalDark(), r.amb, 2.0, 2.0, 0.3, 10, c.x, 5.5, c.z);
    r.b.cylinder(M.metalDark(), r.amb, 0.5, 0.5, WALL_H - 5.6, 6, c.x + 0.8, 5.6 + (WALL_H - 5.6) / 2, c.z);
    glowBox(r, new THREE.Color(5, 1.7, 0.35), 1.6, 1.0, 0.3, c.x, 1.2, c.z - 1.85);
    r.lighting.add({ x: c.x, y: 1.4, z: c.z - 3.2, color: new THREE.Color(0xff7020), intensity: 3.2, radius: 15 });
    claim(r, pick.tx, pick.tz);
    for (let i = 0; i < 9; i++) {
      const s = r.rng.range(0.4, 0.9);
      r.b.box(M.flat(0x151413), r.amb, s, s * 0.7, s, c.x + r.rng.range(-3, 3), s * 0.35, c.z + r.rng.range(2.4, 4.4), r.rng.range(0, 3));
    }
  }
  for (const w of wallTiles(r)) {
    if (r.rng.chance(0.2)) {
      piece(r, w.tx, w.tz, w.facing, (put) => {
        put(M.metalDark(), 0.5, WALL_H, 0.5, r.rng.range(-1, 1), WALL_H / 2, -1.6);
      });
    }
  }
  ceilingPipes(r, 3);
  debris(r, 12, ['rubble']);
}

function dressChapel(r: Room): void {
  const rect = r.zone.rect;
  const alongX = rect.w > rect.h;
  // Altar at one short end, pews in two blocks facing it.
  const altarAtStart = r.rng.chance(0.5);
  const len = alongX ? rect.w : rect.h;
  const cross = alongX ? rect.h : rect.w;
  const altarI = altarAtStart ? 1 : len - 2;
  const facing = alongX ? (altarAtStart ? Math.PI / 2 : -Math.PI / 2) : (altarAtStart ? 0 : Math.PI);
  const at = (i: number, j: number): { tx: number; tz: number } =>
    alongX ? { tx: rect.x + i, tz: rect.z + j } : { tx: rect.x + j, tz: rect.z + i };
  const mid = Math.floor(cross / 2);
  const altar = at(altarI, mid);
  if (free(r, altar.tx, altar.tz)) {
    piece(r, altar.tx, altar.tz, facing, (put) => {
      put(M.stone(), 4.2, 1.8, 1.8, 0, 0.9, 0);
      put(M.flat(0x6a1a1a), 4.4, 0.06, 1.2, 0, 1.83, 0.1);
      put(M.wood(), 0.4, 4.5, 0.4, 0, 3.9, -1.4);
      put(M.wood(), 2.4, 0.4, 0.4, 0, 5.0, -1.4);
    });
    claim(r, altar.tx, altar.tz);
    const c = tileCenter(altar.tx, altar.tz);
    for (const side of [-1.6, 1.6]) {
      const ox = Math.cos(facing) * side;
      const oz = -Math.sin(facing) * side;
      r.b.box(M.flat(0xd8d0b8), r.amb, 0.18, 0.5, 0.18, c.x + ox, 2.1, c.z + oz);
      glowBox(r, new THREE.Color(4, 2.6, 0.9), 0.12, 0.2, 0.12, c.x + ox, 2.47, c.z + oz);
    }
    r.lighting.add({ x: c.x, y: 2.6, z: c.z, color: new THREE.Color(0xffb060), intensity: 1.2, radius: 9 });
  }
  const step = altarAtStart ? 1 : -1;
  for (let k = 3; k < len - 1; k += 2) {
    const i = altarI + step * k;
    if (i < 1 || i > len - 2) break;
    for (const j of [mid - 2, mid + 2]) {
      const t = at(i, j);
      if (!free(r, t.tx, t.tz)) continue;
      if (r.rng.chance(0.15)) {
        piece(r, t.tx, t.tz, facing + r.rng.range(-0.5, 0.5), (put) => {
          put(M.wood(), 3.0, 0.2, 1.0, 0, 0.3, 0, 0, 0, 0.3);
        });
      } else {
        piece(r, t.tx, t.tz, facing + Math.PI, (put) => pew(put, 3.6));
      }
      claim(r, t.tx, t.tz);
    }
  }
  ceilingBeams(r, M.wood());
  debris(r, 10, ['rubble', 'paper']);
}

function dressArmory(r: Room): void {
  for (const w of wallTiles(r)) {
    const roll = r.rng.next();
    if (roll < 0.3) {
      piece(r, w.tx, w.tz, w.facing, (put) => rack(put));
      claim(r, w.tx, w.tz);
    } else if (roll < 0.5) {
      piece(r, w.tx, w.tz, w.facing, (put) => {
        locker(put, -1.2);
        locker(put, 0);
        locker(put, 1.2);
      });
      claim(r, w.tx, w.tz);
    }
  }
  for (const s of interior(r, 2)) {
    if (r.rng.chance(0.12)) {
      piece(r, s.tx, s.tz, r.rng.range(0, 6), (put) => crateStack(put, r.rng));
      claim(r, s.tx, s.tz);
    }
  }
  ceilingPipes(r, 2);
  debris(r, 8, ['rubble']);
}

function dressCatacombs(r: Room): void {
  for (const s of interior(r, 1)) {
    if ((s.tx + s.tz) % 3 === 0 && r.rng.chance(0.35)) {
      piece(r, s.tx, s.tz, r.rng.int(2) * (Math.PI / 2), (put) => coffin(put, r.rng));
      claim(r, s.tx, s.tz);
    }
  }
  for (const w of wallTiles(r)) {
    if (r.rng.chance(0.3)) {
      // Niches stacked with skulls.
      piece(r, w.tx, w.tz, w.facing, (put) => {
        for (let i = 0; i < 5; i++) {
          put(M.flat(0xcfc7ad), 0.5, 0.5, 0.5, r.rng.range(-1.5, 1.5), 0.25 + r.rng.int(2) * 0.5, -1.6 + r.rng.range(0, 0.4));
        }
      });
    }
    if (r.rng.chance(0.08)) {
      const c = tileCenter(w.tx, w.tz);
      glowBox(r, new THREE.Color(4, 2.4, 0.8), 0.12, 0.2, 0.12, c.x, 0.9, c.z);
      r.b.box(M.flat(0xd8d0b8), r.amb, 0.2, 0.6, 0.2, c.x, 0.5, c.z);
      r.lighting.add({ x: c.x, y: 1.2, z: c.z, color: new THREE.Color(0xffa050), intensity: 0.8, radius: 7 });
    }
  }
  debris(r, 26, ['bone', 'bone', 'rubble']);
}

function dressMorgue(r: Room): void {
  const drawers = wallTiles(r).filter(() => r.rng.chance(0.35));
  for (const w of drawers) {
    piece(r, w.tx, w.tz, w.facing, (put) => drawerWall(put));
    claim(r, w.tx, w.tz);
  }
  for (const s of interior(r, 2)) {
    if ((s.tx + s.tz) % 2 === 0 && r.rng.chance(0.3)) {
      piece(r, s.tx, s.tz, r.rng.int(2) * (Math.PI / 2), (put) => autopsyTable(put, r.rng));
      claim(r, s.tx, s.tz);
    }
  }
  debris(r, 6, ['paper']);
}

function dressGenerator(r: Room): void {
  let placed = 0;
  for (const w of wallTiles(r)) {
    if (placed < 3 && r.rng.chance(0.35)) {
      generatorUnit(r, w.tx, w.tz, w.facing);
      claim(r, w.tx, w.tz);
      placed++;
    }
  }
  for (const s of interior(r, 2)) {
    if (r.rng.chance(0.1)) {
      const c = tileCenter(s.tx, s.tz);
      drum(r, c.x - 0.8, c.z);
      if (r.rng.chance(0.5)) drum(r, c.x + 0.9, c.z + 0.4);
      claim(r, s.tx, s.tz);
    }
  }
  ceilingPipes(r, 4);
  debris(r, 8, ['rubble']);
}

const DRESS: Record<ThemeId, (r: Room) => void> = {
  admissions: dressAdmissions,
  ward: dressWard,
  records: dressRecords,
  furnace: dressFurnace,
  chapel: dressChapel,
  armory: dressArmory,
  catacombs: dressCatacombs,
  morgue: dressMorgue,
  generator: dressGenerator,
};

/** Returns the dresser for a layout, to be handed to buildLevel. */
export function dressLevel(layout: Layout): Dresser {
  return (b, lighting, rng) => {
    const claimed = new Set<number>();
    for (const zone of layout.zones) {
      const c = tileCenter(zone.rect.x + zone.rect.w / 2, zone.rect.z + zone.rect.h / 2);
      const room: Room = {
        b, zone, layout, lighting, claimed,
        rng: new Rng(rng.int(0x7fffffff)),
        amb: lighting.ambientAt(c.x, c.z),
      };
      DRESS[zone.theme](room);
    }
  };
}
