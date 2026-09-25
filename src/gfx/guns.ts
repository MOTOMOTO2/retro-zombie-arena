/**
 * Weapon models, built from real-world references.
 *
 * Every gun is modelled in metres from the published dimensions of the
 * firearm it stands in for, out of extruded side profiles (the silhouette is
 * what makes a gun read as a gun), cylinders and boxes:
 *
 *   PEACEKEEPER .45   Colt M1911A1
 *   BOOMSTICK         sawed-off side-by-side coach gun, external hammers
 *   TRENCH BROOM      Thompson M1928A1 with the 50-round drum
 *   GREASE GUN        M3 submachine gun, wire stock
 *   NAIL RIFLE        AK-47 with a bakelite magazine
 *   LONGSHOT .303     Lee-Enfield No.4 Mk I (T) with its No.32 scope
 *   SCATTERGUN        Franchi SPAS-12
 *   THE RIPPER        hand-held six-barrel rotary gun
 *   HELLFIRE M9       M9A1 bazooka
 *   PLASMA LANCE      a 1950s ray gun
 *   THUNDERCLAP       a brass-and-coil air cannon
 *   TRENCH KNIFE      US M1918 Mk I, knuckle-duster grip
 *   FRAG GRENADE      Mk 2 "pineapple"
 *
 * Conventions, in gun space: +x right, +y up, the muzzle points down -z. The
 * origin is where the top of the pistol grip meets the receiver, so reload and
 * recoil rotations pivot around the shooting hand. Profiles are written as
 * (forward, up) pairs, forward being -z.
 *
 * Each model carries named anchors - hands, magazine, charging handle, bolt,
 * pump, loading port, muzzle, ejection port - that the view model animates.
 */

import * as THREE from 'three';
import { textures } from './textures.ts';

export type ReloadStyle = 'pistol' | 'mag' | 'break' | 'shell' | 'bolt' | 'rocket' | 'cell' | 'box' | 'none';

export type GunRig = {
  id: string;
  root: THREE.Group;
  muzzle: THREE.Object3D;
  eject: THREE.Object3D | null;
  rightHand: THREE.Object3D;
  leftHand: THREE.Object3D;
  /** Where the support hand goes to rack the action. */
  charge: THREE.Object3D | null;
  /** Loading port, chamber, stripper-clip guide or tube rear. */
  port: THREE.Object3D | null;
  /** Things that cycle backwards when the gun fires. */
  slides: { obj: THREE.Object3D; travel: number; home: number }[];
  mag: THREE.Group | null;
  magHome: THREE.Matrix4;
  /** Unit vector (gun space) pointing into the magazine well. */
  magAxis: THREE.Vector3;
  magTravel: number;
  /** Rotation about x when fully out: AK magazines rock out rather than dropping. */
  magRock: number;
  magGrab: THREE.Object3D | null;
  bolt: { group: THREE.Group; lift: number; travel: number; knob: THREE.Object3D } | null;
  pump: { group: THREE.Group; travel: number } | null;
  hinge: THREE.Group | null;
  spin: THREE.Group | null;
  /** Visible while the weapon holds a round the player can see (rocket tip, chambered shells). */
  loaded: THREE.Object3D | null;
  /** Carried in the support hand during a reload: shells, a clip, a rocket, a cell. */
  prop: THREE.Object3D | null;
  reload: ReloadStyle;
  casing: 'brass' | 'shell' | null;
  sightRear: THREE.Vector3;
  sightFront: THREE.Vector3;
  /** Distance from the eye to the rear sight when aiming. */
  eye: number;
  /** View-space position and rotation of the gun origin at the hip. */
  hip: THREE.Vector3;
  hipRot: THREE.Euler;
  scoped: boolean;
  /** Bolt-action: cycle the bolt after every shot. */
  cycleAfterShot: boolean;
};

/* ------------------------------------------------------------- materials */

type Kit = {
  blued: THREE.Material;
  parker: THREE.Material;
  bright: THREE.Material;
  black: THREE.Material;
  wood: THREE.Material;
  grip: THREE.Material;
  bakelite: THREE.Material;
  brass: THREE.Material;
  copper: THREE.Material;
  olive: THREE.Material;
  red: THREE.Material;
  shell: THREE.Material;
  perf: THREE.Material;
  bore: THREE.Material;
  glowGreen: THREE.Material;
  glowBlue: THREE.Material;
  glowRed: THREE.Material;
  glass: THREE.Material;
};

export type KitMode = 'view' | 'world';

const kits = new Map<string, Kit>();

function tex(t: THREE.Texture, repeat: number): THREE.Texture {
  const c = t.clone();
  c.repeat.set(repeat, repeat);
  c.needsUpdate = true;
  return c;
}

function makeKit(mode: KitMode, packed: boolean): Kit {
  const t = textures();
  const metalMap = tex(t.gunMetal, 12);
  const camo = packed ? tex(t.camo, 6) : null;
  const view = mode === 'view';

  const std = (color: number, metal: number, rough: number, map: THREE.Texture | null = null, envI = 0.9): THREE.Material => {
    if (view) {
      return new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough, map, envMapIntensity: envI });
    }
    // World copies are Lambert, lit like the rest of the level; lift the metals
    // since they have no reflections to catch.
    const c = new THREE.Color(color);
    if (metal > 0.5) c.offsetHSL(0, 0, 0.12);
    return new THREE.MeshLambertMaterial({ color: c, map });
  };
  const glow = (r: number, g: number, b: number): THREE.Material =>
    new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });

  const metal = (color: number, m: number, r: number): THREE.Material => {
    if (camo) {
      const mat = std(0xffffff, 0.6, 0.35, camo);
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.emissive = new THREE.Color(0x3a1a6a);
        mat.emissiveMap = camo;
        mat.emissiveIntensity = 0.9;
      }
      return mat;
    }
    return std(color, m, r, metalMap);
  };

  return {
    blued: metal(0x30353c, 0.85, 0.36),
    parker: metal(0x4a4e48, 0.55, 0.62),
    bright: std(0xa8aeb4, 1, 0.26, metalMap),
    black: metal(0x202224, 0.2, 0.55),
    wood: std(0xffffff, 0, 0.5, tex(t.gunWood, 9), 0.5),
    grip: std(0xffffff, 0, 0.7, tex(t.gunGrip, 22), 0.3),
    bakelite: std(0x8a3414, 0.1, 0.32, null, 0.7),
    brass: std(0xc8a048, 1, 0.3),
    copper: std(0xb86a3a, 1, 0.34),
    olive: metal(0x505a38, 0.25, 0.7),
    red: std(0x9a1c14, 0.6, 0.3),
    shell: std(0xb01c14, 0.05, 0.45),
    perf: std(0xffffff, 0.8, 0.4, tex(t.perforated, 26)),
    bore: new THREE.MeshBasicMaterial({ color: 0x040404 }),
    glowGreen: glow(0.5, 3.2, 1.4),
    glowBlue: glow(0.6, 1.8, 4.2),
    glowRed: glow(3.6, 0.5, 0.3),
    glass: glow(0.25, 0.55, 0.45),
  };
}

function kitFor(mode: KitMode, packed: boolean): Kit {
  const key = `${mode}|${packed}`;
  let k = kits.get(key);
  if (!k) {
    k = makeKit(mode, packed);
    kits.set(key, k);
  }
  return k;
}

/* --------------------------------------------------------------- builder */

