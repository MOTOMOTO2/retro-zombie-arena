/**
 * Elemental effects shared by the legendary guns and the Pack-a-Punch ammo
 * mods: lightning that arcs from body to body, and the fire and frost that
 * ride on the particle field.
 *
 * Bolts are pooled line strips, re-jagged a few dozen times a second while
 * they live, drawn additive and over-bright so they bloom.
 */

import * as THREE from 'three';

const SEGMENTS = 12;

type Bolt = {
  line: THREE.Line;
  mat: THREE.LineBasicMaterial;
  from: THREE.Vector3;
  to: THREE.Vector3;
  life: number;
  max: number;
  rejag: number;
};

export class ElementFX {
  readonly group = new THREE.Group();
  private readonly bolts: Bolt[] = [];
  private cursor = 0;

  constructor(count = 32) {
    for (let i = 0; i < count; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, fog: false,
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.visible = false;
      this.group.add(line);
      this.bolts.push({ line, mat, from: new THREE.Vector3(), to: new THREE.Vector3(), life: 0, max: 1, rejag: 0 });
    }
  }

  /** A bolt from one point to another. Two are drawn per call, so it forks. */
  bolt(from: THREE.Vector3, to: THREE.Vector3, color: number, life = 0.22): void {
    for (let k = 0; k < 2; k++) {
      const b = this.bolts[this.cursor];
      this.cursor = (this.cursor + 1) % this.bolts.length;
      b.from.copy(from);
      b.to.copy(to);
      b.life = life * (k === 0 ? 1 : 0.7);
      b.max = b.life;
      b.rejag = 0;
      b.mat.color.setHex(color).multiplyScalar(k === 0 ? 4 : 2);
      b.line.visible = true;
      this.jag(b, k === 0 ? 1 : 1.8);
    }
  }

  private jag(b: Bolt, wild: number): void {
    const pos = b.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const len = b.from.distanceTo(b.to);
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      // Jitter is strongest in the middle and pinned at both ends.
      const amp = Math.sin(t * Math.PI) * Math.min(1.2, len * 0.09) * wild;
      pos.setXYZ(
        i,
        b.from.x + (b.to.x - b.from.x) * t + (Math.random() - 0.5) * amp,
        b.from.y + (b.to.y - b.from.y) * t + (Math.random() - 0.5) * amp,
        b.from.z + (b.to.z - b.from.z) * t + (Math.random() - 0.5) * amp,
      );
    }
    pos.needsUpdate = true;
    b.line.geometry.computeBoundingSphere();
  }

  update(dt: number): void {
    for (const b of this.bolts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      b.rejag -= dt;
      if (b.rejag <= 0) {
        b.rejag = 0.035;
        this.jag(b, 1.3);
      }
      b.mat.opacity = Math.max(0, b.life / b.max);
      if (b.life <= 0) b.line.visible = false;
    }
  }

  reset(): void {
    for (const b of this.bolts) {
      b.life = 0;
      b.line.visible = false;
    }
  }
}

/** Colours the effects push through the particle field; above 1 so they glow. */
export const FIRE_COLORS = [new THREE.Color(4, 2.4, 0.8), new THREE.Color(3.6, 1.2, 0.25), new THREE.Color(2.2, 0.5, 0.1)];
export const ICE_COLORS = [new THREE.Color(1.6, 2.6, 3.4), new THREE.Color(0.9, 1.6, 2.4), new THREE.Color(2.4, 2.8, 3.2)];
export const SPARK_BLUE = new THREE.Color(1.2, 2.2, 4.2);
