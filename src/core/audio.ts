/**
 * All sound is synthesised with the Web Audio API at runtime - no audio files.
 * Gunshots are a filtered noise burst layered over a pitch-swept body tone,
 * which is roughly how the sample packs of the era were made in the first place.
 *
 * The dead get a real voice: a raspy glottal buzz with a vocal-fry rattle,
 * pushed through three vowel formants that glide as the groan goes on
 * ("oooaaahhh"), then into a generated reverb so it rolls down the halls.
 * A voice limiter keeps a thirty-strong horde from turning into mush.
 */

import type { WeaponDef } from '../game/weapons.ts';

type Vec = { x: number; z: number };

export type ZombieVoice = 'moan' | 'growl' | 'snarl' | 'scream' | 'death';

export type MechSound =
  | 'magOut' | 'magIn' | 'magDrop' | 'rackBack' | 'rack'
  | 'breakOpen' | 'breakClose' | 'shellIn' | 'pump'
  | 'boltUp' | 'boltBack' | 'boltForward' | 'boltDown' | 'clipIn'
  | 'rocketIn' | 'cellOut' | 'cellIn' | 'boxOut' | 'boxIn' | 'swing' | 'throw';

/** First three formants of the vowels a rotten throat can still make, in Hz. */
const VOWELS: Record<string, [number, number, number]> = {
  oo: [330, 760, 2250],
  oh: [480, 860, 2300],
  uh: [620, 1100, 2350],
  ah: [760, 1220, 2450],
  aa: [820, 1500, 2550],
  eh: [560, 1750, 2500],
};

type Active = { out: GainNode; end: number; loud: number };

