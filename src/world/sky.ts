/**
 * The night sky over the maps that have an outside: a painted dome with the
 * stars and a band of cloud on it, and a moon big enough to bloom. It rides
 * along with the camera so it is always at infinity, and draws first with no
 * depth so everything in the level covers it.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng.ts';
import { MOON_DIR } from './lighting.ts';

const RADIUS = 200;
/** How far below the horizon the dome reaches, as a fraction of a half turn. */
const THETA = 0.62;

function paint(seed: number): HTMLCanvasElement {
  const W = 1024;
  const H = 384;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const rng = new Rng(seed);
  const horizon = H * (0.5 / THETA);

  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#02030a');
  g.addColorStop(0.45, '#070b1a');
  g.addColorStop((horizon / H) * 0.93, '#1a2338');
  g.addColorStop(horizon / H, '#26304a');
  g.addColorStop(1, '#1a2232');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);

  // Stars, thicker toward the zenith and gone in the murk at the horizon.
  for (let i = 0; i < 1400; i++) {
    const y = Math.pow(rng.next(), 1.6) * horizon * 0.92;
    const sx = rng.int(W);
    const a = rng.range(0.25, 1) * (1 - (y / horizon) * 0.8);
    const warm = rng.chance(0.2);
    x.fillStyle = warm ? `rgba(255,226,196,${a.toFixed(2)})` : `rgba(216,228,255,${a.toFixed(2)})`;
    const big = rng.chance(0.06);
    x.fillRect(sx, Math.floor(y), big ? 2 : 1, big ? 2 : 1);
  }

  // A faint band of the galaxy across the sky.
  for (let i = 0; i < 2600; i++) {
    const t = rng.next();
    const bx = t * W;
    const by = horizon * (0.25 + 0.35 * Math.sin(t * Math.PI * 2 + 0.6)) + rng.range(-1, 1) * rng.range(0, 34);
    x.fillStyle = `rgba(170,180,220,${rng.range(0.03, 0.12).toFixed(3)})`;
    x.fillRect(Math.floor(bx), Math.floor(by), 1 + rng.int(3), 1 + rng.int(2));
  }

  // Low cloud, lit from underneath by the town.
  for (let i = 0; i < 38; i++) {
    const cx = rng.int(W);
    const cy = horizon - rng.range(8, 70);
    const w = rng.range(60, 180);
    const h = rng.range(6, 16);
    const cg = x.createRadialGradient(cx, cy, 0, cx, cy, w / 2);
    cg.addColorStop(0, 'rgba(58,66,92,0.55)');
    cg.addColorStop(1, 'rgba(58,66,92,0)');
    x.save();
    x.translate(cx, cy);
    x.scale(1, h / w);
    x.translate(-cx, -cy);
    x.fillStyle = cg;
    x.beginPath();
    x.arc(cx, cy, w / 2, 0, Math.PI * 2);
    x.fill();
    x.restore();
  }
  // Wrap the cloud that ran off either edge.
  x.drawImage(c, W, 0, W, H, 0, 0, W, H);
  return c;
}

function moonTexture(): HTMLCanvasElement {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const halo = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  halo.addColorStop(0, 'rgba(255,250,235,1)');
  halo.addColorStop(0.3, 'rgba(255,250,235,1)');
  halo.addColorStop(0.34, 'rgba(200,210,255,0.35)');
  halo.addColorStop(1, 'rgba(120,140,220,0)');
  x.fillStyle = halo;
  x.fillRect(0, 0, S, S);
  // Maria.
  const rng = new Rng(77);
  for (let i = 0; i < 7; i++) {
    x.fillStyle = 'rgba(150,150,160,0.35)';
    x.beginPath();
    x.arc(S / 2 + rng.range(-8, 8), S / 2 + rng.range(-8, 8), rng.range(2, 5), 0, Math.PI * 2);
    x.fill();
  }
  return c;
}

export function buildSky(seed: number): THREE.Mesh {
  const tex = new THREE.CanvasTexture(paint(seed));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.RepeatWrapping;

  const geo = new THREE.SphereGeometry(RADIUS, 32, 12, 0, Math.PI * 2, 0, Math.PI * THETA);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, side: THREE.BackSide, fog: false, depthWrite: false, depthTest: false,
  });
  mat.userData.ownsMap = true;
  const dome = new THREE.Mesh(geo, mat);
  dome.renderOrder = -1000;
  dome.frustumCulled = false;
  dome.matrixAutoUpdate = false;

  const moonTex = new THREE.CanvasTexture(moonTexture());
  moonTex.colorSpace = THREE.SRGBColorSpace;
  const moon = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 26),
    new THREE.MeshBasicMaterial({
      // Additive and opaque-listed, so it draws straight after the dome and
      // under everything else.
      map: moonTex, color: new THREE.Color(2.2, 2.2, 2.1), blending: THREE.AdditiveBlending,
      fog: false, depthWrite: false, depthTest: false,
    }),
  );
  (moon.material as THREE.Material).userData.ownsMap = true;
  moon.position.copy(MOON_DIR).multiplyScalar(RADIUS * 0.9);
  moon.lookAt(0, 0, 0);
  moon.renderOrder = -999;
  moon.frustumCulled = false;
  dome.add(moon);
  moon.updateMatrix();
  moon.matrixAutoUpdate = false;

  // Always centred on whoever is looking at it.
  const follow = (_r: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera): void => {
    dome.matrixWorld.makeTranslation(camera.matrixWorld.elements[12], camera.matrixWorld.elements[13], camera.matrixWorld.elements[14]);
    moon.matrixWorld.multiplyMatrices(dome.matrixWorld, moon.matrix);
  };
  dome.onBeforeRender = follow;
  return dome;
}
