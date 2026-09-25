/**
 * Interactive furniture: doors, window barricades, perk machines, the mystery
 * box, wall buys, the power switch and Pack-a-Punch.
 *
 * Every wall-standing prop is authored with its front on local +z and placed
 * with the layout's `facing`, which points into the room. Each prop is tinted
 * by the light probe where it stands, so a machine in a dark corner is dark.
 */

import * as THREE from 'three';
import { flatMaterial, buildWeaponModel } from '../gfx/models.ts';
import { placardTexture, perkTexture, textures } from '../gfx/textures.ts';
import { getWeapon } from '../game/weapons.ts';
import { PERK_INFO, type PerkId } from '../game/rules.ts';
import {
  TILE,
  WALL_H,
  type BarricadeDef,
  type DoorDef,
  type Layout,
  type WallProp,
  tileCenter,
} from './mapdata.ts';
import { HEAD, SILL } from './build.ts';
import type { LightProbe } from './lighting.ts';

const PERK_GLYPH: Record<PerkId, string> = {
  revive: '+',
  juggernog: 'J',
  speedcola: 'S',
  doubletap: 'II',
  staminup: '>>',
};

const tmpColor = new THREE.Color();

/**
 * Display models for the box and Pack-a-Punch, built once per weapon and
 * reused: the box flicks through a dozen guns a second while it rolls.
 */
class ModelShelf {
  private readonly models = new Map<string, THREE.Group>();
  private readonly scale: number;

  constructor(scale: number) {
    this.scale = scale;
  }

  get(id: string): THREE.Group {
    let m = this.models.get(id);
    if (!m) {
      m = buildWeaponModel(getWeapon(id), this.scale).group;
      this.models.set(id, m);
    }
    return m;
  }
}

/**
 * Gives every lit material in a prop its own copy, multiplied by the room
 * light at a point. Unlit materials (glows, signs) are left alone.
 */
function tintByLight(root: THREE.Object3D, probe: LightProbe, x: number, z: number): THREE.Color {
  const light = probe.sample(x, z, new THREE.Color());
  // A floor under the machines so they never go fully black.
  light.r = Math.max(0.22, light.r);
  light.g = Math.max(0.22, light.g);
  light.b = Math.max(0.22, light.b);
  const seen = new Map<THREE.Material, THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const m = mesh.material as THREE.Material;
    if (!(m instanceof THREE.MeshLambertMaterial) || m.userData.keepColor) return;
    let copy = seen.get(m);
    if (!copy) {
      const c = m.clone();
      c.color.multiply(light);
      c.userData.owned = true;
      seen.set(m, c);
      copy = c;
    }
    mesh.material = copy;
  });
  return light;
}

function disposeOwned(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const m = mesh.material as THREE.Material;
    if (m.userData.owned) m.dispose();
  });
}

/** World position of a wall prop pushed back toward its wall by `inset` units. */
function againstWall(p: WallProp, inset: number): THREE.Vector3 {
  const c = tileCenter(p.tx, p.tz);
  const nx = Math.sin(p.facing);
  const nz = Math.cos(p.facing);
  return new THREE.Vector3(c.x - nx * (TILE / 2 - inset), 0, c.z - nz * (TILE / 2 - inset));
}

/* ------------------------------------------------------------------ doors */

export class DoorProp {
  readonly def: DoorDef;
  readonly group: THREE.Group;
  readonly center: THREE.Vector3;
  open = false;
  private t = 0;

