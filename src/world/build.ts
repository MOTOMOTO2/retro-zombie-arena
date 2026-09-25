/**
 * Turns a generated layout into actual geometry.
 *
 * Walls, floors, ceilings, window reveals, lamp housings and all the set
 * dressing go through one Batcher and are lit once, at build time, straight
 * into vertex colours. Baked vertex lighting is what shooters of this era
 * actually shipped, it costs nothing at runtime, and it leaves the GPU free
 * for the horde.
 *
 * Walls are built in bands - skirting, wainscot, dado rail, upper wall - so
 * each room reads as a real interior, and every face is split vertically so
 * the bake has enough vertices to show a pool of light under each lamp.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng.ts';
import { Batcher, type MatSpec } from './batch.ts';
import { Lighting, LightProbe } from './lighting.ts';
import {
  MAP_H,
  MAP_W,
  TILE,
  T_BARRICADE,
  T_DOOR,
  T_FLOOR,
  T_WALL,
  WALL_H,
  type Layout,
  type ZoneId,
  getZone,
  tileAt,
  zoneAt,
} from './mapdata.ts';
import { looks, MOONLIGHT, type LampStyle, type LookId, type ThemeLook } from './themes.ts';
import { textures } from '../gfx/textures.ts';

/** Window opening, in world units above the floor. */
export const SILL = 1.1;
export const HEAD = 6.6;

const SKIRT = 0.45;
const RAIL = 0.22;

type Flicker = {
  mat: THREE.MeshBasicMaterial;
  base: THREE.Color;
  phase: number;
  rate: number;
};

export type BuiltLevel = {
  group: THREE.Group;
  lighting: Lighting;
  probe: LightProbe;
  /** Advances flickering lamps. */
  update(t: number): void;
  dispose(): void;
};

export type Dresser = (b: Batcher, lighting: Lighting, rng: Rng) => void;

function isOpen(t: number): boolean {
  return t === T_FLOOR || t === T_DOOR;
}

/** Solid as far as ambient occlusion is concerned. Doors will open, so they do not count. */
function occludes(t: number): boolean {
  return t !== T_FLOOR && t !== T_DOOR;
}

function lookIdAt(layout: Layout, tx: number, tz: number): LookId {
  const z = zoneAt(layout, tx, tz);
  return z ? getZone(layout, z).theme : 'corridor';
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Occlusion at a floor or ceiling vertex from the solid tiles around it. */
function groundAO(map: Uint8Array, x: number, z: number, strength: number): number {
  const tx = Math.floor(x / TILE);
  const tz = Math.floor(z / TILE);
  let occ = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = tx + dx;
      const nz = tz + dz;
      if (!occludes(tileAt(map, nx, nz))) continue;
      const cx = Math.max(nx * TILE, Math.min(x, (nx + 1) * TILE));
      const cz = Math.max(nz * TILE, Math.min(z, (nz + 1) * TILE));
      const d = Math.hypot(x - cx, z - cz);
      occ += Math.max(0, 1 - d / 2.6);
    }
  }
  return Math.max(0.35, 1 - strength * Math.min(1.6, occ)) * grime(x, 0, z);
}

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Low-frequency dirt baked into the vertex colours. Textures repeat every
 * tile; this does not, so it breaks the repetition up into patches.
 */
function grime(x: number, y: number, z: number): number {
  const s = 5.5;
  const fx = x / s;
  const fy = y / s;
  const fz = z / s;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const ty = fy - iy;
  const tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const sz = tz * tz * (3 - 2 * tz);
  let v = 0;
  for (let k = 0; k < 8; k++) {
    const ox = k & 1;
    const oy = (k >> 1) & 1;
    const oz = (k >> 2) & 1;
    const w = (ox ? sx : 1 - sx) * (oy ? sy : 1 - sy) * (oz ? sz : 1 - sz);
    v += hash3(ix + ox, iy + oy, iz + oz) * w;
  }
  return 0.8 + 0.2 * v;
}

function wallAO(y: number): number {
  return (0.52 + 0.48 * smoothstep(0, 3.2, y)) * (1 - 0.2 * smoothstep(WALL_H - 2, WALL_H, y));
}

/* -------------------------------------------------------------- walls */

type Band = { y0: number; y1: number; spec: MatSpec };

