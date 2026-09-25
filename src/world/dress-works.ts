/**
 * Set dressing for the Vireo Ironworks: the loading bays, the casting floor,
 * the warehouses and the container yard out back.
 */

import * as THREE from 'three';
import type { Rng } from '../core/rng.ts';
import { textures } from '../gfx/textures.ts';
import type { MatSpec } from './batch.ts';
import { TILE, WALL_H, tileCenter } from './mapdata.ts';
import {
  M, type Kit, type Put, type Room, ahead, ceilingBeams, ceilingPipes, centrePiece, claim, claimArea,
  crateStack, debris, drum, free, interior, piece, pieceAt, scatter, wallTiles,
} from './furnish.ts';

const hazardSpec = (): MatSpec => ({ map: textures().hazard, uvScale: 2 });

function pallet(put: Put, y = 0): void {
  const w = M.wood();
  for (const x of [-1.0, 0, 1.0]) put(w, 0.3, 0.3, 2.4, x, y + 0.15, 0);
  for (let i = 0; i < 5; i++) put(w, 2.4, 0.06, 0.34, 0, y + 0.33, -1.0 + i * 0.5);
}

/** A pallet with a load on it: crates, sacks or a shrink-wrapped block. */
function palletLoad(put: Put, rng: Rng, y = 0): void {
  pallet(put, y);
  const kind = rng.int(3);
  if (kind === 0) {
    put(M.crate(), 1.1, 1.1, 1.1, -0.6, y + 0.92, -0.6, rng.range(-0.2, 0.2));
    put(M.crate(), 1.1, 1.1, 1.1, 0.6, y + 0.92, 0.5, rng.range(-0.2, 0.2));
    if (rng.chance(0.5)) put(M.crate(), 1.0, 1.0, 1.0, 0, y + 1.97, 0, rng.range(-0.3, 0.3));
  } else if (kind === 1) {
    put(M.flat(0xb8b8b0), 2.3, rng.range(1.2, 2.2), 2.3, 0, y + 1.2, 0);
  } else {
    for (let i = 0; i < 6; i++) put(M.flat(0x8a7a5a), 1.0, 0.45, 0.7, (i % 2) * 1.05 - 0.5, y + 0.6 + Math.floor(i / 2) * 0.46, rng.range(-0.6, 0.6), rng.range(-0.2, 0.2));
  }
}

export function forklift(put: Put, kit: Kit): void {
  const yellow = M.flat(0xb8901a);
  const dark = M.flat(0x1a1a1a);
  put(yellow, 1.9, 1.3, 2.6, 0, 1.05, -0.2);
  put(M.flat(0x3a3a3a), 1.9, 1.0, 0.7, 0, 1.2, -1.7);
  for (const [x, z] of [[-0.85, -1.2], [0.85, -1.2], [-0.85, 0.8], [0.85, 0.8]]) put(dark, 0.1, 2.4, 0.1, x, 2.9, z);
  put(dark, 1.9, 0.1, 2.1, 0, 4.1, -0.2);
  put(dark, 0.4, 0.5, 0.4, 0, 1.9, 0.2);
  for (const x of [-0.6, 0.6]) {
    put(M.flat(0x2a2a2a), 0.2, 4.2, 0.2, x, 2.1, 1.3);
    put(M.flat(0x4a4a48), 0.24, 0.1, 2.2, x * 0.8, 0.1, 2.4);
  }
  for (const x of [-1.0, 1.0]) {
    kit.cyl(dark, 0.5, 0.5, 0.4, x, 0.5, 0.7, 'x', 8);
    kit.cyl(dark, 0.4, 0.4, 0.4, x, 0.4, -1.3, 'x', 8);
  }
}

function container(put: Put, rng: Rng, y = 0): void {
  const tint = rng.pick([0x9a3a2a, 0x2a5a8a, 0x3a6a3a, 0xb88a2a, 0x7a7a7a, 0x5a2a4a]);
  const skin: MatSpec = { map: textures().corrugated, color: tint, uvScale: 2 };
  put(skin, 2.6, 2.8, 6.2, 0, y + 1.4, 0);
  const frame = M.flat(0x1e1e1e);
  for (const z of [-3.05, 3.05]) {
    put(frame, 2.7, 0.2, 0.2, 0, y + 0.1, z);
    put(frame, 2.7, 0.2, 0.2, 0, y + 2.7, z);
  }
  for (const x of [-0.45, 0.45]) put(frame, 0.08, 2.5, 0.08, x, y + 1.4, 3.13);
}

