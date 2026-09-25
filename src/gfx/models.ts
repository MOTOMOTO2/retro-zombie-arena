/**
 * Every model in the game is a stack of boxes. No importer, no mesh files, no
 * skinning - just parented groups rotated by hand, which is how character
 * animation looked before skeletal meshes were cheap.
 *
 * World scale: 1 unit = 0.5 m. A person is about 3.5 units tall.
 */

import * as THREE from 'three';
import { textures } from './textures.ts';
import type { ModelPart, WeaponDef } from '../game/weapons.ts';

const matCache = new Map<number, THREE.MeshLambertMaterial>();

export function flatMaterial(color: number): THREE.MeshLambertMaterial {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    matCache.set(color, m);
  }
  return m;
}

const UNIT = new THREE.BoxGeometry(1, 1, 1);

function box(
  parent: THREE.Object3D,
  sx: number,
  sy: number,
  sz: number,
  px: number,
  py: number,
  pz: number,
  material: THREE.Material,
): THREE.Mesh {
  const m = new THREE.Mesh(UNIT, material);
  m.scale.set(sx, sy, sz);
  m.position.set(px, py, pz);
  parent.add(m);
  return m;
}

/* ------------------------------------------------------------------ guns */

export type WeaponModel = {
  group: THREE.Group;
  slides: THREE.Mesh[];
  muzzle: THREE.Object3D;
};

export function buildWeaponModel(def: WeaponDef, scale = 1): WeaponModel {
  const group = new THREE.Group();
  const slides: THREE.Mesh[] = [];

  for (const part of def.parts as ModelPart[]) {
    const mesh = box(
      group,
      part.size[0], part.size[1], part.size[2],
      part.pos[0], part.pos[1], part.pos[2],
      flatMaterial(part.color),
    );
    if (part.rot) mesh.rotation.set(part.rot[0], part.rot[1], part.rot[2]);
    if (part.slide) slides.push(mesh);
  }

  const muzzle = new THREE.Object3D();
  muzzle.position.set(def.muzzle[0], def.muzzle[1], def.muzzle[2]);
  group.add(muzzle);
  group.scale.setScalar(scale);

  return { group, slides, muzzle };
}

/* --------------------------------------------------------------- zombies */

export type ZombieModel = {
  root: THREE.Group;
  /** Hip-height pivot that carries the whole upper body. */
  body: THREE.Group;
  head: THREE.Group;
  jaw: THREE.Mesh;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  /** Boxes that become gibs when the body comes apart. */
  parts: THREE.Object3D[];
  /** Approximate head centre height, for headshot checks. */
  headHeight: number;
  height: number;
  radius: number;
};

export type ZombieLook = {
  skin: number;
  /** 0 = intact, 1 = missing left arm, 2 = missing right arm, 3 = no jaw. */
  damage: number;
  tall: number;
  wide: number;
};

export function buildZombie(look: ZombieLook): ZombieModel {
  const tex = textures();
  const skin = new THREE.MeshLambertMaterial({
    map: tex.zombieSkins[look.skin % tex.zombieSkins.length],
  });
  const cloth = flatMaterial([0x3b4048, 0x4a3b2c, 0x2f3a33, 0x453040][look.skin % 4]);
  const bone = flatMaterial(0xd9d2bd);

  const root = new THREE.Group();
  const s = look.tall;
  const w = look.wide;

  // Legs pivot at the hip.
  const legL = new THREE.Group();
  legL.position.set(-0.26 * w, 1.5 * s, 0);
  box(legL, 0.34 * w, 1.5 * s, 0.36 * w, 0, -0.75 * s, 0, cloth);
  box(legL, 0.38 * w, 0.18 * s, 0.5 * w, 0, -1.46 * s, 0.06, flatMaterial(0x24201c));
  root.add(legL);

  const legR = new THREE.Group();
  legR.position.set(0.26 * w, 1.5 * s, 0);
  box(legR, 0.34 * w, 1.5 * s, 0.36 * w, 0, -0.75 * s, 0, cloth);
  box(legR, 0.38 * w, 0.18 * s, 0.5 * w, 0, -1.46 * s, 0.06, flatMaterial(0x24201c));
  root.add(legR);

  // Everything above the hips hangs off one pivot so the lurch reads clearly.
  const body = new THREE.Group();
  body.position.set(0, 1.5 * s, 0);
  root.add(body);

  box(body, 0.78 * w, 0.42 * s, 0.5 * w, 0, 0.1 * s, 0, cloth);
  const torso = box(body, 0.9 * w, 1.0 * s, 0.52 * w, 0, 0.82 * s, 0, skin);
  // A shirt over part of the torso, so the skin shows through as gore.
  box(body, 0.94 * w, 0.5 * s, 0.56 * w, 0, 0.55 * s, 0, cloth);
  if (look.damage === 4) box(body, 0.5 * w, 0.4 * s, 0.1, 0, 0.95 * s, -0.28 * w, bone);

  const head = new THREE.Group();
  head.position.set(0, 1.45 * s, 0);
  body.add(head);
  box(head, 0.5 * w, 0.5 * s, 0.5 * w, 0, 0.12 * s, 0, skin);
  // Sunken eyes: two dark pits that catch the light.
  box(head, 0.1 * w, 0.1 * s, 0.06, -0.13 * w, 0.16 * s, -0.26 * w, flatMaterial(0x140d0a));
  box(head, 0.1 * w, 0.1 * s, 0.06, 0.13 * w, 0.16 * s, -0.26 * w, flatMaterial(0x140d0a));
  const jaw = box(head, 0.34 * w, 0.18 * s, 0.34 * w, 0, -0.12 * s, -0.06, skin);
  if (look.damage === 3) jaw.visible = false;

  const makeArm = (side: number): THREE.Group => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.58 * w, 1.15 * s, 0);
    box(arm, 0.26 * w, 0.72 * s, 0.28 * w, 0, -0.34 * s, 0, cloth);
    const fore = new THREE.Group();
    fore.position.set(0, -0.68 * s, 0);
    arm.add(fore);
    box(fore, 0.24 * w, 0.68 * s, 0.24 * w, 0, -0.32 * s, 0, skin);
    box(fore, 0.26 * w, 0.2 * s, 0.3 * w, 0, -0.7 * s, -0.04, skin);
    // Reaching pose: shoulder forward, elbow slightly bent.
    arm.rotation.x = -1.32;
    fore.rotation.x = -0.24;
    body.add(arm);
    return arm;
  };

  const armL = makeArm(-1);
  const armR = makeArm(1);
  if (look.damage === 1) armL.visible = false;
  if (look.damage === 2) armR.visible = false;

  const height = 3.45 * s;
  return {
    root,
    body,
    head,
    jaw,
    armL,
    armR,
    legL,
    legR,
    parts: [torso, head, armL, armR, legL, legR],
    headHeight: 3.05 * s,
    height,
    radius: 0.62 * w,
  };
}

