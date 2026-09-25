/**
 * Set dressing for Vireo Labs, Sublevel 9: the benches where Compound L was
 * made, the tanks it was tested in, the servers that logged it, the cryo
 * vault that kept the results, and the reactor that powers all of it.
 */

import * as THREE from 'three';
import type { Rng } from '../core/rng.ts';
import { textures } from '../gfx/textures.ts';
import type { MatSpec } from './batch.ts';
import { TILE, WALL_H, tileCenter } from './mapdata.ts';
import {
  M, type Kit, type Put, type Room, ceilingPipes, centrePiece, claim, claimArea, debris, drum,
  generatorUnit, interior, locker, piece, scatter, wallTiles,
} from './furnish.ts';

const white = (): MatSpec => ({ color: 0xd0d6d8 });
const steel = (): MatSpec => ({ color: 0x8a9296 });
const hazardSpec = (): MatSpec => ({ map: textures().hazard, uvScale: 2 });

const GREEN = new THREE.Color(0.3, 1.5, 0.6);
const SCREEN = new THREE.Color(0.5, 1.6, 2.0);

function monitor(put: Put, kit: Kit, x: number, y: number, z: number, color = SCREEN): void {
  put(M.flat(0x2a2c2e), 1.1, 0.85, 0.5, x, y, z);
  kit.glow(color, 0.9, 0.65, 0.04, x, y, z + 0.26);
}

/* ------------------------------------------------------------------ lab */

function labBench(put: Put, kit: Kit, rng: Rng): void {
  put(M.flat(0x5a6266), 3.4, 1.6, 1.5, 0, 0.8, 0);
  put(white(), 3.7, 0.14, 1.8, 0, 1.67, 0);
  for (const x of [-1.1, 0, 1.1]) put(M.flat(0x3a4044), 0.9, 0.05, 0.06, x, 1.2, 0.76);
  // Glassware still bubbling.
  const n = 2 + rng.int(4);
  for (let i = 0; i < n; i++) {
    const c = rng.pick([GREEN, new THREE.Color(0.4, 0.9, 1.8), new THREE.Color(1.8, 1.2, 0.3)]);
    const h = rng.range(0.3, 0.7);
    kit.glowCyl(c, rng.range(0.1, 0.2), h, rng.range(-1.5, 1.5), 1.74 + h / 2, rng.range(-0.6, 0.6), 'y', 6);
  }
  if (rng.chance(0.6)) {
    put(M.flat(0x2a2c2e), 0.4, 0.8, 0.5, rng.range(-1.2, 1.2), 2.14, rng.range(-0.4, 0.4));
  }
  if (rng.chance(0.5)) kit.light(0, 2.4, 0, 0x80ffb0, 0.5, 5);
}

function terminal(put: Put, kit: Kit, rng: Rng): void {
  put(M.flat(0x5a6266), 3.6, 0.12, 1.6, 0, 1.6, -1.1);
  put(M.flat(0x3a4044), 0.14, 1.55, 1.5, -1.7, 0.8, -1.1);
  put(M.flat(0x3a4044), 0.14, 1.55, 1.5, 1.7, 0.8, -1.1);
  monitor(put, kit, -0.7, 2.2, -1.4);
  if (rng.chance(0.6)) monitor(put, kit, 0.7, 2.2, -1.4, rng.chance(0.5) ? SCREEN : new THREE.Color(2.0, 0.4, 0.3));
  put(M.flat(0x1a1c1e), 1.2, 0.06, 0.4, 0, 1.69, -0.7);
  put(M.flat(0x2a2c2e), 1.0, 0.1, 1.0, rng.range(-0.6, 0.6), 1.0, 0.4, rng.range(-0.6, 0.6));
  kit.light(0, 2.4, 0.2, 0x80c8ff, 0.7, 7);
}

