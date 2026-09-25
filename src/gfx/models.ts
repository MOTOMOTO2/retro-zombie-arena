/**
 * Every model in the game is a stack of boxes. No importer, no mesh files, no
 * skinning - just parented groups rotated by hand, which is how character
 * animation looked before skeletal meshes were cheap.
 *
 * World scale: 1 unit = 0.5 m. A person is about 3.5 units tall.
 */

import * as THREE from 'three';
import { textures } from './textures.ts';
import type { WeaponDef } from '../game/weapons.ts';
import { buildGun } from './guns.ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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
UNIT.userData.shared = true;

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

/* --------------------------------------------------------------- merging */

function bakedCopy(mesh: THREE.Mesh, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
  }
  geo.clearGroups();
  geo.applyMatrix4(matrix);
  return geo;
}

function replaceWithMerged(parent: THREE.Object3D, meshes: THREE.Mesh[], matrices: THREE.Matrix4[], mat: THREE.Material): void {
  const geos = meshes.map((m, i) => bakedCopy(m, matrices[i]));
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) return;
  for (const m of meshes) {
    m.parent?.remove(m);
    if (!m.geometry.userData.shared) m.geometry.dispose();
  }
  parent.add(new THREE.Mesh(merged, mat));
}

/**
 * Collapses the plain meshes directly under each joint into one mesh per
 * material. Joints (groups) keep animating; anything in `keep` stays its own
 * mesh. A zombie goes from forty-odd draw calls to under twenty this way.
 */
export function mergeStatic(root: THREE.Object3D, keep: Set<THREE.Object3D> = new Set()): void {
  const joints: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) joints.push(o);
  });
  for (const joint of joints) {
    const byMat = new Map<THREE.Material, THREE.Mesh[]>();
    for (const c of joint.children) {
      const m = c as THREE.Mesh;
      if (!m.isMesh || keep.has(m) || m.children.length || !m.visible) continue;
      const mat = m.material as THREE.Material;
      const list = byMat.get(mat) ?? [];
      list.push(m);
      byMat.set(mat, list);
    }
    for (const [mat, list] of byMat) {
      if (list.length < 2) continue;
      replaceWithMerged(joint, list, list.map((m) => {
        m.updateMatrix();
        return m.matrix.clone();
      }), mat);
    }
  }
}

/** Flattens a model that never animates into one mesh per material. */
export function mergeAll(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const byMat = new Map<THREE.Material, { meshes: THREE.Mesh[]; matrices: THREE.Matrix4[] }>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    let hidden = false;
    for (let p = m.parent; p && p !== root; p = p.parent) if (!p.visible) hidden = true;
    if (hidden) return;
    const mat = m.material as THREE.Material;
    const entry = byMat.get(mat) ?? { meshes: [], matrices: [] };
    entry.meshes.push(m);
    entry.matrices.push(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    byMat.set(mat, entry);
  });
  const groups: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o !== root && !(o as THREE.Mesh).isMesh) groups.push(o);
  });
  for (const [mat, e] of byMat) replaceWithMerged(root, e.meshes, e.matrices, mat);
  for (const g of groups) g.parent?.remove(g);
}

/* ------------------------------------------------------------------ guns */

export type WeaponModel = {
  group: THREE.Group;
  muzzle: THREE.Object3D;
};

/**
 * A weapon for display in the world - on a wall, floating out of the box, in
 * Pack-a-Punch's mouth. Same model as the one in your hands, lit like the
 * level. Guns are modelled in metres and the world runs at two units a metre,
 * so scale 1 shows it a little larger than life, which is how wall buys read.
 */
export function buildWeaponModel(def: WeaponDef, scale = 1): WeaponModel {
  const rig = buildGun(def.id, 'world');
  const group = new THREE.Group();
  group.add(rig.root);
  const muzzle = new THREE.Object3D();
  rig.muzzle.getWorldPosition(muzzle.position);
  mergeAll(rig.root);
  rig.root.add(muzzle);
  group.scale.setScalar(scale * 1.6);
  return { group, muzzle };
}

/* --------------------------------------------------------------- zombies */

/** A lit material whose colour is re-multiplied every frame by the room light. */
export type LitMaterial = { mat: THREE.MeshLambertMaterial; base: THREE.Color };

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
  /** Everything that should pick up the light of the room the body stands in. */
  lit: LitMaterial[];
  /** Approximate head centre height, for headshot checks. */
  headHeight: number;
  height: number;
  radius: number;
};

