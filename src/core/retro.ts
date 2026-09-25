/**
 * The "1999 box" - everything the game draws goes through here.
 *
 * The 3D scene renders into a tiny off-screen buffer (240p by default), then a
 * single full-screen pass blows it back up with nearest-neighbour sampling and
 * applies the era's signature artefacts: a crushed colour depth with ordered
 * (Bayer) dithering, scanlines, a soft vignette and a hint of channel bleed.
 * Rendering the world at 320x240 is also why the game can push a whole horde of
 * low-poly zombies without breaking a sweat.
 */

import * as THREE from 'three';

export type RetroQuality = {
  /** Internal vertical resolution. 200/240/360/480, or 0 for native. */
  height: number;
  /** Colour levels per channel. 8 is brutally retro, 32 is gentle. */
  levels: number;
  dither: number;
  scanlines: number;
  vignette: number;
  bleed: number;
};

export const QUALITY_PRESETS: Record<string, RetroQuality> = {
  ps1: { height: 200, levels: 8, dither: 1, scanlines: 0.34, vignette: 0.42, bleed: 1 },
  dos: { height: 240, levels: 14, dither: 0.85, scanlines: 0.26, vignette: 0.34, bleed: 0.7 },
  y2k: { height: 360, levels: 24, dither: 0.5, scanlines: 0.16, vignette: 0.28, bleed: 0.4 },
  crisp: { height: 540, levels: 48, dither: 0.25, scanlines: 0.08, vignette: 0.22, bleed: 0.15 },
};

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision mediump float;

uniform sampler2D tDiffuse;
uniform vec2  uResolution;   // size of the low-res buffer
uniform float uLevels;
uniform float uDither;
uniform float uScanlines;
uniform float uVignette;
uniform float uBleed;
uniform float uTime;
uniform float uDamage;       // 0..1 red flash when hit
uniform vec3  uTint;         // power-up / round tint
uniform float uTintAmount;
uniform float uFade;         // 1 = fully visible, 0 = black

varying vec2 vUv;

// 4x4 ordered Bayer matrix, the classic cheap dither.
float bayer(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = x + y * 4;
  float m[16];
  m[0]=0.0;  m[1]=8.0;  m[2]=2.0;  m[3]=10.0;
  m[4]=12.0; m[5]=4.0;  m[6]=14.0; m[7]=6.0;
  m[8]=3.0;  m[9]=11.0; m[10]=1.0; m[11]=9.0;
  m[12]=15.0;m[13]=7.0; m[14]=13.0;m[15]=5.0;
  float v = 0.0;
  for (int k = 0; k < 16; k++) { if (k == i) v = m[k]; }
  return v / 16.0 - 0.5;
}