function fumeHood(put: Put, kit: Kit): void {
  put(M.flat(0xb8bec0), 3.6, 5.6, 1.6, 0, 2.8, -1.2);
  kit.glow(new THREE.Color(0.9, 1.3, 1.3), 3.0, 1.8, 0.04, 0, 2.8, -0.38);
  put(M.flat(0x3a4044), 3.4, 0.12, 1.2, 0, 1.8, -1.0);
}

function whiteboard(put: Put, rng: Rng): void {
  put(M.flat(0x6a7074), 3.5, 2.3, 0.08, 0, 4.4, -1.95);
  put(M.flat(0xdcdcd8), 3.3, 2.1, 0.1, 0, 4.4, -1.94);
  for (let i = 0; i < 6; i++) {
    put(M.flat(rng.pick([0x1a2a6a, 0x6a1a1a, 0x1a1a1a])), rng.range(0.4, 1.4), 0.05, 0.11,
      rng.range(-1.2, 1.2), rng.range(3.6, 5.2), -1.93, 0, 0, rng.range(-0.3, 0.3));
  }
}

export function dressLab(r: Room): void {
  for (const w of wallTiles(r)) {
    const roll = r.rng.next();
    if (roll < 0.18) piece(r, w.tx, w.tz, w.facing, (put, kit) => terminal(put, kit, r.rng));
    else if (roll < 0.26) piece(r, w.tx, w.tz, w.facing, (put, kit) => fumeHood(put, kit));
    else if (roll < 0.34) piece(r, w.tx, w.tz, w.facing, (put) => whiteboard(put, r.rng));
    else if (roll < 0.4) piece(r, w.tx, w.tz, w.facing, (put) => { locker(put, -1.2); locker(put, 0); locker(put, 1.2); });
    else continue;
    claim(r, w.tx, w.tz);
  }
  const area = r.zone.rect.w * r.zone.rect.h;
  for (const s of scatter(r, 2, 3, Math.round(area / 28))) {
    piece(r, s.tx, s.tz, r.rng.int(2) * (Math.PI / 2), (put, kit) => labBench(put, kit, r.rng));
    claim(r, s.tx, s.tz);
  }
  debris(r, 16, ['paper', 'paper', 'rubble']);
}

/* ---------------------------------------------------------- containment */

/** A specimen tank: murky green fluid in a steel frame. Some have burst. */
function tank(put: Put, kit: Kit, rng: Rng, broken: boolean): void {
  kit.cyl(steel(), 1.35, 1.45, 0.8, 0, 0.4, 0, 'y', 10);
  put(hazardSpec(), 3.6, 0.02, 3.6, 0, 0.012, 0);
  if (broken) {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const h = rng.range(0.3, 1.6);
      put(M.flat(0x9ab8b0), 0.3, h, 0.06, Math.sin(a) * 1.05, 0.8 + h / 2, Math.cos(a) * 1.05, a, 0, rng.range(-0.3, 0.3));
    }
    kit.glow(new THREE.Color(0.1, 0.55, 0.22), 3.4, 0.02, 2.6, rng.range(-0.3, 0.3), 0.02, 1.2);
    kit.cyl(steel(), 1.35, 1.35, 0.6, 0, 5.6, 0, 'y', 10);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      put(steel(), 0.14, 5.2, 0.14, Math.sin(a) * 1.2, 3.0, Math.cos(a) * 1.2);
    }
  } else {
    kit.glowCyl(GREEN, 1.05, 4.4, 0, 3.0, 0, 'y', 10);
    kit.cyl(steel(), 1.35, 1.35, 0.6, 0, 5.5, 0, 'y', 10);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      put(steel(), 0.14, 4.4, 0.14, Math.sin(a) * 1.12, 3.0, Math.cos(a) * 1.12);
    }
    kit.light(0, 3.0, 0, 0x60ff90, 1.4, 10);
  }
  kit.cyl(M.metalDark(), 0.25, 0.25, WALL_H - 5.8, 0.5, 5.8 + (WALL_H - 5.8) / 2, 0, 'y', 6);
}

