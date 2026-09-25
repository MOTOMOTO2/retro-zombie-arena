/**
 * Collects static geometry into one buffer per material and bakes the lighting
 * into its vertex colours. Walls, floors, set dressing and lamp housings all
 * go through here, so a whole room costs a handful of draw calls and is lit by
 * exactly the same lamps whether it is architecture or a gurney.
 */

import * as THREE from 'three';
import type { Lighting } from './lighting.ts';

export type MatSpec = {
  map?: THREE.Texture;
  color?: number;
  /** Texture repeat size in world units for 'world' UVs. */
  uvScale?: number;
  /** 'world' projects UVs from position (consistent texel size); 'box' keeps each face 0..1. */
  uv?: 'world' | 'box';
};

type Entry = {
  map: THREE.Texture | null;
  color: number;
  emissive: boolean;
  pos: number[];
  nor: number[];
  uv: number[];
  /** Per-vertex ambient colour (already scaled) and occlusion. */
  amb: number[];
  ao: number[];
  /** Emissive entries carry their final colour instead of being baked. */
  col: number[];
};

const tmpV = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const tmpC = new THREE.Color();
const tmpAmb = new THREE.Color();
const normalMat = new THREE.Matrix3();

export class Batcher {
  private readonly entries = new Map<string, Entry>();

  private entry(spec: MatSpec, emissive = false): Entry {
    const key = `${emissive ? 'E' : 'L'}|${spec.map?.uuid ?? '-'}|${spec.color ?? 0xffffff}`;
    let e = this.entries.get(key);
    if (!e) {
      e = {
        map: spec.map ?? null,
        color: spec.color ?? 0xffffff,
        emissive,
        pos: [], nor: [], uv: [], amb: [], ao: [], col: [],
      };
      this.entries.set(key, e);
    }
    return e;
  }

  /**
   * One quad, corners in counter-clockwise order as seen from the front.
   * `ambient` is the bounce colour for this surface; `ao` is per corner.
   */
  quad(
    spec: MatSpec,
    a: number[], b: number[], c: number[], d: number[],
    n: number[], uvs: number[], ambient: THREE.Color, ao: number[],
  ): void {
    const e = this.entry(spec);
    const verts = [a, b, c, a, c, d];
    const idx = [0, 1, 2, 0, 2, 3];
    for (let i = 0; i < 6; i++) {
      const v = verts[i];
      e.pos.push(v[0], v[1], v[2]);
      e.nor.push(n[0], n[1], n[2]);
      e.uv.push(uvs[idx[i] * 2], uvs[idx[i] * 2 + 1]);
      e.amb.push(ambient.r, ambient.g, ambient.b);
      e.ao.push(ao[idx[i]]);
    }
  }

  /** An unlit textured quad at a fixed colour: skies seen through windows. */
  unlitQuad(map: THREE.Texture, a: number[], b: number[], c: number[], d: number[], uvs: number[], color: THREE.Color): void {
    const e = this.entry({ map }, true);
    const verts = [a, b, c, a, c, d];
    const idx = [0, 1, 2, 0, 2, 3];
    for (let i = 0; i < 6; i++) {
      const v = verts[i];
      e.pos.push(v[0], v[1], v[2]);
      e.nor.push(0, 0, 1);
      e.uv.push(uvs[idx[i] * 2], uvs[idx[i] * 2 + 1]);
      e.col.push(color.r, color.g, color.b);
    }
  }