function bandsFor(look: ThemeLook): Band[] {
  const trim: MatSpec = { color: look.trim };
  const upper: MatSpec = { map: look.upper };
  if (look.dado > 0 && look.lower) {
    const lower: MatSpec = { map: look.lower };
    const top = look.dado + RAIL;
    const mid = (top + WALL_H) / 2;
    return [
      { y0: 0, y1: SKIRT, spec: trim },
      { y0: SKIRT, y1: look.dado, spec: lower },
      { y0: look.dado, y1: top, spec: trim },
      { y0: top, y1: mid, spec: upper },
      { y0: mid, y1: WALL_H, spec: upper },
    ];
  }
  return [
    { y0: 0, y1: SKIRT, spec: trim },
    { y0: SKIRT, y1: 3.4, spec: upper },
    { y0: 3.4, y1: 6.2, spec: upper },
    { y0: 6.2, y1: WALL_H, spec: upper },
  ];
}

/**
 * One wall face along the floor edge p0 -> p1, facing n, built in bands and
 * clipped to the given height ranges (a window face leaves a hole).
 */
function wallFace(
  b: Batcher, look: ThemeLook, p0: number[], p1: number[], n: number[],
  ranges: [number, number][], amb: THREE.Color, cornerA: number, cornerB: number,
): void {
  // Wind the quad so its front faces n.
  const ex = p1[0] - p0[0];
  const ez = p1[1] - p0[1];
  // (edge x up) must point along n: cross((ex,0,ez),(0,1,0)) = (-ez, 0, ex)
  const flip = -ez * n[0] + ex * n[2] < 0;
  const a = flip ? p1 : p0;
  const c = flip ? p0 : p1;
  const aoA = flip ? cornerB : cornerA;
  const aoC = flip ? cornerA : cornerB;
  const ua = (Math.abs(n[0]) > 0 ? a[1] : a[0]) / TILE;
  const uc = (Math.abs(n[0]) > 0 ? c[1] : c[0]) / TILE;

  for (const band of bandsFor(look)) {
    for (const [r0, r1] of ranges) {
      const y0 = Math.max(band.y0, r0);
      const y1 = Math.min(band.y1, r1);
      if (y1 - y0 < 0.01) continue;
      b.quad(
        band.spec,
        [a[0], y0, a[1]], [c[0], y0, c[1]], [c[0], y1, c[1]], [a[0], y1, a[1]],
        n,
        [ua, y0 / TILE, uc, y0 / TILE, uc, y1 / TILE, ua, y1 / TILE],
        amb,
        [
          wallAO(y0) * aoA * grime(a[0], y0, a[1]),
          wallAO(y0) * aoC * grime(c[0], y0, c[1]),
          wallAO(y1) * aoC * grime(c[0], y1, c[1]),
          wallAO(y1) * aoA * grime(a[0], y1, a[1]),
        ],
      );
    }
  }

  // A proud skirting board and dado rail give the wall some relief.
  const mx = (p0[0] + p1[0]) / 2 + n[0] * 0.06;
  const mz = (p0[1] + p1[1]) / 2 + n[2] * 0.06;
  const len = Math.hypot(ex, ez);
  const along = Math.abs(ex) > Math.abs(ez);
  const trim: MatSpec = { color: look.trim };
  if (ranges[0][0] <= 0) {
    b.box(trim, amb, along ? len : 0.12, SKIRT, along ? 0.12 : len, mx, SKIRT / 2, mz);
  }
  if (look.dado > 0 && ranges.some(([r0, r1]) => r0 <= look.dado && r1 >= look.dado + RAIL)) {
    b.box(trim, amb, along ? len : 0.16, RAIL, along ? 0.16 : len, mx, look.dado + RAIL / 2, mz);
  }
}

/* ------------------------------------------------------------ windows */

