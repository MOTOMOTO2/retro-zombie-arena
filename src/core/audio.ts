/**
 * All sound is synthesised with the Web Audio API at runtime - no audio files.
 * Gunshots are a filtered noise burst layered over a pitch-swept body tone,
 * which is roughly how the sample packs of the era were made in the first place.
 */

import type { WeaponDef } from '../game/weapons.ts';

type Vec = { x: number; z: number };

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private listener: Vec = { x: 0, z: 0 };
  private listenerYaw = 0;
  private musicNodes: AudioScheduledSourceNode[] = [];
  private musicTimer = 0;
  private musicIntensity = 0;
  muted = false;
  volume = 0.7;

  /** Must be called from a user gesture. */
  async resume(): Promise<void> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);

      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 1;
      this.sfxBus.connect(this.master);

      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.55;
      this.musicBus.connect(this.master);

      // One second of white noise, reused for every noise-based voice.
      const len = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && !this.muted) this.master.gain.value = this.volume;
  }

  setListener(pos: Vec, yaw: number): void {
    this.listener = pos;
    this.listenerYaw = yaw;
  }

  private get t(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Gain and stereo pan for a world position, relative to the listener. */
  private spatial(at?: Vec, maxDist = 70): { gain: number; pan: number } {
    if (!at) return { gain: 1, pan: 0 };
    const dx = at.x - this.listener.x;
    const dz = at.z - this.listener.z;
    const d = Math.hypot(dx, dz);
    if (d > maxDist) return { gain: 0, pan: 0 };
    const gain = Math.pow(1 - d / maxDist, 1.8);
    // Rotate into view space so left really is left.
    const sin = Math.sin(this.listenerYaw);
    const cos = Math.cos(this.listenerYaw);
    const right = dx * cos - dz * sin;
    const pan = d > 0.01 ? Math.max(-1, Math.min(1, right / Math.max(4, d))) : 0;
    return { gain, pan };
  }

  private route(source: AudioNode, gainValue: number, pan: number): GainNode | null {
    if (!this.ctx || !this.sfxBus) return null;
    const g = this.ctx.createGain();
    g.gain.value = gainValue;
    source.connect(g);
    if (typeof this.ctx.createStereoPanner === 'function') {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      p.connect(this.sfxBus);
    } else {
      g.connect(this.sfxBus);
    }
    return g;
  }

  private noise(
    duration: number, filterType: BiquadFilterType, freq: number, q: number,
    gainValue: number, pan: number, decayShape = 3,
  ): void {
    if (!this.ctx || !this.noiseBuffer || gainValue <= 0.001) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;
    src.connect(filter);

    const g = this.route(filter, gainValue, pan);
    if (!g) return;
    const now = this.t;
    g.gain.setValueAtTime(gainValue, now);
    g.gain.exponentialRampToValueAtTime(0.0008, now + duration * decayShape * 0.4);
    src.start(now);
    src.stop(now + duration * decayShape * 0.45 + 0.02);
  }

  private tone(
    type: OscillatorType, from: number, to: number, duration: number,
    gainValue: number, pan: number, delay = 0,
  ): void {
    if (!this.ctx || gainValue <= 0.001) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    const now = this.t + delay;
    osc.frequency.setValueAtTime(Math.max(20, from), now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + duration);

    const g = this.route(osc, 0.0001, pan);
    if (!g) return;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gainValue, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, now + duration);
    osc.start(now);
    osc.stop(now + duration + 0.03);
  }

  /* -------------------------------------------------------------- weapons */

  shot(def: WeaponDef, at?: Vec): void {
    const { gain, pan } = this.spatial(at, 120);
    if (gain <= 0.001) return;
    const v = def.voice;
    this.noise(0.05, 'bandpass', 900 + v.freq * 2, 0.9, 0.55 * gain * v.noise, pan, 3.2 * v.decay * 10);
    this.tone('square', v.freq * 1.6, v.freq * 0.35, v.decay, 0.32 * gain * v.body, pan);
    this.tone('sine', v.freq * 0.7, v.freq * 0.2, v.decay * 1.5, 0.22 * gain * v.body, pan);
    // Room tail.
    this.noise(0.22, 'lowpass', 1400, 0.5, 0.1 * gain, pan, 2.5);
  }

  dryFire(): void {
    this.noise(0.03, 'highpass', 2800, 1.2, 0.18, 0);
    this.tone('square', 420, 180, 0.05, 0.08, 0);
  }

  reloadClick(pitch = 1): void {
    this.noise(0.03, 'bandpass', 2200 * pitch, 3, 0.2, 0, 1.5);
    this.tone('square', 260 * pitch, 140 * pitch, 0.06, 0.09, 0);
  }

  explosion(at?: Vec): void {
    const { gain, pan } = this.spatial(at, 150);
    if (gain <= 0.001) return;
    this.noise(0.5, 'lowpass', 520, 0.6, 0.85 * gain, pan, 3.4);
    this.tone('sine', 120, 28, 0.85, 0.6 * gain, pan);
    this.tone('sawtooth', 220, 40, 0.35, 0.22 * gain, pan);
  }

  /* -------------------------------------------------------------- enemies */

  groan(at: Vec, pitch = 1): void {
    const { gain, pan } = this.spatial(at, 55);
    if (gain <= 0.01) return;
    const base = (88 + Math.random() * 45) * pitch;
    this.tone('sawtooth', base, base * 0.62, 0.75, 0.16 * gain, pan);
    this.tone('square', base * 1.5, base * 0.9, 0.55, 0.06 * gain, pan);
    this.noise(0.4, 'bandpass', 480, 1.4, 0.07 * gain, pan, 2.5);
  }

  bark(at: Vec): void {
    const { gain, pan } = this.spatial(at, 60);
    if (gain <= 0.01) return;
    this.tone('sawtooth', 420, 110, 0.16, 0.24 * gain, pan);
    this.noise(0.12, 'bandpass', 900, 1.1, 0.2 * gain, pan, 2);
  }

  flesh(at: Vec, big = false): void {
    const { gain, pan } = this.spatial(at, 60);
    if (gain <= 0.01) return;
    this.noise(big ? 0.2 : 0.08, 'lowpass', big ? 700 : 1300, 0.7, (big ? 0.5 : 0.28) * gain, pan, 2.4);
    this.tone('sine', big ? 150 : 260, 60, big ? 0.24 : 0.1, 0.18 * gain, pan);
  }

  wallHit(at: Vec): void {
    const { gain, pan } = this.spatial(at, 60);
    if (gain <= 0.01) return;
    this.noise(0.05, 'highpass', 3400, 1.5, 0.22 * gain, pan, 1.8);
  }

  boardBreak(at: Vec): void {
    const { gain, pan } = this.spatial(at, 70);
    if (gain <= 0.01) return;
    this.noise(0.14, 'bandpass', 1500, 0.8, 0.4 * gain, pan, 2.2);
    this.tone('square', 320, 90, 0.16, 0.14 * gain, pan);
  }

  footstep(): void {
    this.noise(0.05, 'lowpass', 420, 0.8, 0.08, (Math.random() - 0.5) * 0.4, 2);
  }

  hurt(): void {
    this.tone('sawtooth', 190, 70, 0.3, 0.3, 0);
    this.noise(0.18, 'lowpass', 900, 0.7, 0.22, 0, 2.4);
  }

  /* ----------------------------------------------------------- interface */

  buy(): void {
    this.arpeggio([523, 659, 784, 1047], 0.075, 0.16, 'square');
  }

  deny(): void {
    this.tone('square', 220, 140, 0.16, 0.16, 0);
    this.tone('square', 160, 100, 0.2, 0.12, 0, 0.09);
  }

  doorOpen(at?: Vec): void {
    const { gain, pan } = this.spatial(at, 90);
    this.noise(0.7, 'lowpass', 300, 0.7, 0.4 * gain, pan, 3);
    this.tone('sawtooth', 70, 40, 0.8, 0.2 * gain, pan);
  }

  powerUp(): void {
    this.arpeggio([392, 523, 659, 784, 1047, 1319], 0.06, 0.14, 'triangle');
  }

  perkJingle(): void {
    this.arpeggio([262, 330, 392, 523, 392, 523, 659], 0.11, 0.13, 'square');
  }

  boxJingle(): void {
    this.arpeggio([440, 523, 659, 587, 494, 440, 392], 0.13, 0.1, 'triangle');
  }

  roundStart(round: number): void {
    // A rising siren whose pitch climbs with the round number.
    const base = 180 + Math.min(240, round * 9);
    this.tone('sawtooth', base * 0.5, base * 1.6, 1.4, 0.2, -0.3);
    this.tone('sawtooth', base * 0.52, base * 1.58, 1.4, 0.2, 0.3);
    this.noise(1.0, 'bandpass', 300, 0.6, 0.1, 0, 3);
  }

  roundEnd(): void {
    this.arpeggio([392, 330, 262], 0.16, 0.12, 'sine');
  }

  gameOver(): void {
    this.tone('sawtooth', 220, 40, 2.4, 0.3, 0);
    this.tone('square', 110, 28, 2.6, 0.2, 0.2);
    this.noise(1.6, 'lowpass', 400, 0.6, 0.18, 0, 3);
  }

  private arpeggio(freqs: number[], step: number, gain: number, type: OscillatorType): void {
    freqs.forEach((f, i) => this.tone(type, f, f, 0.16, gain, 0, i * step));
  }

  /* -------------------------------------------------------------- ambient */

  startMusic(): void {
    if (!this.ctx || !this.musicBus || this.musicNodes.length) return;
    // Two detuned drones a fifth apart: the classic "something is wrong" pad.
    for (const [freq, detune, gainValue] of [
      [55, -6, 0.16], [82.4, 5, 0.1], [110, 11, 0.06],
    ]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 320;
      filter.Q.value = 2;
      const g = this.ctx.createGain();
      g.gain.value = gainValue;
      osc.connect(filter);
      filter.connect(g);
      g.connect(this.musicBus);
      osc.start();
      this.musicNodes.push(osc);
    }
  }

  stopMusic(): void {
    for (const n of this.musicNodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    this.musicNodes = [];
  }

  /** Drives the sparse heartbeat pulse; intensity rises with the round. */
  updateMusic(dt: number, intensity: number): void {
    if (!this.ctx || !this.musicBus) return;
    this.musicIntensity += (intensity - this.musicIntensity) * Math.min(1, dt * 0.5);
    this.musicTimer -= dt;
    if (this.musicTimer > 0) return;
    const period = Math.max(0.42, 1.5 - this.musicIntensity * 0.9);
    this.musicTimer = period;
    this.tone('sine', 62, 38, 0.24, 0.1 + this.musicIntensity * 0.1, 0);
    if (this.musicIntensity > 0.45) {
      this.tone('sine', 62, 38, 0.18, 0.06 + this.musicIntensity * 0.06, 0, period * 0.34);
    }
  }
}

export const audio = new AudioEngine();
