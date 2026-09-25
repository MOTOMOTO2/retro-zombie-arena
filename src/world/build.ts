/**
 * Turns the tile map into actual geometry.
 *
 * Walls, floors and ceilings are merged into one buffer per material and lit
 * once, at build time, straight into the vertex colours. Baked vertex lighting
 * is what shooters of this era actually shipped, it costs nothing at runtime,
 * and it leaves the GPU free for the horde.
 */

import * as THREE from 'three';
import { textures } from '../gfx/textures.ts';
import {
  CORRIDORS,
  MAP_H,
  MAP_W,
  TILE,
  T_BARRICADE,
  T_DOOR,
  T_FLOOR,
  WALL_H,
  ZONES,
  type ZoneId,
  zoneAt,
} from './mapdata.ts';
import { Rng } from '../core/rng.ts';

type Surface = { wall: THREE.Texture; floor: THREE.Texture; light: number; tint: number };

type BakeLight = { x: number; y: number; z: number; color: THREE.Color; intensity: number; radius: number };

const CORRIDOR_LIGHT = 0xbfae8a;

export type BuiltLevel = {
  group: THREE.Group;
  /** Ceiling lamp positions, reused for flickering. */
  lamps: THREE.Mesh[];
  lights: BakeLight[];
};

function surfaceFor(tx: number, tz: number): Surface {
  const tex = textures();
  const zone = zoneAt(tx, tz);
  switch (zone) {
    case 'lobby':
      return { wall: tex.plasterSick, floor: tex.floorTile, light: 0xffd9a0, tint: 0xb9ae94 };
    case 'furnace':
      return { wall: tex.brickRed, floor: tex.floorConcrete, light: 0xff8a40, tint: 0xc08a66 };
    case 'chapel':
      return { wall: tex.brickGrey, floor: tex.floorTile, light: 0xaecbff, tint: 0x9aa6bb };
    case 'armory':
      return { wall: tex.metal, floor: tex.floorGrate, light: 0xd8e89a, tint: 0xa8ae90 };
    case 'catacombs':
      return { wall: tex.brickGrey, floor: tex.floorConcrete, light: 0x9a86ff, tint: 0x8f86a8 };
    case 'power':
      return { wall: tex.metal, floor: tex.floorGrate, light: 0x7affd0, tint: 0x8fb8a8 };
    default:
      return { wall: tex.plasterBlue, floor: tex.floorConcrete, light: CORRIDOR_LIGHT, tint: 0x9a9384 };
  }
}