  constructor(def: DoorDef, probe: LightProbe) {
    this.def = def;
    this.group = new THREE.Group();

    const w = def.rect.w * TILE;
    const h = def.rect.h * TILE;
    const cx = (def.rect.x + def.rect.w / 2) * TILE;
    const cz = (def.rect.z + def.rect.h / 2) * TILE;
    this.center = new THREE.Vector3(cx, 1.8, cz);

    const tex = textures();
    const leaf = new THREE.Mesh(
      new THREE.BoxGeometry(w, WALL_H, h),
      new THREE.MeshLambertMaterial({ map: tex.door }),
    );
    leaf.position.set(0, WALL_H / 2, 0);
    this.group.add(leaf);

    // Boards nailed across both faces so it reads as "barred", not just a wall.
    const across = def.axis === 'z' ? h : w;
    const thick = def.axis === 'z' ? w : h;
    const plankMat = new THREE.MeshLambertMaterial({ map: tex.wood });
    for (let i = 0; i < 4; i++) {
      const plank = new THREE.Mesh(
        new THREE.BoxGeometry(
          def.axis === 'z' ? thick + 0.5 : across * 0.95,
          0.55,
          def.axis === 'z' ? across * 0.95 : thick + 0.5,
        ),
        plankMat,
      );
      plank.position.set(0, 1.4 + i * 1.8, 0);
      plank.rotation.set(0, 0, 0);
      if (def.axis === 'z') plank.rotation.x = (i % 2 === 0 ? 1 : -1) * 0.12;
      else plank.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.12;
      this.group.add(plank);
    }

    // A padlocked chain across the middle.
    const chain = new THREE.Mesh(
      new THREE.BoxGeometry(def.axis === 'z' ? thick + 0.7 : across * 0.9, 0.18, def.axis === 'z' ? across * 0.9 : thick + 0.7),
      flatMaterial(0x6a6a66),
    );
    chain.position.set(0, 3.6, 0);
    this.group.add(chain);
    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 0.8), flatMaterial(0xb8a05a));
    lock.scale.set(def.axis === 'z' ? thick / 0.8 + 1.1 : 1, 1, def.axis === 'z' ? 1 : thick / 0.8 + 1.1);
    lock.position.set(0, 3.2, 0);
    this.group.add(lock);

    this.group.position.set(cx, 0, cz);
    tintByLight(this.group, probe, cx, cz);
  }

  /** Slides the leaf up into the ceiling; returns true while still animating. */
  update(dt: number): boolean {
    if (!this.open) return false;
    if (this.t >= 1) return false;
    this.t = Math.min(1, this.t + dt * 0.75);
    const ease = 1 - Math.pow(1 - this.t, 3);
    this.group.position.y = ease * (WALL_H + 0.4);
    if (this.t >= 1) this.group.visible = false;
    return true;
  }

  reset(): void {
    this.open = false;
    this.t = 0;
    this.group.visible = true;
    this.group.position.y = 0;
  }
}

/* ------------------------------------------------------------- barricades */

export class BarricadeProp {
  readonly def: BarricadeDef;
  readonly group: THREE.Group;
  readonly center: THREE.Vector3;
  readonly maxBoards = 5;
  boards = 5;
  private readonly planks: THREE.Mesh[] = [];

  constructor(def: BarricadeDef, probe: LightProbe) {
    this.def = def;
    this.group = new THREE.Group();
    const c = tileCenter(def.tx, def.tz);
    this.center = new THREE.Vector3(c.x, 2.2, c.z);

    const tex = textures();
    const horizontal = def.dx !== 0; // the opening runs along z
    const span = TILE * 1.05;
    const mat = new THREE.MeshLambertMaterial({ map: tex.woodV });
    const step = (HEAD - SILL - 0.6) / (this.maxBoards - 1);

    for (let i = 0; i < this.maxBoards; i++) {
      const plank = new THREE.Mesh(
        new THREE.BoxGeometry(horizontal ? 0.3 : span, 0.55, horizontal ? span : 0.3),
        mat,
      );
      // Nailed across the inside face of the opening.
      plank.position.set(c.x - def.dx * 1.75, SILL + 0.35 + i * step, c.z - def.dz * 1.75);
      const tilt = (i % 2 === 0 ? 1 : -1) * (0.08 + (i % 3) * 0.03);
      if (horizontal) plank.rotation.x = tilt;
      else plank.rotation.z = tilt;
      this.planks.push(plank);
      this.group.add(plank);
    }
    tintByLight(this.group, probe, c.x - def.dx * TILE, c.z - def.dz * TILE);
    this.sync();
  }

  private sync(): void {
    for (let i = 0; i < this.planks.length; i++) this.planks[i].visible = i < this.boards;
  }