function cellBars(put: Put): void {
  put(M.metalDark(), 3.9, 0.3, 0.3, 0, 5.2, -0.4);
  put(M.metalDark(), 3.9, 0.2, 0.3, 0, 0.1, -0.4);
  for (let i = 0; i < 9; i++) put(M.flat(0x3a3e40), 0.1, 5.0, 0.1, -1.8 + i * 0.45, 2.6, -0.4);
  put(M.flat(0x5a1a14), 0.6, 0.2, 0.3, 0, 0.15, -1.2);
}

export function dressContainment(r: Room): void {
  const area = r.zone.rect.w * r.zone.rect.h;
  for (const s of scatter(r, 2, 3, Math.round(area / 30))) {
    const broken = r.rng.chance(0.35);
    piece(r, s.tx, s.tz, r.rng.range(0, 6), (put, kit) => tank(put, kit, r.rng, broken));
    claim(r, s.tx, s.tz);
  }
  for (const w of wallTiles(r)) {
    const roll = r.rng.next();
    if (roll < 0.22) piece(r, w.tx, w.tz, w.facing, (put) => cellBars(put));
    else if (roll < 0.3) piece(r, w.tx, w.tz, w.facing, (put, kit) => terminal(put, kit, r.rng));
    else if (roll < 0.36) {
      const c = tileCenter(w.tx, w.tz);
      drum(r, c.x, c.z);
    } else continue;
    claim(r, w.tx, w.tz);
  }
  ceilingPipes(r, 3);
  debris(r, 10, ['paper', 'rubble', 'bone']);
}

/* -------------------------------------------------------------- servers */

function serverRack(put: Put, kit: Kit, rng: Rng, z: number): void {
  for (const x of [-0.95, 0.95]) {
    put(M.flat(0x16181a), 1.8, 6.0, 1.5, x, 3.0, z);
    put(M.flat(0x0c0d0e), 1.6, 5.6, 0.04, x, 3.0, z + 0.76);
    for (let u = 0; u < 7; u++) {
      const y = 0.8 + u * 0.72;
      put(M.flat(0x2a2c2e), 1.5, 0.05, 0.05, x, y + 0.32, z + 0.78);
      for (let k = 0; k < 3; k++) {
        if (!rng.chance(0.7)) continue;
        const c = rng.pick([new THREE.Color(0.3, 2.4, 0.6), new THREE.Color(0.4, 1.2, 3.0), new THREE.Color(2.8, 1.8, 0.3)]);
        kit.glow(c, 0.08, 0.08, 0.04, x - 0.6 + k * 0.15 + rng.range(0, 0.3), y, z + 0.8);
      }
    }
  }
}

export function dressServers(r: Room): void {
  for (const w of wallTiles(r)) {
    if (!r.rng.chance(0.7)) continue;
    piece(r, w.tx, w.tz, w.facing, (put, kit) => serverRack(put, kit, r.rng, -1.2));
    claim(r, w.tx, w.tz);
  }
  // Rows of racks back to back, with gaps for the cold aisles.
  const rect = r.zone.rect;
  const alongX = rect.w >= rect.h;
  for (const s of interior(r, 3)) {
    const row = alongX ? s.tz - rect.z : s.tx - rect.x;
    const col = alongX ? s.tx - rect.x : s.tz - rect.z;
    if (row % 4 !== 3 || col % 4 === 0) continue;
    const facing = alongX ? 0 : Math.PI / 2;
    piece(r, s.tx, s.tz, facing, (put, kit) => {
      serverRack(put, kit, r.rng, 0.8);
      put(M.flat(0x16181a), 3.8, 6.0, 0.2, 0, 3.0, 0);
    });
    piece(r, s.tx, s.tz, facing + Math.PI, (put, kit) => serverRack(put, kit, r.rng, 0.8));
    claim(r, s.tx, s.tz);
  }
  // Cable trays overhead and the cold blue of the status lights.
  const len = (alongX ? rect.w : rect.h) * TILE;
  for (let k = 1; k < (alongX ? rect.h : rect.w); k += 4) {
    const x = alongX ? (rect.x + rect.w / 2) * TILE : (rect.x + k) * TILE;
    const z = alongX ? (rect.z + k) * TILE : (rect.z + rect.h / 2) * TILE;
    r.b.box(M.flat(0x3a3e40), r.amb, alongX ? len : 1.2, 0.2, alongX ? 1.2 : len, x, WALL_H - 1.2, z);
    r.b.box(M.flat(0x1a1c2a), r.amb, alongX ? len : 0.9, 0.25, alongX ? 0.9 : len, x, WALL_H - 1.0, z);
  }
  debris(r, 8, ['paper']);
}

