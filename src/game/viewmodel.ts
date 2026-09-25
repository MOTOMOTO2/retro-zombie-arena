/**
 * The first-person weapon, and the hands holding it.
 *
 * It lives in its own scene drawn after a depth clear, which is the standard
 * trick for keeping a long barrel from poking through walls. The right hand
 * is fixed to the pistol grip; the left hand is animated through keyframed
 * choreography: it grips the foregrip, reaches for the magazine, pulls it,
 * fetches a fresh one from off-screen, seats it and racks the action. Each
 * reload style (magazine, pistol, break-action, shell by shell, bolt, rocket,
 * energy cell, ammo can) has its own timeline, scaled to the real reload
 * duration so Speed Cola speeds the whole performance up.
 *
 * Aiming down the sights is computed from each gun's actual sight line, so
 * the front post sits on the rear notch in the middle of the screen.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildForearm, buildGun, buildHand, type GunRig, type Hand } from '../gfx/guns.ts';
import { textures } from '../gfx/textures.ts';

export type ViewPose = 'idle' | 'reload' | 'lower' | 'raise' | 'melee' | 'throw' | 'shellEnd' | 'cycle' | 'recover';

export type MechEvent =
  | 'magOut' | 'magIn' | 'magDrop' | 'rackBack' | 'rack'
  | 'breakOpen' | 'breakClose' | 'shellIn' | 'pump'
  | 'boltUp' | 'boltBack' | 'boltForward' | 'boltDown' | 'clipIn'
  | 'rocketIn' | 'cellOut' | 'cellIn' | 'boxOut' | 'boxIn' | 'swing' | 'throw';

type Spot =
  | 'grip' | 'mag' | 'charge' | 'port' | 'portPush' | 'bolt'
  | 'pouch' | 'low' | 'swingA' | 'swingB' | 'swingC' | 'windup' | 'release' | 'present';

/** px, py, pz, rx, ry, rz added to the resting pose. */
type G6 = [number, number, number, number, number, number];

type Key = {
  t: number;
  hand?: Spot;
  gun?: G6;
  mag?: number;
  held?: boolean;
  magVis?: boolean;
  slide?: number;
  bolt?: [number, number];
  pump?: number;
  open?: number;
  prop?: boolean;
  loaded?: boolean;
  tool?: 'knife' | 'frag' | 'none';
  ev?: MechEvent;
  casings?: number;
};

const Z: G6 = [0, 0, 0, 0, 0, 0];

/** View-space hand positions for spots that are not on the gun. */
const VIEW_SPOTS: Partial<Record<Spot, { p: THREE.Vector3; r: THREE.Euler }>> = {
  pouch: { p: new THREE.Vector3(-0.2, -0.36, -0.2), r: new THREE.Euler(-1.1, 0.4, 0.3) },
  low: { p: new THREE.Vector3(-0.08, -0.46, -0.28), r: new THREE.Euler(-0.4, 0, 0.2) },
  swingA: { p: new THREE.Vector3(-0.3, -0.08, -0.24), r: new THREE.Euler(-1.35, -0.5, 0.9) },
  swingB: { p: new THREE.Vector3(-0.02, -0.02, -0.4), r: new THREE.Euler(-1.55, 0, 1.4) },
  swingC: { p: new THREE.Vector3(0.24, -0.14, -0.28), r: new THREE.Euler(-1.75, 0.5, 1.9) },
  windup: { p: new THREE.Vector3(-0.15, 0.0, -0.12), r: new THREE.Euler(0.3, 0, 0.3) },
  release: { p: new THREE.Vector3(0.0, 0.04, -0.5), r: new THREE.Euler(-1.2, 0, 0) },
  present: { p: new THREE.Vector3(-0.02, -0.2, -0.36), r: new THREE.Euler(-0.2, -1.4, 0.2) },
};

// Shoulders sit low and back, so forearms rise into view from below the
// frame instead of swinging across it.
const SHOULDER_R = new THREE.Vector3(0.3, -0.58, 0.12);
const SHOULDER_L = new THREE.Vector3(-0.32, -0.6, 0.12);
const FOREARM = 0.26;

/* ------------------------------------------------------------ timelines */

function magKeys(rig: GunRig, empty: boolean, events: { out: MechEvent; in: MechEvent }): Key[] {
  const tilt: G6 = rig.magAxis.x !== 0 ? [-0.07, 0.07, 0.02, 0.22, 0.35, 0.35] : [-0.08, 0.07, 0.02, 0.2, 0.3, -0.55];
  const jolt: G6 = [tilt[0], tilt[1] + 0.012, tilt[2], tilt[3] - 0.05, tilt[4], tilt[5]];
  const keys: Key[] = [
    { t: 0, gun: Z, hand: 'grip', mag: 0, held: false, magVis: true, slide: 0 },
    { t: 0.12, gun: tilt, hand: 'mag' },
    { t: 0.16, mag: 0 },
    { t: 0.19, ev: events.out },
    { t: 0.28, mag: 1, hand: 'mag' },
    { t: 0.29, held: true },
    { t: 0.44, hand: 'pouch' },
    { t: 0.48, hand: 'pouch' },
    { t: 0.6, hand: 'mag', mag: 1 },
    { t: 0.61, held: false },
    { t: 0.62, gun: tilt },
    { t: 0.7, mag: 0, hand: 'mag', gun: jolt, ev: events.in },
    { t: 0.74, gun: tilt },
  ];
  if (empty && rig.charge) {
    const rack: G6 = [tilt[0], tilt[1], tilt[2], 0.08, 0.05, 0.2];
    keys.push(
      { t: 0.8, hand: 'charge', gun: rack, slide: 0 },
      { t: 0.84, slide: 1, ev: 'rackBack' },
      { t: 0.86, slide: 1, hand: 'charge' },
      { t: 0.89, slide: 0, ev: 'rack' },
      { t: 0.93, hand: 'grip' },
      { t: 1, gun: Z },
    );
  } else {
    keys.push({ t: 0.86, hand: 'grip' }, { t: 1, gun: Z });
  }
  return keys;
}