/** Projects UVs from position so textures keep a constant size in metres. */
function planarUV(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (ax >= ay && ax >= az) {
      uv[i * 2] = z;
      uv[i * 2 + 1] = y;
    } else if (ay >= az) {
      uv[i * 2] = x;
      uv[i * 2 + 1] = z;
    } else {
      uv[i * 2] = x;
      uv[i * 2 + 1] = y;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

class Builder {
  readonly root = new THREE.Group();
  readonly k: Kit;

  constructor(k: Kit) {
    this.k = k;
  }

  private add(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
    planarUV(geo);
    const m = new THREE.Mesh(geo, mat);
    parent.add(m);
    return m;
  }

  /** Extruded side silhouette. pts are (forward, up) in metres. */
  profile(parent: THREE.Object3D, pts: [number, number][], thick: number, mat: THREE.Material, x = 0, holes: [number, number][][] = []): THREE.Mesh {
    const shape = new THREE.Shape(pts.map(([u, v]) => new THREE.Vector2(u, v)));
    for (const h of holes) shape.holes.push(new THREE.Path(h.map(([u, v]) => new THREE.Vector2(u, v))));
    const bevel = Math.min(0.0025, thick * 0.12);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: Math.max(0.0005, thick - bevel * 2),
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 1,
      curveSegments: 4,
    });
    geo.translate(0, 0, -(thick - bevel * 2) / 2);
    geo.rotateY(Math.PI / 2);
    const m = this.add(parent, geo, mat);
    m.position.x = x;
    return m;
  }

  box(parent: THREE.Object3D, sx: number, sy: number, sz: number, u: number, v: number, x: number, mat: THREE.Material, rx = 0, ry = 0, rz = 0): THREE.Mesh {
    const m = this.add(parent, new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(x, v, -u);
    m.rotation.set(rx, ry, rz);
    return m;
  }

  /** Cylinder along the barrel axis, from u0 forward for len. */
  cyl(parent: THREE.Object3D, r: number, len: number, u0: number, v: number, x: number, mat: THREE.Material, segs = 12, rFront?: number): THREE.Mesh {
    const geo = new THREE.CylinderGeometry(rFront ?? r, r, len, segs);
    geo.rotateX(-Math.PI / 2);
    const m = this.add(parent, geo, mat);
    m.position.set(x, v, -(u0 + len / 2));
    return m;
  }

  /** Cylinder along x (drums, knobs, pins). */
  cylX(parent: THREE.Object3D, r: number, len: number, u: number, v: number, x: number, mat: THREE.Material, segs = 14): THREE.Mesh {
    const geo = new THREE.CylinderGeometry(r, r, len, segs);
    geo.rotateZ(Math.PI / 2);
    const m = this.add(parent, geo, mat);
    m.position.set(x, v, -u);
    return m;
  }

  /** Vertical cylinder. */
  cylY(parent: THREE.Object3D, r: number, len: number, u: number, v: number, x: number, mat: THREE.Material, segs = 12, rTop?: number): THREE.Mesh {
    const m = this.add(parent, new THREE.CylinderGeometry(rTop ?? r, r, len, segs), mat);
    m.position.set(x, v, -u);
    return m;
  }

  ring(parent: THREE.Object3D, r: number, tube: number, u: number, v: number, x: number, mat: THREE.Material): THREE.Mesh {
    const m = this.add(parent, new THREE.TorusGeometry(r, tube, 6, 16), mat);
    m.position.set(x, v, -u);
    return m;
  }

  sphere(parent: THREE.Object3D, r: number, u: number, v: number, x: number, mat: THREE.Material): THREE.Mesh {
    const m = this.add(parent, new THREE.SphereGeometry(r, 10, 8), mat);
    m.position.set(x, v, -u);
    return m;
  }

  group(parent: THREE.Object3D, u: number, v: number, x: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, v, -u);
    parent.add(g);
    return g;
  }

  anchor(parent: THREE.Object3D, u: number, v: number, x: number, rx = 0, ry = 0, rz = 0): THREE.Object3D {
    const o = new THREE.Object3D();
    o.position.set(x, v, -u);
    o.rotation.set(rx, ry, rz);
    parent.add(o);
    return o;
  }

  /** A trigger guard loop plus the trigger inside it. */
  guard(parent: THREE.Object3D, u0: number, u1: number, top: number, depth: number, thick: number, mat: THREE.Material): void {
    const outer: [number, number][] = [
      [u0 - 0.004, top], [u1 + 0.003, top], [u1 + 0.006, top - depth * 0.35], [u1, top - depth],
      [u0 + 0.006, top - depth - 0.002], [u0 - 0.006, top - depth * 0.6],
    ];
    const inner: [number, number][] = [
      [u0 + 0.002, top - 0.004], [u1 - 0.002, top - 0.004], [u1 + 0.001, top - depth * 0.38],
      [u1 - 0.004, top - depth + 0.004], [u0 + 0.008, top - depth + 0.003], [u0 - 0.001, top - depth * 0.58],
    ];
    this.profile(parent, outer, thick, mat, 0, [inner]);
    this.profile(parent, [[u0 + (u1 - u0) * 0.45, top], [u0 + (u1 - u0) * 0.58, top], [u0 + (u1 - u0) * 0.42, top - depth * 0.7], [u0 + (u1 - u0) * 0.34, top - depth * 0.62]], 0.006, this.k.bright);
  }
}

function P(u: number, v: number, x = 0): THREE.Vector3 {
  return new THREE.Vector3(x, v, -u);
}

function baseRig(id: string, b: Builder): GunRig {
  return {
    id,
    root: b.root,
    muzzle: new THREE.Object3D(),
    eject: null,
    rightHand: new THREE.Object3D(),
    leftHand: new THREE.Object3D(),
    charge: null,
    port: null,
    slides: [],
    mag: null,
    magHome: new THREE.Matrix4(),
    magAxis: new THREE.Vector3(0, 1, 0),
    magTravel: 0.15,
    magRock: 0,
    magGrab: null,
    bolt: null,
    pump: null,
    hinge: null,
    spin: null,
    loaded: null,
    prop: null,
    reload: 'mag',
    casing: 'brass',
    sightRear: P(0, 0.05),
    sightFront: P(0.3, 0.05),
    eye: 0.14,
    hip: new THREE.Vector3(0.13, -0.13, -0.22),
    hipRot: new THREE.Euler(0, -0.04, 0),
    scoped: false,
    cycleAfterShot: false,
  };
}

function finishMag(rig: GunRig): void {
  if (rig.mag) rig.magHome.copy(rig.mag.matrix.clone().compose(rig.mag.position, rig.mag.quaternion, rig.mag.scale));
}

function slide(rig: GunRig, obj: THREE.Object3D, travel: number): void {
  rig.slides.push({ obj, travel, home: obj.position.z });
}

/* ------------------------------------------------------------------ guns */

/** Colt M1911A1. 216 mm long, 5" barrel, seven-round single-stack magazine. */
function m1911(b: Builder): GunRig {
  const k = b.k;
  const rig = baseRig('sidearm', b);
  const r = b.root;

  const top = b.group(r, 0, 0, 0);
  // Slide, with the rounded top edge and the sights on it.
  b.profile(top, [[-0.047, 0.0], [0.168, 0.0], [0.17, 0.004], [0.17, 0.025], [0.163, 0.031], [-0.038, 0.031], [-0.047, 0.024]], 0.024, k.blued);
  b.box(top, 0.005, 0.007, 0.006, 0.158, 0.034, 0, k.blued);
  b.box(top, 0.007, 0.006, 0.007, -0.032, 0.034, -0.0065, k.blued);
  b.box(top, 0.007, 0.006, 0.007, -0.032, 0.034, 0.0065, k.blued);
  for (let i = 0; i < 7; i++) {
    b.box(top, 0.0255, 0.018, 0.0016, -0.04 + i * 0.0045, 0.015, 0, k.bore);
  }
  b.box(top, 0.003, 0.012, 0.042, 0.04, 0.019, 0.0115, k.bore);
  b.cyl(top, 0.0085, 0.006, 0.167, 0.016, 0, k.blued);
  b.cyl(top, 0.0052, 0.002, 0.1735, 0.016, 0, k.bore);
  slide(rig, top, 0.028);

  // Frame: dust cover, receiver, beavertail and hammer.
  b.profile(r, [[-0.046, 0.002], [0.15, 0.002], [0.15, -0.009], [0.122, -0.013], [0.022, -0.013], [0.012, -0.017], [-0.012, -0.017], [-0.042, -0.012], [-0.052, -0.002]], 0.021, k.blued);
  b.profile(r, [[-0.045, -0.004], [-0.064, 0.001], [-0.066, -0.005], [-0.052, -0.02]], 0.018, k.blued);
  b.profile(r, [[-0.044, 0.006], [-0.057, 0.017], [-0.062, 0.014], [-0.051, 0.001]], 0.008, k.blued);
  b.cylX(r, 0.003, 0.024, 0.07, -0.006, 0, k.bright);
  // Grip frame and checkered walnut panels, raked back about 14 degrees.
  b.profile(r, [[-0.001, -0.012], [-0.028, -0.106], [-0.07, -0.106], [-0.051, -0.012]], 0.022, k.blued);
  b.profile(r, [[-0.007, -0.022], [-0.031, -0.098], [-0.064, -0.098], [-0.046, -0.022]], 0.03, k.grip);
  b.guard(r, 0.0, 0.047, -0.013, 0.031, 0.01, k.blued);

  // Magazine: floorplate shows under the grip; the body sits inside it.
  const mag = b.group(r, -0.037, -0.058, 0);
  mag.rotation.x = -0.245;
  b.box(mag, 0.018, 0.1, 0.03, 0, 0, 0, k.blued);
  b.box(mag, 0.021, 0.006, 0.037, 0.002, -0.052, 0, k.blued);
  b.box(mag, 0.011, 0.008, 0.016, 0.004, 0.051, 0, k.brass);
  rig.mag = mag;
  rig.magAxis.set(0, Math.cos(-0.245), Math.sin(-0.245)).normalize();
  rig.magTravel = 0.12;
  rig.magGrab = b.anchor(mag, 0.0, -0.04, -0.01, 0, 0, 0);

  rig.muzzle = b.anchor(r, 0.175, 0.016, 0);
  rig.eject = b.anchor(r, 0.04, 0.022, 0.014);
  rig.rightHand = b.anchor(r, -0.036, -0.052, 0, -0.245, 0, 0);
  rig.leftHand = b.anchor(r, -0.018, -0.072, -0.024, -0.3, 0.35, 0.15);
  rig.charge = b.anchor(r, 0.02, 0.0, -0.026, 0, 0.3, 0);
  rig.reload = 'pistol';
  rig.sightRear = P(-0.032, 0.037);
  rig.sightFront = P(0.158, 0.037);
  rig.eye = 0.34;
  rig.hip.set(0.13, -0.14, -0.44);
  rig.hipRot.set(0.02, -0.05, 0);
  return rig;
}

