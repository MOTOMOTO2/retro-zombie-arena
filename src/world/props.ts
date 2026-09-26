/**
 * Interactive furniture: doors, window barricades, perk machines, the mystery
 * box, wall buys, traps, the power switch and Pack-a-Punch.
 *
 * Anything with real bulk also reports a `footprint`: the box it takes up on
 * the floor, which the game hands to the nav grid so neither the player nor
 * the horde walks through a vending machine any more.
 *
 * Every wall-standing prop is authored with its front on local +z and placed
 * with the layout's `facing`, which points into the room. Each prop is tinted
 * by the light probe where it stands, so a machine in a dark corner is dark.
 */

import * as THREE from 'three';
import { flatMaterial, buildTeddy, buildWeaponModel } from '../gfx/models.ts';
import { placardTexture, perkTexture, textures } from '../gfx/textures.ts';
import { getWeapon } from '../game/weapons.ts';
import { PERK_INFO, type PerkId } from '../game/rules.ts';
import {
  TILE,
  WALL_H,
  type BarricadeDef,
  type DoorDef,
  type Layout,
  type TrapDef,
  type TrapKind,
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

/** The box a prop takes up on the floor, in world units. Half-extents. */
export type Footprint = { x: number; z: number; hx: number; hz: number };

/**
 * Footprint of a wall-standing prop whose model is `sx` wide and `sz` deep in
 * its own frame. Facings are always cardinal, so the box only ever swaps axes.
 */
function wallFootprint(p: WallProp, inset: number, sx: number, sz: number): Footprint {
  const pos = againstWall(p, inset);
  const alongZ = Math.abs(Math.cos(p.facing)) > 0.5;
  return {
    x: pos.x, z: pos.z,
    hx: (alongZ ? sx : sz) / 2,
    hz: (alongZ ? sz : sx) / 2,
  };
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
  readonly footprint: Footprint;
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
    this.footprint = wallFootprint(p, 0.9, 2.2, 1.4);
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
  /** Where the crate sits on the floor right now; the game keeps the grid in step. */
  footprint: Footprint = { x: 0, z: 0, hx: 1.3, hz: 0.9 };
  padIndex = 0;
  private readonly body = new THREE.Group();
  private readonly lid: THREE.Group;
  private readonly beam: THREE.Mesh;
  private readonly beamMat: THREE.MeshBasicMaterial;
  private readonly halo: THREE.Sprite;
  private readonly light: THREE.PointLight;
  private readonly weaponHolder: THREE.Group;
  private readonly bear: THREE.Group;
  private currentModel: THREE.Group | null = null;
  private readonly shelf = new ModelShelf(2.2);
  private readonly litMats: { mat: THREE.MeshLambertMaterial; base: THREE.Color }[] = [];
  private readonly glowColor = new THREE.Color(0x7ac8ff);
  private rise = 0;
  lidOpen = 0;

  constructor() {
    this.group = new THREE.Group();
    this.group.add(this.body);
    const tex = textures();

    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 1.6, 1.7),
      new THREE.MeshLambertMaterial({ map: tex.wood }),
    );
    crate.position.y = 0.8;
    this.body.add(crate);
    // Brass-cornered and stencilled, so it reads as the box from across a room.
    for (const [x, z] of [[-1.25, -0.8], [1.25, -0.8], [-1.25, 0.8], [1.25, 0.8]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.24, 1.7, 0.24), flatMaterial(0x8a6a2a));
      post.position.set(x, 0.85, z);
      this.body.add(post);
    }
    const band = new THREE.Mesh(new THREE.BoxGeometry(2.66, 0.18, 1.76), flatMaterial(0x6a4a1a));
    band.position.y = 0.45;
    this.body.add(band);

    // Hinged at the back, so it opens away from whoever is buying.
    this.lid = new THREE.Group();
    this.lid.position.set(0, 1.6, -0.85);
    const lidMesh = new THREE.Mesh(
      new THREE.BoxGeometry(2.64, 0.2, 1.74),
      new THREE.MeshLambertMaterial({ map: tex.mystery }),
    );
    lidMesh.position.set(0, 0.1, 0.87);
    this.lid.add(lidMesh);
    this.body.add(this.lid);

    this.weaponHolder = new THREE.Group();
    this.weaponHolder.position.set(0, 1.8, 0);
    this.body.add(this.weaponHolder);

    this.bear = buildTeddy();
    this.bear.visible = false;
    this.weaponHolder.add(this.bear);

    // The beam: always on, faint blue, so the box can be found from afar -
    // gold while it rolls, then the colour of whatever it gave you.
    this.beamMat = new THREE.MeshBasicMaterial({
      color: this.glowColor,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.95, WALL_H - 1.6, 10, 1, true), this.beamMat);
    this.beam.position.y = 1.6 + (WALL_H - 1.6) / 2;
    this.body.add(this.beam);

    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex.glow, color: this.glowColor, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.halo.scale.set(3.4, 3.4, 1);
    this.weaponHolder.add(this.halo);

    this.light = new THREE.PointLight(0x7ac8ff, 6, 14, 2);
    this.light.position.set(0, 2.4, 0.8);
    this.body.add(this.light);

    // The box travels, so it keeps private materials and re-lights on every move.
    this.body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !(mesh.material instanceof THREE.MeshLambertMaterial)) return;
      if (this.bear && isChildOf(mesh, this.bear)) return;
      const mat = mesh.material.clone();
      mesh.material = mat;
      this.litMats.push({ mat, base: mat.color.clone() });
    });
  }

  moveTo(p: WallProp, padIndex: number, probe: LightProbe): void {
    const pos = againstWall(p, 1.2);
    this.footprint = wallFootprint(p, 1.2, 2.6, 1.8);
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

  /** The teddy bear: the box is about to leave. */
  showBear(on: boolean): void {
    if (on) this.showWeapon(null);
    this.bear.visible = on;
  }

  /** Beam, halo and light colour: blue at rest, gold while rolling, rarity on reveal. */
  setGlow(color: number, strength: number): void {
    this.glowColor.setHex(color);
    this.beamMat.color.copy(this.glowColor);
    (this.halo.material as THREE.SpriteMaterial).color.copy(this.glowColor).multiplyScalar(1.6);
    (this.halo.material as THREE.SpriteMaterial).opacity = strength;
    this.light.color.copy(this.glowColor);
  }

  /** How far the gun has risen out of the box, 0-1. */
  setRise(t: number): void {
    this.rise = Math.max(0, Math.min(1, t));
  }

  /** 0 = sitting on its pad; 1 = gone, flown up through the ceiling. */
  setAway(t: number): void {
    const k = Math.max(0, Math.min(1, t));
    this.body.position.y = k * k * 7;
    this.body.rotation.y = k * 3;
    this.body.scale.setScalar(1 - k * 0.7);
    this.body.visible = k < 0.99;
  }

  setLid(openAmount: number): void {
    this.lidOpen = openAmount;
    this.lid.rotation.x = -openAmount * 1.9;
  }

  animate(t: number, spin: number): void {
    this.weaponHolder.rotation.y = this.bear.visible ? Math.sin(t * 2) * 0.4 : spin;
    this.weaponHolder.position.y = 1.7 + this.rise * 1.1 + Math.sin(t * 3) * 0.08;
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
    this.beamMat.opacity = (0.1 + pulse * 0.06) + this.lidOpen * 0.18;
    this.light.intensity = 5 + pulse * 2 + this.lidOpen * 30;
  }
}

