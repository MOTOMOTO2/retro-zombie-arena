/**
 * The props the story hangs on: the three parts waiting on crates around the
 * map, the workbench they are built into, and the way out of the start room
 * that stays sealed until the boss is dead.
 */

import * as THREE from 'three';
import { flatMaterial } from '../gfx/models.ts';
import { textures } from '../gfx/textures.ts';
import { TILE, WALL_H, type WallProp, tileCenter } from './mapdata.ts';
import type { LightProbe } from './lighting.ts';

const PART_GLOW = new THREE.Color(0.5, 2.4, 1.9);

/** Bright at the bottom, gone at the top: a shaft of light rather than a pillar. */
let beamTexture: THREE.CanvasTexture | null = null;
function beamFade(): THREE.CanvasTexture {
  if (beamTexture) return beamTexture;
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const g = x.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,1)');
  x.fillStyle = g;
  x.fillRect(0, 0, 4, 64);
  beamTexture = new THREE.CanvasTexture(c);
  return beamTexture;
}

function againstWall(p: WallProp, inset: number): THREE.Vector3 {
  const c = tileCenter(p.tx, p.tz);
  const nx = Math.sin(p.facing);
  const nz = Math.cos(p.facing);
  return new THREE.Vector3(c.x - nx * (TILE / 2 - inset), 0, c.z - nz * (TILE / 2 - inset));
}

/** Lit materials in a prop pick up the room light where it stands. */
function tint(root: THREE.Object3D, probe: LightProbe, x: number, z: number): void {
  const light = probe.sample(x, z, new THREE.Color());
  light.r = Math.max(0.25, light.r);
  light.g = Math.max(0.25, light.g);
  light.b = Math.max(0.25, light.b);
  const seen = new Map<THREE.Material, THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !(mesh.material instanceof THREE.MeshLambertMaterial)) return;
    let copy = seen.get(mesh.material);
    if (!copy) {
      const c = mesh.material.clone();
      c.color.multiply(light);
      seen.set(mesh.material, c);
      copy = c;
    }
    mesh.material = copy;
  });
}

function disposeAll(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m.dispose();
  });
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/** One of the three quest parts, as a small glowing model. */
export function partModel(index: number): THREE.Group {
  const g = new THREE.Group();
  const glow = new THREE.MeshBasicMaterial({ color: PART_GLOW });
  const metal = new THREE.MeshLambertMaterial({ map: textures().metal });
  if (index === 0) {
    // A canister or tube.
    mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.75, 8), metal, 0, 0, 0, g);
    mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.16, 8), glow, 0, 0.1, 0, g);
    mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.2, 6), metal, 0, 0.46, 0, g);
  } else if (index === 1) {
    // A coil around a glowing core.
    const coil = mesh(new THREE.TorusGeometry(0.3, 0.09, 6, 12), new THREE.MeshLambertMaterial({ color: 0xb87333 }), 0, 0, 0, g);
    coil.rotation.x = Math.PI / 2;
    const coil2 = mesh(new THREE.TorusGeometry(0.3, 0.09, 6, 12), new THREE.MeshLambertMaterial({ color: 0xb87333 }), 0, 0.2, 0, g);
    coil2.rotation.x = Math.PI / 2;
    mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.6, 6), glow, 0, 0.1, 0, g);
  } else {
    // A boxy device with a crystal on top.
    mesh(new THREE.BoxGeometry(0.6, 0.36, 0.4), new THREE.MeshLambertMaterial({ color: 0x2a2c30 }), 0, 0, 0, g);
    mesh(new THREE.BoxGeometry(0.3, 0.12, 0.04), glow, 0, 0.02, 0.21, g);
    mesh(new THREE.OctahedronGeometry(0.2, 0), glow, 0, 0.36, 0, g);
  }
  return g;
}

/* ------------------------------------------------------------------ parts */

export class PartProp {
  readonly group = new THREE.Group();
  readonly center: THREE.Vector3;
  readonly index: number;
  private readonly item: THREE.Group;
  private readonly beam: THREE.Mesh;
  private readonly beamMat: THREE.MeshBasicMaterial;
  taken = false;

