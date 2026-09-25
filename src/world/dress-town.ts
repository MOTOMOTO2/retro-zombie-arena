/**
 * Set dressing for Hollow Creek: the streets and the square, the churchyard,
 * and the houses, the corner shop and the garage along them.
 */

import * as THREE from 'three';
import type { Rng } from '../core/rng.ts';
import { textures } from '../gfx/textures.ts';
import type { MatSpec } from './batch.ts';
import { MAP_W, TILE, T_BARRICADE, T_FLOOR, T_WALL, WALL_H, tileAt, tileCenter } from './mapdata.ts';
import {
  M, type Kit, type Put, type Room, ahead, ceilingBeams, centrePiece, claim, claimArea, debris, drum,
  free, interior, piece, scatter, shelf, wallTiles,
} from './furnish.ts';

const iron = (): MatSpec => ({ color: 0x1e2024 });
const concrete = (): MatSpec => ({ map: textures().floorConcrete, uvScale: 4 });

/* ------------------------------------------------------------ outdoors */

/** A raised pavement along every wall of an open-air space. */
export function pavement(r: Room, width = 2.2): void {
  const rect = r.zone.rect;
  const map = r.layout.tiles;
  const spec = concrete();
  for (let tz = rect.z; tz < rect.z + rect.h; tz++) {
    for (let tx = rect.x; tx < rect.x + rect.w; tx++) {
      if (tileAt(map, tx, tz) !== T_FLOOR) continue;
      const c = tileCenter(tx, tz);
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nt = tileAt(map, tx + dx, tz + dz);
        if (nt !== T_WALL && nt !== T_BARRICADE) continue;
        const off = TILE / 2 - width / 2;
        r.b.box(spec, r.amb, dx ? width : TILE, 0.14, dz ? width : TILE, c.x + dx * off, 0.07, c.z + dz * off);
      }
    }
  }
}

/** Dashed centre line down the long axis of a street. */
function roadLines(r: Room): void {
  const rect = r.zone.rect;
  const alongX = rect.w >= rect.h;
  const paint = M.flat(0xa89040);
  const len = (alongX ? rect.w : rect.h) * TILE;
  const mid = alongX ? (rect.z + rect.h / 2) * TILE : (rect.x + rect.w / 2) * TILE;
  for (let d = 3; d < len - 3; d += 6) {
    const x = alongX ? rect.x * TILE + d : mid;
    const z = alongX ? mid : rect.z * TILE + d;
    if (tileAt(r.layout.tiles, Math.floor(x / TILE), Math.floor(z / TILE)) !== T_FLOOR) continue;
    r.b.box(paint, r.amb, alongX ? 3 : 0.3, 0.02, alongX ? 0.3 : 3, x, 0.015, z);
  }
}

/** A sedan, nose toward +z. Burnt-out ones sit on their rims. */
export function car(put: Put, kit: Kit, rng: Rng, burnt: boolean, lift = 0): void {
  const paint = burnt ? 0x221e1c : rng.pick([0x6a1c18, 0x1c3a5a, 0x2a4a2a, 0x8a7a5a, 0x3a3a3e, 0xa8a090, 0x5a3a1a]);
  const body = M.flat(paint);
  const glass = M.flat(burnt ? 0x080808 : 0x243240);
  const chrome = M.flat(burnt ? 0x2a2624 : 0x8a8a88);
  const y = lift + (burnt ? -0.2 : 0);
  put(body, 2.2, 0.8, 4.8, 0, 0.9 + y, 0);
  put(body, 2.04, 0.1, 1.5, 0, 1.33 + y, 1.55, 0, 0.06);
  put(body, 1.96, 0.8, 2.3, 0, 1.7 + y, -0.35);
  put(glass, 1.8, 0.66, 0.06, 0, 1.68 + y, 0.86, 0, -0.55);
  put(glass, 1.8, 0.6, 0.06, 0, 1.68 + y, -1.54, 0, 0.5);
  put(glass, 2.0, 0.5, 1.9, 0, 1.76 + y, -0.35);
  put(chrome, 2.26, 0.3, 0.18, 0, 0.72 + y, 2.42);
  put(chrome, 2.26, 0.3, 0.18, 0, 0.72 + y, -2.42);
  const wheel = burnt ? 0.3 : 0.46;
  for (const wx of [-1.02, 1.02]) {
    for (const wz of [-1.55, 1.55]) kit.cyl(M.flat(0x121314), wheel, wheel, 0.36, wx, wheel + lift, wz, 'x', 8);
  }
  if (burnt) {
    // Scorched through and still smouldering somewhere inside.
    if (rng.chance(0.4)) kit.glow(new THREE.Color(2.4, 0.7, 0.15), 0.8, 0.2, 0.8, rng.range(-0.4, 0.4), 1.3 + y, rng.range(-0.8, 0.4));
    return;
  }
  put(M.flat(0xd8d0b0), 0.42, 0.22, 0.06, -0.72, 1.0 + y, 2.45);
  put(M.flat(0xd8d0b0), 0.42, 0.22, 0.06, 0.72, 1.0 + y, 2.45);
  put(M.flat(0x6a1010), 0.4, 0.2, 0.06, -0.78, 1.0 + y, -2.45);
  put(M.flat(0x6a1010), 0.4, 0.2, 0.06, 0.78, 1.0 + y, -2.45);
  if (lift === 0 && rng.chance(0.3)) {
    // Abandoned with the lights still on.
    const hl = new THREE.Color(3.2, 3.0, 2.4);
    kit.glow(hl, 0.44, 0.24, 0.04, -0.72, 1.0, 2.49);
    kit.glow(hl, 0.44, 0.24, 0.04, 0.72, 1.0, 2.49);
    kit.light(0, 1.1, 5.5, 0xfff0c8, 1.4, 12);
  }
  if (rng.chance(0.3)) put(body, 1.9, 0.08, 1.4, rng.range(-0.3, 0.3), 1.52 + y, 2.6, rng.range(-0.3, 0.3), -0.9);
}