  removeBoard(): boolean {
    if (this.boards <= 0) return false;
    this.boards--;
    this.sync();
    return true;
  }

  addBoard(): boolean {
    if (this.boards >= this.maxBoards) return false;
    this.boards++;
    this.sync();
    return true;
  }

  get isOpen(): boolean {
    return this.boards <= 0;
  }
}

/* ----------------------------------------------------------- perk machine */

export class PerkMachine {
  readonly id: PerkId;
  readonly group: THREE.Group;
  readonly center: THREE.Vector3;
  readonly light: THREE.PointLight;
  private readonly signMat: THREE.MeshBasicMaterial;
  private readonly faceMat: THREE.MeshBasicMaterial;
  private readonly bodyMat: THREE.MeshLambertMaterial;
  private roomLight = new THREE.Color(1, 1, 1);
  powered = false;
  bought = false;

  constructor(id: PerkId, p: WallProp, probe: LightProbe) {
    this.id = id;
    const info = PERK_INFO[id];
    this.group = new THREE.Group();
    const c = tileCenter(p.tx, p.tz);
    this.center = new THREE.Vector3(c.x, 1.6, c.z);

    this.bodyMat = new THREE.MeshLambertMaterial({ color: 0x23262b });
    this.bodyMat.userData.keepColor = true;
    const cabinet = new THREE.Mesh(new THREE.BoxGeometry(2.2, 4.0, 1.4), this.bodyMat);
    cabinet.position.set(0, 2.0, 0);
    this.group.add(cabinet);

    this.faceMat = new THREE.MeshBasicMaterial({ map: perkTexture(info.color, info.name, PERK_GLYPH[id]) });
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 2.8), this.faceMat);
    face.position.set(0, 2.3, 0.72);
    this.group.add(face);

    const slot = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 0.2), flatMaterial(0x0b0c0e));
    slot.position.set(0, 0.7, 0.72);
    this.group.add(slot);

    this.signMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
    const sign = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.55, 0.4), this.signMat);
    sign.position.set(0, 4.3, 0.5);
    this.group.add(sign);

    this.light = new THREE.PointLight(info.color, 0, 14, 2);
    this.light.position.set(0, 3.2, 1.6);
    this.group.add(this.light);

    const pos = againstWall(p, 0.9);
    this.group.position.copy(pos);
    this.group.rotation.y = p.facing;
    this.roomLight = tintByLight(this.group, probe, c.x, c.z);
    this.setPowered(false);
  }

  setPowered(on: boolean): void {
    this.powered = on;
    const info = PERK_INFO[this.id];
    this.signMat.color.set(on ? info.color : 0x1a1a1a);
    if (on) this.signMat.color.multiplyScalar(2.2);
    this.faceMat.color.setScalar(on ? 1.4 : 0.35);
    this.bodyMat.color.set(on ? 0x3a3f46 : 0x23262b).multiply(this.roomLight);
    this.light.intensity = on ? 20 : 0;
  }

  /** Gentle pulse so a powered machine catches the eye across a dark room. */
  animate(t: number): void {
    if (!this.powered) return;
    this.light.intensity = 18 + Math.sin(t * 3.1) * 5;
  }

  dispose(): void {
    this.faceMat.map?.dispose();
    this.faceMat.dispose();
    this.signMat.dispose();
    this.bodyMat.dispose();
    disposeOwned(this.group);
  }
}

/* ------------------------------------------------------------ mystery box */

export class MysteryBox {
  readonly group: THREE.Group;
  center = new THREE.Vector3();
  padIndex = 0;
  private readonly lid: THREE.Group;
  private readonly beam: THREE.Mesh;
  private readonly light: THREE.PointLight;
  private weaponHolder: THREE.Group;
  private currentModel: THREE.Group | null = null;
  private readonly shelf = new ModelShelf(2.2);
  private readonly litMats: { mat: THREE.MeshLambertMaterial; base: THREE.Color }[] = [];
  lidOpen = 0;