  constructor(p: WallProp, index: number, probe: LightProbe) {
    this.index = index;
    const pos = againstWall(p, 1.2);
    this.center = new THREE.Vector3(pos.x, 1.6, pos.z);
    this.group.position.copy(pos);
    this.group.rotation.y = p.facing;

    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), new THREE.MeshLambertMaterial({ map: textures().crate }));
    crate.position.y = 0.75;
    this.group.add(crate);
    const cloth = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 1.2), flatMaterial(0x3a2a22));
    cloth.position.y = 1.53;
    this.group.add(cloth);

    this.item = partModel(index);
    this.item.position.y = 2.2;
    this.item.scale.setScalar(1.4);
    this.group.add(this.item);

    // A shaft of light so it can be found from across a big room.
    this.beamMat = new THREE.MeshBasicMaterial({
      color: PART_GLOW, map: beamFade(), transparent: true, opacity: 0.2, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.75, WALL_H - 1.6, 8, 1, true), this.beamMat);
    this.beam.position.y = 1.6 + (WALL_H - 1.6) / 2;
    this.group.add(this.beam);
    tint(this.group, probe, pos.x, pos.z);
  }

  setTaken(taken: boolean): void {
    this.taken = taken;
    this.item.visible = !taken;
    this.beam.visible = !taken;
  }

  animate(t: number): void {
    if (this.taken) return;
    this.item.rotation.y = t * 1.6 + this.index;
    this.item.position.y = 2.2 + Math.sin(t * 2.2 + this.index) * 0.12;
    this.beamMat.opacity = 0.14 + 0.06 * Math.sin(t * 3 + this.index);
  }

  dispose(): void {
    disposeAll(this.group);
  }
}

/* -------------------------------------------------------------- workbench */

export class WorkbenchProp {
  readonly group = new THREE.Group();
  readonly center: THREE.Vector3;
  private readonly slots: THREE.Group[] = [];
  private readonly ghosts: THREE.Mesh[] = [];
  private readonly lampMat: THREE.MeshBasicMaterial;
  private readonly device = new THREE.Group();
  private readonly deviceGlow: THREE.MeshBasicMaterial;
  private built = false;