export type Outfit = 'patient' | 'orderly' | 'guard' | 'civilian';

export type ZombieLook = {
  skin: number;
  /** 0 = intact, 1 = missing left arm, 2 = missing right arm, 3 = no jaw, 4 = ribs showing. */
  damage: number;
  tall: number;
  wide: number;
  outfit: Outfit;
  cloth: number;
};

/** Shared by every zombie: the eyes are unlit and over-bright so they glow and bloom. */
const EYE_MAT = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.6, 1.9, 0.35) });
const EMBER_MAT = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.1, 0.25) });

function lit(list: LitMaterial[], params: THREE.MeshLambertMaterialParameters): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial(params);
  list.push({ mat, base: mat.color.clone() });
  return mat;
}

/** Re-lights a body for the room it is standing in. */
export function applyLight(model: ZombieModel, light: THREE.Color): void {
  for (const l of model.lit) l.mat.color.copy(l.base).multiply(light);
}

/**
 * Front is local +z, which is the way the enemy code steers. Everything is
 * authored hunched forward, reaching.
 */
export function buildZombie(look: ZombieLook): ZombieModel {
  const tex = textures();
  const list: LitMaterial[] = [];
  const skin = lit(list, { map: tex.zombieSkins[look.skin % tex.zombieSkins.length] });
  const clothTex = tex.zombieCloth;
  const top = lit(list, {
    map: clothTex[look.outfit === 'patient' || look.outfit === 'orderly' ? 4 : look.cloth % 4],
    color: look.outfit === 'patient' ? 0xa8c0cc : look.outfit === 'guard' ? 0x6a7890 : 0xffffff,
  });
  const bottom = look.outfit === 'patient'
    ? skin
    : lit(list, {
      map: clothTex[look.outfit === 'orderly' ? 4 : (look.cloth + 1) % 4],
      color: look.outfit === 'guard' ? 0x4a5060 : 0xb0b0b0,
    });
  const dark = lit(list, { color: 0x2a241e });
  const bone = lit(list, { color: 0xd9d2bd });
  const blood = lit(list, { color: 0x5a0a08 });

  const root = new THREE.Group();
  const s = look.tall;
  const w = look.wide;

  // Legs pivot at the hip.
  const makeLeg = (side: number): THREE.Group => {
    const leg = new THREE.Group();
    leg.position.set(side * 0.25 * w, 1.5 * s, 0);
    box(leg, 0.34 * w, 0.8 * s, 0.38 * w, 0, -0.4 * s, 0, bottom);
    box(leg, 0.3 * w, 0.75 * s, 0.32 * w, 0, -1.08 * s, -0.02, look.outfit === 'patient' ? skin : bottom);
    box(leg, 0.36 * w, 0.2 * s, 0.56 * w, 0, -1.42 * s, 0.08, dark);
    root.add(leg);
    return leg;
  };
  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  // Everything above the hips hangs off one pivot so the lurch reads clearly.
  const body = new THREE.Group();
  body.position.set(0, 1.5 * s, 0);
  root.add(body);

  box(body, 0.8 * w, 0.4 * s, 0.5 * w, 0, 0.08 * s, 0, bottom);
  box(body, 0.84 * w, 0.06 * s, 0.54 * w, 0, 0.26 * s, 0, dark);
  const torso = box(body, 0.9 * w, 1.0 * s, 0.52 * w, 0, 0.8 * s, 0, skin);
  // Clothes over most of the torso, torn so the skin shows through.
  box(body, 0.94 * w, 0.62 * s, 0.56 * w, 0, 0.62 * s, 0, top);
  box(body, 0.98 * w, 0.28 * s, 0.58 * w, 0, 1.16 * s, 0.0, top);
  if (look.outfit === 'patient' || look.outfit === 'orderly') {
    // Gown or coat tails hanging below the waist.
    box(body, 0.9 * w, 0.7 * s, 0.1, 0, -0.3 * s, -0.24 * w, top);
    box(body, 0.9 * w, 0.5 * s, 0.1, 0, -0.2 * s, 0.26 * w, top);
  }
  if (look.damage === 4) {
    // An open chest wound with ribs.
    box(body, 0.46 * w, 0.44 * s, 0.06, 0, 0.9 * s, 0.29 * w, blood);
    for (let i = 0; i < 3; i++) box(body, 0.42 * w, 0.05 * s, 0.05, 0, (0.76 + i * 0.12) * s, 0.31 * w, bone);
  }
  box(body, 0.3 * w, 0.2 * s, 0.3 * w, 0, 1.36 * s, 0, skin);

  const head = new THREE.Group();
  head.position.set(0, 1.45 * s, 0.06);
  body.add(head);
  box(head, 0.5 * w, 0.52 * s, 0.5 * w, 0, 0.14 * s, 0, skin);
  // Brow ridge, sunken sockets and the glow inside them.
  box(head, 0.52 * w, 0.08 * s, 0.1, 0, 0.26 * s, 0.25 * w, skin);
  for (const side of [-1, 1]) {
    box(head, 0.14 * w, 0.1 * s, 0.04, side * 0.12 * w, 0.17 * s, 0.25 * w, dark);
    box(head, 0.07 * w, 0.06 * s, 0.03, side * 0.12 * w, 0.17 * s, 0.27 * w, EYE_MAT);
  }
  box(head, 0.1 * w, 0.14 * s, 0.1, 0, 0.06 * s, 0.27 * w, skin);
  if (look.cloth % 3 === 0) box(head, 0.54 * w, 0.14 * s, 0.54 * w, 0, 0.42 * s, -0.02, dark);
  const jaw = box(head, 0.4 * w, 0.16 * s, 0.34 * w, 0, -0.14 * s, 0.06, skin);
  box(head, 0.3 * w, 0.04 * s, 0.05, 0, -0.08 * s, 0.24 * w, blood);
  if (look.damage === 3) jaw.visible = false;

  const makeArm = (side: number): THREE.Group => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.56 * w, 1.15 * s, 0);
    box(arm, 0.28 * w, 0.72 * s, 0.3 * w, 0, -0.34 * s, 0, look.outfit === 'patient' ? skin : top);
    const fore = new THREE.Group();
    fore.position.set(0, -0.68 * s, 0);
    arm.add(fore);
    box(fore, 0.24 * w, 0.66 * s, 0.24 * w, 0, -0.32 * s, 0, skin);
    // Hand and hooked fingers.
    box(fore, 0.26 * w, 0.24 * s, 0.14 * w, 0, -0.74 * s, 0, skin);
    for (let f = -1; f <= 1; f++) {
      box(fore, 0.06 * w, 0.2 * s, 0.06 * w, f * 0.08 * w, -0.94 * s, 0.04, skin).rotation.x = 0.5;
    }
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
  mergeStatic(root, new Set([jaw]));

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
    lit: list,
    headHeight: 3.05 * s,
    height: 3.45 * s,
    radius: 0.62 * w,
  };
}