/** Sawed-off side-by-side coach gun, 12 gauge, twin external hammers. */
function coachGun(b: Builder): GunRig {
  const k = b.k;
  const rig = baseRig('boomstick', b);
  const r = b.root;

  // Barrels, rib and forend all hinge down from the front of the action.
  const hinge = b.group(r, 0.03, 0.0, 0);
  b.cyl(hinge, 0.0125, 0.42, 0, 0.02, -0.0125, k.blued, 14);
  b.cyl(hinge, 0.0125, 0.42, 0, 0.02, 0.0125, k.blued, 14);
  b.box(hinge, 0.012, 0.006, 0.42, 0.21, 0.034, 0, k.blued);
  b.box(hinge, 0.012, 0.012, 0.4, 0.21, 0.008, 0, k.blued);
  b.cyl(hinge, 0.0092, 0.002, 0.4195, 0.02, -0.0125, k.bore);
  b.cyl(hinge, 0.0092, 0.002, 0.4195, 0.02, 0.0125, k.bore);
  b.box(hinge, 0.003, 0.01, 0.004, 0.41, 0.041, 0, k.blued);
  b.sphere(hinge, 0.0032, 0.41, 0.048, 0, k.brass);
  b.profile(hinge, [[0.03, -0.004], [0.23, -0.002], [0.24, 0.006], [0.23, 0.014], [0.03, 0.014]], 0.052, k.wood);
  // Brass shell heads showing at the breech when loaded.
  const loaded = b.group(hinge, -0.001, 0.02, 0);
  b.cyl(loaded, 0.0112, 0.002, 0, 0, -0.0125, k.brass, 12);
  b.cyl(loaded, 0.0112, 0.002, 0, 0, 0.0125, k.brass, 12);
  rig.loaded = loaded;
  rig.hinge = hinge;

  // Action body, top lever and hammers.
  b.profile(r, [[-0.07, 0.036], [0.032, 0.036], [0.032, -0.012], [0.0, -0.02], [-0.06, -0.02], [-0.075, 0.0]], 0.05, k.blued);
  b.profile(r, [[-0.07, 0.036], [-0.02, 0.036], [-0.025, 0.04], [-0.07, 0.042]], 0.012, k.bright);
  for (const x of [-0.012, 0.012]) {
    b.profile(r, [[-0.05, 0.03], [-0.062, 0.05], [-0.07, 0.048], [-0.064, 0.028]], 0.008, k.blued, x);
  }
  b.guard(r, -0.035, 0.018, -0.02, 0.028, 0.012, k.blued);
  // Cut-down stock with a pistol grip.
  b.profile(r, [[-0.072, 0.034], [-0.074, -0.018], [-0.1, -0.052], [-0.19, -0.1], [-0.215, -0.088], [-0.2, -0.05], [-0.13, -0.022], [-0.1, 0.01]], 0.042, k.wood);
  b.box(r, 0.014, 0.012, 0.012, -0.01, 0.042, -0.006, k.blued);
  b.box(r, 0.014, 0.012, 0.012, -0.01, 0.042, 0.006, k.blued);

  rig.muzzle = b.anchor(hinge, 0.42, 0.02, 0);
  rig.rightHand = b.anchor(r, -0.1, -0.035, 0, -0.55, 0, 0);
  rig.leftHand = b.anchor(hinge, 0.14, -0.004, -0.018, Math.PI / 2 - 0.1, 0, 0.35);
  rig.port = b.anchor(r, 0.01, 0.06, -0.01, 0.4, 0, 0.3);
  // Two fresh shells carried in the support hand.
  const prop = new THREE.Group();
  b.cyl(prop, 0.011, 0.07, -0.035, 0, -0.012, k.shell);
  b.cyl(prop, 0.011, 0.07, -0.035, 0, 0.012, k.shell);
  b.cyl(prop, 0.0115, 0.012, -0.047, 0, -0.012, k.brass);
  b.cyl(prop, 0.0115, 0.012, -0.047, 0, 0.012, k.brass);
  rig.prop = prop;
  rig.reload = 'break';
  rig.casing = 'shell';
  rig.sightRear = P(-0.01, 0.049);
  rig.sightFront = P(0.41, 0.049);
  rig.eye = 0.3;
  rig.hip.set(0.14, -0.17, -0.36);
  return rig;
}

