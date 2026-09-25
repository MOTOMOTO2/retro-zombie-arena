/**
 * The four bosses. Each is the zombie rig built big, then dressed: the
 * Warden's straitjacket straps and riot baton, the Butcher's apron and
 * cleaver, the Furnace Man's charred skin split with glowing cracks, and
 * Patient Zero's veins lit up green with the compound.
 */

import * as THREE from 'three';
import { buildZombie, type ZombieModel } from './models.ts';
import type { BossId } from '../game/story.ts';

export type BossModel = ZombieModel & {
  /** Unlit glowing parts, pulsed by the boss as it gets angrier. */
  glows: { mat: THREE.MeshBasicMaterial; base: THREE.Color }[];
};

const UNIT = new THREE.BoxGeometry(1, 1, 1);
UNIT.userData.shared = true;

function add(
  parent: THREE.Object3D, sx: number, sy: number, sz: number,
  x: number, y: number, z: number, mat: THREE.Material, rx = 0, ry = 0, rz = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(UNIT, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

/** The forearm joint inside an arm, where things are held. */
function forearm(arm: THREE.Group): THREE.Group {
  const f = arm.children.find((c) => !(c as THREE.Mesh).isMesh);
  return (f as THREE.Group) ?? arm;
}

function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function buildBoss(id: BossId): BossModel {
  const glows: BossModel['glows'] = [];
  const glow = (r: number, g: number, b: number): THREE.MeshBasicMaterial => {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });
    glows.push({ mat, base: mat.color.clone() });
    return mat;
  };
  let m: ZombieModel;
  const lit = (color: number): THREE.MeshLambertMaterial => {
    const mat = new THREE.MeshLambertMaterial({ color });
    m.lit.push({ mat, base: mat.color.clone() });
    return mat;
  };

  switch (id) {
    case 'warden': {
      const s = 1.7;
      const w = 1.85;
      m = buildZombie({ skin: 1, damage: 0, tall: s, wide: w, outfit: 'orderly', cloth: 1, eyes: glow(4.2, 0.5, 0.3) });
      const strap = lit(0x2a2018);
      const brass = lit(0x9a8a4a);
      // Straitjacket straps and buckles, worn over the orderly's coat.
      for (const y of [0.5, 0.8, 1.08]) {
        add(m.body, 1.0 * w, 0.08 * s, 0.6 * w, 0, y * s, 0, strap);
        add(m.body, 0.1, 0.1, 0.04, 0.2 * w, y * s, 0.31 * w, brass);
      }
      add(m.body, 0.1 * w, 1.0 * s, 0.62 * w, -0.22 * w, 0.8 * s, 0, strap, 0, 0, 0.5);
      // A leather muzzle.
      add(m.head, 0.46 * w, 0.22 * s, 0.1, 0, -0.06 * s, 0.26 * w, strap);
      add(m.head, 0.56 * w, 0.06 * s, 0.56 * w, 0, -0.02 * s, 0, strap);
      // The gate keys.
      for (let i = 0; i < 4; i++) add(m.body, 0.05, 0.2, 0.03, 0.28 * w + i * 0.07, -0.05 * s, 0.3 * w, brass, 0, 0, (i - 1.5) * 0.3);
      // Riot baton in the right fist.
      add(forearm(m.armR), 0.2, 0.2, 2.6, 0, -0.78 * s, 0.9, lit(0x141414));
      break;
    }
    case 'butcher': {
      const s = 1.62;
      const w = 2.15;
      m = buildZombie({ skin: 2, damage: 0, tall: s, wide: w, outfit: 'civilian', cloth: 2, eyes: glow(4, 1.6, 0.3) });
      const apron = lit(0xcfc6b0);
      const blood = lit(0x5a0a08);
      const steel = lit(0xa8aeb2);
      add(m.body, 0.84 * w, 1.25 * s, 0.05, 0, 0.42 * s, 0.31 * w, apron);
      for (let i = 0; i < 6; i++) {
        add(m.body, (0.12 + hash(i) * 0.2) * w, (0.1 + hash(i + 9) * 0.3) * s, 0.06,
          (hash(i + 3) - 0.5) * 0.6 * w, (0.1 + hash(i + 5) * 1.0) * s, 0.32 * w, blood);
      }
      // Butcher's cap.
      add(m.head, 0.56 * w, 0.14 * s, 0.56 * w, 0, 0.44 * s, 0, apron);
      // Cleaver in the right hand, a meat hook in the left.
      const fr = forearm(m.armR);
      add(fr, 0.16, 0.16, 0.8, 0, -0.78 * s, 0.35, lit(0x3a2414));
      add(fr, 0.06, 1.0, 1.2, 0, -0.62 * s, 1.3, steel);
      add(fr, 0.07, 0.12, 1.2, 0, -0.62 * s - 0.5, 1.3, blood);
      const fl = forearm(m.armL);
      add(fl, 0.09, 0.09, 1.1, 0, -0.78 * s, 0.5, steel);
      add(fl, 0.09, 0.5, 0.09, 0, -0.78 * s - 0.22, 1.05, steel);
      break;
    }
    case 'furnace': {
      const s = 1.85;
      const w = 1.75;
      m = buildZombie({ skin: 3, damage: 4, tall: s, wide: w, outfit: 'guard', cloth: 0, eyes: glow(6, 4, 1.4) });
      // Charred black, split with cracks that still glow.
      for (const l of m.lit) l.base.multiply(new THREE.Color(0.3, 0.24, 0.2));
      const ember = glow(5.5, 1.6, 0.25);
      for (let i = 0; i < 16; i++) {
        const front = i % 2 === 0 ? 1 : -1;
        add(m.body, (0.12 + hash(i) * 0.3) * w, 0.05 * s, 0.03, (hash(i + 7) - 0.5) * 0.8 * w, (0.15 + hash(i + 2) * 1.1) * s,
          front * 0.3 * w, ember, 0, 0, (hash(i + 4) - 0.5) * 1.8);
      }
      for (const arm of [m.armL, m.armR]) {
        for (let i = 0; i < 3; i++) add(arm, 0.3 * w, 0.04 * s, 0.32 * w, 0, -(0.15 + i * 0.2) * s, 0, ember, 0, 0, hash(i) - 0.5);
      }
      for (const leg of [m.legL, m.legR]) add(leg, 0.36 * w, 0.05 * s, 0.4 * w, 0, -0.5 * s, 0, ember, 0, 0, 0.3);
      // The foundry helmet he died in, and a mouth like an open firebox.
      add(m.head, 0.62 * w, 0.2 * s, 0.62 * w, 0, 0.44 * s, 0, lit(0x3a3a3a));
      add(m.head, 0.66 * w, 0.04 * s, 0.7 * w, 0, 0.34 * s, 0.04, lit(0x2a2a2a));
      add(m.head, 0.32 * w, 0.09 * s, 0.05, 0, -0.08 * s, 0.27 * w, ember);
      // A shovel, for stoking.
      const fr = forearm(m.armR);
      add(fr, 0.14, 0.14, 2.8, 0, -0.78 * s, 1.0, lit(0x3a2414));
      add(fr, 0.06, 0.9, 0.8, 0, -0.78 * s, 2.6, lit(0x2a2a2a));
      break;
    }
    case 'patient0': {
      const s = 1.55;
      const w = 1.25;
      m = buildZombie({ skin: 0, damage: 4, tall: s, wide: w, outfit: 'patient', cloth: 4, eyes: glow(0.6, 4.2, 1.4) });
      for (const l of m.lit) l.base.multiply(new THREE.Color(0.82, 0.95, 0.82));
      const vein = glow(0.4, 3.0, 1.0);
      const growth = lit(0x6a7a5a);
      const tube = lit(0x9ab8a8);
      // The compound, visible under the skin.
      for (let i = 0; i < 14; i++) {
        const front = i % 3 === 0 ? -1 : 1;
        add(m.body, 0.03, (0.2 + hash(i) * 0.4) * s, 0.03, (hash(i + 1) - 0.5) * 0.8 * w, (0.3 + hash(i + 8) * 0.9) * s,
          front * 0.28 * w, vein, 0, 0, (hash(i + 3) - 0.5) * 1.2);
      }
      for (const arm of [m.armL, m.armR]) add(arm, 0.03, 0.6 * s, 0.31 * w, 0, -0.35 * s, 0, vein);
      add(m.head, 0.03, 0.3 * s, 0.52 * w, 0.18 * w, 0.2 * s, 0, vein);
      add(m.head, 0.03, 0.3 * s, 0.52 * w, -0.2 * w, 0.1 * s, 0, vein);
      // Growths where the compound has been feeding.
      add(m.body, 0.55 * w, 0.6 * s, 0.45 * w, -0.3 * w, 1.15 * s, -0.25 * w, growth, 0.3, 0, 0.2);
      add(m.body, 0.4 * w, 0.45 * s, 0.4 * w, 0.35 * w, 1.3 * s, -0.1 * w, growth, -0.2, 0, -0.3);
      add(m.body, 0.3 * w, 0.3 * s, 0.3 * w, 0.1 * w, 0.4 * s, -0.3 * w, growth);
      // IV lines still taped to both arms.
      for (const arm of [m.armL, m.armR]) add(arm, 0.04, 1.6, 0.04, 0.1, -0.9 * s, -0.2, tube, 0.4);
      // Long, too long, fingers.
      for (const arm of [m.armL, m.armR]) {
        const f = forearm(arm);
        for (let k = -1; k <= 1; k++) add(f, 0.06, 0.7, 0.06, k * 0.1 * w, -1.1 * s, 0.1, lit(0xcfc7ad), 0.4);
        arm.scale.y = 1.2;
      }
      break;
    }
  }
  return { ...m, glows };
}