/** Hellhound: four legs, no patience. */
export function buildHound(): ZombieModel {
  const tex = textures();
  const skin = new THREE.MeshLambertMaterial({ map: tex.houndSkin });
  const ember = new THREE.MeshBasicMaterial({ color: 0xff5a1e });

  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.set(0, 1.05, 0);
  root.add(body);

  box(body, 0.62, 0.62, 1.5, 0, 0, 0, skin);
  box(body, 0.52, 0.5, 0.5, 0, 0.1, -0.9, skin);

  const head = new THREE.Group();
  head.position.set(0, 0.16, -1.0);
  body.add(head);
  box(head, 0.4, 0.3, 0.5, 0, -0.1, -0.28, skin);
  box(head, 0.1, 0.1, 0.08, -0.14, 0.08, -0.3, ember);
  box(head, 0.1, 0.1, 0.08, 0.14, 0.08, -0.3, ember);
  const jaw = box(head, 0.34, 0.12, 0.42, 0, -0.24, -0.3, skin);
  // Ears.
  box(head, 0.1, 0.24, 0.08, -0.18, 0.24, 0.02, skin);
  box(head, 0.1, 0.24, 0.08, 0.18, 0.24, 0.02, skin);

  const leg = (x: number, z: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, -0.2, z);
    box(g, 0.2, 0.9, 0.22, 0, -0.45, 0, skin);
    box(g, 0.24, 0.12, 0.34, 0, -0.88, -0.05, skin);
    body.add(g);
    return g;
  };
  const legL = leg(-0.3, -0.5);
  const legR = leg(0.3, -0.5);
  const hindL = leg(-0.3, 0.55);
  const hindR = leg(0.3, 0.55);

  // Tail.
  const tail = new THREE.Group();
  tail.position.set(0, 0.16, 0.76);
  tail.rotation.x = -0.5;
  box(tail, 0.12, 0.12, 0.6, 0, 0, 0.3, skin);
  body.add(tail);

  return {
    root,
    body,
    head,
    jaw,
    armL: hindL,
    armR: hindR,
    legL,
    legR,
    parts: [head, legL, legR, hindL, hindR],
    headHeight: 1.3,
    height: 1.7,
    radius: 0.6,
  };
}

/* ---------------------------------------------------------------- effects */

/** A pooled cloud of small boxes used for blood, sparks and debris. */
export class ParticleField {
  readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly gravity: Float32Array;
  private cursor = 0;
  private readonly count: number;

  constructor(count = 900, size = 0.22) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.colors = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.gravity = new Float32Array(count);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geo.setDrawRange(0, count);

    const mat = new THREE.PointsMaterial({
      size,
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      fog: true,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    // Park everything far below the floor until it is used.
    for (let i = 0; i < count; i++) this.positions[i * 3 + 1] = -999;
  }

  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    color: THREE.Color, life: number, gravity = 26,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.colors[i * 3] = color.r;
    this.colors[i * 3 + 1] = color.g;
    this.colors[i * 3 + 2] = color.b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.gravity[i] = gravity;
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.positions[i * 3 + 1] = -999;
        this.colors[i * 3] = 0;
        this.colors[i * 3 + 1] = 0;
        this.colors[i * 3 + 2] = 0;
        continue;
      }
      this.vel[i * 3 + 1] -= this.gravity[i] * dt;
      this.positions[i * 3] += this.vel[i * 3] * dt;
      this.positions[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.positions[i * 3 + 1] < 0.06) {
        this.positions[i * 3 + 1] = 0.06;
        this.vel[i * 3] *= 0.4;
        this.vel[i * 3 + 1] = 0;
        this.vel[i * 3 + 2] *= 0.4;
      }
      const t = this.life[i] / this.maxLife[i];
      const geoColor = this.points.geometry.attributes.color as THREE.BufferAttribute;
      geoColor.array[i * 3 + 0] = this.colors[i * 3] * t;
      geoColor.array[i * 3 + 1] = this.colors[i * 3 + 1] * t;
      geoColor.array[i * 3 + 2] = this.colors[i * 3 + 2] * t;
    }
    if (any) {
      (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.points.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}
