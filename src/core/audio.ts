/**
 * Sound is synthesised with the Web Audio API at runtime; the only audio files
 * are the spoken lines (see the end of this comment). Gunshots are a filtered noise burst layered over a pitch-swept body tone,
 * which is roughly how the sample packs of the era were made in the first place.
 *
 * The dead get a real voice: a raspy glottal buzz with a vocal-fry rattle,
 * pushed through three vowel formants that glide as the groan goes on
 * ("oooaaahhh"), then into a generated reverb so it rolls down the halls.
 * A voice limiter keeps a thirty-strong horde from turning into mush. The
 * player's grunts come out of the same throat, tuned human.
 *
 * Anything in the world is heard through a head-related panner that follows
 * the listener as they turn, so a moan that started on your left moves to your
 * right when you spin round, and a zombie behind you sounds behind you.
 *
 * The one exception to "all synthesised" is speech: words need a real voice.
 * The announcer and the player's callouts are recorded lines (see voice.ts),
 * but they still play through this mix - the announcer pitched down, doubled
 * and drenched in the room - so they duck the music and follow the volume.
 *
 * The soundtrack is an arcade chiptune sequenced live; see music.ts.
 */

import type { WeaponDef } from '../game/weapons.ts';
import { ArcadeMusic, type MusicCue } from './music.ts';
import { CALLOUT_GAP, CALLOUT_PACE, VoiceBank, type AnnouncerLine, type PlayerLine } from './voice.ts';

export type { AnnouncerLine, MusicCue, PlayerLine };

type Vec = { x: number; z: number };

/**
 * A point in the world a sound comes from. Its panner is made the first time
 * something is routed to it, so a sound too quiet to play costs nothing.
 */
type Spot = { x: number; z: number; far: number; dry?: AudioNode; wet?: AudioNode | null };

/** A fixed stereo position (interface sounds, the player's own kit) or a spot in the world. */
type Place = number | Spot;

/** Closer than this a sound is inside your own head, so it plays dead centre. */
const NEAR = 0.6;

/** The music bus at the top of the music slider; the default of 70 sits at about 0.32. */
const MUSIC_LEVEL = 0.46;

/** The announcer plays slowed like an old sampler, which drops his voice to a rumble. */
const ANNOUNCER_RATE = 0.9;

/** What a throat does over one utterance. */
type Throat = {
  dur: number;
  /** Fundamental in Hz, and the ratios it climbs to (by 30%) and sags to (by the end). */
  f0: number;
  rise: number;
  fall: number;
  /** Three vowels the formants glide through. */
  vowels: string[];
  breath: number;
  fry: number;
  fryHz: number;
  grit: number;
  level: number;
  attack: number;
  /** Vibrato depth as a fraction of f0. */
  wobble?: number;
  /** A long moan breathes: two swells instead of one decay. */
  swell?: boolean;
};

export type Grunt = 'light' | 'hard' | 'agony' | 'death';

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

/** A spoken line in flight: its fader, and when it finishes. */
type Speech = { out: GainNode; end: number };