function scrapPile(put: Put, rng: Rng): void {
  for (let i = 0; i < 9; i++) {
    const s = rng.range(0.4, 1.4);
    put(M.flat(rng.pick([0x4a3a2a, 0x3a3432, 0x5a4a3a, 0x2a2a2a])), s, s * rng.range(0.2, 0.7), s * rng.range(0.5, 1.2),
      rng.range(-1.2, 1.2), s * 0.2 + rng.range(0, 0.8), rng.range(-1.2, 1.2), rng.range(0, 3), rng.range(-0.5, 0.5), rng.range(-0.5, 0.5));
  }
}

function fireBarrel(r: Room, x: number, z: number): void {
  r.b.cylinder(M.flat(0x3a2a1e), r.amb, 0.7, 0.7, 1.9, 8, x, 0.95, z);
  const fire = new THREE.CylinderGeometry(0.2, 0.55, 0.9, 6);
  r.b.glow(fire, new THREE.Matrix4().makeTranslation(x, 2.25, z), new THREE.Color(5, 1.9, 0.4));
  fire.dispose();
  r.lighting.add({ x, y: 2.8, z, color: new THREE.Color(0xff7a2a), intensity: 2.2, radius: 13 });
}

/* ---------------------------------------------------------- loading bay */

function dockDoor(put: Put): void {
  const shutter: MatSpec = { map: textures().corrugated, color: 0x8a8e90, uvScale: 1.5 };
  put(shutter, 3.6, 5.4, 0.12, 0, 2.7, -1.94);
  put(M.flat(0x2a2a2a), 3.8, 0.5, 0.4, 0, 5.6, -1.8);
  put(hazardSpec(), 3.6, 0.02, 1.2, 0, 0.015, -1.2);
  for (const x of [-1.5, 1.5]) put(M.flat(0x121212), 0.5, 0.8, 0.4, x, 1.1, -1.7);
}

export function dressLoading(r: Room): void {
  const walls = wallTiles(r);
  const dockSide = r.rng.pick(walls.map((w) => w.facing));
  for (const w of walls) {
    if (Math.abs(w.facing - dockSide) < 0.01 && r.rng.chance(0.7)) {
      piece(r, w.tx, w.tz, w.facing, (put) => dockDoor(put));
    } else if (r.rng.chance(0.25)) {
      piece(r, w.tx, w.tz, w.facing, (put) => palletLoad(put, r.rng));
    } else continue;
    claim(r, w.tx, w.tz);
  }
  const area = r.zone.rect.w * r.zone.rect.h;
  for (const s of scatter(r, 2, 2, Math.round(area / 22))) {
    piece(r, s.tx, s.tz, r.rng.int(4) * (Math.PI / 2) + r.rng.range(-0.2, 0.2), (put) => palletLoad(put, r.rng));
    claim(r, s.tx, s.tz);
  }
  for (const s of scatter(r, 2, 4, Math.max(1, Math.round(area / 120)))) {
    piece(r, s.tx, s.tz, r.rng.range(0, 6), (put, kit) => forklift(put, kit));
    claimArea(r, s.tx, s.tz, 1);
  }
  // Painted lanes on the floor.
  const rect = r.zone.rect;
  const alongX = rect.w >= rect.h;
  for (const off of [2, (alongX ? rect.h : rect.w) - 2]) {
    const len = (alongX ? rect.w : rect.h) * TILE - 4;
    const x = alongX ? (rect.x + rect.w / 2) * TILE : (rect.x + off) * TILE;
    const z = alongX ? (rect.z + off) * TILE : (rect.z + rect.h / 2) * TILE;
    r.b.box(M.flat(0xa89030), r.amb, alongX ? len : 0.3, 0.02, alongX ? 0.3 : len, x, 0.015, z);
  }
  ceilingBeams(r, M.metalDark());
  debris(r, 14, ['paper', 'rubble']);
}

/* ---------------------------------------------------------- casting floor */