  constructor() {
    this.group = new THREE.Group();
    const tex = textures();

    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 1.6, 1.7),
      new THREE.MeshLambertMaterial({ map: tex.wood }),
    );
    crate.position.y = 0.8;
    this.group.add(crate);

    for (const [x, z] of [[-1.25, -0.8], [1.25, -0.8], [-1.25, 0.8], [1.25, 0.8]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.7, 0.22), flatMaterial(0x4a3b2a));
      post.position.set(x, 0.85, z);
      this.group.add(post);
    }

    // Hinged at the back, so it opens away from whoever is buying.
    this.lid = new THREE.Group();
    this.lid.position.set(0, 1.6, -0.85);
    const lidMesh = new THREE.Mesh(
      new THREE.BoxGeometry(2.64, 0.2, 1.74),
      new THREE.MeshLambertMaterial({ map: tex.mystery }),
    );
    lidMesh.position.set(0, 0.1, 0.87);
    this.lid.add(lidMesh);
    this.group.add(this.lid);

    this.weaponHolder = new THREE.Group();
    this.weaponHolder.position.set(0, 2.4, 0);
    this.group.add(this.weaponHolder);

    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 1.1, 6, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffd04d,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.beam.position.y = 4.4;
    this.group.add(this.beam);

    this.light = new THREE.PointLight(0xffc44d, 0, 18, 2);
    this.light.position.set(0, 2.4, 0.8);
    this.group.add(this.light);

    // The box travels, so it keeps private materials and re-lights on every move.
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !(mesh.material instanceof THREE.MeshLambertMaterial)) return;
      const mat = mesh.material.clone();
      mesh.material = mat;
      this.litMats.push({ mat, base: mat.color.clone() });
    });
  }

  moveTo(p: WallProp, padIndex: number, probe: LightProbe): void {
    const pos = againstWall(p, 1.2);
    this.group.position.copy(pos);
    this.group.rotation.y = p.facing;
    const c = tileCenter(p.tx, p.tz);
    this.center.set(c.x, 1.2, c.z);
    this.padIndex = padIndex;
    probe.sample(c.x, c.z, tmpColor);
    tmpColor.r = Math.max(0.3, tmpColor.r);
    tmpColor.g = Math.max(0.3, tmpColor.g);
    tmpColor.b = Math.max(0.3, tmpColor.b);
    for (const l of this.litMats) l.mat.color.copy(l.base).multiply(tmpColor);
  }

  showWeapon(id: string | null): void {
    if (this.currentModel) {
      this.weaponHolder.remove(this.currentModel);
      this.currentModel = null;
    }
    if (!id) return;
    this.currentModel = this.shelf.get(id);
    this.weaponHolder.add(this.currentModel);
  }

  setLid(openAmount: number): void {
    this.lidOpen = openAmount;
    this.lid.rotation.x = -openAmount * 1.9;
    const mat = this.beam.material as THREE.MeshBasicMaterial;
    mat.opacity = openAmount * 0.3;
    this.light.intensity = openAmount * 34;
  }

  animate(t: number, spin: number): void {
    this.weaponHolder.rotation.y = spin;
    this.weaponHolder.position.y = 2.4 + Math.sin(t * 3) * 0.1;
    const mat = this.beam.material as THREE.MeshBasicMaterial;
    if (this.lidOpen > 0) mat.opacity = this.lidOpen * (0.24 + Math.sin(t * 7) * 0.08);
  }
}

/* --------------------------------------------------------------- wall buy */

export class WallBuy {
  readonly weaponId: string;
  readonly group: THREE.Group;
  readonly center: THREE.Vector3;
  private readonly gun: THREE.Group;
  private readonly placardTex: THREE.Texture;