function burningBarrel(r: Room, x: number, z: number): void {
  r.b.cylinder(M.flat(0x3a2a1e), r.amb, 0.7, 0.7, 1.9, 8, x, 0.95, z);
  r.b.cylinder(M.flat(0x1a1410), r.amb, 0.74, 0.74, 0.1, 8, x, 1.4, z);
  const fire = new THREE.CylinderGeometry(0.2, 0.55, 0.9, 6);
  r.b.glow(fire, new THREE.Matrix4().makeTranslation(x, 2.25, z), new THREE.Color(5, 1.9, 0.4));
  fire.dispose();
  r.lighting.add({ x, y: 2.8, z, color: new THREE.Color(0xff7a2a), intensity: 2.2, radius: 13 });
}

function hydrant(put: Put, kit: Kit, x: number): void {
  const red = M.flat(0x8a1c14);
  kit.cyl(red, 0.28, 0.32, 1.1, x, 0.69, -1.0);
  kit.cyl(red, 0.34, 0.3, 0.2, x, 1.3, -1.0, 'y', 8);
  kit.cyl(red, 0.12, 0.12, 0.9, x, 0.9, -1.0, 'x', 6);
  put(M.flat(0x5a1410), 0.2, 0.2, 0.2, x, 1.45, -1.0);
}

function trashCans(put: Put, kit: Kit, rng: Rng): void {
  const can = M.flat(0x4a4e4a);
  kit.cyl(can, 0.5, 0.44, 1.3, -0.7, 0.79, -1.2);
  kit.cyl(M.flat(0x3a3e3a), 0.56, 0.56, 0.1, -0.7, 1.48, -1.2);
  if (rng.chance(0.6)) {
    kit.cyl(can, 0.5, 0.44, 1.3, 0.7, 0.6, -0.6, 'z');
    for (let i = 0; i < 4; i++) put(M.flat(rng.pick([0x5a5040, 0x2a2a2a, 0xa89a80])), 0.4, 0.2, 0.5, 0.7 + rng.range(-0.6, 0.6), 0.24, 0.4 + rng.range(0, 1.2), rng.range(0, 3));
  } else {
    kit.cyl(can, 0.5, 0.44, 1.3, 0.5, 0.79, -1.2);
  }
}

function bench(put: Put): void {
  const w = M.wood();
  for (let i = 0; i < 3; i++) put(w, 3.0, 0.1, 0.28, 0, 1.0, -1.2 + i * 0.32);
  for (let i = 0; i < 2; i++) put(w, 3.0, 0.26, 0.08, 0, 1.45 + i * 0.36, -1.6, 0, -0.2);
  for (const x of [-1.3, 1.3]) {
    put(iron(), 0.12, 1.0, 1.0, x, 0.5, -0.9);
    put(iron(), 0.12, 1.1, 0.12, x, 1.5, -1.58, 0, -0.2);
  }
}

function mailbox(put: Put): void {
  put(M.flat(0x1c3a6a), 1.0, 1.1, 0.9, 0, 1.3, -1.2);
  put(M.flat(0x1c3a6a), 1.0, 0.3, 0.9, 0, 1.95, -1.2, 0, 0, 0);
  put(M.flat(0x0a0a0a), 0.6, 0.08, 0.1, 0, 1.6, -0.74);
  for (const x of [-0.4, 0.4]) put(iron(), 0.1, 0.8, 0.1, x, 0.4, -1.2);
}

function sawhorse(put: Put): void {
  const stripe = { map: textures().hazard, uv: 'box' } as MatSpec;
  put(stripe, 3.2, 0.5, 0.1, 0, 1.4, 0);
  put(stripe, 3.2, 0.4, 0.1, 0, 0.8, 0);
  for (const x of [-1.3, 1.3]) {
    put(M.flat(0xd8d0c0), 0.12, 1.8, 0.12, x, 0.8, 0.35, 0, 0.3);
    put(M.flat(0xd8d0c0), 0.12, 1.8, 0.12, x, 0.8, -0.35, 0, -0.3);
  }
}

function phoneBooth(put: Put, kit: Kit): void {
  const red = M.flat(0x7a1812);
  put(red, 1.6, 0.3, 1.6, 0, 0.15, -1.1);
  put(red, 1.7, 0.5, 1.7, 0, 5.1, -1.1);
  for (const [x, z] of [[-0.75, -1.85], [0.75, -1.85], [-0.75, -0.35], [0.75, -0.35]]) put(red, 0.14, 4.7, 0.14, x, 2.6, z);
  put(M.flat(0x1a2028), 1.4, 3.6, 0.04, 0, 2.6, -1.84);
  put(M.flat(0x1a2028), 0.04, 3.6, 1.4, -0.74, 2.6, -1.1);
  put(M.flat(0x1a2028), 0.04, 3.6, 1.4, 0.74, 2.6, -1.1);
  kit.glow(new THREE.Color(3, 2.8, 2.2), 1.2, 0.3, 0.04, 0, 4.9, -0.33);
  kit.glow(new THREE.Color(1.6, 1.5, 1.2), 0.6, 0.6, 0.6, 0, 4.4, -1.1);
  kit.light(0, 4.3, -0.4, 0xfff0d0, 1.0, 8);
}