/** Thompson M1928A1: finned barrel, Cutts compensator, vertical foregrip, 50-round drum. */
function thompson(b: Builder): GunRig {
  const k = b.k;
  const rig = baseRig('trench', b);
  const r = b.root;

  b.profile(r, [[-0.075, 0.0], [0.165, 0.0], [0.165, 0.052], [0.14, 0.06], [-0.05, 0.06], [-0.075, 0.048]], 0.034, k.blued);
  b.box(r, 0.004, 0.02, 0.09, 0.05, 0.03, 0.0172, k.bore);
  // Lyman rear sight and the cocking knob that rides on top.
  b.box(r, 0.026, 0.02, 0.018, -0.04, 0.07, 0, k.blued);
  b.box(r, 0.004, 0.012, 0.004, -0.04, 0.083, -0.007, k.blued);
  b.box(r, 0.004, 0.012, 0.004, -0.04, 0.083, 0.007, k.blued);
  const knob = b.group(r, 0.11, 0.066, 0);
  b.cylY(knob, 0.007, 0.014, 0, 0, 0, k.bright);
  slide(rig, knob, 0.07);
  // Barrel with cooling fins, then the compensator.
  b.cyl(r, 0.0095, 0.3, 0.165, 0.028, 0, k.blued);
  for (let i = 0; i < 15; i++) b.cyl(r, 0.0165, 0.0035, 0.175 + i * 0.011, 0.028, 0, k.blued, 14);
  b.cyl(r, 0.0145, 0.065, 0.44, 0.028, 0, k.blued, 12);
  for (let i = 0; i < 3; i++) b.box(r, 0.018, 0.006, 0.006, 0.462 + i * 0.014, 0.041, 0, k.bore);
  b.box(r, 0.003, 0.012, 0.005, 0.49, 0.045, 0, k.blued);
  b.cyl(r, 0.0065, 0.002, 0.5045, 0.028, 0, k.bore);
  // Vertical foregrip with finger grooves.
  b.box(r, 0.02, 0.018, 0.04, 0.26, 0.006, 0, k.blued);
  b.profile(r, [[0.235, -0.002], [0.29, -0.002], [0.287, -0.028], [0.293, -0.05], [0.286, -0.072], [0.292, -0.094], [0.282, -0.118], [0.242, -0.118], [0.236, -0.094], [0.233, -0.05]], 0.032, k.wood);
  // Trigger frame, pistol grip, stock.
  b.profile(r, [[-0.055, 0.0], [0.11, 0.0], [0.11, -0.018], [0.07, -0.024], [-0.055, -0.02]], 0.03, k.blued);
  b.guard(r, 0.002, 0.058, -0.02, 0.03, 0.01, k.blued);
  b.profile(r, [[-0.004, -0.015], [-0.028, -0.118], [-0.072, -0.118], [-0.052, -0.015]], 0.032, k.wood);
  b.profile(r, [[-0.075, 0.055], [-0.075, -0.012], [-0.12, -0.03], [-0.37, -0.078], [-0.38, -0.072], [-0.38, 0.042], [-0.36, 0.047], [-0.12, 0.045]], 0.036, k.wood);

  // The drum slides in sideways, below the receiver in front of the guard.
  const drum = b.group(r, 0.095, -0.1, 0);
  b.cylX(drum, 0.086, 0.036, 0, 0, 0, k.blued, 24);
  b.cylX(drum, 0.089, 0.006, 0, 0, 0.019, k.blued, 24);
  b.cylX(drum, 0.089, 0.006, 0, 0, -0.019, k.blued, 24);
  b.cylX(drum, 0.022, 0.044, 0, 0, 0, k.bright, 12);
  b.box(drum, 0.006, 0.03, 0.012, 0, 0, -0.024, k.bright);
  b.box(drum, 0.03, 0.04, 0.05, 0, 0.078, 0, k.blued);
  rig.mag = drum;
  rig.magAxis.set(1, 0, 0);
  rig.magTravel = 0.16;
  rig.magGrab = b.anchor(drum, 0, -0.03, -0.03, 0, 0, -0.4);

  rig.muzzle = b.anchor(r, 0.51, 0.028, 0);
  rig.eject = b.anchor(r, 0.05, 0.035, 0.018);
  rig.charge = b.anchor(knob, 0.0, 0.004, -0.012, 0, 0, Math.PI / 2);
  rig.rightHand = b.anchor(r, -0.038, -0.058, 0, -0.3, 0, 0);
  rig.leftHand = b.anchor(r, 0.262, -0.06, 0, -0.08, 0, 0);
  rig.leftHand.scale.set(1, 1, 1);
  rig.sightRear = P(-0.04, 0.09);
  rig.sightFront = P(0.49, 0.051);
  rig.eye = 0.13;
  rig.hip.set(0.15, -0.18, -0.38);
  return rig;
}

/** M3 "Grease Gun": stamped tube receiver, wire stock, long 30-round box. */
function greaseGun(b: Builder): GunRig {
  const k = b.k;
  const rig = baseRig('grease', b);
  const r = b.root;

  b.cyl(r, 0.025, 0.29, -0.17, 0.022, 0, k.parker, 18);
  b.cyl(r, 0.026, 0.008, -0.172, 0.022, 0, k.parker, 18);
  b.cyl(r, 0.015, 0.02, 0.12, 0.022, 0, k.parker, 12);
  b.cyl(r, 0.0085, 0.2, 0.14, 0.022, 0, k.blued, 10);
  b.cyl(r, 0.0055, 0.002, 0.3395, 0.022, 0, k.bore);
  // Ejection port cover and the cocking crank on the right.
  b.box(r, 0.004, 0.022, 0.075, 0.02, 0.03, 0.025, k.parker);
  const crank = b.group(r, -0.11, 0.005, 0.03);
  b.box(crank, 0.008, 0.006, 0.05, -0.02, 0, 0.002, k.bright);
  b.cylX(crank, 0.005, 0.018, -0.045, 0, 0.01, k.bright);
  slide(rig, crank, 0.02);
  // Sights.
  b.box(r, 0.016, 0.03, 0.012, -0.145, 0.058, 0, k.parker);
  b.ring(r, 0.006, 0.002, -0.145, 0.078, 0, k.parker);
  b.box(r, 0.004, 0.034, 0.004, 0.1, 0.058, 0, k.parker);
  // Magazine well, grip and guard.
  b.box(r, 0.03, 0.05, 0.04, 0.09, -0.01, 0, k.parker);
  b.profile(r, [[-0.02, 0.0], [-0.046, -0.1], [-0.082, -0.1], [-0.062, 0.0]], 0.03, k.parker);
  b.guard(r, -0.01, 0.04, -0.005, 0.03, 0.008, k.parker);
  // Wire stock: two rods and a butt.
  b.cyl(r, 0.004, 0.3, -0.47, 0.03, 0, k.bright, 6);
  b.cyl(r, 0.004, 0.33, -0.47, -0.035, 0, k.bright, 6);
  b.box(r, 0.006, 0.11, 0.012, -0.47, -0.005, 0, k.bright);

  const mag = b.group(r, 0.09, -0.12, 0);
  b.box(mag, 0.024, 0.2, 0.032, 0, 0, 0, k.parker);
  b.box(mag, 0.028, 0.008, 0.036, 0, -0.1, 0, k.parker);
  b.box(mag, 0.012, 0.006, 0.02, 0, 0.101, 0, k.brass);
  rig.mag = mag;
  rig.magAxis.set(0, 1, 0);
  rig.magTravel = 0.14;
  rig.magGrab = b.anchor(mag, 0, -0.03, -0.012, 0, 0, 0);

  rig.muzzle = b.anchor(r, 0.34, 0.022, 0);
  rig.eject = b.anchor(r, 0.03, 0.03, 0.026);
  rig.charge = b.anchor(crank, -0.045, 0, 0.03, 0, 0, Math.PI / 2);
  rig.rightHand = b.anchor(r, -0.052, -0.05, 0, -0.26, 0, 0);
  rig.leftHand = b.anchor(r, 0.09, -0.06, 0, 0, 0, 0);
  rig.sightRear = P(-0.145, 0.078);
  rig.sightFront = P(0.1, 0.075);
  rig.eye = 0.2;
  rig.hip.set(0.14, -0.17, -0.4);
  return rig;
}