const MAX_VOICES = 7;

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private shaper: Float32Array | null = null;
  private listener: Vec = { x: 0, z: 0 };
  private music: ArcadeMusic | null = null;
  private musicIntensity = 0;
  private voices: Active[] = [];
  private lastGrunt = -1;
  private readonly bank = new VoiceBank();
  private voicesLoading: Promise<void> = Promise.resolve();
  /** Who is talking, so a more important line can cut them off. */
  private mouth: Speech | null = null;
  private announcer: Speech | null = null;
  private readonly calloutReady = new Map<PlayerLine, number>();
  /** What was last said, and by whom. Used by the smoke test. */
  lastLine = '';
  muted = false;
  volume = 0.7;
  /** The music slider, 0..1, on top of the master volume. */
  musicVolume = 0.7;

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
      this.musicBus.gain.value = this.musicLevel;
      this.musicBus.connect(this.master);

      // The spoken lines download in the background; nothing waits on them.
      this.voicesLoading = this.bank.load(this.ctx);

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

  /** The music's own level, 0..1, under the master volume. */
  setMusicVolume(v: number): void {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (!this.musicBus) return;
    const g = this.musicBus.gain;
    g.cancelScheduledValues(this.t);
    g.setTargetAtTime(this.musicLevel, this.t, 0.03);
  }

  private get musicLevel(): number {
    return MUSIC_LEVEL * this.musicVolume;
  }

  /**
   * Moves the ears. Called every frame, and every sound already playing in the
   * world re-pans to match, which is what keeps direction honest while you turn.
   */
  setListener(pos: Vec, yaw: number): void {
    this.listener = pos;
    const l = this.ctx?.listener;
    if (!l) return;
    // Same convention as the camera: yaw 0 looks down -z, +x is to the right.
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    if (l.forwardX) {
      l.positionX.value = pos.x;
      l.positionY.value = 0;
      l.positionZ.value = pos.z;
      l.forwardX.value = fx;
      l.forwardY.value = 0;
      l.forwardZ.value = fz;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      // Firefox only has the old setters.
      l.setPosition(pos.x, 0, pos.z);
      l.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  private get t(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Distance gain for a world position, and where it plays from. */
  private spatial(at?: Vec, maxDist = 70): { gain: number; place: Place } {
    if (!at) return { gain: 1, place: 0 };
    const dx = at.x - this.listener.x;
    const dz = at.z - this.listener.z;
    const d = Math.hypot(dx, dz);
    if (d > maxDist) return { gain: 0, place: 0 };
    const gain = Math.pow(1 - d / maxDist, 1.8);
    return { gain, place: d < NEAR ? 0 : { x: at.x, z: at.z, far: d / maxDist } };
  }

  /** The panner a spot plays through, made on first use and shared by every layer of the sound. */
  private spotNodes(s: Spot): { dry: AudioNode; wet: AudioNode | null } {
    if (s.dry) return { dry: s.dry, wet: s.wet ?? null };
    const ctx = this.ctx as AudioContext;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    // Distance is already in the gain; the panner only supplies direction.
    p.distanceModel = 'linear';
    p.rolloffFactor = 0;
    if (p.positionX) {
      p.positionX.value = s.x;
      p.positionY.value = 0;
      p.positionZ.value = s.z;
    } else {
      p.setPosition(s.x, 0, s.z);
    }
    p.connect(this.sfxBus as GainNode);
    s.dry = p;
    s.wet = null;
    if (this.reverbSend) {
      // The room answers from all round, and more of what reaches you from
      // far off is room: that ratio is most of how the ear judges distance.
      const w = ctx.createGain();
      w.gain.value = 1 + s.far * 1.2;
      w.connect(this.reverbSend);
      s.wet = w;
    }
    return { dry: p, wet: s.wet };
  }

  private route(source: AudioNode, gainValue: number, place: Place, reverb = 0): GainNode | null {
    if (!this.ctx || !this.sfxBus) return null;
    const g = this.ctx.createGain();
    g.gain.value = gainValue;
    source.connect(g);
    let out: AudioNode = g;
    let wet = this.reverbSend as AudioNode | null;
    if (typeof place !== 'number') {
      const spot = this.spotNodes(place);
      g.connect(spot.dry);
      wet = spot.wet;
    } else {
      if (typeof this.ctx.createStereoPanner === 'function') {
        const p = this.ctx.createStereoPanner();
        p.pan.value = place;
        g.connect(p);
        out = p;
      }
      out.connect(this.sfxBus);
    }
    if (reverb > 0 && wet) {
      const send = this.ctx.createGain();
      send.gain.value = reverb;
      out.connect(send);
      send.connect(wet);
    }
    return g;
  }

  private noise(
    duration: number, filterType: BiquadFilterType, freq: number, q: number,
    gainValue: number, place: Place, decayShape = 3, reverb = 0, delay = 0, freqTo = 0,
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

    const g = this.route(filter, gainValue, place, reverb);
    if (!g) return;
    g.gain.setValueAtTime(gainValue, now);
    g.gain.exponentialRampToValueAtTime(0.0008, now + duration * decayShape * 0.4);
    src.start(now, Math.random() * 0.5);
    src.stop(now + duration * decayShape * 0.45 + 0.02);
  }

  private tone(
    type: OscillatorType, from: number, to: number, duration: number,
    gainValue: number, place: Place, delay = 0, reverb = 0,
  ): void {
    if (!this.ctx || gainValue <= 0.001) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    const now = this.t + delay;
    osc.frequency.setValueAtTime(Math.max(20, from), now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + duration);

    const g = this.route(osc, 0.0001, place, reverb);
    if (!g) return;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gainValue, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, now + duration);
    osc.start(now);
    osc.stop(now + duration + 0.03);
  }

  /* -------------------------------------------------------------- weapons */

  shot(def: WeaponDef, at?: Vec): void {
    const { gain, place } = this.spatial(at, 120);
    if (gain <= 0.001) return;
    const v = def.voice;
    this.noise(0.05, 'bandpass', 900 + v.freq * 2, 0.9, 0.55 * gain * v.noise, place, 3.2 * v.decay * 10, 0.25);
    this.tone('square', v.freq * 1.6, v.freq * 0.35, v.decay, 0.32 * gain * v.body, place);
    this.tone('sine', v.freq * 0.7, v.freq * 0.2, v.decay * 1.5, 0.22 * gain * v.body, place);
    // Room tail.
    this.noise(0.22, 'lowpass', 1400, 0.5, 0.1 * gain, place, 2.5, 0.4);
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
    const { gain, place } = this.spatial(at, 150);
    if (gain <= 0.001) return;
    this.noise(0.5, 'lowpass', 520, 0.6, 0.85 * gain, place, 3.4, 0.4);
    this.tone('sine', 120, 28, 0.85, 0.6 * gain, place, 0, 0.3);
    this.tone('sawtooth', 220, 40, 0.35, 0.22 * gain, place);
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
    const { gain, place } = this.spatial(at, range);
    if (!this.ctx || !this.noiseBuffer || !this.shaper || gain <= 0.01) return;
    if (!this.claimVoice(gain)) return;

    // Per-kind character.
    const spec: Throat = {
      moan: { dur: rand(1.3, 2.3), f0: rand(68, 96), rise: 1.12, fall: 0.72, vowels: ['oo', 'ah', 'uh'], breath: 0.35, fry: 0.55, fryHz: rand(22, 34), grit: 0.25, level: 0.34, attack: 0.25, swell: true },
      growl: { dur: rand(0.7, 1.1), f0: rand(52, 72), rise: 1.05, fall: 0.8, vowels: ['uh', 'ah', 'uh'], breath: 0.5, fry: 0.85, fryHz: rand(30, 42), grit: 0.8, level: 0.42, attack: 0.08 },
      snarl: { dur: rand(0.35, 0.55), f0: rand(120, 170), rise: 1.35, fall: 0.7, vowels: ['aa', 'eh', 'ah'], breath: 0.6, fry: 0.6, fryHz: rand(38, 55), grit: 1, level: 0.5, attack: 0.02 },
      scream: { dur: rand(0.7, 1.0), f0: rand(260, 380), rise: 1.25, fall: 0.6, vowels: ['aa', 'eh', 'aa'], breath: 0.7, fry: 0.3, fryHz: rand(40, 60), grit: 0.7, level: 0.42, attack: 0.03 },
      death: { dur: rand(0.8, 1.3), f0: rand(70, 95), rise: 1.0, fall: 0.45, vowels: ['uh', 'oh', 'oo'], breath: 0.55, fry: 1, fryHz: rand(10, 18), grit: 0.5, level: 0.4, attack: 0.03 },
    }[kind];
    spec.f0 *= pitch;

    const voice = this.throat(spec, 0.9 + pitch * 0.1, gain, place, kind === 'snarl' ? 0.25 : 0.55);
    if (!voice) return;
    this.voices.push({ out: voice.out, end: voice.end, loud: gain });
    if (kind === 'death') {
      // A wet gurgle underneath as it goes down.
      this.noise(0.2, 'bandpass', 380, 4, 0.18 * gain, place, 3, 0.3, spec.dur * 0.3, 160);
    }
  }

  /**
   * A voice: a raspy glottal buzz with a vocal-fry rattle, pushed through three
   * vowel formants that glide as it goes. `formants` scales the vocal tract.
   */
  private throat(spec: Throat, formants: number, gain: number, place: Place, reverb: number): { out: GainNode; end: number } | null {
    if (!this.ctx || !this.noiseBuffer || !this.shaper) return null;
    const ctx = this.ctx;
    const dur = spec.dur;
    const now = this.t + 0.005;
    const end = now + dur;
    const f0 = spec.f0;

    // Glottal source: a sawtooth with a sagging pitch contour and a wobble.
    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(f0 * 0.92, now);
    src.frequency.linearRampToValueAtTime(f0 * spec.rise, now + dur * 0.3);
    src.frequency.linearRampToValueAtTime(f0 * spec.fall, end);
    const vib = ctx.createOscillator();
    vib.frequency.value = rand(4, 7);
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = f0 * (spec.wobble ?? 0.04);
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
      const vs = spec.vowels.map((v) => VOWELS[v][i] * formants);
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
    if (spec.swell) {
      env.gain.linearRampToValueAtTime(peak * 0.7, now + dur * 0.45);
      env.gain.linearRampToValueAtTime(peak * 0.95, now + dur * 0.7);
    }
    env.gain.exponentialRampToValueAtTime(0.0006, end);
    mix.connect(env);

    const out = this.route(env, 1, place, reverb);
    if (!out) return null;

    for (const n of [src, vib, breath, fryOsc]) {
      n.start(now);
      n.stop(end + 0.05);
    }
    return { out, end };
  }

  bark(at: Vec): void {
    const { gain, place } = this.spatial(at, 60);
    if (gain <= 0.01) return;
    this.tone('sawtooth', 420, 110, 0.16, 0.24 * gain, place, 0, 0.3);
    this.noise(0.12, 'bandpass', 900, 1.1, 0.2 * gain, place, 2, 0.3);
    this.zombieVoice(at, 'growl', 1.6);
  }

  flesh(at: Vec, big = false): void {
    const { gain, place } = this.spatial(at, 60);
    if (gain <= 0.01) return;
    this.noise(big ? 0.2 : 0.08, 'lowpass', big ? 700 : 1300, 0.7, (big ? 0.5 : 0.28) * gain, place, 2.4);
    this.tone('sine', big ? 150 : 260, 60, big ? 0.24 : 0.1, 0.18 * gain, place);
  }

  wallHit(at: Vec): void {
    const { gain, place } = this.spatial(at, 60);
    if (gain <= 0.01) return;
    this.noise(0.05, 'highpass', 3400, 1.5, 0.22 * gain, place, 1.8, 0.15);
  }

  boardBreak(at: Vec): void {
    const { gain, place } = this.spatial(at, 70);
    if (gain <= 0.01) return;
    this.noise(0.14, 'bandpass', 1500, 0.8, 0.4 * gain, place, 2.2, 0.35);
    this.tone('square', 320, 90, 0.16, 0.14 * gain, place);
  }

  footstep(): void {
    this.noise(0.05, 'lowpass', 420, 0.8, 0.08, (Math.random() - 0.5) * 0.4, 2);
  }

  /* --------------------------------------------------------------- player */

  /**
   * Taking a hit: the thump of it, and a grunt that gets rougher the harder the
   * hit and the closer to dead you are. At no health left it is a death cry.
   * Grunts are spaced out so a crowd clawing at you doesn't turn into a stutter.
   */
  hurt(amount = 30, health = 1): void {
    this.tone('sawtooth', 190, 70, 0.3, 0.3, 0);
    this.noise(0.18, 'lowpass', 900, 0.7, 0.22, 0, 2.4);
    if (health <= 0) {
      this.grunt('death');
      return;
    }
    const now = this.t;
    if (now - this.lastGrunt < (amount >= 45 ? 0.25 : amount >= 20 ? 0.45 : 0.9)) return;
    this.lastGrunt = now;
    const tier = (amount >= 45 ? 2 : amount >= 20 ? 1 : 0) + (health < 0.3 ? 1 : 0);
    this.grunt((['light', 'hard', 'agony', 'agony'] as const)[tier]);
  }

  /** The player's own voice: the zombie throat, tuned to a living man. */
  grunt(kind: Grunt): void {
    const spec: Throat = {
      light: { dur: rand(0.16, 0.24), f0: rand(118, 138), rise: 1.14, fall: 0.8, vowels: ['uh', 'uh', 'oh'], breath: 0.3, fry: 0.25, fryHz: rand(55, 75), grit: 0.15, level: 0.44, attack: 0.012, wobble: 0.015 },
      hard: { dur: rand(0.26, 0.36), f0: rand(128, 150), rise: 1.22, fall: 0.72, vowels: ['ah', 'ah', 'uh'], breath: 0.35, fry: 0.3, fryHz: rand(60, 80), grit: 0.3, level: 0.5, attack: 0.01, wobble: 0.02 },
      agony: { dur: rand(0.45, 0.6), f0: rand(150, 180), rise: 1.28, fall: 0.62, vowels: ['aa', 'ah', 'uh'], breath: 0.45, fry: 0.35, fryHz: rand(65, 85), grit: 0.5, level: 0.52, attack: 0.015, wobble: 0.03 },
      death: { dur: rand(1.1, 1.4), f0: rand(160, 185), rise: 1.08, fall: 0.42, vowels: ['aa', 'ah', 'oh'], breath: 0.5, fry: 0.55, fryHz: rand(30, 45), grit: 0.45, level: 0.5, attack: 0.02, wobble: 0.04 },
    }[kind];
    this.throat(spec, 1, 1, 0, kind === 'death' ? 0.35 : 0.12);
    // The breath forced out after it.
    if (kind !== 'light') {
      this.noise(kind === 'death' ? 0.3 : 0.1, 'bandpass', 1300, 0.9, kind === 'death' ? 0.07 : 0.05, 0, 2, 0.1, spec.dur * 0.92);
    }
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
    const { gain, place } = this.spatial(at, 90);
    this.noise(0.7, 'lowpass', 300, 0.7, 0.4 * gain, place, 3, 0.4);
    this.tone('sawtooth', 70, 40, 0.8, 0.2 * gain, place);
  }

  powerUp(): void {
    this.arpeggio([392, 523, 659, 784, 1047, 1319], 0.06, 0.14, 'triangle');
  }

  /**
   * The announcer, as in the old games: a low boom, the music ducking out of
   * the way, and a huge slow voice calling it. The recorded line is played
   * slowed down, doubled by a second copy a hair slower still (so the two
   * drift and phase against each other), warmed through the grit curve and
   * sent heavily into the room. Before the lines have downloaded, only the
   * boom plays; the banner still says it.
   */
  announce(line: AnnouncerLine, delay = 0): void {
    if (!this.ctx || !this.shaper) return;
    const ctx = this.ctx;
    const at = this.t + delay;
    this.tone('sine', 96, 42, 1.2, 0.24, 0, delay, 0.5);
    this.noise(0.5, 'lowpass', 420, 0.7, 0.14, 0, 3, 0.6, delay, 160);
    const buf = this.bank.pick('announcer', line);
    const length = buf ? buf.duration / ANNOUNCER_RATE : 0.8;
    this.duck(length + 0.5, at);
    if (!buf) return;

    const main = ctx.createBufferSource();
    main.buffer = buf;
    main.playbackRate.value = ANNOUNCER_RATE;
    const double = ctx.createBufferSource();
    double.buffer = buf;
    double.playbackRate.value = ANNOUNCER_RATE * 0.992;
    const doubleGain = ctx.createGain();
    doubleGain.gain.value = 0.5;
    double.connect(doubleGain);

    const drive = ctx.createGain();
    drive.gain.value = 0.35;
    main.connect(drive);
    doubleGain.connect(drive);
    const grit = ctx.createWaveShaper();
    grit.curve = this.shaper as Float32Array<ArrayBuffer>;
    drive.connect(grit);
    const chest = ctx.createBiquadFilter();
    chest.type = 'lowshelf';
    chest.frequency.value = 200;
    chest.gain.value = 5;
    grit.connect(chest);
    const rumble = ctx.createBiquadFilter();
    rumble.type = 'highpass';
    rumble.frequency.value = 65;
    chest.connect(rumble);

    const out = this.route(rumble, 0.95, 0, 0.6);
    if (!out) return;
    main.start(at);
    double.start(at + 0.02);
    // He talks over everyone, including himself calling the last pick-up.
    this.hush(this.mouth, at);
    this.hush(this.announcer, at);
    this.announcer = { out, end: at + length + 0.15 };
    this.lastLine = `announcer.${line}`;
  }

  /**
   * The player says something about what just happened - if the moment earns a
   * line (see CALLOUT_PACE), the same line has not just been said, and nobody
   * is already talking. Returns whether a line was spoken.
   */
  callout(line: PlayerLine, delay = 0): boolean {
    if (!this.ctx) return false;
    const ctx = this.ctx;
    const now = this.t;
    const at = now + delay;
    const pace = CALLOUT_PACE[line];
    if (this.announcer && at < this.announcer.end) return false;
    if (!pace.urgent && this.mouth && at < this.mouth.end + CALLOUT_GAP) return false;
    if (now < (this.calloutReady.get(line) ?? 0)) return false;
    if (Math.random() >= pace.chance) return false;
    const buf = this.bank.pick('player', line);
    if (!buf) return false;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Nobody says a line the same way twice: a hair up or down each time.
    src.playbackRate.value = rand(0.97, 1.03);
    const clean = ctx.createBiquadFilter();
    clean.type = 'highpass';
    clean.frequency.value = 90;
    src.connect(clean);
    const out = this.route(clean, 0.7, 0, 0.1);
    if (!out) return false;
    this.hush(this.mouth, at);
    src.start(at);
    this.mouth = { out, end: at + buf.duration / src.playbackRate.value };
    this.calloutReady.set(line, now + pace.cooldown);
    this.lastLine = `player.${line}`;
    return true;
  }

  /** Cuts a line off, from a moment in time. */
  private hush(speech: Speech | null, at: number): void {
    if (!speech || speech.end <= at) return;
    const g = speech.out.gain;
    g.setValueAtTime(g.value, at);
    g.setTargetAtTime(0, at, 0.04);
    speech.end = at;
  }

  /** Resolves once the spoken lines have downloaded (or failed to). */
  get voicesReady(): Promise<number> {
    return this.voicesLoading.then(() => this.bank.loaded);
  }

  /** Pulls the music down out of the way for a moment. */
  private duck(seconds: number, at = this.t): void {
    if (!this.musicBus) return;
    const g = this.musicBus.gain;
    if (typeof g.cancelAndHoldAtTime === 'function') {
      g.cancelAndHoldAtTime(at);
    } else {
      g.cancelScheduledValues(at);
      g.setValueAtTime(g.value, at);
    }
    g.setTargetAtTime(this.musicLevel * 0.3, at, 0.06);
    g.setTargetAtTime(this.musicLevel, at + seconds, 0.5);
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

  /* ------------------------------------------------------- box and story */

  /** The mystery box's music-box waltz, slowing as it runs down. */
  musicBox(duration = 3.6): void {
    const tune = [659, 784, 988, 1319, 1175, 988, 784, 880, 740, 587, 659, 523, 494, 440];
    let t = 0;
    for (let i = 0; i < tune.length && t < duration - 0.2; i++) {
      const f = tune[i];
      this.tone('sine', f, f * 0.998, 0.5, 0.09, -0.1, t, 0.35);
      this.tone('triangle', f * 2, f * 2, 0.25, 0.025, 0.1, t, 0.35);
      t += 0.2 + (t / duration) * 0.16;
    }
  }

  /** What plays when the box settles: louder and brighter the rarer the gun. */
  reveal(rarity: 'common' | 'rare' | 'epic' | 'legendary'): void {
    if (rarity === 'legendary') {
      this.arpeggio([523, 659, 784, 1047, 1319, 1568, 2093], 0.07, 0.15, 'square');
      for (const f of [523, 659, 784, 1047]) this.tone('sawtooth', f, f, 1.4, 0.06, 0, 0.5, 0.5);
      this.noise(0.8, 'highpass', 5000, 0.7, 0.1, 0, 3, 0.5, 0.45);
    } else if (rarity === 'epic') {
      this.arpeggio([440, 554, 659, 880, 1109], 0.07, 0.14, 'triangle');
      this.tone('sine', 880, 880, 0.9, 0.06, 0, 0.35, 0.4);
    } else if (rarity === 'rare') {
      this.arpeggio([523, 659, 784, 1047], 0.07, 0.13, 'triangle');
    } else {
      this.buy();
    }
  }

  /** The teddy bear's giggle: three wheezy syllables and a sour note. */
  teddy(): void {
    for (let i = 0; i < 3; i++) {
      this.tone('sawtooth', 330 - i * 30, 250 - i * 30, 0.13, 0.1, 0, i * 0.19, 0.4);
      this.noise(0.05, 'bandpass', 1800, 3, 0.08, 0, 1.5, 0.3, i * 0.19);
    }
    this.tone('sine', 311, 294, 1.2, 0.08, 0, 0.6, 0.5);
  }

  /** Lightning: a crackle of short bursts over a falling whine. */
  zap(at?: Vec): void {
    const { gain, place } = this.spatial(at, 90);
    if (gain <= 0.01) return;
    for (let i = 0; i < 5; i++) this.noise(0.02, 'highpass', 2600 + Math.random() * 3000, 1.2, 0.26 * gain, place, 1.4, 0.3, Math.random() * 0.18);
    this.tone('sawtooth', 1600, 180, 0.28, 0.09 * gain, place, 0, 0.3);
  }

  freeze(at?: Vec): void {
    const { gain, place } = this.spatial(at, 80);
    if (gain <= 0.01) return;
    this.noise(0.3, 'highpass', 5200, 0.8, 0.25 * gain, place, 2.5, 0.4);
    this.tone('sine', 2600, 1300, 0.45, 0.06 * gain, place, 0, 0.4);
    for (let i = 0; i < 4; i++) this.noise(0.015, 'bandpass', 6000, 3, 0.2 * gain, place, 1.2, 0.3, 0.05 + Math.random() * 0.3);
  }

  fireBurst(at?: Vec): void {
    const { gain, place } = this.spatial(at, 80);
    if (gain <= 0.01) return;
    this.noise(0.4, 'lowpass', 900, 0.7, 0.4 * gain, place, 2.6, 0.3, 0, 300);
    this.tone('sine', 110, 50, 0.3, 0.2 * gain, place);
  }

  /** One tick of a flamethrower; at fifteen a second it becomes a roar. */
  flameTick(): void {
    this.noise(0.07, 'bandpass', 500 + Math.random() * 400, 0.6, 0.12, 0.1, 1.8);
  }

  /** A boss announcing itself: a huge growl over a sub-bass swell. */
  bossRoar(at?: Vec, pitch = 0.5): void {
    const where = at ?? this.listener;
    this.zombieVoice(where, 'growl', pitch);
    this.zombieVoice(where, 'moan', pitch * 0.8);
    const { gain, place } = this.spatial(at, 200);
    this.tone('sine', 70, 38, 1.6, 0.35 * Math.max(0.3, gain), place, 0, 0.5);
    this.noise(1.2, 'lowpass', 300, 0.7, 0.2 * Math.max(0.3, gain), place, 3, 0.5);
  }

  /** A boss hitting the floor. */
  slam(at?: Vec): void {
    const { gain, place } = this.spatial(at, 120);
    if (gain <= 0.01) return;
    this.noise(0.35, 'lowpass', 400, 0.8, 0.8 * gain, place, 3, 0.4);
    this.tone('sine', 90, 26, 0.7, 0.6 * gain, place, 0, 0.3);
    this.noise(0.15, 'bandpass', 1400, 1, 0.25 * gain, place, 2, 0.3, 0.02);
  }

  /** A valve wheel spun open: a squeal of metal, a clunk and a rush of steam. */
  valve(at?: Vec): void {
    const { gain, place } = this.spatial(at, 70);
    if (gain <= 0.01) return;
    this.tone('sawtooth', 380, 520, 0.35, 0.05 * gain, place, 0, 0.3);
    this.noise(0.06, 'lowpass', 900, 1, 0.4 * gain, place, 2, 0.3, 0.3);
    this.tone('square', 140, 80, 0.1, 0.14 * gain, place, 0.3);
    this.noise(0.9, 'highpass', 2600, 0.6, 0.16 * gain, place, 2.6, 0.4, 0.35, 5200);
  }

  /** Pressure gone: every valve slamming shut at once, and the steam dying away. */
  steam(): void {
    for (let i = 0; i < 3; i++) this.noise(0.06, 'lowpass', 700, 1, 0.3, (i - 1) * 0.5, 2, 0.4, i * 0.12);
    this.noise(1.1, 'highpass', 3000, 0.6, 0.14, 0, 3, 0.4, 0.1, 900);
  }

  /** A soul flying into the station: a whoosh that rises as it goes. */
  soul(at?: Vec): void {
    const { gain, place } = this.spatial(at, 70);
    if (gain <= 0.01) return;
    this.noise(0.35, 'bandpass', 500, 2.5, 0.16 * gain, place, 2, 0.4, 0, 2400);
    this.tone('sine', 300, 900, 0.4, 0.05 * gain, place, 0.05, 0.4);
  }

  /** One second of the valve clock running out; the last few are sharper. */
  countdown(urgent: boolean): void {
    this.tone('square', urgent ? 1320 : 990, urgent ? 1320 : 990, 0.07, urgent ? 0.1 : 0.07, 0);
  }

  /** Radio traffic: a squelch, two pips and a hiss of static. */
  radio(): void {
    this.noise(0.12, 'bandpass', 2200, 1.5, 0.12, 0, 2, 0.1);
    this.tone('square', 1200, 1200, 0.06, 0.05, 0, 0.12);
    this.tone('square', 1600, 1600, 0.06, 0.05, 0, 0.22);
    this.noise(0.5, 'bandpass', 3000, 0.6, 0.04, 0, 2.5, 0, 0.3);
  }

  pickup(): void {
    this.arpeggio([784, 988, 1175, 1568], 0.05, 0.12, 'triangle');
  }

  objective(): void {
    this.tone('triangle', 659, 659, 0.25, 0.12, 0, 0, 0.3);
    this.tone('triangle', 988, 988, 0.4, 0.12, 0, 0.14, 0.3);
  }

  /** The swell when a chapter is done. */
  victory(): void {
    const chords = [[262, 330, 392], [349, 440, 523], [392, 494, 587], [523, 659, 784, 1047]];
    chords.forEach((c, i) => {
      for (const f of c) this.tone('sawtooth', f, f, 0.9, 0.05, 0, i * 0.55, 0.5);
      for (const f of c) this.tone('sine', f / 2, f / 2, 0.9, 0.06, 0, i * 0.55, 0.5);
    });
  }

  /* ---------------------------------------------------------------- music */

  /** Starts the soundtrack in its between-rounds breakdown. */
  startMusic(): void {
    if (!this.ctx || !this.musicBus || !this.noiseBuffer) return;
    this.music ??= new ArcadeMusic(this.ctx, this.musicBus, this.noiseBuffer);
    this.music.start();
  }

  stopMusic(): void {
    this.music?.stop();
  }

  /** Between rounds, or into the fight. The music changes at its next bar line. */
  musicCue(cue: MusicCue): void {
    this.music?.cue(cue);
  }

  /** Keeps the soundtrack scheduled; intensity (0..1) sets its tempo and drive. */
  updateMusic(dt: number, intensity: number): void {
    if (!this.music) return;
    this.musicIntensity += (intensity - this.musicIntensity) * Math.min(1, dt * 0.5);
    this.music.update(this.musicIntensity);
  }

  /** Where the soundtrack is. Used by the smoke test. */
  get musicPosition(): { section: string; bar: number; bpm: number; level: number } | null {
    return this.music?.playing ? this.music.position : null;
  }

  /** How many zombie voices are sounding right now. Used by the smoke test. */
  get activeVoices(): number {
    const now = this.t;
    return this.voices.filter((v) => v.end > now).length;
  }
}

export const audio = new AudioEngine();