  /**
   * Adds any three.js geometry, transformed. Occlusion darkens the parts of a
   * prop that sit close to the floor, which is what grounds it in the room.
   */
  geometry(
    spec: MatSpec, geo: THREE.BufferGeometry, matrix: THREE.Matrix4, ambient: THREE.Color,
    emissiveColor?: THREE.Color,
  ): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const e = this.entry(spec, Boolean(emissiveColor));
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    normalMat.getNormalMatrix(matrix);
    const scale = spec.uvScale ?? 2;
    for (let i = 0; i < pos.count; i++) {
      tmpV.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      tmpN.fromBufferAttribute(nor, i).applyMatrix3(normalMat).normalize();
      e.pos.push(tmpV.x, tmpV.y, tmpV.z);
      e.nor.push(tmpN.x, tmpN.y, tmpN.z);
      if (spec.uv === 'box' && uv) {
        e.uv.push(uv.getX(i), uv.getY(i));
      } else {
        const ax = Math.abs(tmpN.x);
        const ay = Math.abs(tmpN.y);
        const az = Math.abs(tmpN.z);
        if (ay >= ax && ay >= az) e.uv.push(tmpV.x / scale, tmpV.z / scale);
        else if (ax >= az) e.uv.push(tmpV.z / scale, tmpV.y / scale);
        else e.uv.push(tmpV.x / scale, tmpV.y / scale);
      }
      if (emissiveColor) {
        e.col.push(emissiveColor.r, emissiveColor.g, emissiveColor.b);
      } else {
        e.amb.push(ambient.r, ambient.g, ambient.b);
        e.ao.push(0.62 + 0.38 * Math.min(1, Math.max(0, tmpV.y / 1.6)));
      }
    }
    if (g !== geo) g.dispose();
  }

  box(
    spec: MatSpec, ambient: THREE.Color,
    sx: number, sy: number, sz: number, x: number, y: number, z: number,
    rotY = 0, rotX = 0, rotZ = 0,
  ): void {
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, rotZ, 'YXZ')),
      new THREE.Vector3(1, 1, 1),
    );
    this.geometry(spec, geo, m, ambient);
    geo.dispose();
  }

  cylinder(
    spec: MatSpec, ambient: THREE.Color,
    rTop: number, rBottom: number, h: number, segments: number,
    x: number, y: number, z: number, rotX = 0, rotZ = 0, rotY = 0, open = false,
  ): void {
    const geo = new THREE.CylinderGeometry(rTop, rBottom, h, segments, 1, open);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, rotZ, 'YXZ')),
      new THREE.Vector3(1, 1, 1),
    );
    this.geometry(spec, geo, m, ambient);
    geo.dispose();
  }

  /** Unlit geometry at a fixed (possibly over-bright) colour: lamp tubes, fire, screens. */
  glow(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, color: THREE.Color): void {
    this.geometry({}, geo, matrix, tmpAmb, color);
  }

  /** Bakes every batch and returns the finished meshes. */
  build(lighting: Lighting): THREE.Group {
    const group = new THREE.Group();
    for (const e of this.entries.values()) {
      if (!e.pos.length) continue;
      const count = e.pos.length / 3;
      const col = new Float32Array(count * 3);
      if (e.emissive) {
        col.set(e.col);
      } else {
        for (let i = 0; i < count; i++) {
          tmpAmb.setRGB(e.amb[i * 3], e.amb[i * 3 + 1], e.amb[i * 3 + 2]);
          lighting.shade(
            e.pos[i * 3], e.pos[i * 3 + 1], e.pos[i * 3 + 2],
            e.nor[i * 3], e.nor[i * 3 + 1], e.nor[i * 3 + 2],
            tmpAmb, e.ao[i], tmpC,
          );
          col[i * 3] = Math.min(3, tmpC.r);
          col[i * 3 + 1] = Math.min(3, tmpC.g);
          col[i * 3 + 2] = Math.min(3, tmpC.b);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(e.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(e.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(e.uv.length ? e.uv : new Array(count * 2).fill(0), 2));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.computeBoundingSphere();
      const mat = e.emissive
        ? new THREE.MeshBasicMaterial({ map: e.map, vertexColors: true })
        : new THREE.MeshLambertMaterial({ map: e.map, color: e.color, vertexColors: true });
      const mesh = new THREE.Mesh(g, mat);
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    group.matrixAutoUpdate = false;
    return group;
  }
}