const MAX_VOICES = 7;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private shaper: Float32Array | null = null;
  private listener: Vec = { x: 0, z: 0 };
  private listenerYaw = 0;
  private musicNodes: AudioScheduledSourceNode[] = [];
  private musicTimer = 0;
  private musicIntensity = 0;
  private voices: Active[] = [];
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

      // A tiled, dark room: two seconds of decaying, low-passed stereo noise.
      if (typeof this.ctx.createConvolver === 'function') {
        const rate = this.ctx.sampleRate;
        const irLen = Math.floor(rate * 2.2);
        const ir = this.ctx.createBuffer(2, irLen, rate);
        for (let ch = 0; ch < 2; ch++) {
          const d = ir.getChannelData(ch);
          let lp = 0;
          for (let i = 0; i < irLen; i++) {
            const t = i / rate;
            const pre = t < 0.018 ? 0 : 1;
            lp += (Math.random() * 2 - 1 - lp) * 0.35;
            d[i] = lp * pre * Math.pow(1 - i / irLen, 2.4) * Math.exp(-t * 1.6);
          }
        }
        const conv = this.ctx.createConvolver();
        conv.buffer = ir;
        const wet = this.ctx.createGain();
        wet.gain.value = 0.55;
        conv.connect(wet);
        wet.connect(this.master);
        this.reverbSend = this.ctx.createGain();
        this.reverbSend.gain.value = 1;
        this.reverbSend.connect(conv);
      }

      // Soft-clip curve for the grit in a growl.
      const n = 1024;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 3.2) * 0.9;
      }
      this.shaper = curve;
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

  private route(source: AudioNode, gainValue: number, pan: number, reverb = 0): GainNode | null {
    if (!this.ctx || !this.sfxBus) return null;
    const g = this.ctx.createGain();
    g.gain.value = gainValue;
    source.connect(g);
    let out: AudioNode = g;
    if (typeof this.ctx.createStereoPanner === 'function') {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      out = p;
    }
    out.connect(this.sfxBus);
    if (reverb > 0 && this.reverbSend) {
      const send = this.ctx.createGain();
      send.gain.value = reverb;
      out.connect(send);
      send.connect(this.reverbSend);
    }
    return g;
  }

  private noise(
    duration: number, filterType: BiquadFilterType, freq: number, q: number,
    gainValue: number, pan: number, decayShape = 3, reverb = 0, delay = 0, freqTo = 0,
  ): void {
    if (!this.ctx || !this.noiseBuffer || gainValue <= 0.001) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    const now = this.t + delay;
    filter.frequency.setValueAtTime(freq, now);
    if (freqTo > 0) filter.frequency.exponentialRampToValueAtTime(freqTo, now + duration * decayShape * 0.4);
    filter.Q.value = q;
    src.connect(filter);

    const g = this.route(filter, gainValue, pan, reverb);
    if (!g) return;
    g.gain.setValueAtTime(gainValue, now);
    g.gain.exponentialRampToValueAtTime(0.0008, now + duration * decayShape * 0.4);
    src.start(now, Math.random() * 0.5);
    src.stop(now + duration * decayShape * 0.45 + 0.02);
  }

  private tone(
    type: OscillatorType, from: number, to: number, duration: number,
    gainValue: number, pan: number, delay = 0, reverb = 0,
  ): void {
    if (!this.ctx || gainValue <= 0.001) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    const now = this.t + delay;
    osc.frequency.setValueAtTime(Math.max(20, from), now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + duration);

    const g = this.route(osc, 0.0001, pan, reverb);
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
    this.noise(0.05, 'bandpass', 900 + v.freq * 2, 0.9, 0.55 * gain * v.noise, pan, 3.2 * v.decay * 10, 0.25);
    this.tone('square', v.freq * 1.6, v.freq * 0.35, v.decay, 0.32 * gain * v.body, pan);
    this.tone('sine', v.freq * 0.7, v.freq * 0.2, v.decay * 1.5, 0.22 * gain * v.body, pan);
    // Room tail.
    this.noise(0.22, 'lowpass', 1400, 0.5, 0.1 * gain, pan, 2.5, 0.4);
  }

  dryFire(): void {
    this.noise(0.03, 'highpass', 2800, 1.2, 0.18, 0);
    this.tone('square', 420, 180, 0.05, 0.08, 0);
  }

  /** A short metallic ring: a few inharmonic partials, which is what makes steel sound like steel. */
  private ring(base: number, gain: number, delay = 0, decay = 0.12): void {
    for (const [ratio, g] of [[1, 1], [2.32, 0.6], [3.71, 0.35]]) {
      this.tone('sine', base * ratio, base * ratio * 0.985, decay, gain * g, 0.15, delay, 0.15);
    }
  }

  private click(freq: number, gain: number, delay = 0): void {
    this.noise(0.012, 'bandpass', freq, 2.2, gain, 0.15, 1.6, 0.1, delay);
  }

  /** Reload foley, cued by the view-model animation. */
  mech(kind: MechSound): void {
    switch (kind) {
      case 'magOut':
        this.click(3200, 0.25);
        this.noise(0.06, 'bandpass', 2400, 3, 0.12, 0.15, 2, 0.1, 0.02, 900);
        break;
      case 'magIn':
        this.click(1800, 0.4);
        this.tone('square', 200, 120, 0.04, 0.1, 0.15);
        this.click(3400, 0.3, 0.045);
        this.ring(1900, 0.03, 0.045);
        break;
      case 'magDrop':
        this.click(2600, 0.12, 0.25);
        this.click(1900, 0.08, 0.34);
        break;
      case 'rackBack':
        this.noise(0.05, 'bandpass', 2800, 2.5, 0.2, 0.15, 2, 0.1, 0, 1400);
        this.click(3600, 0.25, 0.05);
        break;
      case 'rack':
        this.click(2400, 0.45);
        this.tone('square', 240, 130, 0.05, 0.1, 0.15);
        this.ring(2200, 0.05, 0.005, 0.18);
        break;
      case 'breakOpen':
        this.noise(0.06, 'lowpass', 900, 1, 0.35, 0.15, 2, 0.15);
        this.tone('square', 150, 90, 0.07, 0.14, 0.15);
        this.ring(1300, 0.04, 0.02, 0.2);
        break;
      case 'breakClose':
        this.noise(0.05, 'lowpass', 1200, 1, 0.5, 0.15, 2, 0.2);
        this.tone('square', 190, 100, 0.06, 0.18, 0.15);
        this.click(3000, 0.3, 0.01);
        break;
      case 'shellIn':
        this.click(2100, 0.25);
        this.tone('triangle', 420, 260, 0.04, 0.08, 0.15);
        this.click(1500, 0.18, 0.05);
        break;
      case 'pump':
        this.noise(0.05, 'bandpass', 1600, 1.8, 0.3, 0.15, 2, 0.15, 0, 900);
        this.click(2600, 0.3, 0.05);
        break;
      case 'boltUp':
        this.click(3000, 0.25);
        break;
      case 'boltBack':
        this.noise(0.05, 'bandpass', 2600, 2.2, 0.2, 0.15, 2, 0.1, 0, 1200);
        this.click(2000, 0.25, 0.06);
        break;
      case 'boltForward':
        this.noise(0.05, 'bandpass', 1400, 2.2, 0.2, 0.15, 2, 0.1, 0, 2600);
        this.click(2800, 0.35, 0.06);
        this.ring(2400, 0.03, 0.06);
        break;
      case 'boltDown':
        this.click(2200, 0.3);
        break;
      case 'clipIn':
        for (let i = 0; i < 5; i++) this.click(3400 + i * 150, 0.14, i * 0.035);
        this.click(1800, 0.3, 0.2);
        break;
      case 'rocketIn':
        this.noise(0.2, 'lowpass', 500, 0.8, 0.3, 0.15, 2, 0.1, 0, 300);
        this.tone('square', 110, 70, 0.1, 0.18, 0.15, 0.18);
        this.click(1500, 0.35, 0.2);
        break;
      case 'cellOut':
        this.tone('sine', 1400, 300, 0.25, 0.12, 0.15, 0, 0.2);
        this.click(2800, 0.25);
        break;
      case 'cellIn':
        this.click(2400, 0.3);
        this.tone('sawtooth', 300, 1800, 0.3, 0.07, 0.15, 0.03, 0.25);
        this.tone('sine', 900, 2400, 0.25, 0.1, 0.15, 0.05, 0.25);
        break;
      case 'boxOut':
        this.noise(0.08, 'lowpass', 700, 1, 0.35, 0.15, 2, 0.1);
        this.click(1600, 0.3, 0.03);
        break;
      case 'boxIn':
        this.noise(0.08, 'lowpass', 800, 1, 0.45, 0.15, 2, 0.15);
        this.tone('square', 130, 80, 0.08, 0.16, 0.15);
        this.click(2200, 0.35, 0.04);
        break;
      case 'swing':
        this.noise(0.12, 'bandpass', 500, 1.5, 0.28, 0, 2, 0, 0, 2200);
        break;
      case 'throw':
        this.tone('sine', 3200, 3100, 0.12, 0.05, 0);
        this.noise(0.12, 'bandpass', 700, 1.2, 0.2, 0, 2, 0, 0.05, 1800);
        break;
    }
  }

  explosion(at?: Vec): void {
    const { gain, pan } = this.spatial(at, 150);
    if (gain <= 0.001) return;
    this.noise(0.5, 'lowpass', 520, 0.6, 0.85 * gain, pan, 3.4, 0.4);
    this.tone('sine', 120, 28, 0.85, 0.6 * gain, pan, 0, 0.3);
    this.tone('sawtooth', 220, 40, 0.35, 0.22 * gain, pan);
  }

  /* -------------------------------------------------------------- enemies */

  /**
   * Makes room in the voice budget. A new voice that is quieter than every
   * voice already sounding is dropped; otherwise the quietest one is faded
   * out to make room.
   */
  private claimVoice(loud: number): boolean {
    const now = this.t;
    this.voices = this.voices.filter((v) => v.end > now);
    if (this.voices.length < MAX_VOICES) return true;
    let quietest = this.voices[0];
    for (const v of this.voices) if (v.loud < quietest.loud) quietest = v;
    if (loud <= quietest.loud) return false;
    quietest.out.gain.cancelScheduledValues(now);
    quietest.out.gain.setTargetAtTime(0, now, 0.04);
    quietest.end = now;
    return true;
  }

  /**
   * One utterance from a zombie throat. `pitch` scales the voice: brutes are
   * deeper, runners higher.
   */
  zombieVoice(at: Vec, kind: ZombieVoice, pitch = 1): void {
    const range = kind === 'scream' ? 80 : kind === 'death' ? 50 : 60;
    const { gain, pan } = this.spatial(at, range);
    if (!this.ctx || !this.noiseBuffer || !this.shaper || gain <= 0.01) return;
    if (!this.claimVoice(gain)) return;
    const ctx = this.ctx;
    const r = (a: number, b: number): number => a + Math.random() * (b - a);

    // Per-kind character.
    const spec = {
      moan: { dur: r(1.3, 2.3), f0: r(68, 96), rise: 1.12, fall: 0.72, vowels: ['oo', 'ah', 'uh'], breath: 0.35, fry: 0.55, fryHz: r(22, 34), grit: 0.25, level: 0.34, attack: 0.25 },
      growl: { dur: r(0.7, 1.1), f0: r(52, 72), rise: 1.05, fall: 0.8, vowels: ['uh', 'ah', 'uh'], breath: 0.5, fry: 0.85, fryHz: r(30, 42), grit: 0.8, level: 0.42, attack: 0.08 },
      snarl: { dur: r(0.35, 0.55), f0: r(120, 170), rise: 1.35, fall: 0.7, vowels: ['aa', 'eh', 'ah'], breath: 0.6, fry: 0.6, fryHz: r(38, 55), grit: 1, level: 0.5, attack: 0.02 },
      scream: { dur: r(0.7, 1.0), f0: r(260, 380), rise: 1.25, fall: 0.6, vowels: ['aa', 'eh', 'aa'], breath: 0.7, fry: 0.3, fryHz: r(40, 60), grit: 0.7, level: 0.42, attack: 0.03 },
      death: { dur: r(0.8, 1.3), f0: r(70, 95), rise: 1.0, fall: 0.45, vowels: ['uh', 'oh', 'oo'], breath: 0.55, fry: 1, fryHz: r(10, 18), grit: 0.5, level: 0.4, attack: 0.03 },
    }[kind];
    const dur = spec.dur;
    const now = this.t + 0.005;
    const end = now + dur;
    const f0 = spec.f0 * pitch;

    // Glottal source: a sawtooth with a sagging pitch contour and a wobble.
    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(f0 * 0.92, now);
    src.frequency.linearRampToValueAtTime(f0 * spec.rise, now + dur * 0.3);
    src.frequency.linearRampToValueAtTime(f0 * spec.fall, end);
    const vib = ctx.createOscillator();
    vib.frequency.value = r(4, 7);
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = f0 * 0.04;
    vib.connect(vibDepth);
    vibDepth.connect(src.frequency);

    // Breath and rasp: noise band-passed into the same formants.
    const breath = ctx.createBufferSource();
    breath.buffer = this.noiseBuffer;
    breath.loop = true;
    const breathGain = ctx.createGain();
    breathGain.gain.value = spec.breath;
    breath.connect(breathGain);

    const voiceIn = ctx.createGain();
    voiceIn.gain.value = 1;
    src.connect(voiceIn);
    breathGain.connect(voiceIn);

    // Vocal fry: the throat rattling, as amplitude modulation.
    const fryNode = ctx.createGain();
    fryNode.gain.value = 1 - spec.fry * 0.5;
    const fryOsc = ctx.createOscillator();
    fryOsc.type = 'square';
    fryOsc.frequency.value = spec.fryHz;
    const fryDepth = ctx.createGain();
    fryDepth.gain.value = spec.fry * 0.5;
    fryOsc.connect(fryDepth);
    fryDepth.connect(fryNode.gain);
    voiceIn.connect(fryNode);

    // Grit.
    const shape = ctx.createWaveShaper();
    shape.curve = this.shaper as Float32Array<ArrayBuffer>;
    const pre = ctx.createGain();
    pre.gain.value = 0.4 + spec.grit * 2.2;
    fryNode.connect(pre);
    pre.connect(shape);

    // Three formants that glide from vowel to vowel.
    const mix = ctx.createGain();
    mix.gain.value = 1;
    for (let i = 0; i < 3; i++) {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = [7, 9, 11][i];
      const vs = spec.vowels.map((v) => VOWELS[v][i] * (0.9 + pitch * 0.1));
      f.frequency.setValueAtTime(vs[0], now);
      f.frequency.linearRampToValueAtTime(vs[1], now + dur * 0.45);
      f.frequency.linearRampToValueAtTime(vs[2], end);
      const g = ctx.createGain();
      g.gain.value = [1, 0.55, 0.25][i] * 3.2;
      shape.connect(f);
      f.connect(g);
      g.connect(mix);
    }
    // A little of the raw buzz under the formants keeps the chest in it.
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 280;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.35;
    shape.connect(body);
    body.connect(bodyGain);
    bodyGain.connect(mix);

    // Envelope, with a couple of swells so a long moan breathes.
    const env = ctx.createGain();
    const peak = spec.level * gain;
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(peak, now + spec.attack);
    if (kind === 'moan') {
      env.gain.linearRampToValueAtTime(peak * 0.7, now + dur * 0.45);
      env.gain.linearRampToValueAtTime(peak * 0.95, now + dur * 0.7);
    }
    env.gain.exponentialRampToValueAtTime(0.0006, end);
    mix.connect(env);

    const out = this.route(env, 1, pan, kind === 'snarl' ? 0.25 : 0.55);
    if (!out) return;
    this.voices.push({ out, end, loud: gain });

    for (const n of [src, vib, breath, fryOsc]) {
      n.start(now);
      n.stop(end + 0.05);
    }
    if (kind === 'death') {
      // A wet gurgle underneath as it goes down.
      this.noise(0.2, 'bandpass', 380, 4, 0.18 * gain, pan, 3, 0.3, dur * 0.3, 160);
    }
  }

  bark(at: Vec): void {
    const { gain, pan } = this.spatial(at, 60);
    if (gain <= 0.01) return;
    this.tone('sawtooth', 420, 110, 0.16, 0.24 * gain, pan, 0, 0.3);
    this.noise(0.12, 'bandpass', 900, 1.1, 0.2 * gain, pan, 2, 0.3);
    this.zombieVoice(at, 'growl', 1.6);
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
    this.noise(0.05, 'highpass', 3400, 1.5, 0.22 * gain, pan, 1.8, 0.15);
  }

  boardBreak(at: Vec): void {
    const { gain, pan } = this.spatial(at, 70);
    if (gain <= 0.01) return;
    this.noise(0.14, 'bandpass', 1500, 0.8, 0.4 * gain, pan, 2.2, 0.35);
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
    this.noise(0.7, 'lowpass', 300, 0.7, 0.4 * gain, pan, 3, 0.4);
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
    this.tone('sawtooth', base * 0.5, base * 1.6, 1.4, 0.2, -0.3, 0, 0.3);
    this.tone('sawtooth', base * 0.52, base * 1.58, 1.4, 0.2, 0.3, 0, 0.3);
    this.noise(1.0, 'bandpass', 300, 0.6, 0.1, 0, 3);
  }

  roundEnd(): void {
    this.arpeggio([392, 330, 262], 0.16, 0.12, 'sine');
  }

  gameOver(): void {
    this.tone('sawtooth', 220, 40, 2.4, 0.3, 0, 0, 0.3);
    this.tone('square', 110, 28, 2.6, 0.2, 0.2);
    this.noise(1.6, 'lowpass', 400, 0.6, 0.18, 0, 3, 0.3);
  }

  private arpeggio(freqs: number[], step: number, gain: number, type: OscillatorType): void {
    freqs.forEach((f, i) => this.tone(type, f, f, 0.16, gain, 0, i * step, 0.2));
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

  /** How many zombie voices are sounding right now. Used by the smoke test. */
  get activeVoices(): number {
    const now = this.t;
    return this.voices.filter((v) => v.end > now).length;
  }
}

export const audio = new AudioEngine();