function windowOpening(
  b: Batcher, layout: Layout, look: ThemeLook, amb: THREE.Color,
  bx: number, bz: number, dx: number, dz: number, outside: Set<number>,
): void {
  const map = layout.tiles;
  const reveal: MatSpec = { map: look.upper };
  // Tile bounds of the barricade tile.
  const x0 = bx * TILE;
  const z0 = bz * TILE;
  const x1 = x0 + TILE;
  const z1 = z0 + TILE;
  const up = [0, 1, 0];
  const down = [0, -1, 0];
  const ao4 = [0.8, 0.8, 0.8, 0.8];

  // Sill and head of the reveal.
  b.quad(reveal, [x0, SILL, z1], [x1, SILL, z1], [x1, SILL, z0], [x0, SILL, z0], up,
    [x0 / TILE, z1 / TILE, x1 / TILE, z1 / TILE, x1 / TILE, z0 / TILE, x0 / TILE, z0 / TILE], amb, ao4);
  b.quad(reveal, [x0, HEAD, z0], [x1, HEAD, z0], [x1, HEAD, z1], [x0, HEAD, z1], down,
    [x0 / TILE, z0 / TILE, x1 / TILE, z0 / TILE, x1 / TILE, z1 / TILE, x0 / TILE, z1 / TILE], amb, ao4);

  // Jambs: the two side faces of the opening.
  const lx = Math.abs(dz);
  const lz = Math.abs(dx);
  for (const s of [-1, 1]) {
    // Face plane on the side of the barricade tile toward lateral direction s.
    const n = [-lx * s, 0, -lz * s];
    const px = lx ? (s > 0 ? x1 : x0) : x0;
    const pz = lz ? (s > 0 ? z1 : z0) : z0;
    const qx = lx ? px : x1;
    const qz = lz ? pz : z1;
    wallFace(b, { ...look, dado: 0, lower: null }, [px, pz], [qx, qz], n, [[SILL, HEAD]], amb, 0.85, 0.85);
  }

  // A timber sill ledge on the room side.
  const cx = (x0 + x1) / 2 - dx * (TILE / 2 + 0.2);
  const cz = (z0 + z1) / 2 - dz * (TILE / 2 + 0.2);
  b.box({ map: textures().wood, uv: 'box' }, amb, lx ? TILE + 0.4 : 0.55, 0.18, lz ? TILE + 0.4 : 0.55, cx, SILL - 0.09, cz);

  // The night outside: a sky, a treeline and the fence, just past the ground.
  const far = TILE * 3.4;
  const half = TILE * 1.45;
  const bcx = (x0 + x1) / 2 + dx * far;
  const bcz = (z0 + z1) / 2 + dz * far;
  const p0 = [bcx - lx * half, bcz - lz * half];
  const p1 = [bcx + lx * half, bcz + lz * half];
  // Wind it to face back toward the room.
  const faceIn = (-(p1[1] - p0[1])) * -dx + (p1[0] - p0[0]) * -dz > 0;
  const qa = faceIn ? p0 : p1;
  const qb = faceIn ? p1 : p0;
  b.unlitQuad(textures().nightSky,
    [qa[0], -1, qa[1]], [qb[0], -1, qb[1]], [qb[0], WALL_H + 5, qb[1]], [qa[0], WALL_H + 5, qa[1]],
    [0, 0, 1, 0, 1, 1, 0, 1], new THREE.Color(0.75, 0.78, 0.9));

  // A scrap of ground outside, so the dead have something to walk on.
  for (let step = 0; step <= 3; step++) {
    for (let lat = -1; lat <= 1; lat++) {
      const tx = bx + dx * step + lx * lat;
      const tz = bz + dz * step + lz * lat;
      if (step > 0 && tileAt(map, tx, tz) !== 0) continue;
      if (step === 0 && lat !== 0) continue;
      outside.add(tz * MAP_W + tx);
    }
  }
}

/** Moonlit ground under every window, laid once even where two windows share it. */
function outsideGround(b: Batcher, layout: Layout, outside: Set<number>): void {
  const windows = layout.barricades.map((w) => [(w.tx + 0.5) * TILE, (w.tz + 0.5) * TILE]);
  const shadeAt = (x: number, z: number): number => {
    let best = Infinity;
    for (const [wx, wz] of windows) best = Math.min(best, Math.hypot(x - wx, z - wz));
    return Math.max(0.15, 1 - best / 16);
  };
  const up = [0, 1, 0];
  for (const i of outside) {
    const gx0 = (i % MAP_W) * TILE;
    const gz0 = Math.floor(i / MAP_W) * TILE;
    const gx1 = gx0 + TILE;
    const gz1 = gz0 + TILE;
    b.quad({ map: textures().ground }, [gx0, 0.02, gz1], [gx1, 0.02, gz1], [gx1, 0.02, gz0], [gx0, 0.02, gz0],
      up, [gx0 / TILE, gz1 / TILE, gx1 / TILE, gz1 / TILE, gx1 / TILE, gz0 / TILE, gx0 / TILE, gz0 / TILE], MOONLIGHT,
      [shadeAt(gx0, gz1), shadeAt(gx1, gz1), shadeAt(gx1, gz0), shadeAt(gx0, gz0)]);
  }
}