/* ----------------------------------------------------------------- cryo */

function cryoPod(put: Put, kit: Kit, rng: Rng): void {
  put(steel(), 2.6, 6.0, 1.2, 0, 3.0, -1.4);
  kit.cyl(M.flat(0x6a7276), 1.05, 1.05, 0.5, 0, 0.25, -0.6, 'y', 10);
  kit.cyl(M.flat(0x6a7276), 1.05, 1.05, 0.5, 0, 5.2, -0.6, 'y', 10);
  const open = rng.chance(0.3);
  if (open) {
    // Empty. Whatever was inside is out.
    put(M.flat(0x0c1418), 1.6, 4.4, 0.1, 0, 2.7, -0.95);
    put(M.flat(0x9ab8c8), 1.6, 4.4, 0.08, 1.3, 2.7, 0.1, 1.2);
  } else {
    kit.glowCyl(new THREE.Color(0.8, 1.5, 1.9), 0.9, 4.4, 0, 2.7, -0.6, 'y', 10);
  }
  kit.glow(new THREE.Color(0.4, 1.6, 2.4), 0.8, 0.3, 0.05, 0, 5.8, -0.78);
  kit.light(0, 2.8, 0.6, 0x9adfff, open ? 0.5 : 1.1, 8);
  put(M.flat(0xd8e4ea), rng.range(1.8, 3.2), 0.03, rng.range(1.2, 2.2), rng.range(-0.3, 0.3), 0.02, 0.8, rng.range(0, 1));
}

function coolantTank(kit: Kit): void {
  kit.cyl(white(), 0.9, 0.9, 5.2, 0, 2.6, -1.0, 'y', 10);
  for (const y of [1.2, 4.0]) kit.cyl(M.flat(0x2a5a8a), 0.93, 0.93, 0.3, 0, y, -1.0, 'y', 10);
  kit.cyl(M.metalDark(), 0.2, 0.2, WALL_H - 5.2, 0, 5.2 + (WALL_H - 5.2) / 2, -1.2, 'y', 6);
}

function lyingPod(put: Put, kit: Kit): void {
  put(M.flat(0x4a5256), 1.8, 1.0, 3.6, 0, 0.5, 0);
  kit.cyl(steel(), 0.95, 0.95, 3.8, 0, 1.6, 0, 'z', 10);
  kit.glow(new THREE.Color(0.7, 1.4, 1.8), 1.0, 0.1, 2.4, 0, 2.55, 0);
  kit.light(0, 3.0, 0, 0x9adfff, 0.6, 6);
}

export function dressCryo(r: Room): void {
  for (const w of wallTiles(r)) {
    const roll = r.rng.next();
    if (roll < 0.4) piece(r, w.tx, w.tz, w.facing, (put, kit) => cryoPod(put, kit, r.rng));
    else if (roll < 0.5) piece(r, w.tx, w.tz, w.facing, (_put, kit) => coolantTank(kit));
    else continue;
    claim(r, w.tx, w.tz);
  }
  const area = r.zone.rect.w * r.zone.rect.h;
  for (const s of scatter(r, 2, 3, Math.round(area / 36))) {
    piece(r, s.tx, s.tz, r.rng.int(2) * (Math.PI / 2), (put, kit) => lyingPod(put, kit));
    claim(r, s.tx, s.tz);
  }
  // Frost creeping across the floor.
  for (const s of interior(r, 0)) {
    if (!r.rng.chance(0.1)) continue;
    const c = tileCenter(s.tx, s.tz);
    r.b.box(M.flat(0xdce8f0), r.amb, r.rng.range(1.5, 3.5), 0.02, r.rng.range(1.5, 3.5), c.x, 0.012, c.z, r.rng.range(0, 3));
  }
  ceilingPipes(r, 4);
  debris(r, 8, ['paper', 'rubble']);
}