/** Hellhound: four legs, no patience. Front is local +z. */
export function buildHound(): ZombieModel {
  const tex = textures();
  const list: LitMaterial[] = [];
  const skin = lit(list, { map: tex.houndSkin });

  const root = new THREE.Group();
  // Authored nose-first along -z, then turned to face +z like everything else.
  const turn = new THREE.Group();
  turn.rotation.y = Math.PI;
  root.add(turn);
  const body = new THREE.Group();
  body.position.set(0, 1.05, 0);
  turn.add(body);

  box(body, 0.62, 0.62, 1.5, 0, 0, 0, skin);
  box(body, 0.52, 0.5, 0.5, 0, 0.1, -0.9, skin);
  // Spine ridge.
  for (let i = 0; i < 4; i++) box(body, 0.12, 0.2, 0.2, 0, 0.36, -0.5 + i * 0.35, skin);

  const head = new THREE.Group();
  head.position.set(0, 0.16, -1.0);
  body.add(head);
  box(head, 0.4, 0.3, 0.5, 0, -0.1, -0.28, skin);
  box(head, 0.1, 0.1, 0.08, -0.14, 0.08, -0.3, EMBER_MAT);
  box(head, 0.1, 0.1, 0.08, 0.14, 0.08, -0.3, EMBER_MAT);
  const jaw = box(head, 0.34, 0.12, 0.42, 0, -0.24, -0.3, skin);
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

  const tail = new THREE.Group();
  tail.position.set(0, 0.16, 0.76);
  tail.rotation.x = -0.5;
  box(tail, 0.12, 0.12, 0.6, 0, 0, 0.3, skin);
  body.add(tail);
  mergeStatic(root, new Set([jaw]));

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
    lit: list,
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