/** AK-47: wood furniture, gas tube, and the curved bakelite 30-rounder. */
function ak47(b: Builder): GunRig {
  const k = b.k;
  const rig = baseRig('nailrifle', b);
  const r = b.root;

  b.profile(r, [[-0.13, 0.0], [0.125, 0.0], [0.125, 0.04], [-0.1, 0.042], [-0.13, 0.03]], 0.03, k.blued);
  // Dust cover.
  b.profile(r, [[-0.12, 0.04], [0.105, 0.04], [0.11, 0.05], [-0.1, 0.056], [-0.125, 0.046]], 0.026, k.blued);
  b.box(r, 0.004, 0.012, 0.075, 0.05, 0.032, 0.0152, k.bore);
  // Long selector lever down the right side.
  b.box(r, 0.003, 0.012, 0.13, 0.0, 0.028, 0.0165, k.blued);
  const handle = b.group(r, 0.085, 0.033, 0.018);
  b.box(handle, 0.02, 0.008, 0.012, 0, 0, 0.009, k.bright);
  b.box(handle, 0.004, 0.01, 0.06, -0.03, 0, -0.002, k.bright);
  slide(rig, handle, 0.09);
  // Rear sight block, barrel, gas block, gas tube and front sight.
  b.profile(r, [[0.125, 0.036], [0.19, 0.036], [0.19, 0.06], [0.14, 0.066]], 0.03, k.blued);
  b.box(r, 0.006, 0.014, 0.012, 0.162, 0.073, -0.006, k.blued);
  b.box(r, 0.006, 0.014, 0.012, 0.162, 0.073, 0.006, k.blued);
  b.cyl(r, 0.009, 0.42, 0.12, 0.026, 0, k.blued, 10);
  b.box(r, 0.022, 0.05, 0.03, 0.375, 0.038, 0, k.blued);
  b.cyl(r, 0.0095, 0.19, 0.19, 0.05, 0, k.blued, 10);
  b.profile(r, [[0.49, 0.015], [0.525, 0.015], [0.525, 0.035], [0.515, 0.08], [0.5, 0.08], [0.49, 0.035]], 0.024, k.blued, 0, [[[0.497, 0.042], [0.518, 0.042], [0.512, 0.074], [0.503, 0.074]]]);
  b.box(r, 0.003, 0.034, 0.003, 0.508, 0.057, 0, k.blued);
  b.cyl(r, 0.011, 0.016, 0.53, 0.026, 0, k.blued, 10);
  b.cyl(r, 0.006, 0.002, 0.545, 0.026, 0, k.bore);
  // Wood: lower handguard with finger grooves, upper handguard over the gas tube.
  b.profile(r, [[0.14, -0.012], [0.33, -0.008], [0.34, 0.01], [0.335, 0.034], [0.14, 0.036]], 0.044, k.wood);
  for (let i = 0; i < 3; i++) b.box(r, 0.046, 0.003, 0.012, 0.22 + i * 0.028, 0.0, 0, k.bore);
  b.profile(r, [[0.19, 0.04], [0.345, 0.042], [0.34, 0.064], [0.2, 0.066]], 0.032, k.wood);
  b.profile(r, [[-0.012, 0.0], [-0.036, -0.1], [-0.074, -0.1], [-0.055, 0.0]], 0.028, k.wood);
  b.guard(r, 0.0, 0.062, 0.0, 0.03, 0.01, k.blued);
  b.profile(r, [[-0.13, 0.036], [-0.13, -0.006], [-0.16, -0.032], [-0.44, -0.072], [-0.45, -0.066], [-0.45, 0.028], [-0.43, 0.034], [-0.16, 0.038]], 0.036, k.wood);

  // The magazine hooks in at the front and rocks back into place.
  const mag = b.group(r, 0.075, 0.0, 0);
  b.profile(mag, [[-0.038, 0.0], [0.002, 0.0], [0.018, -0.06], [0.038, -0.12], [0.064, -0.18], [0.07, -0.2], [0.034, -0.214], [0.024, -0.17], [0.004, -0.11], [-0.018, -0.05], [-0.036, -0.0]], 0.026, k.bakelite);
  for (let i = 0; i < 3; i++) b.box(mag, 0.028, 0.06, 0.004, -0.005 + i * 0.022, -0.06 - i * 0.05, 0, k.bakelite, -0.3 - i * 0.12);
  b.box(mag, 0.011, 0.006, 0.02, -0.014, 0.004, 0, k.brass);
  rig.mag = mag;
  rig.magAxis.set(0, 1, 0);
  rig.magTravel = 0.09;
  rig.magRock = 0.5;
  rig.magGrab = b.anchor(mag, 0.02, -0.08, -0.012, 0.3, 0, 0);

  rig.muzzle = b.anchor(r, 0.545, 0.026, 0);
  rig.eject = b.anchor(r, 0.05, 0.034, 0.016);
  rig.charge = b.anchor(handle, 0, 0.0, 0.03, 0, 0, Math.PI / 2);
  rig.rightHand = b.anchor(r, -0.042, -0.05, 0, -0.26, 0, 0);
  rig.leftHand = b.anchor(r, 0.26, -0.006, -0.012, Math.PI / 2 - 0.15, 0, 0.5);
  rig.sightRear = P(0.162, 0.0745);
  rig.sightFront = P(0.508, 0.0745);
  rig.eye = 0.17;
  rig.hip.set(0.15, -0.17, -0.37);
  return rig;
}

/** Lee-Enfield No.4 Mk I (T): full-length wood, turn-bolt, No.32 scope. */
function enfield(b: Builder): GunRig {
  const k = b.k;
  const rig = baseRig('longshot', b);
  const r = b.root;

  b.profile(r, [[-0.07, 0.0], [0.13, 0.0], [0.13, 0.042], [-0.05, 0.044], [-0.07, 0.032]], 0.03, k.blued);
  // The bolt: body along the receiver, handle bent down on the right.
  const bolt = b.group(r, 0.0, 0.034, 0);
  b.cyl(bolt, 0.009, 0.16, -0.1, 0, 0, k.bright, 10);
  b.cyl(bolt, 0.011, 0.02, -0.105, 0, 0, k.blued, 10);
  b.box(bolt, 0.04, 0.006, 0.008, -0.07, -0.006, 0.02, k.bright, 0, 0, -0.5);
  const knob = b.group(bolt, -0.072, -0.02, 0.04);
  b.sphere(knob, 0.009, 0, 0, 0, k.bright);
  rig.bolt = { group: bolt, lift: 1.25, travel: 0.1, knob };
  // Box magazine under the action.
  b.box(r, 0.028, 0.05, 0.06, 0.05, -0.022, 0, k.blued);
  // Full-length wood.
  b.profile(r, [[0.0, -0.02], [0.52, -0.016], [0.56, 0.0], [0.56, 0.03], [0.13, 0.034], [0.0, 0.03]], 0.046, k.wood);
  b.profile(r, [[0.14, 0.034], [0.3, 0.034], [0.3, 0.05], [0.15, 0.05]], 0.036, k.wood);
  b.profile(r, [[0.32, 0.032], [0.55, 0.03], [0.55, 0.046], [0.33, 0.048]], 0.034, k.wood);
  b.cyl(r, 0.0092, 0.08, 0.55, 0.024, 0, k.blued, 10);
  b.cyl(r, 0.0056, 0.002, 0.6295, 0.024, 0, k.bore);
  b.box(r, 0.004, 0.024, 0.02, 0.62, 0.04, -0.012, k.blued);
  b.box(r, 0.004, 0.024, 0.02, 0.62, 0.04, 0.012, k.blued);
  b.box(r, 0.003, 0.018, 0.004, 0.62, 0.042, 0, k.blued);
  b.guard(r, -0.02, 0.06, -0.018, 0.028, 0.011, k.blued);
  b.profile(r, [[-0.07, 0.032], [-0.07, -0.02], [-0.1, -0.052], [-0.43, -0.1], [-0.44, -0.094], [-0.44, 0.022], [-0.41, 0.03], [-0.1, 0.028]], 0.038, k.wood);
  b.box(r, 0.04, 0.12, 0.006, -0.443, -0.036, 0, k.brass);
  // No.32 scope on its side-mounted bracket.
  b.box(r, 0.016, 0.028, 0.07, 0.03, 0.058, -0.012, k.blued);
  b.cyl(r, 0.013, 0.26, -0.08, 0.082, -0.014, k.blued, 14);
  b.cyl(r, 0.017, 0.05, -0.12, 0.082, -0.014, k.blued, 14);
  b.cyl(r, 0.0185, 0.05, 0.17, 0.082, -0.014, k.blued, 14);
  b.cyl(r, 0.015, 0.002, 0.2195, 0.082, -0.014, k.glass, 14);
  b.cylY(r, 0.009, 0.02, 0.05, 0.1, -0.014, k.blued);

  // Stripper clip of five, carried in the support hand.
  const clip = new THREE.Group();
  b.box(clip, 0.012, 0.004, 0.06, 0, -0.03, 0, k.bright);
  for (let i = 0; i < 5; i++) b.cyl(clip, 0.005, 0.07, -0.02, -0.024, -0.024 + i * 0.012, k.brass, 6);
  rig.prop = clip;

  rig.muzzle = b.anchor(r, 0.63, 0.024, 0);
  rig.eject = b.anchor(r, 0.03, 0.045, 0.012);
  rig.port = b.anchor(r, 0.04, 0.09, 0.0, 0.3, 0, 0);
  rig.rightHand = b.anchor(r, -0.085, -0.032, 0, -0.62, 0, 0);
  rig.leftHand = b.anchor(r, 0.25, -0.01, -0.016, Math.PI / 2 - 0.15, 0, 0.5);
  rig.reload = 'bolt';
  rig.cycleAfterShot = true;
  rig.scoped = true;
  rig.sightRear = P(-0.1, 0.082, -0.014);
  rig.sightFront = P(0.2, 0.082, -0.014);
  rig.eye = 0.08;
  rig.hip.set(0.15, -0.17, -0.34);
  return rig;
}