/* --------------------------------------------------------------- lamps */

type Fixture = { x: number; z: number; style: LampStyle; color: THREE.Color; along: 'x' | 'z'; flicker: boolean };

const STYLE = {
  fluorescent: { y: WALL_H - 0.35, radius: 19, gain: 1.8, glow: 3.2 },
  bulb: { y: WALL_H - 2.3, radius: 17, gain: 1.9, glow: 4.5 },
  cage: { y: WALL_H - 0.75, radius: 18, gain: 1.8, glow: 3.4 },
} as const;

function placeLamps(layout: Layout, lighting: Lighting, rng: Rng): Fixture[] {
  const fixtures: Fixture[] = [];
  const pillar = new Set<number>();
  for (const zone of layout.zones) for (const p of zone.pillars) pillar.add(p.tz * MAP_W + p.tx);

  const addLamp = (tx: number, tz: number, look: ThemeLook, along: 'x' | 'z'): void => {
    const s = STYLE[look.lampStyle];
    const x = (tx + 0.5) * TILE;
    const z = (tz + 0.5) * TILE;
    const flicker = rng.chance(0.12);
    const color = new THREE.Color(look.light);
    lighting.add({
      x, y: s.y, z, color,
      intensity: look.lampIntensity * s.gain * rng.range(0.9, 1.1) * (flicker ? 0.75 : 1),
      radius: s.radius,
    });
    fixtures.push({ x, z, style: look.lampStyle, color, along, flicker });
  };

  for (const zone of layout.zones) {
    const look = looks()[zone.theme];
    const r = zone.rect;
    const nx = Math.max(1, Math.round(r.w / look.lampSpacing));
    const nz = Math.max(1, Math.round(r.h / look.lampSpacing));
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        let tx = r.x + Math.floor(((i + 0.5) * r.w) / nx);
        const tz = r.z + Math.floor(((j + 0.5) * r.h) / nz);
        if (pillar.has(tz * MAP_W + tx)) tx += tx + 1 < r.x + r.w ? 1 : -1;
        addLamp(tx, tz, look, r.w >= r.h ? 'x' : 'z');
      }
    }
  }

  const corridor = looks().corridor;
  for (const c of layout.corridors) {
    const horizontal = c.w > c.h;
    const long = horizontal ? c.w : c.h;
    const steps = Math.max(1, Math.round(long / corridor.lampSpacing));
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const tx = horizontal ? c.x + Math.floor(t * c.w) : c.x + 1;
      const tz = horizontal ? c.z + 1 : c.z + Math.floor(t * c.h);
      if (tileAt(layout.tiles, tx, tz) === T_DOOR) continue;
      addLamp(tx, tz, corridor, horizontal ? 'x' : 'z');
    }
  }
  return fixtures;
}