export function tree(put: Put, kit: Kit, rng: Rng, dead: boolean): void {
  const bark = M.flat(0x2a1e16);
  const h = rng.range(3.4, 4.6);
  kit.cyl(bark, 0.2, 0.36, h, 0, h / 2, 0, 'y', 6);
  if (dead) {
    for (let i = 0; i < 5; i++) {
      const a = rng.range(0, Math.PI * 2);
      const y = h * rng.range(0.5, 0.95);
      const len = rng.range(1.2, 2.4);
      put(bark, 0.14, len, 0.14, Math.sin(a) * len * 0.35, y + len * 0.3, Math.cos(a) * len * 0.35, a, 0.9);
    }
    return;
  }
  const leaf = M.flat(rng.pick([0x1c2a18, 0x22301c, 0x1a2616]));
  for (let i = 0; i < 3; i++) kit.cyl(leaf, 0, 2.2 - i * 0.5, 2.4, 0, h - 0.4 + i * 1.2, 0, 'y', 7);
}

function fountain(put: Put, kit: Kit): void {
  const stone = M.stone();
  kit.cyl(stone, 3.3, 3.4, 1.0, 0, 0.5, 0, 'y', 10);
  kit.cyl(M.flat(0x14202a), 3.0, 3.0, 0.1, 0, 0.92, 0, 'y', 10);
  kit.cyl(stone, 0.5, 0.7, 2.8, 0, 1.4, 0, 'y', 8);
  kit.cyl(stone, 1.5, 0.5, 0.5, 0, 2.9, 0, 'y', 10);
  kit.cyl(stone, 0.25, 0.35, 1.2, 0, 3.7, 0, 'y', 6);
  put(stone, 0.5, 0.5, 0.5, 0, 4.5, 0, 0.8, 0.6);
}

function statue(put: Put, kit: Kit): void {
  const stone = M.stone();
  const bronze = M.flat(0x3e5a4c);
  put(stone, 3.0, 2.6, 3.0, 0, 1.3, 0);
  put(stone, 3.4, 0.3, 3.4, 0, 2.7, 0);
  put(M.flat(0x6a5a2a), 1.4, 0.5, 0.06, 0, 1.5, 1.52);
  // The town's founder, one arm raised against whatever came up out of the ground.
  put(bronze, 0.4, 1.6, 0.45, -0.3, 3.65, 0);
  put(bronze, 0.4, 1.6, 0.45, 0.3, 3.65, 0.1, 0, 0.15);
  put(bronze, 1.1, 1.6, 0.6, 0, 5.2, 0);
  put(bronze, 0.5, 0.55, 0.5, 0, 6.3, 0);
  put(bronze, 0.3, 1.4, 0.3, -0.72, 5.1, 0.1, 0, 0, -0.2);
  put(bronze, 0.3, 1.5, 0.3, 0.75, 6.2, 0, 0, 0, 0.35);
  put(M.flat(0x8a8a86), 0.1, 1.8, 0.1, 1.05, 7.6, 0, 0, 0, 0.35);
  kit.glow(new THREE.Color(2.6, 2.2, 1.4), 0.4, 0.2, 0.4, 0, 0.1, 2.0);
  kit.light(0, 0.6, 2.6, 0xffd8a0, 1.6, 10);
}

/** A shop-window or house-front sign glowing on the wall above the pavement. */
function neonSign(put: Put, kit: Kit, rng: Rng): void {
  const color = rng.pick([[3.4, 0.6, 0.8], [0.6, 2.6, 3.2], [3.2, 2.2, 0.5]]);
  const c = new THREE.Color(color[0], color[1], color[2]);
  put(M.flat(0x141414), 3.0, 1.0, 0.2, 0, 6.2, -1.9);
  for (let i = 0; i < 4; i++) kit.glow(c, 0.4, 0.5, 0.06, -1.05 + i * 0.7, 6.2, -1.78);
  kit.light(0, 6.0, -0.6, c.getHex(), 1.0, 9);
}

export function dressStreet(r: Room): void {
  const rect = r.zone.rect;
  const alongX = rect.w >= rect.h;
  pavement(r);
  roadLines(r);
  const n = Math.max(2, Math.round((rect.w * rect.h) / 60));
  for (const s of scatter(r, 3, 3, n)) {
    const facing = (alongX ? Math.PI / 2 : 0) + (r.rng.chance(0.5) ? Math.PI : 0) + r.rng.range(-0.4, 0.4);
    const burnt = r.rng.chance(0.35);
    piece(r, s.tx, s.tz, facing, (put, kit) => car(put, kit, r.rng, burnt));
    claimArea(r, s.tx, s.tz, 1);
  }
  let barrels = 0;
  for (const w of wallTiles(r)) {
    const roll = r.rng.next();
    if (roll < 0.05) piece(r, w.tx, w.tz, w.facing, (put, kit) => hydrant(put, kit, r.rng.range(-1, 1)));
    else if (roll < 0.12) piece(r, w.tx, w.tz, w.facing, (put, kit) => trashCans(put, kit, r.rng));
    else if (roll < 0.15) piece(r, w.tx, w.tz, w.facing, (put) => mailbox(put));
    else if (roll < 0.19) piece(r, w.tx, w.tz, w.facing, (put) => bench(put));
    else if (roll < 0.25) piece(r, w.tx, w.tz, w.facing, (put, kit) => neonSign(put, kit, r.rng));
    else if (roll < 0.28 && barrels < 2) {
      const c = tileCenter(w.tx, w.tz);
      burningBarrel(r, c.x + Math.sin(w.facing) * 0.4, c.z + Math.cos(w.facing) * 0.4);
      barrels++;
    } else continue;
    claim(r, w.tx, w.tz);
  }
  for (const s of scatter(r, 2, 4, 2)) {
    piece(r, s.tx, s.tz, r.rng.range(0, Math.PI), (put) => sawhorse(put));
    claim(r, s.tx, s.tz);
  }
  debris(r, Math.round((rect.w * rect.h) / 8), ['paper', 'rubble', 'paper']);
}

