/**
 * The first-person weapon.
 *
 * It lives in its own scene drawn after a depth clear, which is the standard
 * trick for keeping a long barrel from poking through walls. Animation is all
 * procedural: bob from the walk cycle, sway that lags the mouse, a recoil
 * spring, and hand-keyed reload/swap/melee poses.
 */

import * as THREE from 'three';
import { buildWeaponModel, type WeaponModel } from '../gfx/models.ts';
import { getWeapon, type WeaponDef } from './weapons.ts';

export type ViewPose = 'idle' | 'reload' | 'lower' | 'raise' | 'melee';

const REST = new THREE.Vector3(0.34, -0.3, -0.62);
const ADS = new THREE.Vector3(0, -0.175, -0.42);

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly holder = new THREE.Group();
  private readonly models = new Map<string, WeaponModel>();
  private current: WeaponModel | null = null;
  private currentDef: WeaponDef | null = null;

  private readonly flash: THREE.Mesh;
  private readonly flashLight: THREE.PointLight;
  private flashTimer = 0;

  private bob = 0;
  private swayX = 0;
  private swayY = 0;
  private recoil = 0;
  private recoilVel = 0;
  private slide = 0;
  private pose: ViewPose = 'idle';
  private poseT = 0;
  private poseDuration = 1;
  private adsAmount = 0;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(58, 1.6, 0.01, 12);
    this.scene.add(this.holder);
    this.scene.add(new THREE.AmbientLight(0xb9c4d0, 2.9));

    const key = new THREE.DirectionalLight(0xfff0d0, 3.4);
    key.position.set(-0.6, 1, 0.6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x5f7fb0, 1.9);
    rim.position.set(0.8, -0.3, -1);
    this.scene.add(rim);

    // Muzzle flash: two crossed additive quads, exactly like the old sprites.
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffe08a,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const flashGeo = new THREE.BufferGeometry();
    const s = 0.26;
    flashGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          -s, -s, 0, s, -s, 0, s, s, 0, -s, -s, 0, s, s, 0, -s, s, 0,
          0, -s, -s, 0, -s, s, 0, s, s, 0, -s, -s, 0, s, s, 0, s, -s,
        ],
        3,
      ),
    );
    this.flash = new THREE.Mesh(flashGeo, flashMat);
    this.flash.visible = false;
    this.holder.add(this.flash);

    this.flashLight = new THREE.PointLight(0xffc870, 0, 5, 2);
    this.holder.add(this.flashLight);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Swaps the visible gun instantly; call during the low point of a swap. */
  equip(weaponId: string): void {
    const def = getWeapon(weaponId);
    let model = this.models.get(weaponId);
    if (!model) {
      model = buildWeaponModel(def);
      this.models.set(weaponId, model);
    }
    if (this.current && this.current !== model) this.holder.remove(this.current.group);
    if (this.current !== model) this.holder.add(model.group);
    this.current = model;
    this.currentDef = def;
    this.flash.position.set(def.muzzle[0], def.muzzle[1], def.muzzle[2] - 0.08);
    this.flashLight.position.copy(this.flash.position);
  }

  get equipped(): string | null {
    return this.currentDef?.id ?? null;
  }

  setPose(pose: ViewPose, duration: number): void {
    this.pose = pose;
    this.poseT = 0;
    this.poseDuration = Math.max(0.01, duration);
  }

  get busyPose(): ViewPose {
    return this.pose;
  }

  kick(amount: number): void {
    this.recoilVel += amount;
    this.slide = 1;
    this.flashTimer = 0.055;
    this.flash.visible = true;
    this.flash.rotation.z = Math.random() * Math.PI;
    const scale = 0.8 + Math.random() * 0.7;
    this.flash.scale.setScalar(scale);
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

  update(
    dt: number,
    opts: {
      speed: number; grounded: boolean; aiming: boolean; lookDX: number; lookDY: number;
      lowHealth: boolean;
    },
  ): void {
    // Recoil spring.
    this.recoilVel += -this.recoil * 62 * dt;
    this.recoilVel *= Math.pow(0.0016, dt);
    this.recoil += this.recoilVel * dt;
    this.slide = Math.max(0, this.slide - dt * 9);

    if (this.current) {
      for (const s of this.current.slides) s.position.z = this.slide * 0.09;
    }

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const mat = this.flash.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, this.flashTimer / 0.055);
      this.flashLight.intensity = mat.opacity * 22;
      if (this.flashTimer <= 0) {
        this.flash.visible = false;
        this.flashLight.intensity = 0;
      }
    }

    // Sway lags behind the mouse, then eases back.
    const swayTarget = opts.aiming ? 0.25 : 1;
    this.swayX += (-opts.lookDX * 0.22 * swayTarget - this.swayX) * Math.min(1, dt * 9);
    this.swayY += (-opts.lookDY * 0.18 * swayTarget - this.swayY) * Math.min(1, dt * 9);
    this.swayX = THREE.MathUtils.clamp(this.swayX, -0.12, 0.12);
    this.swayY = THREE.MathUtils.clamp(this.swayY, -0.1, 0.1);

    this.bob += dt * (opts.grounded ? opts.speed * 1.25 : 0);
    const bobAmount = Math.min(1, opts.speed / 9) * (opts.aiming ? 0.3 : 1);
    const bobX = Math.sin(this.bob) * 0.026 * bobAmount;
    const bobY = -Math.abs(Math.cos(this.bob)) * 0.022 * bobAmount;

    this.adsAmount += ((opts.aiming ? 1 : 0) - this.adsAmount) * Math.min(1, dt * 13);

    const base = new THREE.Vector3().lerpVectors(REST, ADS, this.adsAmount);
    const pos = base.clone();
    pos.x += bobX + this.swayX;
    pos.y += bobY + this.swayY;
    pos.z += this.recoil * 0.1;

    const rot = new THREE.Euler(
      this.recoil * 0.55 - this.swayY * 1.2,
      -this.swayX * 1.1,
      this.swayX * 0.7 + Math.sin(this.bob * 0.5) * 0.012 * bobAmount,
    );

    // Pose overlays.
    if (this.pose !== 'idle') {
      this.poseT += dt / this.poseDuration;
      const t = Math.min(1, this.poseT);
      if (this.pose === 'reload') {
        // Drop out of view, roll the weapon over, come back up.
        const dip = Math.sin(t * Math.PI);
        pos.y -= dip * 0.34;
        pos.z += dip * 0.1;
        rot.x += dip * 0.85;
        rot.z += Math.sin(t * Math.PI * 2) * 0.5;
      } else if (this.pose === 'lower') {
        pos.y -= t * 0.5;
        rot.x += t * 1.1;
      } else if (this.pose === 'raise') {
        pos.y -= (1 - t) * 0.5;
        rot.x += (1 - t) * 1.1;
      } else if (this.pose === 'melee') {
        const thrust = Math.sin(t * Math.PI);
        pos.z -= thrust * 0.5;
        pos.x -= thrust * 0.12;
        rot.y += thrust * 0.5;
        rot.x -= thrust * 0.35;
      }
      if (t >= 1) this.pose = 'idle';
    }

    // A low-health wobble, cheap but effective.
    if (opts.lowHealth) {
      pos.x += Math.sin(this.bob * 0.7) * 0.015;
      rot.z += Math.sin(this.bob * 0.55) * 0.02;
    }

    this.holder.position.copy(pos);
    this.holder.rotation.copy(rot);
  }

  reset(): void {
    this.pose = 'idle';
    this.recoil = 0;
    this.recoilVel = 0;
    this.slide = 0;
    this.adsAmount = 0;
    this.flashTimer = 0;
    this.flash.visible = false;
    this.flashLight.intensity = 0;
  }
}