function crucible(put: Put, kit: Kit): void {
  const steel = M.metalDark();
  put(steel, 5.4, 0.6, 1.0, 0, 0.3, -2.6);
  put(steel, 5.4, 0.6, 1.0, 0, 0.3, 2.6);
  for (const x of [-2.3, 2.3]) put(steel, 0.6, 5.0, 0.6, x, 2.5, 0);
  kit.cyl(M.metal(), 2.0, 1.5, 3.4, 0, 3.6, 0, 'y', 10);
  kit.cyl(steel, 0.35, 0.35, 5.2, 0, 4.4, 0, 'x', 6);
  kit.glowCyl(new THREE.Color(6, 2.2, 0.35), 1.8, 0.15, 0, 5.3, 0, 'y', 10);
  // A pour frozen mid-stream into the channel below.
  put(M.metal(), 0.8, 0.3, 1.2, 0, 5.1, 2.0, 0, -0.4);
  kit.glow(new THREE.Color(6, 2.0, 0.3), 0.3, 4.6, 0.3, 0, 2.8, 2.5);
  kit.glow(new THREE.Color(5, 1.6, 0.25), 1.0, 0.1, 4.0, 0, 0.06, 4.2);
  kit.light(0, 6.0, 0, 0xff7a20, 3.6, 20);
  kit.light(0, 1.2, 4.0, 0xff6a10, 2.2, 12);
}

function moulds(put: Put, kit: Kit, rng: Rng): void {
  for (let i = 0; i < 4; i++) {
    const x = -1.35 + i * 0.9;
    put(M.flat(0x2a2624), 0.8, 0.6, 2.8, x, 0.3, 0);
    if (rng.chance(0.5)) kit.glow(new THREE.Color(4, 1.3, 0.2), 0.6, 0.04, 2.5, x, 0.61, 0);
  }
}

function furnaceDoor(put: Put, kit: Kit): void {
  const brick: MatSpec = { map: textures().brickRed, uvScale: 3 };
  put(brick, 3.8, 5.6, 1.4, 0, 2.8, -1.3);
  put(M.metalDark(), 2.4, 2.2, 0.2, 0, 2.0, -0.55);
  kit.glow(new THREE.Color(5, 1.8, 0.3), 1.8, 0.16, 0.06, 0, 1.2, -0.44);
  kit.light(0, 1.2, 0.8, 0xff7020, 1.6, 10);
}

function hangingHook(r: Room, x: number, z: number): void {
  const len = r.rng.range(2, 4);
  r.b.box(M.flat(0x2a2a2a), r.amb, 0.08, len, 0.08, x, WALL_H - 0.7 - len / 2, z);
  r.b.box(M.flat(0x5a4a1a), r.amb, 0.5, 0.6, 0.2, x, WALL_H - 0.7 - len - 0.3, z);
}

export function dressFoundry(r: Room): void {
  const mid = centrePiece(r, 1);
  if (mid) {
    piece(r, mid.tx, mid.tz, r.rng.int(4) * (Math.PI / 2), (put, kit) => crucible(put, kit));
    claimArea(r, mid.tx, mid.tz, 1);
  }
  for (const w of wallTiles(r)) {
    const roll = r.rng.next();
    if (roll < 0.12) piece(r, w.tx, w.tz, w.facing, (put, kit) => furnaceDoor(put, kit));
    else if (roll < 0.22) {
      const c = tileCenter(w.tx, w.tz);
      drum(r, c.x - 0.8, c.z);
      drum(r, c.x + 0.8, c.z + 0.3);
    } else continue;
    claim(r, w.tx, w.tz);
  }
  const area = r.zone.rect.w * r.zone.rect.h;
  for (const s of scatter(r, 2, 3, Math.round(area / 50))) {
    piece(r, s.tx, s.tz, r.rng.int(2) * (Math.PI / 2), (put, kit) => moulds(put, kit, r.rng));
    claim(r, s.tx, s.tz);
  }
  const open = interior(r, 1);
  for (let i = 0; i < 4 && open.length; i++) {
    const s = open[r.rng.int(open.length)];
    const c = tileCenter(s.tx, s.tz);
    hangingHook(r, c.x, c.z);
  }
  ceilingBeams(r, M.metalDark());
  ceilingPipes(r, 3);
  debris(r, 20, ['rubble']);
}

/* ------------------------------------------------------------ warehouse */

/** Pallet racking three levels high, loaded. */
function racking(put: Put, rng: Rng): void {
  const upright = M.flat(0x2a4a7a);
  const beam = M.flat(0xb8601a);
  for (const x of [-1.85, 1.85]) for (const z of [-1.8, -0.2]) put(upright, 0.14, 7.4, 0.14, x, 3.7, z);
  for (const y of [0.3, 2.7, 5.1]) {
    for (const z of [-1.8, -0.2]) put(beam, 3.8, 0.22, 0.12, 0, y, z);
    put(M.flat(0x3a3a3a), 3.7, 0.04, 1.6, 0, y + 0.12, -1.0);
    if (rng.chance(0.8)) {
      put(M.wood(), 3.4, 0.25, 1.4, 0, y + 0.27, -1.0);
      if (rng.chance(0.5)) put(M.crate(), 1.4, 1.4, 1.3, -0.9, y + 1.1, -1.0, rng.range(-0.1, 0.1));
      if (rng.chance(0.6)) put(M.crate(), 1.4, 1.4, 1.3, 0.8, y + 1.1, -1.0, rng.range(-0.1, 0.1));
      if (rng.chance(0.3)) put(M.flat(0xb8b8b0), 1.5, 1.8, 1.3, 0, y + 1.3, -1.0);
    }
  }
}