export function dressSquare(r: Room): void {
  const rect = r.zone.rect;
  pavement(r, 3);
  const mid = centrePiece(r, 1);
  if (mid) {
    const big = r.rng.chance(0.5);
    piece(r, mid.tx, mid.tz, r.rng.int(4) * (Math.PI / 2), (put, kit) => (big ? fountain(put, kit) : statue(put, kit)));
    claimArea(r, mid.tx, mid.tz, 1);
  }
  const trees = Math.max(3, Math.round((rect.w * rect.h) / 45));
  for (const s of scatter(r, 2, 4, trees)) {
    piece(r, s.tx, s.tz, r.rng.range(0, 6), (put, kit) => {
      kit.cyl(M.stone(), 1.3, 1.3, 0.6, 0, 0.3, 0, 'y', 8);
      kit.cyl(M.flat(0x1e1812), 1.15, 1.15, 0.08, 0, 0.6, 0, 'y', 8);
      tree(put, kit, r.rng, r.rng.chance(0.4));
    });
    claim(r, s.tx, s.tz);
  }
  let booth = false;
  for (const w of wallTiles(r)) {
    const roll = r.rng.next();
    if (roll < 0.14) piece(r, w.tx, w.tz, w.facing, (put) => bench(put));
    else if (roll < 0.18 && !booth) {
      piece(r, w.tx, w.tz, w.facing, (put, kit) => phoneBooth(put, kit));
      booth = true;
    } else if (roll < 0.23) piece(r, w.tx, w.tz, w.facing, (put, kit) => trashCans(put, kit, r.rng));
    else continue;
    claim(r, w.tx, w.tz);
  }
  debris(r, Math.round((rect.w * rect.h) / 10), ['paper', 'paper', 'rubble']);
}

/* ------------------------------------------------------------ cemetery */

function headstone(put: Put, kit: Kit, rng: Rng): void {
  const stone = M.flat(rng.pick([0x5a5a58, 0x6a665e, 0x4a4c4e]));
  const tilt = rng.range(-0.14, 0.14);
  const kind = rng.int(4);
  if (kind === 0) {
    put(stone, 1.3, 1.5, 0.3, 0, 0.75, -0.9, 0, 0, tilt);
    kit.cyl(stone, 0.65, 0.65, 0.3, 0, 1.5, -0.9, 'z', 10);
  } else if (kind === 1) {
    put(stone, 0.28, 2.4, 0.28, 0, 1.2, -0.9, 0, 0, tilt);
    put(stone, 1.3, 0.28, 0.28, 0, 1.75, -0.9, 0, 0, tilt);
  } else if (kind === 2) {
    put(stone, 1.0, 0.4, 1.0, 0, 0.2, -0.9);
    kit.cyl(stone, 0.12, 0.4, 3.0, 0, 1.9, -0.9, 'y', 4);
  } else {
    put(stone, 1.6, 1.0, 0.36, 0, 0.5, -0.9, 0, 0, tilt);
  }
  if (rng.chance(0.2)) {
    // Dug up from underneath.
    put(M.flat(0x0a0806), 1.3, 0.04, 2.2, 0, 0.02, 0.6);
    put(M.flat(0x2e261c), 1.2, 0.5, 1.0, 1.3, 0.25, 0.4, rng.range(-0.5, 0.5));
  } else {
    put(M.flat(0x2e2a1e), 1.3, 0.22, 2.3, 0, 0.11, 0.6);
  }
}

function mausoleum(put: Put, kit: Kit): void {
  const stone = M.stone();
  put(stone, 3.9, 5.0, 3.4, 0, 2.5, -0.3);
  put(stone, 4.3, 0.5, 3.8, 0, 5.25, -0.3);
  kit.cyl(stone, 2.2, 2.2, 3.8, 0, 5.5, -0.3, 'z', 3);
  put(M.flat(0x0a0a0c), 1.6, 3.0, 0.1, 0, 1.5, 1.42);
  for (const x of [-1.6, 1.6]) kit.cyl(stone, 0.28, 0.3, 4.9, x, 2.45, 1.7, 'y', 8);
  put(stone, 4.1, 0.3, 1.0, 0, 0.15, 1.8);
  kit.glow(new THREE.Color(3.4, 2.2, 0.8), 0.14, 0.22, 0.14, -0.6, 0.45, 1.9);
  kit.glow(new THREE.Color(3.4, 2.2, 0.8), 0.14, 0.22, 0.14, 0.6, 0.45, 1.9);
  kit.light(0, 1.0, 2.6, 0xffa050, 1.1, 8);
}