/** Franchi SPAS-12: perforated heat shield, ribbed pump, tube magazine. */
function spas12(b: Builder): GunRig {
  const k = b.k;
  const rig = baseRig('scattergun', b);
  const r = b.root;

  b.profile(r, [[-0.085, 0.0], [0.125, 0.0], [0.125, 0.058], [-0.06, 0.063], [-0.085, 0.05]], 0.04, k.black);
  b.box(r, 0.004, 0.02, 0.07, 0.05, 0.036, 0.0202, k.bore);
  b.cyl(r, 0.0115, 0.5, 0.12, 0.044, 0, k.black, 12);
  // Perforated heat shield over the barrel.
  const shieldGeo = new THREE.CylinderGeometry(0.017, 0.017, 0.4, 12, 1, true, -Math.PI / 2, Math.PI);
  shieldGeo.rotateX(-Math.PI / 2);
  shieldGeo.rotateZ(Math.PI / 2);
  planarUV(shieldGeo);
  const shield = new THREE.Mesh(shieldGeo, k.perf);
  shield.position.set(0, 0.046, -0.4);
  r.add(shield);
  b.cyl(r, 0.0135, 0.46, 0.12, 0.014, 0, k.black, 12);
  b.cyl(r, 0.0145, 0.02, 0.58, 0.014, 0, k.black, 12);
  b.cyl(r, 0.009, 0.002, 0.6195, 0.044, 0, k.bore);
  b.box(r, 0.008, 0.014, 0.008, 0.6, 0.064, 0, k.black);
  b.box(r, 0.003, 0.012, 0.003, 0.6, 0.076, 0, k.bright);
  b.box(r, 0.03, 0.006, 0.02, -0.03, 0.066, 0, k.black);
  b.ring(r, 0.009, 0.0025, -0.03, 0.078, 0, k.black);
  // Pump: ribbed polymer forend around the magazine tube.
  const pump = b.group(r, 0, 0, 0);
  b.profile(pump, [[0.2, -0.014], [0.39, -0.012], [0.395, 0.03], [0.2, 0.032]], 0.052, k.black);
  for (let i = 0; i < 7; i++) b.box(pump, 0.054, 0.034, 0.004, 0.22 + i * 0.024, 0.009, 0, k.bore);
  rig.pump = { group: pump, travel: 0.08 };
  // Grip, guard, skeleton stock.
  b.profile(r, [[-0.012, 0.0], [-0.038, -0.102], [-0.076, -0.102], [-0.058, 0.0]], 0.032, k.black);
  b.guard(r, 0.0, 0.058, 0.0, 0.032, 0.012, k.black);
  b.cyl(r, 0.005, 0.28, -0.36, 0.04, -0.018, k.black, 6);
  b.cyl(r, 0.005, 0.28, -0.36, 0.04, 0.018, k.black, 6);
  b.box(r, 0.05, 0.12, 0.012, -0.365, -0.01, 0, k.black);
  b.profile(r, [[-0.36, -0.07], [-0.33, -0.07], [-0.3, -0.1], [-0.31, -0.105]], 0.01, k.black);

  // Shells for the loading port, and the one that gets pumped out.
  const shell = new THREE.Group();
  b.cyl(shell, 0.0105, 0.065, -0.045, 0, 0, k.shell);
  b.cyl(shell, 0.011, 0.012, -0.055, 0, 0, k.brass);
  rig.prop = shell;

  rig.muzzle = b.anchor(r, 0.62, 0.044, 0);
  rig.eject = b.anchor(r, 0.05, 0.036, 0.02);
  rig.port = b.anchor(r, 0.06, -0.012, 0, -Math.PI / 2, 0, 0);
  rig.rightHand = b.anchor(r, -0.045, -0.052, 0, -0.26, 0, 0);
  rig.leftHand = b.anchor(pump, 0.29, -0.012, -0.018, Math.PI / 2 - 0.1, 0, 0.45);
  rig.reload = 'shell';
  rig.casing = 'shell';
  rig.sightRear = P(-0.03, 0.078);
  rig.sightFront = P(0.6, 0.081);
  rig.eye = 0.17;
  rig.hip.set(0.15, -0.18, -0.37);
  return rig;
}

/** Six-barrel rotary gun, carried at the hip with a side handle and an ammo can. */
function rotary(b: Builder): GunRig {
  const k = b.k;
  const rig = baseRig('ripper', b);
  const r = b.root;

  const spin = b.group(r, 0, 0.0, 0);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.cyl(spin, 0.0085, 0.5, 0.1, Math.sin(a) * 0.03, Math.cos(a) * 0.03, k.blued, 8);
    b.cyl(spin, 0.005, 0.002, 0.599, Math.sin(a) * 0.03, Math.cos(a) * 0.03, k.bore, 6);
  }
  b.cyl(spin, 0.044, 0.012, 0.34, 0, 0, k.blued, 14);
  b.cyl(spin, 0.044, 0.02, 0.57, 0, 0, k.blued, 14);
  b.cyl(spin, 0.02, 0.5, 0.1, 0, 0, k.black, 8);
  rig.spin = spin;
  // Motor housing, rear body, carry handle.
  b.cyl(r, 0.058, 0.3, -0.2, 0, 0, k.black, 18);
  b.cyl(r, 0.062, 0.02, 0.08, 0, 0, k.blued, 18);
  b.box(r, 0.1, 0.1, 0.1, -0.24, -0.005, 0, k.black);
  b.box(r, 0.012, 0.012, 0.18, -0.02, 0.095, 0, k.blued);
  b.box(r, 0.012, 0.04, 0.012, 0.06, 0.07, 0, k.blued);
  b.box(r, 0.012, 0.04, 0.012, -0.1, 0.07, 0, k.blued);
  // Right grip under the rear, left handle out to the side.
  b.profile(r, [[-0.1, -0.05], [-0.12, -0.15], [-0.16, -0.15], [-0.145, -0.05]], 0.032, k.black);
  b.box(r, 0.08, 0.012, 0.012, 0.0, -0.02, -0.07, k.blued);
  b.cylY(r, 0.013, 0.1, 0.0, -0.06, -0.11, k.black);
  // Ammo can and feed chute.
  const can = b.group(r, -0.07, -0.12, 0.1);
  b.box(can, 0.1, 0.12, 0.2, 0, 0, 0, k.olive);
  b.box(can, 0.104, 0.02, 0.204, 0, 0.06, 0, k.olive);
  b.box(can, 0.03, 0.01, 0.06, 0, 0.074, 0, k.bright);
  rig.mag = can;
  rig.magAxis.set(0, 1, 0);
  rig.magTravel = 0.16;
  rig.magGrab = b.anchor(can, 0, 0.02, -0.05, 0, 0, 0);
  b.box(r, 0.03, 0.03, 0.14, -0.02, -0.04, 0.07, k.olive, 0.5, 0, 0.3);

  rig.muzzle = b.anchor(r, 0.6, 0, 0);
  rig.eject = b.anchor(r, -0.05, -0.05, 0.06);
  rig.charge = b.anchor(r, -0.05, 0.06, 0.06, 0, 0, Math.PI / 2);
  rig.rightHand = b.anchor(r, -0.13, -0.1, 0, -0.2, 0, 0);
  rig.leftHand = b.anchor(r, 0.0, -0.06, -0.11, 0, 0, 0);
  rig.reload = 'box';
  rig.sightRear = P(-0.05, 0.11);
  rig.sightFront = P(0.06, 0.11);
  rig.eye = 0.3;
  rig.hip.set(0.17, -0.17, -0.46);
  rig.hipRot.set(0, -0.08, 0);
  return rig;
}

