/**
 * Interactive furniture: doors, window barricades, perk machines, the mystery
 * box, wall buys, the power switch, and the set dressing that gives each room
 * its own silhouette.
 */

import * as THREE from 'three';
import { flatMaterial, buildWeaponModel } from '../gfx/models.ts';
import { placardTexture, perkTexture, textures } from '../gfx/textures.ts';
import { getWeapon } from '../game/weapons.ts';
import { PERK_INFO, type PerkId } from '../game/rules.ts';
import {
  BARRICADES,
  DOORS,
  PERKS,
  POWER_SWITCH,
  TILE,
  WALL_BUYS,
  WALL_H,
  ZONES,
  type BarricadeDef,
  type DoorDef,
  tileCenter,
} from './mapdata.ts';
import { Rng } from '../core/rng.ts';

/** Pack-a-Punch sits against the south wall of the generator room. */
export const PACK_TILE = { tx: 36, tz: 15, facing: Math.PI };

const PERK_GLYPH: Record<PerkId, string> = {
  revive: '+',
  juggernog: 'J',
  speedcola: 'S',
  doubletap: 'II',
  staminup: '>>',
};

/* ------------------------------------------------------------------ doors */

export class DoorProp {
  readonly def: DoorDef;
  readonly group: THREE.Group;
  readonly center: THREE.Vector3;
  open = false;
  private t = 0;
  private readonly baseY: number;