/** Wrought-iron railings standing just off the walls. */
function railings(r: Room): void {
  const rect = r.zone.rect;
  const map = r.layout.tiles;
  const bar = iron();
  for (let tz = rect.z; tz < rect.z + rect.h; tz++) {
    for (let tx = rect.x; tx < rect.x + rect.w; tx++) {
      if (tileAt(map, tx, tz) !== T_FLOOR || r.layout.reserved.has(tz * MAP_W + tx)) continue;
      const c = tileCenter(tx, tz);
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (tileAt(map, tx + dx, tz + dz) !== T_WALL) continue;
        const off = TILE / 2 - 0.6;
        const x = c.x + dx * off;
        const z = c.z + dz * off;
        for (let k = 0; k < 4; k++) {
          const t = -TILE / 2 + 0.5 + k;
          r.b.box(bar, r.amb, 0.1, 2.4, 0.1, x + (dz ? t : 0), 1.2, z + (dx ? t : 0));
        }
        for (const y of [0.4, 2.1]) r.b.box(bar, r.amb, dx ? 0.08 : TILE, 0.08, dz ? 0.08 : TILE, x, y, z);
      }
    }
  }
}

export function dressCemetery(r: Room): void {
  const rect = r.zone.rect;
  const alongX = rect.w >= rect.h;
  railings(r);
  const w0 = wallTiles(r).filter((w) => free(r, ahead(w).tx, ahead(w).tz));
  if (w0.length && rect.w * rect.h > 150) {
    const w = w0[r.rng.int(w0.length)];
    piece(r, w.tx, w.tz, w.facing, (put, kit) => mausoleum(put, kit));
    claim(r, w.tx, w.tz);
    const a = ahead(w);
    claim(r, a.tx, a.tz);
  }
  // Rows of graves either side of a path up the middle.
  const path = alongX ? rect.z + Math.floor(rect.h / 2) : rect.x + Math.floor(rect.w / 2);
  for (const s of interior(r, 1)) {
    const row = alongX ? s.tz : s.tx;
    const col = alongX ? s.tx : s.tz;
    if (Math.abs(row - path) < 1 || col % 2 !== 0 || !r.rng.chance(0.75)) continue;
    const facing = alongX ? (row < path ? 0 : Math.PI) : (row < path ? Math.PI / 2 : -Math.PI / 2);
    piece(r, s.tx, s.tz, facing, (put, kit) => headstone(put, kit, r.rng));
    claim(r, s.tx, s.tz);
    if (r.rng.chance(0.06)) {
      piece(r, s.tx, s.tz, facing, (_put, kit) => {
        kit.glow(new THREE.Color(3.4, 2.2, 0.8), 0.12, 0.2, 0.12, 0.8, 0.35, -0.5);
        kit.light(0.8, 0.8, 0, 0xffa050, 0.8, 6);
      });
    }
  }
  for (const s of scatter(r, 1, 4, 3)) {
    piece(r, s.tx, s.tz, r.rng.range(0, 6), (put, kit) => tree(put, kit, r.rng, true));
    claim(r, s.tx, s.tz);
  }
  debris(r, Math.round((rect.w * rect.h) / 14), ['bone', 'rubble']);
}

/* --------------------------------------------------------------- house */

function sofa(put: Put, color: number): void {
  const fabric = M.flat(color);
  put(fabric, 3.4, 0.7, 1.4, 0, 0.75, -1.1);
  put(fabric, 3.4, 1.3, 0.4, 0, 1.4, -1.65);
  put(fabric, 0.4, 1.0, 1.4, -1.7, 1.0, -1.1);
  put(fabric, 0.4, 1.0, 1.4, 1.7, 1.0, -1.1);
  put(M.flat(0x1a120c), 3.4, 0.4, 1.3, 0, 0.2, -1.1);
}

function fireplace(put: Put, kit: Kit): void {
  const brick = { map: textures().brickRed, uvScale: 3 } as MatSpec;
  put(brick, 3.4, 3.4, 1.0, 0, 1.7, -1.5);
  put(brick, 2.4, WALL_H - 3.4, 0.8, 0, 3.4 + (WALL_H - 3.4) / 2, -1.6);
  put(M.flat(0x0a0806), 1.8, 1.5, 0.1, 0, 0.95, -0.98);
  put(M.wood(), 3.9, 0.22, 1.3, 0, 3.5, -1.35);
  kit.glow(new THREE.Color(4.2, 1.4, 0.3), 1.2, 0.3, 0.5, 0, 0.35, -1.25);
  kit.light(0, 1.0, 0.4, 0xff7a2a, 1.8, 12);
  put(M.flat(0x8a7a5a), 0.3, 0.6, 0.3, -1.2, 3.9, -1.4);
  put(M.flat(0x2a2a2a), 0.5, 0.7, 0.3, 1.1, 3.95, -1.4);
}

function television(put: Put, kit: Kit): void {
  put(M.wood(), 2.4, 1.2, 1.1, 0, 0.6, -1.3);
  put(M.flat(0x2a2420), 1.7, 1.3, 1.2, 0, 1.85, -1.35);
  kit.glow(new THREE.Color(1.3, 1.6, 2.2), 1.2, 0.95, 0.04, 0, 1.85, -0.74);
  kit.light(0, 1.9, 0.6, 0x9ab8ff, 1.0, 9);
}