/** Accumulates triangles for one material. */
class Batch {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];

  quad(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    n: THREE.Vector3,
    uw: number,
    uh: number,
  ): void {
    const verts = [a, b, c, a, c, d];
    const uvs = [0, 0, uw, 0, uw, uh, 0, 0, uw, uh, 0, uh];
    for (let i = 0; i < 6; i++) {
      this.pos.push(verts[i].x, verts[i].y, verts[i].z);
      this.nor.push(n.x, n.y, n.z);
      this.uv.push(uvs[i * 2], uvs[i * 2 + 1]);
      this.col.push(1, 1, 1);
    }
  }

  build(map: THREE.Texture): THREE.Mesh | null {
    if (this.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    const mat = new THREE.MeshLambertMaterial({ map, vertexColors: true });
    const mesh = new THREE.Mesh(g, mat);
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

/** Places a light grid over every room and corridor. */
function bakeLights(): BakeLight[] {
  const lights: BakeLight[] = [];
  const rng = new Rng(0x5eed1);

  for (const zone of ZONES) {
    const r = zone.rect;
    const stepX = Math.max(4, Math.round(r.w / Math.ceil(r.w / 6)));
    const stepZ = Math.max(4, Math.round(r.h / Math.ceil(r.h / 6)));
    for (let z = r.z + 1; z < r.z + r.h - 1; z += stepZ) {
      for (let x = r.x + 1; x < r.x + r.w - 1; x += stepX) {
        lights.push({
          x: (x + 0.5) * TILE,
          y: WALL_H - 1.1,
          z: (z + 0.5) * TILE,
          color: new THREE.Color(zone.lightColor),
          intensity: rng.range(1.5, 2.0),
          radius: 22,
        });
      }
    }
  }

  for (const c of CORRIDORS) {
    const long = Math.max(c.w, c.h);
    const steps = Math.max(1, Math.round(long / 4));
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      lights.push({
        x: (c.x + (c.w > c.h ? t * c.w : c.w / 2)) * TILE,
        y: WALL_H - 1.4,
        z: (c.z + (c.h >= c.w ? t * c.h : c.h / 2)) * TILE,
        color: new THREE.Color(CORRIDOR_LIGHT),
        intensity: 1.25,
        radius: 15,
      });
    }
  }

  return lights;
}

/** Writes the baked lighting result into a batch's vertex colours. */
function applyBake(batch: Batch, lights: BakeLight[], tint: THREE.Color, ambient: number): void {
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const acc = new THREE.Color();

  for (let i = 0; i < batch.pos.length / 3; i++) {
    p.set(batch.pos[i * 3], batch.pos[i * 3 + 1], batch.pos[i * 3 + 2]);
    n.set(batch.nor[i * 3], batch.nor[i * 3 + 1], batch.nor[i * 3 + 2]);
    acc.setRGB(tint.r * ambient, tint.g * ambient, tint.b * ambient);

    for (const L of lights) {
      const dx = L.x - p.x;
      const dy = L.y - p.y;
      const dz = L.z - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > L.radius * L.radius) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const lambert = Math.max(0, (dx * n.x + dy * n.y + dz * n.z) / d);
      // Wrapped lighting keeps back faces from going pitch black.
      const wrapped = lambert * 0.82 + 0.18;
      const atten = Math.max(0, 1 - d / L.radius);
      const f = wrapped * atten * atten * L.intensity;
      acc.r += L.color.r * f;
      acc.g += L.color.g * f;
      acc.b += L.color.b * f;
    }

    batch.col[i * 3] = Math.min(1.35, acc.r);
    batch.col[i * 3 + 1] = Math.min(1.35, acc.g);
    batch.col[i * 3 + 2] = Math.min(1.35, acc.b);
  }
}

function isOpenTile(t: number): boolean {
  return t === T_FLOOR || t === T_DOOR || t === T_BARRICADE;
}

/**
 * Builds the whole static level. Door and barricade tiles get floor and ceiling
 * but no wall faces, so a bought door reveals a finished opening.
 */