function pistolKeys(empty: boolean): Key[] {
  const tilt: G6 = [-0.06, 0.06, 0.04, 0.35, 0.25, 0.45];
  return [
    { t: 0, gun: Z, hand: 'grip', mag: 0, held: false, magVis: true, slide: empty ? 1 : 0 },
    { t: 0.1, gun: tilt, hand: 'grip' },
    { t: 0.12, mag: 0 },
    { t: 0.19, mag: 1, ev: 'magDrop' },
    { t: 0.2, magVis: false },
    { t: 0.3, hand: 'pouch' },
    { t: 0.36, hand: 'pouch', magVis: true, held: true, mag: 1 },
    { t: 0.55, hand: 'mag' },
    { t: 0.56, held: false },
    { t: 0.62, mag: 0, hand: 'mag', ev: 'magIn', gun: [-0.06, 0.07, 0.04, 0.28, 0.25, 0.45] },
    { t: 0.66, gun: tilt },
    ...(empty
      ? [
        { t: 0.72, hand: 'charge' as Spot, slide: 1 },
        { t: 0.76, slide: 0, ev: 'rack' as MechEvent, gun: [-0.05, 0.05, 0.05, 0.42, 0.2, 0.35] as G6 },
      ]
      : []),
    { t: 0.86, hand: 'grip' },
    { t: 1, gun: Z },
  ];
}

function breakKeys(): Key[] {
  const open: G6 = [-0.06, 0.06, 0.02, -0.3, 0.3, 0.4];
  return [
    { t: 0, gun: Z, hand: 'grip', open: 0, loaded: true, prop: false },
    { t: 0.1, gun: open },
    { t: 0.12, open: 0 },
    { t: 0.14, ev: 'breakOpen' },
    { t: 0.2, open: 1 },
    { t: 0.22, casings: 2, loaded: false },
    { t: 0.24, hand: 'grip' },
    { t: 0.34, hand: 'pouch' },
    { t: 0.38, hand: 'pouch', prop: true },
    { t: 0.52, hand: 'port' },
    { t: 0.6, hand: 'portPush', ev: 'shellIn' },
    { t: 0.63, prop: false, loaded: true },
    { t: 0.72, hand: 'grip', gun: open, open: 1 },
    { t: 0.79, open: 0, ev: 'breakClose', gun: [0, 0.02, 0, 0.18, 0, 0] },
    { t: 1, gun: Z },
  ];
}

const SHELL_TILT: G6 = [-0.07, 0.07, 0.02, 0.18, 0.3, 0.75];

function shellKeys(first: boolean): Key[] {
  if (first) {
    return [
      { t: 0, gun: Z, hand: 'grip', prop: false },
      { t: 0.3, gun: SHELL_TILT, hand: 'pouch', prop: true },
      { t: 0.62, hand: 'port' },
      { t: 0.78, hand: 'portPush', ev: 'shellIn' },
      { t: 0.8, prop: false },
      { t: 1, hand: 'pouch', gun: SHELL_TILT },
    ];
  }
  return [
    { t: 0, gun: SHELL_TILT, hand: 'pouch', prop: true },
    { t: 0.45, hand: 'port' },
    { t: 0.68, hand: 'portPush', ev: 'shellIn' },
    { t: 0.7, prop: false },
    { t: 1, hand: 'pouch', gun: SHELL_TILT },
  ];
}

function shellEndKeys(): Key[] {
  return [
    { t: 0, gun: SHELL_TILT, hand: 'pouch', pump: 0, prop: false },
    { t: 0.4, gun: [0, 0, 0, 0.05, 0, 0.1], hand: 'grip' },
    { t: 0.55, pump: 1, ev: 'pump' },
    { t: 0.62, pump: 1 },
    { t: 0.76, pump: 0, ev: 'rack', gun: [0, 0.01, 0.01, 0.08, 0, 0] },
    { t: 1, gun: Z },
  ];
}

function cycleKeys(): Key[] {
  const c: G6 = [-0.03, 0.03, 0.01, 0.08, 0.12, 0.3];
  return [
    { t: 0, gun: Z, hand: 'grip', bolt: [0, 0] },
    { t: 0.14, gun: c, hand: 'bolt' },
    { t: 0.24, bolt: [1, 0], ev: 'boltUp' },
    { t: 0.42, bolt: [1, 1], ev: 'boltBack' },
    { t: 0.44, casings: 1 },
    { t: 0.6, bolt: [1, 0], ev: 'boltForward' },
    { t: 0.7, bolt: [0, 0], ev: 'boltDown', hand: 'bolt' },
    { t: 0.9, hand: 'grip' },
    { t: 1, gun: Z },
  ];
}