void main() {
  vec2 texel = 1.0 / uResolution;

  // Slight horizontal channel bleed, like composite video.
  float off = uBleed * texel.x;
  vec3 col;
  col.r = texture2D(tDiffuse, vUv + vec2( off, 0.0)).r;
  col.g = texture2D(tDiffuse, vUv).g;
  col.b = texture2D(tDiffuse, vUv + vec2(-off, 0.0)).b;

  // Crush the colour depth with an ordered dither so gradients band like 1999.
  vec2 pix = vUv * uResolution;
  float d = bayer(pix) * uDither / max(uLevels, 1.0);
  col = floor((col + d) * uLevels + 0.5) / uLevels;

  // Scanlines keyed to the low-res buffer, not the window.
  float scan = 1.0 - uScanlines * 0.5 * (1.0 - cos(pix.y * 6.28318));
  col *= scan;

  // Faint interference roll, just enough to feel like a CRT.
  col *= 1.0 + 0.012 * sin(vUv.y * 220.0 + uTime * 2.2);

  vec2 v = vUv - 0.5;
  float vig = 1.0 - uVignette * dot(v, v) * 1.9;
  col *= clamp(vig, 0.0, 1.0);

  col = mix(col, uTint, uTintAmount);
  col = mix(col, vec3(0.72, 0.03, 0.03), uDamage * 0.68);
  col *= uFade;

  gl_FragColor = vec4(col, 1.0);
}
`;

export class RetroPipeline {
  readonly renderer: THREE.WebGLRenderer;
  private target: THREE.WebGLRenderTarget;
  private readonly quadScene: THREE.Scene;
  private readonly quadCamera: THREE.OrthographicCamera;
  private readonly material: THREE.ShaderMaterial;
  private quality: RetroQuality;
  private bufferW = 320;
  private bufferH = 240;

  constructor(canvas: HTMLCanvasElement, quality: RetroQuality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = true;
    this.renderer.setClearColor(0x05060a, 1);

    this.target = new THREE.WebGLRenderTarget(320, 240, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      type: THREE.UnsignedByteType,
    });

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: this.target.texture },
        uResolution: { value: new THREE.Vector2(320, 240) },
        uLevels: { value: quality.levels },
        uDither: { value: quality.dither },
        uScanlines: { value: quality.scanlines },
        uVignette: { value: quality.vignette },
        uBleed: { value: quality.bleed },
        uTime: { value: 0 },
        uDamage: { value: 0 },
        uTint: { value: new THREE.Color(0, 0, 0) },
        uTintAmount: { value: 0 },
        uFade: { value: 1 },
      },
    });

    this.quadScene = new THREE.Scene();
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  setQuality(q: RetroQuality): void {
    this.quality = q;
    const u = this.material.uniforms;
    u.uLevels.value = q.levels;
    u.uDither.value = q.dither;
    u.uScanlines.value = q.scanlines;
    u.uVignette.value = q.vignette;
    u.uBleed.value = q.bleed;
    this.resize(window.innerWidth, window.innerHeight);
  }

  getQuality(): RetroQuality {
    return this.quality;
  }

  /** Aspect ratio of the internal buffer, for the camera. */
  get aspect(): number {
    return this.bufferW / this.bufferH;
  }

  resize(cssW: number, cssH: number): void {
    const w = Math.max(1, Math.floor(cssW));
    const h = Math.max(1, Math.floor(cssH));
    this.renderer.setSize(w, h, false);

    const targetH = this.quality.height > 0 ? this.quality.height : h;
    const scale = targetH / h;
    this.bufferH = Math.max(120, Math.round(targetH));
    this.bufferW = Math.max(160, Math.round(w * scale));

    this.target.setSize(this.bufferW, this.bufferH);
    (this.material.uniforms.uResolution.value as THREE.Vector2).set(this.bufferW, this.bufferH);
  }

  /** 0..1 red flash overlay. */
  setDamage(v: number): void {
    this.material.uniforms.uDamage.value = Math.max(0, Math.min(1, v));
  }

  setTint(color: THREE.ColorRepresentation, amount: number): void {
    (this.material.uniforms.uTint.value as THREE.Color).set(color);
    this.material.uniforms.uTintAmount.value = Math.max(0, Math.min(1, amount));
  }

  setFade(v: number): void {
    this.material.uniforms.uFade.value = Math.max(0, Math.min(1, v));
  }

  /**
   * Draws the world, then the optional overlay scene on a cleared depth buffer
   * (that is what keeps the first-person weapon from poking through walls),
   * then upscales the whole thing through the CRT pass.
   */
  render(
    scene: THREE.Scene,
    camera: THREE.Camera,
    elapsed: number,
    overlay?: { scene: THREE.Scene; camera: THREE.Camera },
  ): void {
    this.material.uniforms.uTime.value = elapsed;
    this.renderer.setRenderTarget(this.target);
    this.renderer.autoClear = true;
    this.renderer.clear();
    this.renderer.render(scene, camera);

    if (overlay) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(overlay.scene, overlay.camera);
      this.renderer.autoClear = true;
    }

    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /**
   * Reads the low-resolution buffer back to the CPU. Only used by the headless
   * smoke test, which asserts the world actually rasterised something.
   */
  readFrame(): { width: number; height: number; pixels: Uint8Array } {
    const pixels = new Uint8Array(this.bufferW * this.bufferH * 4);
    this.renderer.readRenderTargetPixels(this.target, 0, 0, this.bufferW, this.bufferH, pixels);
    return { width: this.bufferW, height: this.bufferH, pixels };
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }
}