/** A 1950s ray gun: stubby red body, three emitter rings, a glowing vial on top. */
function rayGun(b: Builder): GunRig {
  const k = b.k;
  const rig = baseRig('plasma', b);
  const r = b.root;

  b.sphere(r, 0.03, -0.055, 0.03, 0, k.red).scale.set(1, 1, 1.5);
  b.cyl(r, 0.034, 0.15, -0.05, 0.03, 0, k.red, 16, 0.026);
  b.cyl(r, 0.02, 0.04, 0.1, 0.03, 0, k.brass, 12, 0.014);
  b.ring(r, 0.036, 0.005, 0.12, 0.03, 0, k.glowGreen).rotation.y = 0;
  b.ring(r, 0.03, 0.005, 0.145, 0.03, 0, k.glowGreen);
  b.ring(r, 0.024, 0.005, 0.17, 0.03, 0, k.glowGreen);
  b.cyl(r, 0.007, 0.03, 0.14, 0.03, 0, k.brass, 8);
  b.cyl(r, 0.005, 0.004, 0.17, 0.03, 0, k.glowGreen, 8);
  for (let i = 0; i < 3; i++) {
    const fin = b.box(r, 0.004, 0.04, 0.05, -0.07, 0.03, 0, k.brass);
    fin.rotation.z = (i / 3) * Math.PI * 2;
    fin.position.y = 0.03 + Math.cos((i / 3) * Math.PI * 2) * 0.035;
    fin.position.x = Math.sin((i / 3) * Math.PI * 2) * 0.035;
  }
  b.profile(r, [[-0.005, 0.0], [-0.03, -0.095], [-0.066, -0.095], [-0.05, 0.0]], 0.028, k.black);
  b.guard(r, 0.0, 0.05, 0.0, 0.028, 0.009, k.brass);
  // The glowing vial rides in a cradle on the left flank: this is the "magazine".
  b.box(r, 0.01, 0.03, 0.1, 0.02, 0.03, -0.03, k.brass);
  const vial = b.group(r, 0.02, 0.034, -0.046);
  b.cyl(vial, 0.012, 0.08, -0.04, 0, 0, k.glowGreen, 10);
  b.cyl(vial, 0.014, 0.012, -0.052, 0, 0, k.brass, 10);
  b.cyl(vial, 0.014, 0.012, 0.04, 0, 0, k.brass, 10);
  rig.mag = vial;
  rig.magAxis.set(1, 0, 0);
  rig.magTravel = 0.07;
  rig.magGrab = b.anchor(vial, 0, -0.012, -0.012, 0, 0, -0.4);

  rig.muzzle = b.anchor(r, 0.18, 0.03, 0);
  rig.rightHand = b.anchor(r, -0.034, -0.048, 0, -0.25, 0, 0);
  rig.leftHand = b.anchor(r, -0.03, -0.062, -0.03, -0.3, 0.25, 0.25);
  rig.reload = 'cell';
  rig.casing = null;
  rig.sightRear = P(-0.04, 0.1);
  rig.sightFront = P(0.08, 0.1);
  rig.eye = 0.34;
  rig.hip.set(0.14, -0.15, -0.46);
  return rig;
}

/** M9A1 bazooka: 60 mm tube, blast deflector, twin grips, wooden shoulder rest. */
function bazooka(b: Builder): GunRig {
  const k = b.k;
  const rig = baseRig('hellfire', b);
  const r = b.root;

  b.cyl(r, 0.033, 1.1, -0.55, 0.06, 0, k.olive, 16);
  b.cyl(r, 0.036, 0.03, 0.52, 0.06, 0, k.olive, 16);
  b.cyl(r, 0.029, 0.002, 0.549, 0.06, 0, k.bore, 16);
  b.ring(r, 0.06, 0.004, 0.33, 0.06, 0, k.olive);
  for (const x of [-0.045, 0.045]) b.box(r, 0.004, 0.004, 0.05, 0.33, 0.06, x, k.olive);
  b.box(r, 0.02, 0.03, 0.05, 0.12, 0.02, 0, k.olive);
  b.profile(r, [[0.1, 0.02], [0.14, 0.02], [0.138, -0.08], [0.105, -0.08]], 0.03, k.wood);
  b.profile(r, [[-0.01, 0.03], [-0.035, -0.08], [-0.075, -0.08], [-0.06, 0.03]], 0.03, k.wood);
  b.guard(r, 0.0, 0.05, 0.028, 0.03, 0.01, k.olive);
  b.profile(r, [[-0.18, 0.03], [-0.36, 0.03], [-0.36, -0.03], [-0.2, -0.02]], 0.06, k.wood);
  // Folding sight on the left, and the contact box.
  b.box(r, 0.004, 0.05, 0.04, 0.05, 0.1, -0.03, k.olive);
  b.box(r, 0.018, 0.022, 0.03, 0.06, 0.1, -0.03, k.glass);
  b.box(r, 0.03, 0.02, 0.05, -0.34, 0.1, 0.02, k.olive);
  // Rocket warhead visible in the muzzle while loaded.
  const loaded = b.group(r, 0.5, 0.06, 0);
  b.cyl(loaded, 0.028, 0.04, -0.02, 0, 0, k.olive, 12, 0.012);
  rig.loaded = loaded;

  const rocket = new THREE.Group();
  b.cyl(rocket, 0.028, 0.2, -0.1, 0, 0, k.olive, 12);
  b.cyl(rocket, 0.028, 0.1, 0.1, 0, 0, k.olive, 12, 0.006);
  b.cyl(rocket, 0.012, 0.18, -0.28, 0, 0, k.blued, 8);
  for (let i = 0; i < 4; i++) b.box(rocket, 0.002, 0.05, 0.05, -0.26, 0, 0, k.blued, 0, 0, (i * Math.PI) / 2).position.set(0, 0, 0.26);
  rig.prop = rocket;

  rig.muzzle = b.anchor(r, 0.55, 0.06, 0);
  rig.port = b.anchor(r, -0.45, 0.02, 0.05, 0, 0, 0);
  rig.rightHand = b.anchor(r, -0.042, -0.02, 0, -0.26, 0, 0);
  rig.leftHand = b.anchor(r, 0.12, -0.03, 0, -0.05, 0, 0);
  rig.reload = 'rocket';
  rig.casing = null;
  rig.sightRear = P(0.03, 0.105, -0.03);
  rig.sightFront = P(0.08, 0.105, -0.03);
  rig.eye = 0.2;
  rig.hip.set(0.17, -0.17, -0.26);
  rig.hipRot.set(0, -0.03, 0);
  return rig;
}

/** Brass-and-coil air cannon with a bell mouth and a spinning turbine. */
function thunderGun(b: Builder): GunRig {
  const k = b.k;
  const rig = baseRig('thunder', b);
  const r = b.root;

  b.cyl(r, 0.06, 0.32, -0.12, 0.05, 0, k.copper, 18);
  for (let i = 0; i < 4; i++) b.cyl(r, 0.064, 0.012, -0.1 + i * 0.08, 0.05, 0, k.brass, 18);
  b.cyl(r, 0.064, 0.12, 0.2, 0.05, 0, k.brass, 18, 0.105);
  b.cyl(r, 0.098, 0.004, 0.318, 0.05, 0, k.bore, 18);
  const turbine = b.group(r, 0.3, 0.05, 0);
  for (let i = 0; i < 6; i++) {
    const blade = b.box(turbine, 0.012, 0.08, 0.004, 0, 0, 0, k.glowBlue);
    blade.rotation.z = (i / 6) * Math.PI;
  }
  rig.spin = turbine;
  for (const x of [-0.066, 0.066]) b.cyl(r, 0.008, 0.3, -0.1, 0.05, x, k.glowBlue, 8);
  b.sphere(r, 0.06, -0.12, 0.05, 0, k.copper);
  b.profile(r, [[-0.03, 0.0], [-0.055, -0.1], [-0.095, -0.1], [-0.075, 0.0]], 0.034, k.wood);
  b.guard(r, -0.02, 0.035, -0.005, 0.03, 0.01, k.brass);
  b.box(r, 0.014, 0.04, 0.2, 0.08, 0.13, 0, k.brass);
  const cell = b.group(r, 0.05, 0.05, -0.08);
  b.box(cell, 0.03, 0.05, 0.12, 0, 0, 0, k.blued);
  b.box(cell, 0.032, 0.03, 0.1, 0, 0, 0, k.glowBlue);
  rig.mag = cell;
  rig.magAxis.set(1, 0, 0);
  rig.magTravel = 0.08;
  rig.magGrab = b.anchor(cell, 0, -0.01, -0.02, 0, 0, -0.3);

  rig.muzzle = b.anchor(r, 0.32, 0.05, 0);
  rig.rightHand = b.anchor(r, -0.06, -0.048, 0, -0.25, 0, 0);
  rig.leftHand = b.anchor(r, 0.18, -0.02, -0.05, Math.PI / 2 - 0.2, 0, 0.5);
  rig.reload = 'cell';
  rig.casing = null;
  rig.sightRear = P(0.0, 0.16);
  rig.sightFront = P(0.18, 0.16);
  rig.eye = 0.2;
  rig.hip.set(0.19, -0.21, -0.52);
  return rig;
}