  constructor(def: DoorDef) {
    this.def = def;
    this.group = new THREE.Group();

    const w = def.rect.w * TILE;
    const h = def.rect.h * TILE;
    const cx = (def.rect.x + def.rect.w / 2) * TILE;
    const cz = (def.rect.z + def.rect.h / 2) * TILE;
    this.center = new THREE.Vector3(cx, 1.8, cz);
    this.baseY = 0;

    const tex = textures();
    const leaf = new THREE.Mesh(
      new THREE.BoxGeometry(w, WALL_H, h),
      new THREE.MeshLambertMaterial({ map: tex.door }),
    );
    leaf.position.set(0, WALL_H / 2, 0);
    this.group.add(leaf);

    // Chained boards across the face so it reads as "barred", not just a wall.
    const across = def.axis === 'z' ? h : w;
    const thick = def.axis === 'z' ? w : h;
    for (let i = 0; i < 4; i++) {
      const plank = new THREE.Mesh(
        new THREE.BoxGeometry(
          def.axis === 'z' ? thick + 0.5 : across * 0.92,
          0.5,
          def.axis === 'z' ? across * 0.92 : thick + 0.5,
        ),
        new THREE.MeshLambertMaterial({ map: tex.wood }),
      );
      plank.position.set(0, 1.6 + i * 1.7, 0);
      plank.rotation.y = (i % 2 === 0 ? 1 : -1) * 0.05;
      this.group.add(plank);
    }

    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.7), flatMaterial(0xb8a05a));
    lock.position.set(0, 3.6, 0);
    this.group.add(lock);

    this.group.position.set(cx, this.baseY, cz);
  }

  /** Slides the leaf up into the ceiling; returns true while still animating. */
  update(dt: number): boolean {
    if (!this.open) return false;
    if (this.t >= 1) return false;
    this.t = Math.min(1, this.t + dt * 0.75);
    const ease = 1 - Math.pow(1 - this.t, 3);
    this.group.position.y = this.baseY + ease * (WALL_H + 0.4);
    if (this.t >= 1) this.group.visible = false;
    return true;
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

  constructor(def: BarricadeDef) {
    this.def = def;
    this.group = new THREE.Group();
    const c = tileCenter(def.tx, def.tz);
    this.center = new THREE.Vector3(c.x, 2.2, c.z);

    const tex = textures();
    const horizontal = def.dx !== 0; // the opening runs along z
    const span = TILE * 0.98;

    // A dark recess so the gap reads as a window even with the boards gone.
    const recess = new THREE.Mesh(
      new THREE.BoxGeometry(
        horizontal ? TILE * 0.55 : span,
        WALL_H * 0.62,
        horizontal ? span : TILE * 0.55,
      ),
      flatMaterial(0x070809),
    );
    recess.position.set(c.x, WALL_H * 0.42, c.z);
    this.group.add(recess);

    for (let i = 0; i < this.maxBoards; i++) {
      const plank = new THREE.Mesh(
        new THREE.BoxGeometry(
          horizontal ? 0.35 : span * 1.02,
          0.52,
          horizontal ? span * 1.02 : 0.35,
        ),
        new THREE.MeshLambertMaterial({ map: tex.woodV }),
      );
      const y = 1.1 + i * 1.05;
      plank.position.set(c.x - def.dx * 0.9, y, c.z - def.dz * 0.9);
      plank.rotation.y = (i % 2 === 0 ? 1 : -1) * 0.07;
      plank.rotation.x = horizontal ? (i % 2 === 0 ? 0.05 : -0.05) : 0;
      plank.rotation.z = horizontal ? 0 : (i % 2 === 0 ? 0.05 : -0.05);
      this.planks.push(plank);
      this.group.add(plank);
    }
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
  private readonly bodyMat: THREE.MeshLambertMaterial;
  powered = false;
  bought = false;

  constructor(id: PerkId, tx: number, tz: number, facing: number) {
    this.id = id;
    const info = PERK_INFO[id];
    this.group = new THREE.Group();
    const c = tileCenter(tx, tz);
    this.center = new THREE.Vector3(c.x, 1.6, c.z);

    this.bodyMat = new THREE.MeshLambertMaterial({ color: 0x23262b });
    const cabinet = new THREE.Mesh(new THREE.BoxGeometry(2.0, 3.6, 1.2), this.bodyMat);
    cabinet.position.y = 1.8;
    this.group.add(cabinet);

    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 2.6),
      new THREE.MeshBasicMaterial({ map: perkTexture(info.color, info.name, PERK_GLYPH[id]) }),
    );
    face.position.set(0, 2.1, -0.62);
    face.rotation.y = Math.PI;
    this.group.add(face);

    // Dispensing slot.
    const slot = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 0.2), flatMaterial(0x0b0c0e));
    slot.position.set(0, 0.7, -0.62);
    this.group.add(slot);

    this.signMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
    const sign = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.5, 0.35), this.signMat);
    sign.position.set(0, 3.9, -0.4);
    this.group.add(sign);

    this.light = new THREE.PointLight(info.color, 0, 11, 1.6);
    this.light.position.set(0, 3.2, -1.2);
    this.group.add(this.light);

    this.group.position.set(c.x, 0, c.z);
    this.group.rotation.y = facing;
    this.setPowered(false);
  }

  setPowered(on: boolean): void {
    this.powered = on;
    const info = PERK_INFO[this.id];
    this.signMat.color.set(on ? info.color : 0x1a1a1a);
    this.bodyMat.color.set(on ? 0x33373d : 0x23262b);
    this.light.intensity = on ? 1.4 : 0;
  }

  /** Gentle pulse so a powered machine catches the eye across a dark room. */
  animate(t: number): void {
    if (!this.powered) return;
    this.light.intensity = 1.2 + Math.sin(t * 3.1) * 0.35;
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
  lidOpen = 0;

  constructor() {
    this.group = new THREE.Group();
    const tex = textures();

    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.5, 1.6),
      new THREE.MeshLambertMaterial({ map: tex.wood }),
    );
    crate.position.y = 0.75;
    this.group.add(crate);

    for (const [x, z] of [[-1.05, -0.75], [1.05, -0.75], [-1.05, 0.75], [1.05, 0.75]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.6, 0.22), flatMaterial(0x4a3b2a));
      post.position.set(x, 0.8, z);
      this.group.add(post);
    }

    this.lid = new THREE.Group();
    this.lid.position.set(0, 1.5, 0.8);
    const lidMesh = new THREE.Mesh(
      new THREE.BoxGeometry(2.24, 0.2, 1.64),
      new THREE.MeshLambertMaterial({ map: tex.mystery }),
    );
    lidMesh.position.set(0, 0.1, -0.8);
    this.lid.add(lidMesh);
    this.group.add(this.lid);

    this.weaponHolder = new THREE.Group();
    this.weaponHolder.position.set(0, 2.3, 0);
    this.group.add(this.weaponHolder);

    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 1.1, 6, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffd04d,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.beam.position.y = 4.2;
    this.group.add(this.beam);

    this.light = new THREE.PointLight(0xffc44d, 0, 14, 1.8);
    this.light.position.y = 2.2;
    this.group.add(this.light);
  }

  moveTo(tx: number, tz: number, padIndex: number): void {
    const c = tileCenter(tx, tz);
    this.group.position.set(c.x, 0, c.z);
    this.center.set(c.x, 1.2, c.z);
    this.padIndex = padIndex;
  }

  showWeapon(id: string | null): void {
    if (this.currentModel) {
      this.weaponHolder.remove(this.currentModel);
      this.currentModel = null;
    }
    if (!id) return;
    const m = buildWeaponModel(getWeapon(id), 2.2);
    this.currentModel = m.group;
    this.weaponHolder.add(m.group);
  }

  setLid(openAmount: number): void {
    this.lidOpen = openAmount;
    this.lid.rotation.x = -openAmount * 1.9;
    const mat = this.beam.material as THREE.MeshBasicMaterial;
    mat.opacity = openAmount * 0.16;
    this.light.intensity = openAmount * 2.6;
  }

  animate(t: number, spin: number): void {
    this.weaponHolder.rotation.y = spin;
    this.weaponHolder.position.y = 2.3 + Math.sin(t * 3) * 0.1;
    const mat = this.beam.material as THREE.MeshBasicMaterial;
    if (this.lidOpen > 0) mat.opacity = this.lidOpen * (0.12 + Math.sin(t * 7) * 0.04);
  }
}