export function buildLevel(map: Uint8Array): BuiltLevel {
  const tex = textures();
  const group = new THREE.Group();
  const lights = bakeLights();

  // One batch per (texture, tint) pair so baked colour stays per-room.
  const batches = new Map<string, { batch: Batch; tex: THREE.Texture; tint: THREE.Color; amb: number }>();

  const getBatch = (key: string, t: THREE.Texture, tint: number, amb: number): Batch => {
    const id = `${key}|${tint}`;
    let entry = batches.get(id);
    if (!entry) {
      entry = { batch: new Batch(), tex: t, tint: new THREE.Color(tint), amb };
      batches.set(id, entry);
    }
    return entry.batch;
  };

  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const wallRepeatY = WALL_H / TILE;

  for (let tz = 0; tz < MAP_H; tz++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const t = map[tz * MAP_W + tx];
      if (!isOpenTile(t)) continue;

      const s = surfaceFor(tx, tz);
      const x0 = tx * TILE;
      const z0 = tz * TILE;
      const x1 = x0 + TILE;
      const z1 = z0 + TILE;

      // Floor.
      getBatch(`floor${s.floor.id}`, s.floor, s.tint, 0.2).quad(
        v(x0, 0, z1), v(x1, 0, z1), v(x1, 0, z0), v(x0, 0, z0),
        v(0, 1, 0), 1, 1,
      );

      // Ceiling.
      getBatch('ceil', tex.ceiling, s.tint, 0.12).quad(
        v(x0, WALL_H, z0), v(x1, WALL_H, z0), v(x1, WALL_H, z1), v(x0, WALL_H, z1),
        v(0, -1, 0), 1, 1,
      );

      // Walls: one inward-facing quad per solid neighbour.
      const neighbours: [number, number, THREE.Vector3, THREE.Vector3[]][] = [
        // -x neighbour: face looks toward +x
        [-1, 0, v(1, 0, 0), [v(x0, 0, z0), v(x0, 0, z1), v(x0, WALL_H, z1), v(x0, WALL_H, z0)]],
        // +x neighbour: face looks toward -x
        [1, 0, v(-1, 0, 0), [v(x1, 0, z1), v(x1, 0, z0), v(x1, WALL_H, z0), v(x1, WALL_H, z1)]],
        // -z neighbour: face looks toward +z
        [0, -1, v(0, 0, 1), [v(x1, 0, z0), v(x0, 0, z0), v(x0, WALL_H, z0), v(x1, WALL_H, z0)]],
        // +z neighbour: face looks toward -z
        [0, 1, v(0, 0, -1), [v(x0, 0, z1), v(x1, 0, z1), v(x1, WALL_H, z1), v(x0, WALL_H, z1)]],
      ];

      for (const [dx, dz, normal, corners] of neighbours) {
        const nx = tx + dx;
        const nz = tz + dz;
        const nt = nx < 0 || nz < 0 || nx >= MAP_W || nz >= MAP_H ? 0 : map[nz * MAP_W + nx];
        if (isOpenTile(nt)) continue;
        getBatch(`wall${s.wall.id}`, s.wall, s.tint, 0.16).quad(
          corners[0], corners[1], corners[2], corners[3], normal, 1, wallRepeatY,
        );
      }
    }
  }

  for (const entry of batches.values()) {
    applyBake(entry.batch, lights, entry.tint, entry.amb);
    const mesh = entry.batch.build(entry.tex);
    if (mesh) group.add(mesh);
  }

  // Ceiling lamps: emissive boxes under each baked light, plus a dim halo.
  const lamps: THREE.Mesh[] = [];
  const lampGeo = new THREE.BoxGeometry(1.5, 0.25, 1.5);
  for (const L of lights) {
    const mat = new THREE.MeshBasicMaterial({ color: L.color.clone().multiplyScalar(1.0) });
    const lamp = new THREE.Mesh(lampGeo, mat);
    lamp.position.set(L.x, WALL_H - 0.16, L.z);
    lamp.matrixAutoUpdate = false;
    lamp.updateMatrix();
    group.add(lamp);
    lamps.push(lamp);

    const housing = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.3, 1.9),
      new THREE.MeshLambertMaterial({ color: 0x1a1c20 }),
    );
    housing.position.set(L.x, WALL_H - 0.02, L.z);
    housing.matrixAutoUpdate = false;
    housing.updateMatrix();
    group.add(housing);
  }

  group.matrixAutoUpdate = false;
  group.updateMatrix();
  return { group, lamps, lights };
}

/** Per-zone fog colour so each room reads differently at distance. */
export function zoneFogColor(zone: ZoneId | null): THREE.Color {
  switch (zone) {
    case 'furnace':
      return new THREE.Color(0x1a0d08);
    case 'chapel':
      return new THREE.Color(0x0a0e18);
    case 'armory':
      return new THREE.Color(0x101208);
    case 'catacombs':
      return new THREE.Color(0x0c0a14);
    case 'power':
      return new THREE.Color(0x061210);
    case 'lobby':
      return new THREE.Color(0x120f0a);
    default:
      return new THREE.Color(0x0a0a0c);
  }
}