function kitchenCounter(put: Put, kit: Kit, rng: Rng): void {
  put(M.flat(0xd8d2c0), 3.9, 1.8, 1.5, 0, 0.9, -1.2);
  put(M.flat(0x5a5048), 4.0, 0.12, 1.6, 0, 1.86, -1.2);
  for (const x of [-1.3, 0, 1.3]) put(M.flat(0x9a948a), 0.08, 0.3, 0.06, x, 1.4, -0.44);
  put(M.flat(0xd8d2c0), 3.9, 2.0, 0.9, 0, 5.2, -1.55);
  if (rng.chance(0.5)) {
    kit.cyl(M.flat(0x9aa0a4), 0.5, 0.5, 0.1, 0.8, 1.93, -1.2, 'y', 10);
    put(M.flat(0x9aa0a4), 0.1, 0.6, 0.1, 0.8, 2.2, -1.75);
  }
  if (rng.chance(0.5)) put(M.flat(0x6a6a6a), 0.9, 0.5, 0.7, -1.0, 2.15, -1.2);
}

function fridge(put: Put): void {
  put(M.flat(0xc8c4b4), 1.8, 4.6, 1.6, 0, 2.3, -1.1);
  put(M.flat(0x8a8878), 0.1, 1.2, 0.1, 0.7, 3.4, -0.26);
  put(M.flat(0x8a8878), 1.8, 0.04, 0.04, 0, 3.0, -0.28);
}

function doubleBed(put: Put, rng: Rng): void {
  const w = M.wood();
  put(w, 3.6, 2.6, 0.2, 0, 1.3, -1.8);
  put(w, 3.6, 0.8, 4.4, 0, 0.5, 0.4);
  put(M.sheet(), 3.4, 0.4, 4.2, 0, 1.1, 0.4);
  put(M.flat(rng.pick([0x5a2a2a, 0x2a3a5a, 0x4a5a3a])), 3.5, 0.2, 2.8, 0, 1.36, 1.1, 0, 0.04);
  put(M.sheet(), 1.2, 0.3, 0.7, -0.9, 1.45, -1.2);
  put(M.sheet(), 1.2, 0.3, 0.7, 0.9, 1.45, -1.2);
}

function diningSet(put: Put, rng: Rng): void {
  const w = M.wood();
  put(w, 3.4, 0.14, 2.0, 0, 1.75, 0);
  for (const [x, z] of [[-1.5, -0.8], [1.5, -0.8], [-1.5, 0.8], [1.5, 0.8]]) put(w, 0.14, 1.7, 0.14, x, 0.85, z);
  for (const [x, z, a] of [[-0.8, -1.5, 0], [0.8, -1.5, 0], [-0.8, 1.5, Math.PI], [0.8, 1.5, Math.PI]]) {
    const knocked = rng.chance(0.25);
    put(w, 0.9, 0.1, 0.9, x, knocked ? 0.3 : 1.0, z, a + rng.range(-0.3, 0.3), knocked ? 1.4 : 0);
    if (!knocked) put(w, 0.9, 1.2, 0.1, x, 1.6, z + (a ? 0.42 : -0.42), a);
  }
  if (rng.chance(0.6)) put(M.flat(0xd8d0b8), 0.5, 0.3, 0.5, rng.range(-1, 1), 1.97, rng.range(-0.5, 0.5));
}

function rug(r: Room, tx: number, tz: number): void {
  const c = tileCenter(tx, tz);
  const color = r.rng.pick([0x5a2a1e, 0x2a3446, 0x4a3a22]);
  r.b.box(M.flat(color), r.amb, 5.6, 0.03, 3.8, c.x, 0.02, c.z, r.rng.int(2) * (Math.PI / 2));
  r.b.box(M.flat(0x8a7a4a), r.amb, 4.8, 0.035, 3.0, c.x, 0.025, c.z, r.rng.int(2) * (Math.PI / 2));
}

function pictures(put: Put, rng: Rng): void {
  const n = 1 + rng.int(2);
  for (let i = 0; i < n; i++) {
    const x = rng.range(-1.2, 1.2);
    const y = rng.range(4.2, 5.6);
    put(M.flat(0x3a2410), 1.3, 1.0, 0.08, x, y, -1.95, 0, 0, rng.range(-0.15, 0.15));
    put(M.flat(rng.pick([0x4a5a3a, 0x6a5a4a, 0x3a4a5a])), 1.05, 0.75, 0.1, x, y, -1.94, 0, 0, rng.range(-0.15, 0.15));
  }
}