function buildFixtures(b: Batcher, lighting: Lighting, fixtures: Fixture[], group: THREE.Group): Flicker[] {
  const flickers: Flicker[] = [];
  const housing: MatSpec = { color: 0x2a2c30 };
  const metal: MatSpec = { map: textures().metalDark };
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);

  for (const f of fixtures) {
    const s = STYLE[f.style];
    const amb = lighting.ambientAt(f.x, f.z);
    const glowColor = f.color.clone().multiplyScalar(s.glow);
    const ax = f.along === 'x';
    let glowGeo: THREE.BufferGeometry;
    let gy: number;

    if (f.style === 'fluorescent') {
      b.box(housing, amb, ax ? 3.2 : 0.9, 0.2, ax ? 0.9 : 3.2, f.x, WALL_H - 0.1, f.z);
      glowGeo = new THREE.BoxGeometry(ax ? 2.9 : 0.62, 0.06, ax ? 0.62 : 2.9);
      gy = WALL_H - 0.23;
    } else if (f.style === 'bulb') {
      b.cylinder(housing, amb, 0.03, 0.03, 1.9, 4, f.x, WALL_H - 0.95, f.z);
      b.cylinder(metal, amb, 0.22, 0.85, 0.55, 8, f.x, WALL_H - 2.05, f.z, 0, 0, 0, true);
      glowGeo = new THREE.OctahedronGeometry(0.22, 0);
      gy = STYLE.bulb.y;
    } else {
      b.box(housing, amb, 1.0, 0.3, 1.0, f.x, WALL_H - 0.15, f.z);
      for (const [ox, oz] of [[-0.36, -0.36], [0.36, -0.36], [-0.36, 0.36], [0.36, 0.36]]) {
        b.box(housing, amb, 0.06, 0.6, 0.06, f.x + ox, WALL_H - 0.6, f.z + oz);
      }
      b.box(housing, amb, 0.8, 0.06, 0.8, f.x, WALL_H - 0.92, f.z);
      glowGeo = new THREE.BoxGeometry(0.46, 0.4, 0.46);
      gy = WALL_H - 0.62;
    }

    m.compose(new THREE.Vector3(f.x, gy, f.z), q, one);
    if (f.flicker) {
      const mat = new THREE.MeshBasicMaterial({ color: glowColor.clone() });
      const mesh = new THREE.Mesh(glowGeo, mat);
      mesh.applyMatrix4(m);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      flickers.push({ mat, base: glowColor, phase: Math.random() * 100, rate: 0.6 + Math.random() * 1.8 });
    } else {
      b.glow(glowGeo, m, glowColor);
      glowGeo.dispose();
    }
  }
  return flickers;
}

/* --------------------------------------------------------------- level */

/**
 * Builds the whole static level. Door tiles get floor and ceiling but no wall
 * faces, so a bought door reveals a finished opening; window tiles become a
 * wall with a hole through it, looking out onto a patch of moonlit ground.
 */