  constructor(p: WallProp, probe: LightProbe) {
    const pos = againstWall(p, 1.3);
    this.center = new THREE.Vector3(pos.x, 1.8, pos.z);
    this.group.position.copy(pos);
    this.group.rotation.y = p.facing;

    const wood = new THREE.MeshLambertMaterial({ map: textures().wood });
    const steel = new THREE.MeshLambertMaterial({ map: textures().metalDark });
    mesh(new THREE.BoxGeometry(3.8, 0.2, 1.8), wood, 0, 1.7, 0, this.group);
    for (const [x, z] of [[-1.7, -0.7], [1.7, -0.7], [-1.7, 0.7], [1.7, 0.7]]) {
      mesh(new THREE.BoxGeometry(0.2, 1.6, 0.2), steel, x, 0.8, z, this.group);
    }
    mesh(new THREE.BoxGeometry(3.6, 0.12, 1.6), wood, 0, 0.5, 0, this.group);
    // Pegboard of tools behind it.
    mesh(new THREE.BoxGeometry(3.8, 2.4, 0.1), new THREE.MeshLambertMaterial({ color: 0x6a5a3a }), 0, 3.4, -0.95, this.group);
    for (let i = 0; i < 6; i++) {
      const tool = mesh(new THREE.BoxGeometry(0.12, 0.8, 0.08), flatMaterial(0x2a2c2e), -1.4 + i * 0.55, 3.4, -0.86, this.group);
      tool.rotation.z = (i % 3 - 1) * 0.3;
    }
    // Vice.
    mesh(new THREE.BoxGeometry(0.5, 0.4, 0.6), flatMaterial(0x3a4a6a), 1.5, 2.0, 0.4, this.group);

    // Three spots on the bench for the parts; outlines until they turn up.
    for (let i = 0; i < 3; i++) {
      const slot = new THREE.Group();
      slot.position.set(-1.1 + i * 1.1, 2.1, 0.2);
      this.group.add(slot);
      this.slots.push(slot);
      const ghost = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 0.03, 0.7),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.9, 0.7) }),
      );
      ghost.position.set(slot.position.x, 1.82, 0.2);
      this.group.add(ghost);
      this.ghosts.push(ghost);
    }

    // The status lamp: red until it can be built.
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0x551111 });
    mesh(new THREE.BoxGeometry(0.35, 0.35, 0.2), this.lampMat, -1.6, 4.4, -0.85, this.group);

    // What gets built: a squat machine with an aerial and a glowing heart.
    this.deviceGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.8, 0.4) });
    mesh(new THREE.BoxGeometry(1.4, 0.9, 0.9), steel, 0, 0.45, 0, this.device);
    mesh(new THREE.BoxGeometry(1.0, 0.3, 0.05), this.deviceGlow, 0, 0.55, 0.47, this.device);
    mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.8, 4), steel, 0.5, 1.8, 0, this.device);
    mesh(new THREE.OctahedronGeometry(0.16, 0), this.deviceGlow, 0.5, 2.75, 0, this.device);
    this.device.position.set(0, 1.8, 0.1);
    this.device.visible = false;
    this.group.add(this.device);

    tint(this.group, probe, pos.x, pos.z);
  }

  /** Shows the parts found so far on the bench. */
  setParts(found: readonly boolean[]): void {
    found.forEach((have, i) => {
      const slot = this.slots[i];
      if (have && !slot.children.length && !this.built) {
        const m = partModel(i);
        m.scale.setScalar(1.2);
        slot.add(m);
      }
      if (!have) for (const c of [...slot.children]) slot.remove(c);
      this.ghosts[i].visible = !have && !this.built;
    });
  }

  setReady(ready: boolean): void {
    if (this.built) return;
    this.lampMat.color.set(ready ? 0x55ff88 : 0x551111).multiplyScalar(ready ? 3 : 1);
  }

  setBuilt(built: boolean): void {
    this.built = built;
    this.device.visible = built;
    for (const s of this.slots) s.visible = !built;
    for (const g of this.ghosts) g.visible = !built && g.visible;
    if (built) this.lampMat.color.set(0xff5533).multiplyScalar(3);
  }

  animate(t: number): void {
    for (const s of this.slots) for (const c of s.children) c.rotation.y = t * 0.8;
    if (this.built) {
      const k = 0.6 + 0.4 * Math.abs(Math.sin(t * 4));
      this.deviceGlow.color.setRGB(3 * k, 0.8 * k, 0.4 * k);
    }
  }

  dispose(): void {
    for (const s of this.slots) for (const c of [...s.children]) {
      s.remove(c);
      disposeAll(c);
    }
    disposeAll(this.group);
  }
}

/* ------------------------------------------------------------------- exit */

export class ExitProp {
  readonly group = new THREE.Group();
  readonly center: THREE.Vector3;
  private readonly leaves: THREE.Group[] = [];
  private readonly chains: THREE.Group;
  private readonly signMat: THREE.MeshBasicMaterial;
  private readonly light: THREE.Mesh;
  private readonly lightMat: THREE.MeshBasicMaterial;
  private readonly beamMat: THREE.MeshBasicMaterial;
  private readonly beam: THREE.Mesh;
  private openT = 0;
  open = false;