export function dressHouse(r: Room): void {
  let hearth = false;
  let tv = false;
  for (const w of wallTiles(r)) {
    const front = ahead(w);
    const roll = r.rng.next();
    if (roll < 0.06 && !hearth) {
      piece(r, w.tx, w.tz, w.facing, (put, kit) => fireplace(put, kit));
      hearth = true;
    } else if (roll < 0.16) piece(r, w.tx, w.tz, w.facing, (put) => shelf(put, r.rng));
    else if (roll < 0.24) piece(r, w.tx, w.tz, w.facing, (put, kit) => kitchenCounter(put, kit, r.rng));
    else if (roll < 0.27) piece(r, w.tx, w.tz, w.facing, (put) => fridge(put));
    else if (roll < 0.34) piece(r, w.tx, w.tz, w.facing, (put) => sofa(put, r.rng.pick([0x5a3a2a, 0x3a4a3a, 0x6a5a4a, 0x4a2a3a])));
    else if (roll < 0.38 && !tv) {
      piece(r, w.tx, w.tz, w.facing, (put, kit) => television(put, kit));
      tv = true;
    } else if (roll < 0.44 && free(r, front.tx, front.tz)) {
      piece(r, w.tx, w.tz, w.facing, (put) => doubleBed(put, r.rng));
      claim(r, front.tx, front.tz);
    } else {
      if (r.rng.chance(0.3)) piece(r, w.tx, w.tz, w.facing, (put) => pictures(put, r.rng));
      continue;
    }
    claim(r, w.tx, w.tz);
  }
  for (const s of scatter(r, 2, 4, Math.max(1, Math.round((r.zone.rect.w * r.zone.rect.h) / 70)))) {
    if (r.rng.chance(0.5)) {
      rug(r, s.tx, s.tz);
      piece(r, s.tx, s.tz, r.rng.int(4) * (Math.PI / 2), (put) => diningSet(put, r.rng));
    } else {
      rug(r, s.tx, s.tz);
      piece(r, s.tx, s.tz, r.rng.range(0, 6), (put) => {
        put(M.wood(), 2.2, 0.12, 1.2, 0, 1.0, 0);
        put(M.wood(), 2.0, 0.9, 1.0, 0, 0.45, 0);
        put(M.paper(), 0.6, 0.1, 0.8, 0.4, 1.1, 0, 0.4);
      });
    }
    claim(r, s.tx, s.tz);
  }
  debris(r, 12, ['paper', 'rubble']);
}

/* --------------------------------------------------------------- store */

function goods(put: Put, rng: Rng, x0: number, x1: number, y: number, z: number, depth: number): void {
  let x = x0;
  while (x < x1 - 0.2) {
    const w = rng.range(0.3, 0.6);
    if (rng.chance(0.82)) {
      const h = rng.range(0.4, 0.9);
      put(M.flat(rng.pick([0xa82a1e, 0x2a5a8a, 0xc8a82a, 0x3a7a3a, 0xd8d0c0, 0x8a4a2a, 0x6a2a6a])), w - 0.06, h, depth, x + w / 2, y + h / 2, z);
    }
    x += w;
  }
}

function wallShelf(put: Put, rng: Rng): void {
  const m = M.flat(0x8a8e90);
  put(m, 3.8, 4.8, 0.12, 0, 2.4, -1.9);
  for (let s = 0; s < 4; s++) {
    const y = 0.3 + s * 1.2;
    put(m, 3.8, 0.1, 1.1, 0, y, -1.4);
    goods(put, rng, -1.8, 1.8, y + 0.05, -1.4, 0.8);
  }
}

function freezer(put: Put, kit: Kit): void {
  put(M.flat(0xd8dcd8), 3.8, 5.0, 1.6, 0, 2.5, -1.2);
  kit.glow(new THREE.Color(1.4, 1.7, 1.9), 3.3, 3.8, 0.05, 0, 2.6, -0.38);
  for (const x of [-0.85, 0.85]) put(M.flat(0x9aa0a4), 0.08, 3.8, 0.1, x, 2.6, -0.34);
  kit.light(0, 2.4, 0.6, 0xd8f0ff, 0.9, 8);
}

function gondola(put: Put, rng: Rng): void {
  const m = M.flat(0x8a8e90);
  put(m, 3.8, 2.6, 0.12, 0, 1.3, 0);
  put(M.flat(0x5a5e60), 3.8, 0.4, 1.8, 0, 0.2, 0);
  for (const side of [-0.5, 0.5]) {
    for (let s = 0; s < 2; s++) {
      const y = 0.45 + s * 1.0;
      put(m, 3.8, 0.08, 0.8, 0, y, side);
      goods(put, rng, -1.8, 1.8, y + 0.04, side, 0.5);
    }
  }
}

function checkout(put: Put, kit: Kit): void {
  put(M.flat(0x6a5a4a), 1.4, 1.9, 4.0, 0, 0.95, 0);
  put(M.flat(0x1a1a1a), 1.0, 0.06, 2.6, 0, 1.93, 0.6);
  put(M.flat(0x2a2a2a), 1.0, 0.7, 0.8, 0, 2.25, -1.3);
  kit.glow(new THREE.Color(0.4, 2.2, 0.8), 0.5, 0.2, 0.04, 0, 2.5, -0.88);
}

function cart(put: Put, rng: Rng): void {
  const wire = M.flat(0x8a8e92);
  const tipped = rng.chance(0.35);
  const rz = tipped ? 1.45 : 0;
  const y = tipped ? 0.7 : 0;
  put(wire, 1.3, 0.9, 1.8, 0, 1.5 - y, 0, 0, 0, rz);
  put(M.flat(0x3a3e40), 1.2, 0.05, 1.7, 0, 1.06 - y * 0.2, 0, 0, 0, rz);
  put(wire, 1.3, 0.08, 0.08, 0, 2.2 - y, -1.0, 0, 0, rz);
  if (!tipped) for (const [x, z] of [[-0.55, -0.7], [0.55, -0.7], [-0.55, 0.7], [0.55, 0.7]]) put(M.flat(0x1a1a1a), 0.1, 1.0, 0.1, x, 0.5, z);
}