/* -------------------------------------------------------------- reactor */

function reactorCore(put: Put, kit: Kit): void {
  const band = new THREE.Color(0.4, 2.8, 2.0);
  kit.cyl(M.metalDark(), 3.0, 3.2, 1.0, 0, 0.5, 0, 'y', 12);
  kit.cyl(M.metal(), 2.0, 2.2, 6.4, 0, 4.2, 0, 'y', 12);
  for (const y of [2.2, 3.9, 5.6]) kit.glowCyl(band, 2.1, 0.32, 0, y, 0, 'y', 12);
  kit.cyl(M.metalDark(), 0.9, 2.1, 1.0, 0, 7.9, 0, 'y', 12);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    kit.cyl(M.metalDark(), 0.3, 0.3, WALL_H - 1.2, Math.sin(a) * 1.6, 1.2 + (WALL_H - 1.2) / 2, Math.cos(a) * 1.6, 'y', 6);
  }
  // A railing ring around it.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    put(M.flat(0xa88a1a), 0.12, 2.0, 0.12, Math.sin(a) * 4.0, 1.0, Math.cos(a) * 4.0);
    put(M.flat(0xa88a1a), 2.1, 0.12, 0.12, Math.sin(a + Math.PI / 12) * 3.9, 1.95, Math.cos(a + Math.PI / 12) * 3.9, a + Math.PI / 12 + Math.PI / 2);
  }
  put(hazardSpec(), 11, 0.02, 11, 0, 0.012, 0);
  kit.light(0, 4.0, 0, 0x60ffd0, 3.2, 20);
}

function console_(put: Put, kit: Kit, rng: Rng): void {
  put(M.flat(0x3a4044), 3.6, 1.6, 1.2, 0, 0.8, -1.3);
  put(M.flat(0x4a5256), 3.6, 0.2, 1.0, 0, 1.75, -1.1, 0, 0.35);
  for (let i = 0; i < 6; i++) {
    const c = rng.pick([new THREE.Color(0.3, 2.4, 0.6), new THREE.Color(2.8, 0.4, 0.3), new THREE.Color(2.8, 1.8, 0.3)]);
    kit.glow(c, 0.2, 0.06, 0.2, -1.4 + i * 0.55, 1.88, -1.05);
  }
  put(M.flat(0x3a4044), 3.6, 2.0, 0.3, 0, 3.4, -1.85);
  monitor(put, kit, -0.9, 3.4, -1.6);
  monitor(put, kit, 0.9, 3.4, -1.6, new THREE.Color(0.4, 2.2, 1.2));
  kit.light(0, 2.4, 0, 0x80ffd0, 0.8, 7);
}

export function dressReactor(r: Room): void {
  const mid = centrePiece(r, 1);
  if (mid) {
    piece(r, mid.tx, mid.tz, 0, (put, kit) => reactorCore(put, kit));
    claimArea(r, mid.tx, mid.tz, 1);
  }
  let units = 0;
  for (const w of wallTiles(r)) {
    const roll = r.rng.next();
    if (roll < 0.2) piece(r, w.tx, w.tz, w.facing, (put, kit) => console_(put, kit, r.rng));
    else if (roll < 0.3 && units < 2) {
      generatorUnit(r, w.tx, w.tz, w.facing);
      units++;
    } else if (roll < 0.36) {
      const c = tileCenter(w.tx, w.tz);
      drum(r, c.x - 0.7, c.z);
      drum(r, c.x + 0.8, c.z + 0.3);
    } else continue;
    claim(r, w.tx, w.tz);
  }
  ceilingPipes(r, 4);
  debris(r, 8, ['rubble']);
}
