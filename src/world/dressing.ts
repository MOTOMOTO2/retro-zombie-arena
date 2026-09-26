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
import { WALL_H, type Layout, type ThemeId, tileCenter } from './mapdata.ts';
import type { Dresser } from './build.ts';
import {
  M, type Room, type Solid, autopsyTable, bed, ceilingBeams, ceilingPipes, claim, coffin, crateStack, debris, desk,
  drawerWall, drum, filingCabinet, free, generatorUnit, glowBox, interior, ivStand, locker, pew, piece,
  rack, screen, shelf, solidBox, wallTiles,
} from './furnish.ts';
import { dressCemetery, dressGarage, dressHouse, dressSquare, dressStore, dressStreet } from './dress-town.ts';
import { dressFoundry, dressLoading, dressWarehouse, dressYard } from './dress-works.ts';
import { dressContainment, dressCryo, dressLab, dressReactor, dressServers } from './dress-labs.ts';

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
    // The counter is a real barrier: three boxes, so you can go round either end.
    for (const off of [-3, 0, 3]) solidBox(r, c.x + off, c.z, 1.4, 0.75);
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
  street: dressStreet,
  square: dressSquare,
  cemetery: dressCemetery,
  house: dressHouse,
  store: dressStore,
  garage: dressGarage,
  loading: dressLoading,
  foundry: dressFoundry,
  warehouse: dressWarehouse,
  yard: dressYard,
  lab: dressLab,
  containment: dressContainment,
  servers: dressServers,
  cryo: dressCryo,
  reactor: dressReactor,
};

/** Returns the dresser for a layout, to be handed to buildLevel. */
/**
 * Dresses every room. `solids` is filled in as it goes with the boxes the
 * furniture puts on the floor; the caller hands those to the collision grid.
 */
export function dressLevel(layout: Layout, solids: Solid[] = []): Dresser {
  return (b, lighting, rng, taken) => {
    // Street lamps are already standing where the level put them.
    const claimed = new Set<number>(taken);
    for (const zone of layout.zones) {
      const c = tileCenter(zone.rect.x + zone.rect.w / 2, zone.rect.z + zone.rect.h / 2);
      const room: Room = {
        b, zone, layout, lighting, claimed, solids,
        rng: new Rng(rng.int(0x7fffffff)),
        amb: lighting.ambientAt(c.x, c.z),
      };
      DRESS[zone.theme](room);
    }
  };
}