  constructor(p: WallProp, probe: LightProbe) {
    const pos = againstWall(p, 0.15);
    this.center = new THREE.Vector3(pos.x, 2.4, pos.z);
    this.group.position.copy(pos);
    this.group.rotation.y = p.facing;

    const steel = new THREE.MeshLambertMaterial({ map: textures().metalDark });
    const frame = new THREE.MeshLambertMaterial({ color: 0x2a2c2e });
    mesh(new THREE.BoxGeometry(4.2, 0.5, 0.6), frame, 0, 6.05, 0.2, this.group);
    for (const x of [-2.0, 2.0]) mesh(new THREE.BoxGeometry(0.4, 6.3, 0.6), frame, x, 3.15, 0.2, this.group);

    // What waits beyond, dark until the gate opens.
    this.lightMat = new THREE.MeshBasicMaterial({ color: 0x050607 });
    this.light = mesh(new THREE.BoxGeometry(3.6, 5.8, 0.05), this.lightMat, 0, 2.9, 0.02, this.group);

    for (const side of [-1, 1]) {
      const leaf = new THREE.Group();
      leaf.position.set(side * 1.8, 0, 0.3);
      const panel = mesh(new THREE.BoxGeometry(1.8, 5.8, 0.18), steel, -side * 0.9, 2.9, 0, leaf);
      panel.castShadow = false;
      for (const y of [1.2, 2.9, 4.6]) mesh(new THREE.BoxGeometry(1.7, 0.14, 0.24), frame, -side * 0.9, y, 0, leaf);
      mesh(new THREE.BoxGeometry(0.12, 0.6, 0.3), flatMaterial(0x8a8a86), -side * 1.6, 2.8, 0.1, leaf);
      this.group.add(leaf);
      this.leaves.push(leaf);
    }

    // Chained and padlocked.
    this.chains = new THREE.Group();
    const chain = flatMaterial(0x6a6a66);
    for (let i = 0; i < 9; i++) {
      const link = mesh(new THREE.BoxGeometry(0.34, 0.16, 0.08), chain, -1.6 + i * 0.4, 2.9 + Math.sin(i * 0.8) * 0.3, 0.52, this.chains);
      link.rotation.z = i % 2 ? 0.5 : -0.5;
    }
    mesh(new THREE.BoxGeometry(0.5, 0.6, 0.25), flatMaterial(0x8a7a3a), 0, 2.6, 0.58, this.chains);
    this.group.add(this.chains);

    // EXIT sign over the door.
    this.signMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.3, 0.2) });
    mesh(new THREE.BoxGeometry(1.8, 0.6, 0.12), flatMaterial(0x141414), 0, 6.8, 0.3, this.group);
    mesh(new THREE.BoxGeometry(1.5, 0.36, 0.06), this.signMat, 0, 6.8, 0.38, this.group);

    this.beamMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.4, 2.2, 0.8), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.beam = new THREE.Mesh(new THREE.BoxGeometry(3.4, 5.6, 3.0), this.beamMat);
    this.beam.position.set(0, 2.8, 1.6);
    this.beam.visible = false;
    this.group.add(this.beam);

    tint(this.group, probe, pos.x, pos.z);
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.chains.visible = !open;
    this.signMat.color.setRGB(open ? 0.4 : 2.6, open ? 2.8 : 0.3, open ? 0.6 : 0.2);
    this.lightMat.color.set(open ? new THREE.Color(2.2, 2.4, 2.0) : new THREE.Color(0x050607));
    this.beam.visible = open;
    if (!open) this.openT = 0;
  }

  animate(t: number, dt: number): void {
    if (!this.open) {
      for (const l of this.leaves) l.rotation.y = 0;
      return;
    }
    this.openT = Math.min(1, this.openT + dt * 0.8);
    const k = this.openT * this.openT * (3 - 2 * this.openT);
    this.leaves[0].rotation.y = -k * 1.4;
    this.leaves[1].rotation.y = k * 1.4;
    this.beamMat.opacity = 0.14 + 0.06 * Math.sin(t * 3);
    this.light.visible = true;
  }

  dispose(): void {
    disposeAll(this.group);
  }
}

export type QuestProps = {
  parts: PartProp[];
  bench: WorkbenchProp;
  exit: ExitProp;
};

export function buildQuestProps(parts: WallProp[], bench: WallProp, exit: WallProp, probe: LightProbe): QuestProps {
  return {
    parts: parts.map((p, i) => new PartProp(p, i, probe)),
    bench: new WorkbenchProp(bench, probe),
    exit: new ExitProp(exit, probe),
  };
}

export function questGroups(q: QuestProps): THREE.Object3D[] {
  return [...q.parts.map((p) => p.group), q.bench.group, q.exit.group];
}

export function disposeQuestProps(q: QuestProps): void {
  for (const p of q.parts) p.dispose();
  q.bench.dispose();
  q.exit.dispose();
}