/* --------------------------------------------------------------- wall buy */

export class WallBuy {
  readonly weaponId: string;
  readonly group: THREE.Group;
  readonly center: THREE.Vector3;
  private readonly gun: THREE.Group;

  constructor(weaponId: string, tx: number, tz: number, facing: number) {
    this.weaponId = weaponId;
    const def = getWeapon(weaponId);
    this.group = new THREE.Group();
    const c = tileCenter(tx, tz);
    const nx = Math.sin(facing);
    const nz = Math.cos(facing);
    // Hang it flat on the wall behind the pad.
    this.group.position.set(c.x - nx * (TILE / 2 - 0.06), 0, c.z - nz * (TILE / 2 - 0.06));
    this.group.rotation.y = facing;
    this.center = new THREE.Vector3(c.x, 2.4, c.z);

    const placard = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 2.6),
      new THREE.MeshBasicMaterial({ map: placardTexture(def.name, def.wallCost) }),
    );
    placard.position.set(0, 2.9, 0.02);
    this.group.add(placard);

    const m = buildWeaponModel(def, 1.5);
    this.gun = m.group;
    this.gun.position.set(0, 2.3, 0.7);
    this.gun.rotation.set(0, Math.PI / 2, 0.12);
    this.group.add(this.gun);
  }

  animate(t: number): void {
    this.gun.position.y = 2.3 + Math.sin(t * 1.7) * 0.06;
  }
}

/* ----------------------------------------------------------- power switch */

export class PowerSwitch {
  readonly group: THREE.Group;
  readonly center: THREE.Vector3;
  private readonly lever: THREE.Group;
  private readonly lamp: THREE.MeshBasicMaterial;
  on = false;

  constructor() {
    this.group = new THREE.Group();
    const c = tileCenter(POWER_SWITCH.tx, POWER_SWITCH.tz);
    const nx = Math.sin(POWER_SWITCH.facing);
    const nz = Math.cos(POWER_SWITCH.facing);
    this.group.position.set(c.x - nx * (TILE / 2 - 0.2), 0, c.z - nz * (TILE / 2 - 0.2));
    this.group.rotation.y = POWER_SWITCH.facing;
    this.center = new THREE.Vector3(c.x, 2.2, c.z);

    const panel = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3.4, 0.4), flatMaterial(0x2b3036));
    panel.position.set(0, 2.2, 0.2);
    this.group.add(panel);

    this.lamp = new THREE.MeshBasicMaterial({ color: 0x551111 });
    const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.2), this.lamp);
    bulb.position.set(-0.8, 3.3, 0.42);
    this.group.add(bulb);

    this.lever = new THREE.Group();
    this.lever.position.set(0.3, 2.2, 0.4);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.3, 0.18), flatMaterial(0x8b949e));
    arm.position.y = 0.55;
    this.lever.add(arm);
    const knob = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), flatMaterial(0xc4402a));
    knob.position.y = 1.2;
    this.lever.add(knob);
    this.lever.rotation.x = 0.9;
    this.group.add(this.lever);
  }

  setOn(on: boolean): void {
    this.on = on;
    this.lever.rotation.x = on ? -0.9 : 0.9;
    this.lamp.color.set(on ? 0x55ff88 : 0x551111);
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
  powered = false;

  constructor(tx: number, tz: number, facing: number) {
    const c = tileCenter(tx, tz);
    this.center = new THREE.Vector3(c.x, 1.8, c.z);

    const shell = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.8, 2.0), flatMaterial(0x2a2f36));
    shell.position.y = 1.9;
    this.group.add(shell);

    this.glowMat = new THREE.MeshBasicMaterial({ color: 0x1d2a2a });
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.0, 0.3), this.glowMat);
    mouth.position.set(0, 2.1, -1.05);
    this.group.add(mouth);

    this.drum = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, 1.6, 8),
      flatMaterial(0x6a5a2a),
    );
    this.drum.rotation.z = Math.PI / 2;
    this.drum.position.set(0, 3.6, -0.2);
    this.group.add(this.drum);

    for (const side of [-1, 1]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 3.6, 6), flatMaterial(0x4a5157));
      pipe.position.set(side * 1.9, 1.8, 0.4);
      this.group.add(pipe);
    }

    this.holder.position.set(0, 2.2, -1.9);
    this.group.add(this.holder);

    this.light = new THREE.PointLight(0x48f0c0, 0, 12, 1.7);
    this.light.position.set(0, 2.6, -1.6);
    this.group.add(this.light);

    this.group.position.set(c.x, 0, c.z);
    this.group.rotation.y = facing;
  }

  setPowered(on: boolean): void {
    this.powered = on;
    this.glowMat.color.set(on ? 0x48f0c0 : 0x1d2a2a);
    this.light.intensity = on ? 1.6 : 0;
  }

  /** Shows the weapon being worked on, or null when the mouth is empty. */
  showWeapon(id: string | null): void {
    if (this.model) {
      this.holder.remove(this.model);
      this.model = null;
    }
    if (!id) return;
    const m = buildWeaponModel(getWeapon(id), 1.8);
    this.model = m.group;
    this.holder.add(m.group);
  }

  animate(t: number): void {
    if (!this.powered) return;
    this.drum.rotation.x = t * 1.4;
    this.light.intensity = 1.4 + Math.sin(t * 5.5) * 0.4;
    this.holder.rotation.y = t * 2.2;
    this.holder.position.y = 2.2 + Math.sin(t * 3) * 0.08;
  }
}