function isChildOf(o: THREE.Object3D, parent: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === parent) return true;
  return false;
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
  readonly footprint: Footprint;
  private readonly lever: THREE.Group;
  private readonly lamp: THREE.MeshBasicMaterial;
  on = false;

  constructor(p: WallProp, probe: LightProbe) {
    this.group = new THREE.Group();
    const c = tileCenter(p.tx, p.tz);
    this.group.position.copy(againstWall(p, 0.2));
    this.footprint = wallFootprint(p, 0.2, 2.8, 0.9);
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
  readonly footprint: Footprint;
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
    this.footprint = wallFootprint(p, 1.1, 3.4, 2.2);
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


/* ------------------------------------------------------------------ traps */

/**
 * A trap: a hazard-striped panel on the wall with a lever, and a pylon either
 * side of it. Pay and throw the lever and the stretch of floor between the
 * pylons cooks anything that walks into it for half a minute; then it has to
 * cool down before it will take your money again. The arcs and the flame
 * itself are drawn by the game, which owns the particles and the bolts.
 */
export class TrapProp {
  readonly def: TrapDef;
  readonly group = new THREE.Group();
  /** The lever, for the interaction prompt. */
  readonly center: THREE.Vector3;
  /** Middle of the killing floor, and how wide it reaches. */
  readonly zone: THREE.Vector3;
  readonly radius: number;
  /** The tops of the two pylons, for arcs to jump between. */
  readonly emitters: THREE.Vector3[] = [];
  readonly solids: Footprint[] = [];
  private readonly lampMat: THREE.MeshBasicMaterial;
  private readonly coilMats: THREE.MeshBasicMaterial[] = [];
  private readonly lever: THREE.Group;
  private readonly light: THREE.PointLight;
  powered = false;
  /** Running, cooling off, or sitting there waiting to be paid. */
  state: 'ready' | 'live' | 'cooling' = 'ready';
  timer = 0;

  constructor(def: TrapDef, probe: LightProbe) {
    this.def = def;
    const c = tileCenter(def.tx, def.tz);
    const nx = Math.sin(def.facing);
    const nz = Math.cos(def.facing);
    // Along the wall: the perpendicular of the facing.
    const ax = nz;
    const az = -nx;
    this.center = new THREE.Vector3(c.x, 2.2, c.z);
    this.zone = new THREE.Vector3(c.x + nx * TILE * 0.95, 0, c.z + nz * TILE * 0.95);
    this.radius = 4.6;

    const tex = textures();
    const panel = new THREE.Group();
    const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 3.2, 0.35), new THREE.MeshLambertMaterial({ map: tex.metalDark }));
    back.position.set(0, 2.3, 0.17);
    panel.add(back);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.5, 0.38), new THREE.MeshLambertMaterial({ map: tex.hazard }));
    stripe.position.set(0, 0.95, 0.17);
    panel.add(stripe);

    this.lampMat = new THREE.MeshBasicMaterial({ color: 0x3a1a10 });
    const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.44, 0.2), this.lampMat);
    bulb.position.set(-0.75, 3.5, 0.38);
    panel.add(bulb);

    this.lever = new THREE.Group();
    this.lever.position.set(0.45, 2.3, 0.4);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.2, 0.16), flatMaterial(0x8b949e));
    arm.position.y = 0.5;
    this.lever.add(arm);
    const knob = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.38, 0.38), flatMaterial(0xc4402a));
    knob.position.y = 1.1;
    this.lever.add(knob);
    this.lever.rotation.x = -0.85;
    panel.add(this.lever);

    panel.position.copy(againstWall(def, 0.2));
    panel.rotation.y = def.facing;
    this.group.add(panel);

    // A pylon either side, standing clear of the panel and facing each other.
    const shock = def.kind === 'shock';
    for (const side of [-1, 1] as const) {
      const pylon = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.72, 0.4, 8), new THREE.MeshLambertMaterial({ map: tex.metal }));
      base.position.y = 0.2;
      pylon.add(base);
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(shock ? 0.26 : 0.34, shock ? 0.32 : 0.4, shock ? 3.2 : 2.2, 8),
        new THREE.MeshLambertMaterial({ map: tex.metalDark }),
      );
      post.position.y = shock ? 1.8 : 1.3;
      pylon.add(post);
      if (shock) {
        // Copper rings and an insulator crown.
        for (const y of [1.2, 2.1]) {
          const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.18, 8), flatMaterial(0x9a6a2a));
          ring.position.y = y;
          pylon.add(ring);
        }
        const coil = new THREE.MeshBasicMaterial({ color: 0x14202a });
        this.coilMats.push(coil);
        const ball = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), coil);
        ball.position.y = 3.6;
        ball.userData.keepColor = true;
        pylon.add(ball);
      } else {
        // A burner head, tilted in toward the middle of the zone.
        const head = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.44, 1.0, 8), flatMaterial(0x4a4038));
        head.position.set(0, 2.6, 0);
        head.rotation.z = -side * 0.5;
        pylon.add(head);
        const mouth = new THREE.MeshBasicMaterial({ color: 0x2a1408 });
        this.coilMats.push(mouth);
        const flame = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 0.3, 6), mouth);
        flame.position.set(side * 0.24, 3.05, 0);
        flame.userData.keepColor = true;
        pylon.add(flame);
      }
      const px = c.x + ax * side * 2.9 - nx * (TILE / 2 - 0.9);
      const pz = c.z + az * side * 2.9 - nz * (TILE / 2 - 0.9);
      pylon.position.set(px, 0, pz);
      pylon.rotation.y = def.facing;
      this.group.add(pylon);
      this.solids.push({ x: px, z: pz, hx: 0.7, hz: 0.7 });
      this.emitters.push(new THREE.Vector3(px, shock ? 3.6 : 3.0, pz));
    }

    this.light = new THREE.PointLight(shock ? 0x8fd8ff : 0xff8a3a, 0, 20, 2);
    this.light.position.set(this.zone.x, 2.6, this.zone.z);
    this.group.add(this.light);

    tintByLight(this.group, probe, c.x, c.z);
    this.setPowered(false);
  }

  get kind(): TrapKind {
    return this.def.kind;
  }

  /** True when a body standing here is in the cooking. */
  catches(x: number, z: number): boolean {
    const dx = x - this.zone.x;
    const dz = z - this.zone.z;
    return dx * dx + dz * dz < this.radius * this.radius;
  }

  setPowered(on: boolean): void {
    this.powered = on;
    if (!on) {
      this.state = 'ready';
      this.timer = 0;
    }
    this.sync();
  }

  fire(seconds: number): void {
    this.state = 'live';
    this.timer = seconds;
    this.sync();
  }

  /** Runs the clock down. Returns true on the frame it switches itself off. */
  update(dt: number, cooldown: number): boolean {
    if (this.timer <= 0) return false;
    this.timer -= dt;
    if (this.timer > 0) return false;
    if (this.state === 'live') {
      this.state = 'cooling';
      this.timer = cooldown;
      this.sync();
      return true;
    }
    this.state = 'ready';
    this.timer = 0;
    this.sync();
    return false;
  }

  reset(): void {
    this.state = 'ready';
    this.timer = 0;
    this.setPowered(false);
  }

  get live(): boolean {
    return this.state === 'live';
  }

  private sync(): void {
    const live = this.state === 'live';
    const hot = this.kind === 'shock' ? 0x8fd8ff : 0xff8a3a;
    this.lever.rotation.x = live ? 0.85 : -0.85;
    this.lampMat.color.set(!this.powered ? 0x3a1a10 : live ? 0x40ff90 : this.state === 'cooling' ? 0xffa03a : 0xffe14d);
    if (this.powered) this.lampMat.color.multiplyScalar(2.4);
    for (const m of this.coilMats) {
      m.color.set(live ? hot : 0x14202a);
      if (live) m.color.multiplyScalar(3);
    }
    this.light.intensity = live ? 26 : 0;
  }

  animate(t: number): void {
    if (this.state !== 'live') return;
    const flicker = 0.75 + 0.25 * Math.sin(t * (this.kind === 'shock' ? 31 : 17));
    this.light.intensity = 26 * flicker;
    // The last three seconds stutter, so you can hear it running out.
    if (this.timer < 3) this.light.intensity *= 0.4 + 0.6 * Math.abs(Math.sin(t * 9));
  }

  dispose(): void {
    this.lampMat.dispose();
    for (const m of this.coilMats) m.dispose();
    disposeOwned(this.group);
  }
}