export function dressStore(r: Room): void {
  const walls = wallTiles(r);
  // Chiller cabinets down one wall, shelves on the others.
  const chillSide = r.rng.pick(walls.map((w) => w.facing));
  for (const w of walls) {
    if (Math.abs(w.facing - chillSide) < 0.01 && r.rng.chance(0.8)) {
      piece(r, w.tx, w.tz, w.facing, (put, kit) => freezer(put, kit));
    } else if (r.rng.chance(0.6)) {
      piece(r, w.tx, w.tz, w.facing, (put) => wallShelf(put, r.rng));
    } else continue;
    claim(r, w.tx, w.tz);
  }
  // Aisles: runs of low shelving with gaps to walk through.
  const rect = r.zone.rect;
  const alongX = rect.w >= rect.h;
  for (const s of interior(r, 2)) {
    const row = alongX ? s.tz - rect.z : s.tx - rect.x;
    const col = alongX ? s.tx - rect.x : s.tz - rect.z;
    if (row % 3 !== 0 || col % 4 === 0) continue;
    piece(r, s.tx, s.tz, alongX ? 0 : Math.PI / 2, (put) => gondola(put, r.rng));
    claim(r, s.tx, s.tz);
  }
  for (const s of scatter(r, 1, 3, 3)) {
    piece(r, s.tx, s.tz, r.rng.int(4) * (Math.PI / 2), (put, kit) => checkout(put, kit));
    claim(r, s.tx, s.tz);
  }
  for (const s of scatter(r, 1, 2, 4)) {
    piece(r, s.tx, s.tz, r.rng.range(0, 6), (put) => cart(put, r.rng));
    claim(r, s.tx, s.tz);
  }
  debris(r, 20, ['paper', 'rubble']);
}

/* -------------------------------------------------------------- garage */

function toolChest(put: Put): void {
  put(M.flat(0x8a1c14), 2.6, 2.4, 1.2, 0, 1.2, -1.3);
  for (let i = 0; i < 6; i++) put(M.flat(0x3a0e0a), 2.4, 0.05, 0.06, 0, 0.5 + i * 0.32, -0.68);
  put(M.flat(0x5a5e60), 3.6, 2.8, 0.1, 0, 4.3, -1.92);
  for (let i = 0; i < 7; i++) put(M.flat(0x2a2c2e), 0.12, 0.8, 0.08, -1.4 + i * 0.45, 4.3, -1.85, 0, 0, i * 0.3);
}

function tyres(kit: Kit, rng: Rng): void {
  const rubber = M.flat(0x141414);
  const n = 2 + rng.int(4);
  for (let i = 0; i < n; i++) kit.cyl(rubber, 0.75, 0.75, 0.55, rng.range(-0.1, 0.1), 0.28 + i * 0.56, -0.9, 'y', 10);
}

function carLift(put: Put, kit: Kit, rng: Rng): void {
  const yellow = M.flat(0xa88a1a);
  for (const x of [-1.8, 1.8]) {
    put(yellow, 0.5, 5.0, 0.5, x, 2.5, 0);
    put(yellow, 0.3, 0.2, 3.6, x * 0.75, 2.2, 0);
  }
  car(put, kit, rng, false, 2.3);
}

function engineHoist(put: Put, kit: Kit): void {
  const red = M.flat(0x7a1a14);
  put(red, 0.3, 4.6, 0.3, 0, 2.3, -0.8);
  put(red, 0.3, 0.3, 3.2, 0, 4.4, 0.5, 0, -0.3);
  put(red, 2.0, 0.2, 0.2, 0, 0.1, -0.8);
  put(red, 0.2, 0.2, 2.8, -0.9, 0.1, 0.5);
  put(red, 0.2, 0.2, 2.8, 0.9, 0.1, 0.5);
  put(M.flat(0x2a2a2a), 0.06, 1.6, 0.06, 0, 3.5, 1.8);
  put(M.flat(0x3a3e40), 1.4, 1.1, 1.6, 0, 2.2, 1.8);
  kit.cyl(M.flat(0x2a2c2e), 0.3, 0.3, 1.6, 0, 2.9, 1.8, 'x', 6);
}

export function dressGarage(r: Room): void {
  for (const w of wallTiles(r)) {
    const roll = r.rng.next();
    if (roll < 0.22) piece(r, w.tx, w.tz, w.facing, (put) => toolChest(put));
    else if (roll < 0.36) piece(r, w.tx, w.tz, w.facing, (_put, kit) => tyres(kit, r.rng));
    else if (roll < 0.46) {
      const c = tileCenter(w.tx, w.tz);
      drum(r, c.x - 0.8, c.z);
      drum(r, c.x + 0.8, c.z + 0.2);
    } else continue;
    claim(r, w.tx, w.tz);
  }
  const lifts = scatter(r, 2, 4, Math.max(1, Math.round((r.zone.rect.w * r.zone.rect.h) / 90)));
  lifts.forEach((s, i) => {
    const facing = r.rng.int(2) * (Math.PI / 2);
    piece(r, s.tx, s.tz, facing, (put, kit) => (i % 2 === 0 ? carLift(put, kit, r.rng) : engineHoist(put, kit)));
    claimArea(r, s.tx, s.tz, 1);
  });
  // Oil stains.
  for (const s of interior(r, 1)) {
    if (!r.rng.chance(0.08)) continue;
    const c = tileCenter(s.tx, s.tz);
    r.b.box(M.flat(0x0e0e0c), r.amb, r.rng.range(1, 2.4), 0.02, r.rng.range(1, 2), c.x + r.rng.range(-1, 1), 0.015, c.z + r.rng.range(-1, 1), r.rng.range(0, 3));
  }
  ceilingBeams(r, M.metalDark());
  debris(r, 10, ['rubble', 'paper']);
}