/* -------------------------------------------------------------- clutter */

/** Room dressing. Purely visual, and deliberately blocky. */
export function buildClutter(): THREE.Group {
  const group = new THREE.Group();
  const tex = textures();
  const rng = new Rng(0xc1077e2);
  const wood = new THREE.MeshLambertMaterial({ map: tex.wood });
  const metal = new THREE.MeshLambertMaterial({ map: tex.metal });

  const put = (
    mesh: THREE.Mesh, tx: number, tz: number, ox: number, oz: number, rot: number,
  ): void => {
    const c = tileCenter(tx, tz);
    mesh.position.set(c.x + ox, mesh.position.y, c.z + oz);
    mesh.rotation.y = rot;
    group.add(mesh);
  };

  // CHAPEL: rows of pews facing an altar.
  for (let i = 0; i < 5; i++) {
    for (const side of [-1, 1]) {
      const pew = new THREE.Mesh(new THREE.BoxGeometry(6, 0.5, 0.9), wood);
      pew.position.y = 1.0;
      put(pew, 24, 10 + i * 2, side * 5.2, 0, rng.range(-0.03, 0.03));
      const back = new THREE.Mesh(new THREE.BoxGeometry(6, 1.4, 0.3), wood);
      back.position.y = 1.5;
      put(back, 24, 10 + i * 2, side * 5.2, 0.5, 0);
    }
  }
  const altar = new THREE.Mesh(new THREE.BoxGeometry(4, 1.6, 1.6), flatMaterial(0x6a6458));
  altar.position.y = 0.8;
  put(altar, 24, 8, 0, 0, 0);
  const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4, 0.4), wood);
  crossV.position.y = 3.6;
  put(crossV, 24, 8, 0, 1.2, 0);
  const crossH = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.4, 0.4), wood);
  crossH.position.y = 4.6;
  put(crossH, 24, 8, 0, 1.2, 0);

  // FURNACE HALL: a boiler, pipes and coal.
  const boiler = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 5, 8), metal);
  boiler.position.y = 2.5;
  put(boiler, 6, 26, 0, 0, 0);
  const firebox = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.6, 0.4), flatMaterial(0xff5a1e));
  firebox.position.y = 1.2;
  put(firebox, 6, 26, 0, -1.9, 0);
  for (let i = 0; i < 6; i++) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 8, 6), metal);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.y = 6.6 - (i % 2) * 0.9;
    put(pipe, 5 + i * 2, 30, 0, 0, 0);
  }
  for (let i = 0; i < 7; i++) {
    const coal = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.9), flatMaterial(0x141312));
    coal.position.y = 0.35;
    put(coal, 11, 34, rng.range(-2.4, 2.4), rng.range(-2.4, 2.4), rng.range(0, 3));
  }

  // ADMISSIONS: reception desk, gurneys, filing cabinets.
  const desk = new THREE.Mesh(new THREE.BoxGeometry(7, 2, 1.4), wood);
  desk.position.y = 1;
  put(desk, 24, 28, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 4), metal);
    frame.position.y = 1.5;
    put(frame, 21 + i * 3, 33, rng.range(-0.6, 0.6), 0, rng.range(-0.2, 0.2));
    const legs = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 0.3), metal);
    legs.position.y = 0.7;
    put(legs, 21 + i * 3, 33, 0, -1.7, 0);
  }
  for (let i = 0; i < 4; i++) {
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.6, 1.0), flatMaterial(0x4a5057));
    cab.position.y = 1.3;
    put(cab, 28, 26 + i, 0.8, 0, 0);
  }

  // ARMORY: weapon racks and ammo crates.
  for (let i = 0; i < 4; i++) {
    const rack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4, 3.2), metal);
    rack.position.y = 2;
    put(rack, 38 + (i % 2) * 4, 25 + Math.floor(i / 2) * 5, 0, 0, 0);
  }
  for (let i = 0; i < 8; i++) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 1.4), flatMaterial(0x4a5236));
    crate.position.y = 0.6 + (i % 2) * 1.2;
    put(crate, 36 + (i % 4), 33, rng.range(-1, 1), rng.range(-1, 1), rng.range(0, 1.5));
  }

  // CATACOMBS: stone coffins and bone piles.
  for (let i = 0; i < 6; i++) {
    const coffin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 4), flatMaterial(0x6b6a63));
    coffin.position.y = 0.6;
    put(coffin, 5 + (i % 2) * 6, 7 + Math.floor(i / 2) * 3, 0, 0, 0);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.25, 4.1), flatMaterial(0x5a594f));
    lid.position.y = 1.3;
    put(lid, 5 + (i % 2) * 6, 7 + Math.floor(i / 2) * 3, rng.range(-0.4, 0.4), rng.range(-0.5, 0.5), 0);
  }
  for (let i = 0; i < 10; i++) {
    const bone = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 1.1), flatMaterial(0xcfc7ad));
    bone.position.y = 0.12;
    put(bone, 8, 15, rng.range(-3, 3), rng.range(-3, 3), rng.range(0, 3));
  }

  // GENERATOR: the machinery that the power switch feeds.
  for (let i = 0; i < 3; i++) {
    const gen = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 5), metal);
    gen.position.y = 1.5;
    put(gen, 36 + i * 3, 10, 0, 0, 0);
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 4, 6), metal);
    stack.position.y = 4.5;
    put(stack, 36 + i * 3, 10, 0.9, -1.4, 0);
  }

  // A few sagging ceiling cables everywhere, to break up the flat ceiling.
  for (const zone of ZONES) {
    for (let i = 0; i < 3; i++) {
      const tx = zone.rect.x + 1 + rng.int(zone.rect.w - 2);
      const tz = zone.rect.z + 1 + rng.int(zone.rect.h - 2);
      const cable = new THREE.Mesh(
        new THREE.BoxGeometry(rng.range(3, 8), 0.12, 0.12),
        flatMaterial(0x14161a),
      );
      cable.position.y = WALL_H - rng.range(0.4, 1.1);
      put(cable, tx, tz, 0, 0, rng.range(0, Math.PI));
    }
  }

  for (const child of group.children) {
    child.matrixAutoUpdate = false;
    child.updateMatrix();
  }
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  return group;
}

/* ----------------------------------------------------------------- build */

export type PropSet = {
  doors: DoorProp[];
  barricades: BarricadeProp[];
  machines: PerkMachine[];
  wallBuys: WallBuy[];
  box: MysteryBox;
  power: PowerSwitch;
  pack: PackMachine;
  clutter: THREE.Group;
};

export function buildProps(): PropSet {
  return {
    doors: DOORS.map((d) => new DoorProp(d)),
    barricades: BARRICADES.map((b) => new BarricadeProp(b)),
    machines: PERKS.map((p) => new PerkMachine(p.perk as PerkId, p.tx, p.tz, p.facing)),
    wallBuys: WALL_BUYS.map((w) => new WallBuy(w.weapon, w.tx, w.tz, w.facing)),
    box: new MysteryBox(),
    power: new PowerSwitch(),
    pack: new PackMachine(PACK_TILE.tx, PACK_TILE.tz, PACK_TILE.facing),
    clutter: buildClutter(),
  };
}