export function buildLevel(layout: Layout, dress?: Dresser): BuiltLevel {
  const map = layout.tiles;
  const rng = new Rng(layout.seed ^ 0x51ed);
  const lighting = new Lighting(layout);
  const b = new Batcher();
  const group = new THREE.Group();
  const lookFor = (tx: number, tz: number): ThemeLook => looks()[lookIdAt(layout, tx, tz)];

  const fixtures = placeLamps(layout, lighting, rng);
  const outside = new Set<number>();

  for (let tz = 0; tz < MAP_H; tz++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      if (!isOpen(map[tz * MAP_W + tx])) continue;
      const look = lookFor(tx, tz);
      const amb = lighting.ambientAt((tx + 0.5) * TILE, (tz + 0.5) * TILE);
      const x0 = tx * TILE;
      const z0 = tz * TILE;

      // Floor, split 2x2 so occlusion and light pools have somewhere to live.
      const h = TILE / 2;
      for (let sz = 0; sz < 2; sz++) {
        for (let sx = 0; sx < 2; sx++) {
          const ax = x0 + sx * h;
          const az = z0 + sz * h;
          const bx = ax + h;
          const bz = az + h;
          b.quad({ map: look.floor }, [ax, 0, bz], [bx, 0, bz], [bx, 0, az], [ax, 0, az], [0, 1, 0],
            [ax / TILE, bz / TILE, bx / TILE, bz / TILE, bx / TILE, az / TILE, ax / TILE, az / TILE], amb,
            [groundAO(map, ax, bz, 0.4), groundAO(map, bx, bz, 0.4), groundAO(map, bx, az, 0.4), groundAO(map, ax, az, 0.4)]);
        }
      }

      // Ceiling.
      const x1 = x0 + TILE;
      const z1 = z0 + TILE;
      b.quad({ map: look.ceiling }, [x0, WALL_H, z0], [x1, WALL_H, z0], [x1, WALL_H, z1], [x0, WALL_H, z1], [0, -1, 0],
        [x0 / TILE, z0 / TILE, x1 / TILE, z0 / TILE, x1 / TILE, z1 / TILE, x0 / TILE, z1 / TILE], amb,
        [groundAO(map, x0, z0, 0.25), groundAO(map, x1, z0, 0.25), groundAO(map, x1, z1, 0.25), groundAO(map, x0, z1, 0.25)]);

      // Drop ceilings are missing the odd panel, and some hang loose.
      if (look.ceiling === textures().ceilAcoustic && rng.chance(0.07)) {
        const qx = x0 + rng.int(2) * h;
        const qz = z0 + rng.int(2) * h;
        const hole: MatSpec = { color: 0x060606 };
        b.quad(hole, [qx, WALL_H - 0.02, qz], [qx + h, WALL_H - 0.02, qz], [qx + h, WALL_H - 0.02, qz + h], [qx, WALL_H - 0.02, qz + h],
          [0, -1, 0], [0, 0, 1, 0, 1, 1, 0, 1], amb, [0.3, 0.3, 0.3, 0.3]);
        if (rng.chance(0.5)) {
          b.box({ map: look.ceiling, uvScale: 4 }, amb, h, 0.08, h, qx + h / 2, WALL_H - 1.0, qz + h * 0.25, 0, 0.9);
        }
      }

      // Walls: one inward-facing face per solid neighbour.
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nt = tileAt(map, tx + dx, tz + dz);
        if (isOpen(nt)) continue;
        const n = [-dx, 0, -dz];
        // Edge of this tile that touches the neighbour.
        const ex = dx < 0 ? x0 : dx > 0 ? x1 : null;
        const ez = dz < 0 ? z0 : dz > 0 ? z1 : null;
        const p0 = ex !== null ? [ex, z0] : [x0, ez as number];
        const p1 = ex !== null ? [ex, z1] : [x1, ez as number];
        // Inside corners get a little extra occlusion.
        const lx = Math.abs(dz);
        const lz = Math.abs(dx);
        const cornerA = occludes(tileAt(map, tx - lx, tz - lz)) ? 0.72 : 1;
        const cornerB = occludes(tileAt(map, tx + lx, tz + lz)) ? 0.72 : 1;

        if (nt === T_BARRICADE) {
          wallFace(b, look, p0, p1, n, [[0, SILL], [HEAD, WALL_H]], amb, cornerA, cornerB);
          windowOpening(b, layout, look, amb, tx + dx, tz + dz, dx, dz, outside);
        } else if (nt === T_WALL || nt === 0) {
          wallFace(b, look, p0, p1, n, [[0, WALL_H]], amb, cornerA, cornerB);
        }
      }
    }
  }

  // Pillars get four faces of their room's wall finish.
  for (const zone of layout.zones) {
    const look = looks()[zone.theme];
    for (const p of zone.pillars) {
      const x0 = p.tx * TILE;
      const z0 = p.tz * TILE;
      const x1 = x0 + TILE;
      const z1 = z0 + TILE;
      const amb = lighting.ambientAt(x0 + TILE / 2, z0 + TILE / 2);
      // The loop above already skins pillars from the neighbouring floor
      // tiles; only a capital at the top is added here.
      b.box({ color: look.trim }, amb, TILE + 0.3, 0.5, TILE + 0.3, (x0 + x1) / 2, WALL_H - 0.25, (z0 + z1) / 2);
      b.box({ color: look.trim }, amb, TILE + 0.3, 0.4, TILE + 0.3, (x0 + x1) / 2, 0.2, (z0 + z1) / 2);
    }
  }

  outsideGround(b, layout, outside);
  const flickers = buildFixtures(b, lighting, fixtures, group);
  dress?.(b, lighting, rng);

  const baked = b.build(lighting);
  group.add(baked);
  const probe = new LightProbe(lighting);

  group.matrixAutoUpdate = false;
  group.updateMatrix();

  return {
    group,
    lighting,
    probe,
    update(t: number): void {
      for (const f of flickers) {
        // Mostly on, with bursts of stutter.
        const k = t * f.rate + f.phase;
        const burst = Math.sin(k * 0.7) > 0.55;
        const on = burst ? (Math.sin(k * 37) > -0.1 ? 1 : 0.08) : 1;
        const hum = 0.9 + 0.1 * Math.sin(k * 11);
        f.mat.color.copy(f.base).multiplyScalar(on * hum);
      }
    },
    dispose(): void {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) m.dispose();
      });
    },
  };
}

/** Fog colour for whichever room a tile is in. */
export function fogColorAt(layout: Layout, zone: ZoneId | null): THREE.Color {
  const look = looks()[zone ? getZone(layout, zone).theme : 'corridor'];
  return new THREE.Color(look.fog);
}