function boltReloadKeys(): Key[] {
  const r: G6 = [-0.07, 0.06, 0.02, 0.18, 0.25, 0.45];
  return [
    { t: 0, gun: Z, hand: 'grip', bolt: [0, 0], prop: false },
    { t: 0.08, gun: r, hand: 'bolt' },
    { t: 0.13, bolt: [1, 0], ev: 'boltUp' },
    { t: 0.2, bolt: [1, 1], ev: 'boltBack', hand: 'bolt' },
    { t: 0.32, hand: 'pouch' },
    { t: 0.36, hand: 'pouch', prop: true },
    { t: 0.5, hand: 'port' },
    { t: 0.62, hand: 'portPush', ev: 'clipIn' },
    { t: 0.66, prop: false },
    { t: 0.72, hand: 'bolt' },
    { t: 0.77, bolt: [1, 0], ev: 'boltForward' },
    { t: 0.83, bolt: [0, 0], ev: 'boltDown', hand: 'bolt' },
    { t: 0.92, hand: 'grip' },
    { t: 1, gun: Z },
  ];
}

function rocketKeys(): Key[] {
  const low: G6 = [-0.02, -0.04, 0.06, -0.2, -0.25, 0.3];
  return [
    { t: 0, gun: Z, hand: 'grip', prop: false },
    { t: 0.14, gun: low },
    { t: 0.26, hand: 'pouch' },
    { t: 0.29, prop: true },
    { t: 0.42, hand: 'present' },
    { t: 0.5, hand: 'present' },
    { t: 0.58, hand: 'port' },
    { t: 0.62, hand: 'portPush', ev: 'rocketIn' },
    { t: 0.62, prop: false, loaded: true },
    { t: 0.66, gun: [-0.02, -0.02, 0.06, -0.16, -0.25, 0.3] },
    { t: 0.78, hand: 'grip', gun: low },
    { t: 1, gun: Z },
  ];
}

function lowerKeys(raise: boolean): Key[] {
  const down: G6 = [0.02, -0.2, 0.06, -0.9, 0.1, 0.25];
  return raise
    ? [{ t: 0, gun: down, hand: 'grip' }, { t: 1, gun: Z }]
    : [{ t: 0, gun: Z, hand: 'grip' }, { t: 1, gun: down }];
}

function meleeKeys(): Key[] {
  const duck: G6 = [0.06, -0.08, 0.04, -0.25, 0.25, -0.35];
  return [
    { t: 0, gun: Z, hand: 'grip', tool: 'none' },
    { t: 0.16, gun: duck, hand: 'low' },
    { t: 0.17, tool: 'knife' },
    { t: 0.32, hand: 'swingA' },
    { t: 0.4, ev: 'swing' },
    { t: 0.56, hand: 'swingB' },
    { t: 0.74, hand: 'swingC' },
    { t: 0.84, hand: 'low', gun: duck },
    { t: 0.86, tool: 'none' },
    { t: 1, gun: Z, hand: 'grip' },
  ];
}

function throwKeys(): Key[] {
  const duck: G6 = [0.04, -0.07, 0.03, -0.25, 0.15, -0.2];
  return [
    { t: 0, gun: Z, hand: 'grip', tool: 'none' },
    { t: 0.14, gun: duck, hand: 'low' },
    { t: 0.16, tool: 'frag' },
    { t: 0.42, hand: 'windup' },
    { t: 0.6, hand: 'release', ev: 'throw' },
    { t: 0.62, tool: 'none' },
    { t: 0.82, hand: 'low', gun: duck },
    { t: 1, gun: Z, hand: 'grip' },
  ];
}

function recoverKeys(from: G6): Key[] {
  return [
    { t: 0, gun: from, hand: 'pouch', prop: false },
    { t: 1, gun: Z, hand: 'grip' },
  ];
}