/** US M1918 Mk I trench knife: brass knuckle-duster grip, flat double-edged blade. */
function trenchKnife(b: Builder): GunRig {
  const k = b.k;
  const rig = baseRig('knife', b);
  const r = b.root;
  b.profile(r, [[0.0, -0.008], [0.14, -0.004], [0.175, 0.0], [0.14, 0.004], [0.0, 0.008]], 0.004, k.bright);
  b.profile(r, [[-0.015, 0.03], [0.005, 0.03], [0.005, -0.03], [-0.015, -0.03]], 0.012, k.brass);
  b.profile(r, [[-0.11, 0.028], [-0.012, 0.028], [-0.012, 0.018], [-0.1, 0.018]], 0.02, k.wood);
  b.profile(r, [[-0.11, 0.028], [-0.1, 0.03], [-0.1, -0.035], [-0.012, -0.035], [-0.012, 0.025]], 0.012, k.brass, 0,
    [[[-0.095, 0.014], [-0.075, 0.014], [-0.075, -0.028], [-0.095, -0.028]], [[-0.066, 0.014], [-0.046, 0.014], [-0.046, -0.028], [-0.066, -0.028]], [[-0.037, 0.014], [-0.018, 0.014], [-0.018, -0.028], [-0.037, -0.028]]]);
  b.cyl(r, 0.009, 0.02, -0.13, 0.022, 0, k.brass, 8);
  rig.muzzle = b.anchor(r, 0.17, 0, 0);
  rig.rightHand = b.anchor(r, -0.06, 0.024, 0, 0, 0, 0);
  rig.leftHand = b.anchor(r, -0.06, 0.024, 0, 0, 0, 0);
  rig.reload = 'none';
  rig.casing = null;
  return rig;
}

/** Mk 2 fragmentation grenade: the serrated "pineapple" with spoon and pin. */
function mk2(b: Builder): GunRig {
  const k = b.k;
  const rig = baseRig('frag', b);
  const r = b.root;
  const body = b.cylY(r, 0.027, 0.07, 0, 0, 0, k.olive, 8, 0.024);
  body.scale.set(1, 1, 1);
  for (let i = 0; i < 4; i++) b.cylY(r, 0.0285, 0.004, 0, -0.026 + i * 0.017, 0, k.bore, 8);
  b.cylY(r, 0.012, 0.018, 0, 0.044, 0, k.parker, 8);
  b.box(r, 0.012, 0.06, 0.006, 0, 0.022, 0.03, k.parker, 0, 0, 0.1);
  b.ring(r, 0.012, 0.002, 0, 0.056, -0.018, k.bright).rotation.y = Math.PI / 2;
  rig.muzzle = b.anchor(r, 0, 0, 0);
  rig.rightHand = b.anchor(r, 0, 0, 0);
  rig.leftHand = b.anchor(r, 0, 0, 0);
  rig.reload = 'none';
  rig.casing = null;
  return rig;
}

const BUILDERS: Record<string, (b: Builder) => GunRig> = {
  sidearm: m1911,
  boomstick: coachGun,
  trench: thompson,
  grease: greaseGun,
  nailrifle: ak47,
  longshot: enfield,
  scattergun: spas12,
  ripper: rotary,
  plasma: rayGun,
  hellfire: bazooka,
  thunder: thunderGun,
  knife: trenchKnife,
  frag: mk2,
};

/** Weapon ids that have a model. Every entry in the weapon table must be here. */
export const GUN_IDS = Object.keys(BUILDERS);

export function buildGun(id: string, mode: KitMode = 'view', packed = false): GunRig {
  const make = BUILDERS[id];
  if (!make) throw new Error(`no model for weapon ${id}`);
  const rig = make(new Builder(kitFor(mode, packed)));
  rig.root.updateMatrixWorld(true);
  finishMag(rig);
  if (rig.prop) rig.prop.visible = false;
  return rig;
}

/* ----------------------------------------------------------------- hands */

export type Hand = {
  group: THREE.Group;
  /** Where the forearm attaches. */
  wrist: THREE.Object3D;
};

let handMats: { glove: THREE.Material; knuckle: THREE.Material; sleeve: THREE.Material; skin: THREE.Material } | null = null;

export function handMaterials(): { glove: THREE.Material; knuckle: THREE.Material; sleeve: THREE.Material; skin: THREE.Material } {
  if (!handMats) {
    const t = textures();
    handMats = {
      glove: new THREE.MeshStandardMaterial({ color: 0x221e1b, roughness: 0.75, metalness: 0, envMapIntensity: 0.4 }),
      knuckle: new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 0.6, metalness: 0, envMapIntensity: 0.4 }),
      sleeve: new THREE.MeshStandardMaterial({ map: tex(t.sleeve, 14), color: 0x8a8a70, roughness: 0.95, metalness: 0, envMapIntensity: 0.2 }),
      skin: new THREE.MeshStandardMaterial({ color: 0xb88a6a, roughness: 0.7, metalness: 0, envMapIntensity: 0.3 }),
    };
  }
  return handMats;
}

/**
 * A gloved right hand closed around a grip. Local +y runs up the grip, the
 * fingers wrap around its front (-z), the back of the hand faces +x. The left
 * hand is the same model mirrored.
 */
export function buildHand(): Hand {
  const m = handMaterials();
  const g = new THREE.Group();
  const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number, mat: THREE.Material, rx = 0, ry = 0, rz = 0): THREE.Mesh => {
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    planarUV(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    g.add(mesh);
    return mesh;
  };
  // Back of the hand and palm.
  box(0.03, 0.088, 0.082, 0.028, -0.004, 0.008, m.glove);
  box(0.006, 0.07, 0.05, 0.044, 0.0, 0.0, m.knuckle);
  // Four fingers wrapped across the front of the grip, in two segments.
  for (let i = 0; i < 4; i++) {
    const y = 0.03 - i * 0.021;
    box(0.036, 0.019, 0.022, 0.014, y, -0.03, m.glove);
    box(0.02, 0.018, 0.026, -0.018, y, -0.02, m.glove, 0, 0.5, 0);
  }
  // Thumb along the left side, index finger laid alongside the frame.
  box(0.018, 0.02, 0.058, -0.022, 0.036, -0.006, m.glove, 0.1, 0.15, 0);
  box(0.017, 0.017, 0.05, 0.004, 0.052, -0.05, m.glove, 0, 0, 0);
  // Cuff.
  box(0.058, 0.07, 0.052, 0.03, -0.036, 0.058, m.glove, -0.3, 0, 0);
  const wrist = new THREE.Object3D();
  wrist.position.set(0.032, -0.05, 0.085);
  g.add(wrist);
  return { group: g, wrist };
}

/** A forearm in a canvas sleeve: +z runs from the wrist toward the elbow. */
export function buildForearm(): THREE.Group {
  const m = handMaterials();
  const g = new THREE.Group();
  const geo = new THREE.CylinderGeometry(0.032, 0.04, 1, 8);
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, 0.5);
  planarUV(geo);
  const arm = new THREE.Mesh(geo, m.sleeve);
  g.add(arm);
  const cuffGeo = new THREE.CylinderGeometry(0.042, 0.042, 0.03, 8);
  cuffGeo.rotateX(Math.PI / 2);
  const cuff = new THREE.Mesh(cuffGeo, m.sleeve);
  cuff.position.z = 0.02;
  g.add(cuff);
  g.userData.arm = arm;
  return g;
}