  constructor(weaponId: string, p: WallProp, probe: LightProbe) {
    this.weaponId = weaponId;
    const def = getWeapon(weaponId);
    this.group = new THREE.Group();
    const c = tileCenter(p.tx, p.tz);
    // Hang it flat on the wall behind the pad.
    this.group.position.copy(againstWall(p, 0.06));
    this.group.rotation.y = p.facing;
    this.center = new THREE.Vector3(c.x, 2.4, c.z);

    this.placardTex = placardTexture(def.name, def.wallCost);
    const placard = new THREE.Mesh(
      new THREE.PlaneGeometry(2.8, 2.8),
      new THREE.MeshLambertMaterial({ map: this.placardTex }),
    );
    placard.position.set(0, 3.4, 0.05);
    this.group.add(placard);

    const m = buildWeaponModel(def, 1.5);
    this.gun = m.group;
    this.gun.position.set(0, 2.6, 0.6);
    this.gun.rotation.set(0, Math.PI / 2, 0.08);
    this.group.add(this.gun);

    // Chalk outline glow so wall guns can be spotted across a room.
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 1.4),
      new THREE.MeshBasicMaterial({ color: 0x5a4a20, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    glow.position.set(0, 2.6, 0.08);
    this.group.add(glow);

    const light = tintByLight(this.group, probe, c.x, c.z);
    // Placards should stay legible even in a dim room.
    const pm = placard.material as THREE.MeshLambertMaterial;
    pm.color.copy(light).multiplyScalar(1.3).addScalar(0.25);
  }

  animate(t: number): void {
    this.gun.position.y = 2.6 + Math.sin(t * 1.7) * 0.06;
  }

  dispose(): void {
    this.placardTex.dispose();
    disposeOwned(this.group);
  }
}

/* ----------------------------------------------------------- power switch */

export class PowerSwitch {
  readonly group: THREE.Group;
  readonly center: THREE.Vector3;
  private readonly lever: THREE.Group;
  private readonly lamp: THREE.MeshBasicMaterial;
  on = false;

  constructor(p: WallProp, probe: LightProbe) {
    this.group = new THREE.Group();
    const c = tileCenter(p.tx, p.tz);
    this.group.position.copy(againstWall(p, 0.2));
    this.group.rotation.y = p.facing;
    this.center = new THREE.Vector3(c.x, 2.2, c.z);

    const panel = new THREE.Mesh(new THREE.BoxGeometry(2.8, 3.6, 0.4), new THREE.MeshLambertMaterial({ map: textures().metal }));
    panel.position.set(0, 2.4, 0.2);
    this.group.add(panel);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.5, 0.42), new THREE.MeshLambertMaterial({ map: textures().hazard }));
    stripe.position.set(0, 0.85, 0.2);
    this.group.add(stripe);

    this.lamp = new THREE.MeshBasicMaterial({ color: 0x551111 });
    const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.2), this.lamp);
    bulb.position.set(-0.9, 3.6, 0.42);
    this.group.add(bulb);

    this.lever = new THREE.Group();
    this.lever.position.set(0.3, 2.4, 0.45);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.3, 0.18), flatMaterial(0x8b949e));
    arm.position.y = 0.55;
    this.lever.add(arm);
    const knob = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), flatMaterial(0xc4402a));
    knob.position.y = 1.2;
    this.lever.add(knob);
    this.lever.rotation.x = -0.9;
    this.group.add(this.lever);
    tintByLight(this.group, probe, c.x, c.z);
  }

  setOn(on: boolean): void {
    this.on = on;
    this.lever.rotation.x = on ? 0.9 : -0.9;
    this.lamp.color.set(on ? 0x55ff88 : 0x551111).multiplyScalar(on ? 3 : 1);
  }

  dispose(): void {
    this.lamp.dispose();
    disposeOwned(this.group);
  }
}

/* ------------------------------------------------------- pack-a-punch */

/** Upgrades the weapon in hand. Dead until the generator is running. */
export class PackMachine {
  readonly group = new THREE.Group();
  readonly center: THREE.Vector3;
  private readonly drum: THREE.Mesh;
  private readonly glowMat: THREE.MeshBasicMaterial;
  private readonly light: THREE.PointLight;
  private readonly holder = new THREE.Group();
  private model: THREE.Group | null = null;
  private static readonly shelf = new ModelShelf(1.8);
  powered = false;