function ease(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

/** Interpolates one numeric channel across the keys that define it. */
function channel(keys: Key[], t: number, get: (k: Key) => number | undefined, def: number): number {
  let a: Key | null = null;
  let b: Key | null = null;
  for (const k of keys) {
    if (get(k) === undefined) continue;
    if (k.t <= t) a = k;
    else if (!b) b = k;
  }
  if (!a && !b) return def;
  if (!a) return get(b as Key) as number;
  if (!b) return get(a) as number;
  const w = ease((t - a.t) / Math.max(1e-6, b.t - a.t));
  return (get(a) as number) * (1 - w) + (get(b) as number) * w;
}

function discrete<T>(keys: Key[], t: number, get: (k: Key) => T | undefined, def: T): T {
  let v = def;
  for (const k of keys) {
    const x = get(k);
    if (x !== undefined && k.t <= t) v = x;
  }
  return v;
}

/* ---------------------------------------------------------------- casings */

type Casing = { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; life: number };

/* ------------------------------------------------------------ view model */

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Called for every mechanical sound cue in an animation. */
  onEvent: (e: MechEvent) => void = () => {};

  private readonly holder = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private readonly rigs = new Map<string, GunRig>();
  private current: GunRig | null = null;
  private currentId: string | null = null;

  private readonly handR: Hand;
  private readonly handL: Hand;
  private readonly armR: THREE.Group;
  private readonly armL: THREE.Group;
  private readonly upperR: THREE.Group;
  private readonly upperL: THREE.Group;
  private readonly knife: GunRig;
  private readonly frag: GunRig;

  private readonly ambient: THREE.AmbientLight;
  private readonly key: THREE.DirectionalLight;
  private readonly flash = new THREE.Group();
  private readonly flashMats: THREE.Material[] = [];
  private readonly flashLight: THREE.PointLight;
  private flashTimer = 0;
  private flashColor = new THREE.Color(4, 2.6, 1.2);

  private readonly casings: Casing[] = [];
  private casingCursor = 0;
  private dropped: { obj: THREE.Object3D; vel: THREE.Vector3; life: number } | null = null;

  private bob = 0;
  private swayX = 0;
  private swayY = 0;
  private recoil = 0;
  private recoilVel = 0;
  private fireSlide = 0;
  private spinSpeed = 0;
  private sprintAmount = 0;
  private adsAmount = 0;
  private pendingCycle = -1;

  private pose: ViewPose = 'idle';
  private poseT = 0;
  private poseDuration = 1;
  private keys: Key[] = [];
  private shellFirst = true;
  private holdTimer = 0;

  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpM2 = new THREE.Matrix4();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpS = new THREE.Vector3();
  private readonly inv = new THREE.Matrix4();

  constructor() {
    this.camera = new THREE.PerspectiveCamera(56, 1.6, 0.01, 12);
    this.scene.add(this.holder);
    this.holder.add(this.pivot);

    this.ambient = new THREE.AmbientLight(0xffffff, 1.2);
    this.scene.add(this.ambient);
    this.key = new THREE.DirectionalLight(0xfff0d8, 2.4);
    this.key.position.set(-0.5, 1, 0.4);
    this.scene.add(this.key);
    const rim = new THREE.DirectionalLight(0x8aa0c8, 1.2);
    rim.position.set(0.8, 0.2, -1);
    this.scene.add(rim);

    this.handR = buildHand();
    this.handL = buildHand();
    this.handL.group.scale.set(-1, 1, 1);
    this.armR = buildForearm();
    this.armL = buildForearm();
    this.upperR = buildForearm();
    this.upperL = buildForearm();
    this.scene.add(this.armR, this.armL, this.upperR, this.upperL);

    this.knife = buildGun('knife');
    this.knife.root.rotation.set(Math.PI / 2, 0, 0);
    this.knife.root.position.set(-0.004, 0.064, -0.004);
    this.frag = buildGun('frag');
    this.frag.root.position.set(0.0, 0.0, -0.035);

    // Muzzle flash: a camera-facing star plus a cone of crossed quads down the barrel.
    const tex = textures();
    const mk = (map: THREE.Texture): THREE.MeshBasicMaterial => {
      const m = new THREE.MeshBasicMaterial({
        map, color: this.flashColor, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, opacity: 1,
      });
      this.flashMats.push(m);
      return m;
    };
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), mk(tex.flash[0]));
    this.flash.add(front);
    for (let i = 0; i < 2; i++) {
      // Lying along the barrel axis, one flat and one on edge.
      const cone = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.24), mk(tex.flash[1 + i]));
      cone.rotation.x = -Math.PI / 2;
      cone.position.z = -0.1;
      const turn = new THREE.Group();
      turn.rotation.z = i * (Math.PI / 2);
      turn.add(cone);
      this.flash.add(turn);
    }
    this.flash.visible = false;
    this.flashLight = new THREE.PointLight(0xffc870, 0, 1.5, 2);
    this.scene.add(this.flashLight);

    // Spent brass and shotgun hulls.
    const brassGeo = new THREE.CylinderGeometry(0.0055, 0.0055, 0.024, 6);
    const shellGeo = new THREE.CylinderGeometry(0.011, 0.011, 0.066, 8);
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xc8a048, metalness: 1, roughness: 0.3 });
    const shellMat = new THREE.MeshStandardMaterial({ color: 0xb01c14, metalness: 0.1, roughness: 0.45 });
    for (let i = 0; i < 18; i++) {
      const mesh = new THREE.Mesh(i < 12 ? brassGeo : shellGeo, i < 12 ? brassMat : shellMat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.casings.push({ mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 });
    }
  }

  /** Builds the reflection map the metal picks its highlights from. Needs the renderer. */
  init(renderer: THREE.WebGLRenderer): void {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Swaps the visible gun instantly; call during the low point of a swap. */
  equip(weaponId: string, packed = false): void {
    const key = `${weaponId}|${packed}`;
    let rig = this.rigs.get(key);
    if (!rig) {
      rig = buildGun(weaponId, 'view', packed);
      this.rigs.set(key, rig);
    }
    if (this.current && this.current !== rig) this.pivot.remove(this.current.root);
    if (this.current !== rig) this.pivot.add(rig.root);
    this.current = rig;
    this.currentId = weaponId;
    rig.rightHand.add(this.handR.group);
    rig.root.add(this.handL.group);
    rig.muzzle.add(this.flash);
    this.flashColor.set(
      weaponId === 'plasma' ? 0x60ffc0 : weaponId === 'thunder' ? 0x80c8ff : weaponId === 'hellfire' ? 0xff9040 : 0xffc070,
    ).multiplyScalar(4);
    for (const m of this.flashMats) (m as THREE.MeshBasicMaterial).color.copy(this.flashColor);
    this.flashLight.color.copy(this.flashColor).multiplyScalar(0.25);
    this.pose = 'idle';
    this.keys = [];
    this.applyStatic(rig);
  }

  get equipped(): string | null {
    return this.currentId;
  }

  /** True while aiming a scoped rifle all the way in: hide the gun, show the scope. */
  get scopeView(): boolean {
    return Boolean(this.current?.scoped) && this.adsAmount > 0.86;
  }

  get scoped(): boolean {
    return Boolean(this.current?.scoped);
  }

  /**
   * Starts a pose. For reloads, `empty` says whether the action needs racking
   * afterwards; for shell-by-shell reloads each call is one shell.
   */
  setPose(pose: ViewPose, duration: number, opts: { empty?: boolean } = {}): void {
    const rig = this.current;
    this.poseDuration = Math.max(0.05, duration);
    this.poseT = 0;
    this.pose = pose;
    this.pendingCycle = -1;
    this.holdTimer = 0;
    if (!rig) {
      this.keys = [];
      return;
    }
    const empty = opts.empty ?? false;
    switch (pose) {
      case 'reload':
        switch (rig.reload) {
          case 'pistol': this.keys = pistolKeys(empty); break;
          case 'mag': this.keys = magKeys(rig, empty, { out: 'magOut', in: 'magIn' }); break;
          case 'cell': this.keys = magKeys(rig, false, { out: 'cellOut', in: 'cellIn' }); break;
          case 'box': this.keys = magKeys(rig, true, { out: 'boxOut', in: 'boxIn' }); break;
          case 'break': this.keys = breakKeys(); break;
          case 'shell':
            this.keys = shellKeys(this.shellFirst);
            this.shellFirst = false;
            break;
          case 'bolt': this.keys = boltReloadKeys(); break;
          case 'rocket': this.keys = rocketKeys(); break;
          default: this.keys = [];
        }
        break;
      case 'shellEnd':
        this.shellFirst = true;
        this.keys = shellEndKeys();
        break;
      case 'recover':
        this.shellFirst = true;
        this.keys = recoverKeys(SHELL_TILT);
        break;
      case 'cycle': this.keys = cycleKeys(); break;
      case 'lower': this.keys = lowerKeys(false); break;
      case 'raise': this.keys = lowerKeys(true); break;
      case 'melee': this.keys = meleeKeys(); break;
      case 'throw': this.keys = throwKeys(); break;
      default: this.keys = [];
    }
  }

  get busyPose(): ViewPose {
    return this.pose;
  }

  /** Abandons a shell-by-shell reload because the player fired out of it. */
  cancelShells(): void {
    if (this.current?.reload === 'shell' && (this.pose === 'reload' || !this.shellFirst)) {
      this.setPose('recover', 0.16);
    }
  }

  kick(amount: number): void {
    const rig = this.current;
    this.recoilVel += amount;
    this.fireSlide = 1;
    this.flashTimer = 0.05;
    this.flash.visible = true;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(0.8 + Math.random() * 0.6);
    if (!rig) return;
    if (rig.spin) this.spinSpeed = Math.min(60, this.spinSpeed + 14);
    if (rig.casing && !rig.cycleAfterShot && rig.reload !== 'break') this.ejectCasing(rig.casing);
    if (rig.cycleAfterShot) this.pendingCycle = 0.1;
  }

  /** Muzzle position in world space, for tracers and lighting the room. */
  muzzleWorld(camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    if (!this.current) return out.setFromMatrixPosition(camera.matrixWorld);
    this.current.muzzle.getWorldPosition(out);
    // The view-model scene shares the camera's orientation but not its matrix,
    // so map the local offset onto the real camera.
    out.applyMatrix4(camera.matrixWorld);
    return out;
  }

  private ejectCasing(kind: 'brass' | 'shell'): void {
    const rig = this.current;
    if (!rig?.eject) return;
    const start = kind === 'brass' ? 0 : 12;
    const end = kind === 'brass' ? 12 : 18;
    let c = this.casings[start + (this.casingCursor++ % (end - start))];
    for (let i = start; i < end; i++) {
      if (this.casings[i].life <= 0) {
        c = this.casings[i];
        break;
      }
    }
    rig.eject.getWorldPosition(c.mesh.position);
    c.mesh.quaternion.setFromEuler(new THREE.Euler(Math.random(), 0, Math.PI / 2));
    c.vel.set(0.9 + Math.random() * 0.5, 1.1 + Math.random() * 0.6, 0.25 + Math.random() * 0.3);
    c.spin.set(Math.random() * 20, Math.random() * 20, Math.random() * 10);
    c.life = 0.7;
    c.mesh.visible = true;
  }

  /** Holds every moving part at rest. */
  private applyStatic(rig: GunRig): void {
    for (const s of rig.slides) s.obj.position.z = s.home;
    if (rig.mag) {
      rig.magHome.decompose(rig.mag.position, rig.mag.quaternion, rig.mag.scale);
      rig.mag.visible = true;
    }
    if (rig.hinge) rig.hinge.rotation.x = 0;
    if (rig.pump) rig.pump.group.position.z = 0;
    if (rig.bolt) {
      rig.bolt.group.rotation.z = 0;
      rig.bolt.group.position.z = 0;
    }
    if (rig.prop) rig.prop.visible = false;
  }

  /** Local transform of the magazine at `out` (0 seated, 1 clear of the well). */
  private magMatrix(rig: GunRig, out: number, target: THREE.Matrix4): THREE.Matrix4 {
    target.copy(rig.magHome);
    if (rig.magRock) target.multiply(this.tmpM2.makeRotationX(rig.magRock * Math.min(1, out * 1.6)));
    const d = rig.magTravel * out;
    const shift = this.tmpM2.makeTranslation(-rig.magAxis.x * d, -rig.magAxis.y * d, -rig.magAxis.z * d);
    return target.premultiply(shift);
  }

  /** A spot for the support hand, as a transform in gun space. */
  private spotMatrix(rig: GunRig, spot: Spot, magOut: number, target: THREE.Matrix4): THREE.Matrix4 {
    const rootInv = this.inv.copy(rig.root.matrixWorld).invert();
    const fromAnchor = (o: THREE.Object3D | null): THREE.Matrix4 => {
      if (!o) return target.copy(rootInv).multiply(rig.leftHand.matrixWorld);
      return target.copy(rootInv).multiply(o.matrixWorld);
    };
    switch (spot) {
      case 'grip':
        return fromAnchor(rig.leftHand);
      case 'mag':
        if (!rig.mag || !rig.magGrab) return fromAnchor(rig.leftHand);
        this.magMatrix(rig, magOut, target);
        return target.multiply(rig.magGrab.matrix);
      case 'charge':
        return fromAnchor(rig.charge);
      case 'port':
        return fromAnchor(rig.port);
      case 'portPush':
        fromAnchor(rig.port);
        return target.multiply(this.tmpM2.makeTranslation(0, -0.03, 0.02));
      case 'bolt':
        return fromAnchor(rig.bolt ? rig.bolt.knob : rig.charge);
      default: {
        const v = VIEW_SPOTS[spot];
        if (!v) return fromAnchor(rig.leftHand);
        target.compose(v.p, this.tmpQ.setFromEuler(v.r), this.tmpS.set(1, 1, 1));
        return target.premultiply(rootInv);
      }
    }
  }

  update(
    dt: number,
    opts: {
      speed: number; grounded: boolean; aiming: boolean; sprinting: boolean;
      lookDX: number; lookDY: number; lowHealth: boolean; mag: number; light: THREE.Color;
    },
  ): void {
    const rig = this.current;

    // Room light reaches the hands too, so a dark corridor darkens the gun.
    this.ambient.color.copy(opts.light).multiplyScalar(0.9).addScalar(0.08);
    this.key.color.copy(opts.light).multiplyScalar(0.6).addScalar(0.25);

    // Recoil spring.
    this.recoilVel += -this.recoil * 70 * dt;
    this.recoilVel *= Math.pow(0.002, dt);
    this.recoil += this.recoilVel * dt;
    this.fireSlide = Math.max(0, this.fireSlide - dt * 14);
    this.spinSpeed = Math.max(rig?.id === 'thunder' ? 2 : 0, this.spinSpeed - dt * 30);

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const k = Math.max(0, this.flashTimer / 0.05);
      for (const m of this.flashMats) (m as THREE.MeshBasicMaterial).opacity = k;
      this.flashLight.intensity = k * 3;
      if (this.flashTimer <= 0) {
        this.flash.visible = false;
        this.flashLight.intensity = 0;
      }
    }

    if (this.pendingCycle >= 0) {
      this.pendingCycle -= dt;
      if (this.pendingCycle < 0 && this.pose === 'idle') this.setPose('cycle', 0.62);
    }

    // Sway lags behind the mouse, then eases back.
    const swayScale = opts.aiming ? 0.2 : 1;
    this.swayX += (-opts.lookDX * 0.1 * swayScale - this.swayX) * Math.min(1, dt * 9);
    this.swayY += (-opts.lookDY * 0.08 * swayScale - this.swayY) * Math.min(1, dt * 9);
    this.swayX = THREE.MathUtils.clamp(this.swayX, -0.05, 0.05);
    this.swayY = THREE.MathUtils.clamp(this.swayY, -0.04, 0.04);

    this.bob += dt * (opts.grounded ? opts.speed * 1.25 : 0);
    const bobAmount = Math.min(1, opts.speed / 9) * (opts.aiming ? 0.25 : 1);
    const bobX = Math.sin(this.bob) * 0.012 * bobAmount;
    const bobY = -Math.abs(Math.cos(this.bob)) * 0.01 * bobAmount;

    const posing = this.pose !== 'idle';
    const wantAds = opts.aiming && !(posing && this.pose !== 'cycle') ? 1 : 0;
    this.adsAmount += (wantAds - this.adsAmount) * Math.min(1, dt * 12);
    const wantSprint = opts.sprinting && !opts.aiming && !posing ? 1 : 0;
    this.sprintAmount += (wantSprint - this.sprintAmount) * Math.min(1, dt * 8);

    if (!rig) return;

    // Pose timeline.
    let t = 1;
    const prev = this.poseT;
    if (posing) {
      this.poseT = Math.min(1, this.poseT + dt / this.poseDuration);
      t = this.poseT;
      for (const k of this.keys) {
        if (k.t > prev && k.t <= t) {
          if (k.ev) {
            this.onEvent(k.ev);
            if (k.ev === 'magDrop') this.dropMag(rig);
          }
          if (k.casings) for (let i = 0; i < k.casings; i++) this.ejectCasing(rig.casing ?? 'brass');
        }
      }
    }
    const keys = posing ? this.keys : [];
    const g = (i: number): number => channel(keys, t, (k) => k.gun?.[i], 0);
    const magOut = channel(keys, t, (k) => k.mag, 0);
    const held = discrete(keys, t, (k) => k.held, false);
    const magVis = discrete(keys, t, (k) => k.magVis, true);
    const lockedOpen = rig.reload === 'pistol' && opts.mag === 0 ? 1 : 0;
    const poseSlide = channel(keys, t, (k) => k.slide, posing ? 0 : lockedOpen);
    const boltLift = channel(keys, t, (k) => k.bolt?.[0], 0);
    const boltBack = channel(keys, t, (k) => k.bolt?.[1], 0);
    const pump = channel(keys, t, (k) => k.pump, 0);
    const open = channel(keys, t, (k) => k.open, 0);
    const prop = discrete(keys, t, (k) => k.prop, false);
    const tool = discrete(keys, t, (k) => k.tool, 'none');
    const loadedKey = discrete<boolean | null>(keys, t, (k) => k.loaded, null);

    // Base transform: hip and sights, blended.
    const hipQ = this.tmpQ.setFromEuler(rig.hipRot).clone();
    const alpha = -Math.atan2(rig.sightFront.y - rig.sightRear.y, rig.sightRear.z - rig.sightFront.z);
    const adsQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(alpha, 0, 0));
    const adsP = rig.sightRear.clone().applyQuaternion(adsQ).negate().add(new THREE.Vector3(0, 0, -rig.eye));
    const baseQ = hipQ.slerp(adsQ, this.adsAmount);
    const baseP = new THREE.Vector3().lerpVectors(rig.hip, adsP, this.adsAmount);

    const s = this.sprintAmount;
    const recoilScale = rig.id === 'hellfire' || rig.id === 'thunder' ? 1.6 : 1;
    this.holder.position.set(
      baseP.x + bobX + this.swayX + s * -0.04,
      baseP.y + bobY + this.swayY + s * -0.035,
      baseP.z + this.recoil * 0.05 * recoilScale + s * 0.02,
    );
    this.holder.quaternion.copy(baseQ);
    const lowWobble = opts.lowHealth ? Math.sin(this.bob * 0.55) * 0.02 : 0;
    this.holder.rotateX(this.recoil * 0.45 - this.swayY * 0.8 - s * 0.25);
    this.holder.rotateY(-this.swayX * 0.8 + s * 0.55);
    this.holder.rotateZ(this.swayX * 0.5 + Math.sin(this.bob * 0.5) * 0.01 * bobAmount + s * 0.35 + lowWobble);
    this.holder.visible = !this.scopeView;

    // Pose offsets pivot around the grip.
    this.pivot.position.set(g(0), g(1), g(2));
    this.pivot.rotation.set(g(3), g(4), g(5));

    // Moving parts.
    for (const sl of rig.slides) sl.obj.position.z = sl.home + sl.travel * Math.max(rig.cycleAfterShot ? 0 : this.fireSlide, poseSlide);
    if (rig.pump) rig.pump.group.position.z = rig.pump.travel * pump;
    if (rig.bolt) {
      rig.bolt.group.rotation.z = -rig.bolt.lift * boltLift;
      rig.bolt.group.position.z = rig.bolt.travel * boltBack;
    }
    if (rig.hinge) rig.hinge.rotation.x = -0.62 * open;
    if (rig.spin) rig.spin.rotation.z += this.spinSpeed * dt;
    if (rig.loaded) rig.loaded.visible = loadedKey ?? (rig.reload === 'rocket' ? opts.mag > 0 : true);
    if (rig.mag) {
      rig.mag.visible = magVis;
      if (!held) this.magMatrix(rig, magOut, this.tmpM).decompose(rig.mag.position, rig.mag.quaternion, rig.mag.scale);
    }

    this.holder.updateMatrixWorld(true);

    // Support hand: blend between the spots of the keys either side of now.
    const handM = this.tmpM;
    if (posing && keys.some((k) => k.hand)) {
      let a: Key | null = null;
      let b: Key | null = null;
      for (const k of keys) {
        if (!k.hand) continue;
        if (k.t <= t) a = k;
        else if (!b) b = k;
      }
      const sa = (a ?? b) as Key;
      const sb = (b ?? a) as Key;
      const w = a && b ? ease((t - a.t) / Math.max(1e-6, b.t - a.t)) : 0;
      const ma = this.spotMatrix(rig, sa.hand as Spot, magOut, new THREE.Matrix4());
      const mb = this.spotMatrix(rig, sb.hand as Spot, magOut, new THREE.Matrix4());
      const pa = new THREE.Vector3();
      const qa = new THREE.Quaternion();
      const pb = new THREE.Vector3();
      const qb = new THREE.Quaternion();
      ma.decompose(pa, qa, this.tmpS);
      mb.decompose(pb, qb, this.tmpS);
      pa.lerp(pb, w);
      qa.slerp(qb, w);
      handM.compose(pa, qa, this.tmpS.set(1, 1, 1));
    } else {
      this.spotMatrix(rig, 'grip', 0, handM);
    }
    handM.decompose(this.handL.group.position, this.handL.group.quaternion, this.tmpS);
    this.handL.group.scale.set(-1, 1, 1);

    // A magazine in the hand rides with it.
    if (rig.mag && rig.magGrab && held) {
      this.tmpM2.copy(rig.magGrab.matrix).invert();
      new THREE.Matrix4().multiplyMatrices(handM, this.tmpM2)
        .decompose(rig.mag.position, rig.mag.quaternion, rig.mag.scale);
    }

    // Things the support hand carries.
    if (rig.prop) {
      rig.prop.visible = prop;
      if (prop && rig.prop.parent !== this.handL.group) this.handL.group.add(rig.prop);
      if (prop) {
        rig.prop.position.set(0.0, 0.0, -0.035);
        rig.prop.rotation.set(0, 0, 0);
      }
    }
    this.knife.root.visible = tool === 'knife';
    if (tool === 'knife' && this.knife.root.parent !== this.handL.group) this.handL.group.add(this.knife.root);
    this.frag.root.visible = tool === 'frag';
    if (tool === 'frag' && this.frag.root.parent !== this.handL.group) this.handL.group.add(this.frag.root);

    this.holder.updateMatrixWorld(true);
    this.placeArm(this.handR, this.armR, this.upperR, SHOULDER_R);
    this.placeArm(this.handL, this.armL, this.upperL, SHOULDER_L);
    this.armR.visible = this.upperR.visible = this.holder.visible;
    this.armL.visible = this.upperL.visible = this.holder.visible;

    if (this.flash.visible) this.flash.getWorldPosition(this.flashLight.position);

    this.updateCasings(dt);

    if (posing && this.poseT >= 1) {
      // Between shells the gun stays tilted with the hand at the pouch until
      // the game says whether another shell or the pump comes next.
      if (this.pose === 'reload' && rig.reload === 'shell') {
        this.holdTimer += dt;
        if (this.holdTimer > 0.4) this.setPose('recover', 0.2);
        return;
      }
      const finished = this.pose;
      this.pose = 'idle';
      this.keys = [];
      if (finished === 'cycle' || finished === 'shellEnd' || finished === 'recover') this.applyStatic(rig);
    }
  }

  private placeArm(hand: Hand, fore: THREE.Group, upper: THREE.Group, shoulder: THREE.Vector3): void {
    const wrist = hand.wrist.getWorldPosition(this.tmpV);
    const dist = wrist.distanceTo(shoulder);
    const len = Math.min(FOREARM, dist);
    // The elbow hangs: aim the forearm between the shoulder and straight
    // down-and-back, so a hand reaching over the gun does not drag the whole
    // arm across the screen.
    const toShoulder = new THREE.Vector3().copy(shoulder).sub(wrist).normalize();
    const hang = new THREE.Vector3(Math.sign(shoulder.x) * 0.3, -0.85, 0.42).normalize();
    const dir = toShoulder.lerp(hang, 0.55).normalize();
    const elbow = new THREE.Vector3().copy(dir).multiplyScalar(len).add(wrist);
    fore.position.copy(wrist);
    fore.lookAt(elbow);
    fore.scale.set(1, 1, len);
    const rest = shoulder.distanceTo(elbow);
    upper.visible = rest > 0.01;
    upper.position.copy(elbow);
    upper.lookAt(shoulder.x, shoulder.y - 0.05, shoulder.z + 0.1);
    upper.scale.set(1.25, 1.25, Math.max(0.01, rest + 0.1));
  }

  private dropMag(rig: GunRig): void {
    if (!rig.mag) return;
    if (!this.dropped) {
      const obj = rig.mag.clone();
      this.scene.add(obj);
      this.dropped = { obj, vel: new THREE.Vector3(), life: 0 };
    }
    const d = this.dropped;
    rig.mag.updateMatrixWorld(true);
    rig.mag.matrixWorld.decompose(d.obj.position, d.obj.quaternion, d.obj.scale);
    d.vel.set(-0.1, -0.6, 0.1);
    d.life = 0.6;
    d.obj.visible = true;
  }

  private updateCasings(dt: number): void {
    for (const c of this.casings) {
      if (c.life <= 0) continue;
      c.life -= dt;
      c.vel.y -= 9.8 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      if (c.life <= 0) c.mesh.visible = false;
    }
    const d = this.dropped;
    if (d && d.life > 0) {
      d.life -= dt;
      d.vel.y -= 9.8 * dt;
      d.obj.position.addScaledVector(d.vel, dt);
      d.obj.rotation.x += dt * 3;
      if (d.life <= 0) d.obj.visible = false;
    }
  }

  reset(): void {
    this.pose = 'idle';
    this.keys = [];
    this.recoil = 0;
    this.recoilVel = 0;
    this.fireSlide = 0;
    this.adsAmount = 0;
    this.sprintAmount = 0;
    this.flashTimer = 0;
    this.flash.visible = false;
    this.flashLight.intensity = 0;
    this.pendingCycle = -1;
    this.shellFirst = true;
    for (const c of this.casings) {
      c.life = 0;
      c.mesh.visible = false;
    }
    if (this.dropped) this.dropped.obj.visible = false;
    if (this.current) this.applyStatic(this.current);
  }
}