/* ----------------------------------------------------------------- build */

export type PropSet = {
  doors: DoorProp[];
  barricades: BarricadeProp[];
  machines: PerkMachine[];
  wallBuys: WallBuy[];
  traps: TrapProp[];
  power: PowerSwitch;
  pack: PackMachine;
};

export function buildProps(layout: Layout, probe: LightProbe): PropSet {
  return {
    doors: layout.doors.map((d) => new DoorProp(d, probe)),
    barricades: layout.barricades.map((b) => new BarricadeProp(b, probe)),
    machines: layout.perks.map((p) => new PerkMachine(p.perk as PerkId, p, probe)),
    wallBuys: layout.wallBuys.map((w) => new WallBuy(w.weapon, w, probe)),
    traps: layout.traps.map((t) => new TrapProp(t, probe)),
    power: new PowerSwitch(layout.powerSwitch, probe),
    pack: new PackMachine(layout.pack, probe),
  };
}

/** Every solid box the props put on the floor, for the collision grid. */
export function propSolids(p: PropSet): Footprint[] {
  return [
    ...p.machines.map((m) => m.footprint),
    ...p.traps.flatMap((t) => t.solids),
    p.power.footprint,
    p.pack.footprint,
  ];
}

/** Everything a prop set added to the scene, and the GPU memory it owns. */
export function propGroups(p: PropSet): THREE.Object3D[] {
  return [
    ...p.doors.map((d) => d.group),
    ...p.barricades.map((b) => b.group),
    ...p.machines.map((m) => m.group),
    ...p.wallBuys.map((w) => w.group),
    ...p.traps.map((t) => t.group),
    p.power.group,
    p.pack.group,
  ];
}

export function disposeProps(p: PropSet): void {
  for (const d of p.doors) disposeOwned(d.group);
  for (const b of p.barricades) disposeOwned(b.group);
  for (const m of p.machines) m.dispose();
  for (const w of p.wallBuys) w.dispose();
  for (const t of p.traps) t.dispose();
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