  constructor(p: WallProp, probe: LightProbe) {
    const c = tileCenter(p.tx, p.tz);
    this.center = new THREE.Vector3(c.x, 1.8, c.z);

    const shell = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.8, 2.0), new THREE.MeshLambertMaterial({ map: textures().metalDark }));
    shell.position.y = 1.9;
    this.group.add(shell);

    this.glowMat = new THREE.MeshBasicMaterial({ color: 0x1d2a2a });
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.0, 0.3), this.glowMat);
    mouth.position.set(0, 2.1, 1.05);
    this.group.add(mouth);

    this.drum = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 1.6, 8), flatMaterial(0x6a5a2a));
    this.drum.rotation.z = Math.PI / 2;
    this.drum.position.set(0, 3.6, 0.2);
    this.group.add(this.drum);

    for (const side of [-1, 1]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 3.6, 6), flatMaterial(0x4a5157));
      pipe.position.set(side * 1.9, 1.8, -0.4);
      this.group.add(pipe);
    }

    this.holder.position.set(0, 2.2, 1.9);
    this.group.add(this.holder);

    this.light = new THREE.PointLight(0x48f0c0, 0, 16, 2);
    this.light.position.set(0, 2.6, 1.6);
    this.group.add(this.light);

    this.group.position.copy(againstWall(p, 1.1));
    this.group.rotation.y = p.facing;
    tintByLight(this.group, probe, c.x, c.z);
  }

  setPowered(on: boolean): void {
    this.powered = on;
    this.glowMat.color.set(on ? 0x48f0c0 : 0x1d2a2a).multiplyScalar(on ? 2.5 : 1);
    this.light.intensity = on ? 24 : 0;
  }

  /** Shows the weapon being worked on, or null when the mouth is empty. */
  showWeapon(id: string | null): void {
    if (this.model) {
      this.holder.remove(this.model);
      this.model = null;
    }
    if (!id) return;
    this.model = PackMachine.shelf.get(id);
    this.holder.add(this.model);
  }

  animate(t: number): void {
    if (!this.powered) return;
    this.drum.rotation.x = t * 1.4;
    this.light.intensity = 22 + Math.sin(t * 5.5) * 6;
    this.holder.rotation.y = t * 2.2;
    this.holder.position.y = 2.2 + Math.sin(t * 3) * 0.08;
  }

  dispose(): void {
    this.glowMat.dispose();
    disposeOwned(this.group);
  }
}

/* ----------------------------------------------------------------- build */

export type PropSet = {
  doors: DoorProp[];
  barricades: BarricadeProp[];
  machines: PerkMachine[];
  wallBuys: WallBuy[];
  power: PowerSwitch;
  pack: PackMachine;
};

export function buildProps(layout: Layout, probe: LightProbe): PropSet {
  return {
    doors: layout.doors.map((d) => new DoorProp(d, probe)),
    barricades: layout.barricades.map((b) => new BarricadeProp(b, probe)),
    machines: layout.perks.map((p) => new PerkMachine(p.perk as PerkId, p, probe)),
    wallBuys: layout.wallBuys.map((w) => new WallBuy(w.weapon, w, probe)),
    power: new PowerSwitch(layout.powerSwitch, probe),
    pack: new PackMachine(layout.pack, probe),
  };
}

/** Everything a prop set added to the scene, and the GPU memory it owns. */
export function propGroups(p: PropSet): THREE.Object3D[] {
  return [
    ...p.doors.map((d) => d.group),
    ...p.barricades.map((b) => b.group),
    ...p.machines.map((m) => m.group),
    ...p.wallBuys.map((w) => w.group),
    p.power.group,
    p.pack.group,
  ];
}

export function disposeProps(p: PropSet): void {
  for (const d of p.doors) disposeOwned(d.group);
  for (const b of p.barricades) disposeOwned(b.group);
  for (const m of p.machines) m.dispose();
  for (const w of p.wallBuys) w.dispose();
  p.power.dispose();
  p.pack.showWeapon(null);
  p.pack.dispose();
  // Geometries are small and unique per prop; release them too.
  for (const g of propGroups(p)) {
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
  }
}