export function dressWarehouse(r: Room): void {
  for (const w of wallTiles(r)) {
    if (!r.rng.chance(0.6)) continue;
    piece(r, w.tx, w.tz, w.facing, (put) => racking(put, r.rng));
    claim(r, w.tx, w.tz);
  }
  // Freestanding double-sided runs down the middle, broken for cross-aisles.
  const rect = r.zone.rect;
  const alongX = rect.w >= rect.h;
  for (const s of interior(r, 3)) {
    const row = alongX ? s.tz - rect.z : s.tx - rect.x;
    const col = alongX ? s.tx - rect.x : s.tz - rect.z;
    if (row % 4 !== 3 || col % 5 === 0) continue;
    const facing = alongX ? 0 : Math.PI / 2;
    piece(r, s.tx, s.tz, facing, (put) => racking(put, r.rng));
    claim(r, s.tx, s.tz);
  }
  for (const s of scatter(r, 2, 3, 5)) {
    if (r.rng.chance(0.3)) {
      piece(r, s.tx, s.tz, r.rng.range(0, 6), (put, kit) => forklift(put, kit));
    } else {
      piece(r, s.tx, s.tz, r.rng.range(0, 6), (put) => crateStack(put, r.rng));
    }
    claim(r, s.tx, s.tz);
  }
  ceilingBeams(r, M.metalDark());
  debris(r, 14, ['paper', 'rubble']);
}

/* ----------------------------------------------------------------- yard */

export function dressYard(r: Room): void {
  const area = r.zone.rect.w * r.zone.rect.h;
  // Containers stand on two tiles; a few are stacked two high.
  const spots = scatter(r, 2, 3, Math.round(area / 32));
  for (const s of spots) {
    const facing = r.rng.int(2) * (Math.PI / 2);
    const along = facing === 0 ? { tx: s.tx, tz: s.tz + 1 } : { tx: s.tx + 1, tz: s.tz };
    if (!free(r, along.tx, along.tz)) continue;
    const c0 = tileCenter(s.tx, s.tz);
    const c1 = tileCenter(along.tx, along.tz);
    const stacked = r.rng.chance(0.3);
    const cx = (c0.x + c1.x) / 2;
    const cz = (c0.z + c1.z) / 2;
    for (const [y, twist] of stacked ? [[0, 0], [2.8, r.rng.range(-0.15, 0.15)]] : [[0, r.rng.range(-0.05, 0.05)]]) {
      pieceAt(r, cx, cz, facing + twist, (put) => container(put, r.rng, y));
    }
    claim(r, s.tx, s.tz);
    claim(r, along.tx, along.tz);
  }
  for (const s of scatter(r, 2, 4, Math.max(2, Math.round(area / 90)))) {
    piece(r, s.tx, s.tz, r.rng.range(0, 6), (put) => scrapPile(put, r.rng));
    claim(r, s.tx, s.tz);
  }
  let barrels = 0;
  for (const w of wallTiles(r)) {
    const roll = r.rng.next();
    if (roll < 0.1) {
      const c = tileCenter(w.tx, w.tz);
      drum(r, c.x - 0.7, c.z + 0.2);
      if (r.rng.chance(0.5)) drum(r, c.x + 0.8, c.z);
    } else if (roll < 0.14 && barrels < 2) {
      const c = tileCenter(w.tx, w.tz);
      const a = ahead(w);
      fireBarrel(r, (c.x + tileCenter(a.tx, a.tz).x) / 2, (c.z + tileCenter(a.tx, a.tz).z) / 2);
      barrels++;
    } else if (roll < 0.22) {
      piece(r, w.tx, w.tz, w.facing, (put) => palletLoad(put, r.rng));
    } else continue;
    claim(r, w.tx, w.tz);
  }
  debris(r, Math.round(area / 10), ['rubble', 'rubble', 'paper']);
}
