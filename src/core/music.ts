/**
 * The soundtrack: a spooky arcade chiptune, sequenced and synthesised live.
 *
 * Four channels, the way the sound chips of the era had them: a pulse-wave
 * lead with a little slide and vibrato and a dotted-eighth echo, a bouncing
 * triangle bass with a buzzy square under it, a thin fast arpeggio spelling out
 * the chords, and a noise-and-sine drum kit. It is written in A minor with the
 * raised seventh (the E major chord) that gives the old horror platformers their
 * menace, and runs through seven four-bar sections before it loops.
 *
 * It follows the game. The intensity it is given (round and horde size) sets
 * the tempo, from a stroll at 126 BPM to a sprint at 160, and how hard the
 * drums hit; between rounds it drops to the breakdown, and the next round
 * kicks back in at the top of the tune. Changes wait for the bar line, so they
 * always land on the beat.
 *
 * Notes are scheduled a fraction of a second ahead on the audio clock, not on
 * frame timing, so a dropped frame never makes it stumble.
 */

type Chord = { root: number; minor: boolean };
type Note = { midi: number; len: number };
type BassStyle = 'octave' | 'drive' | 'gallop' | 'pulse';

type Section = {
  name: string;
  /** One chord a bar; the root is the bass note, in MIDI. */
  chords: Chord[];
  lead: (Note | null)[][];
  leadLevel: number;
  bass: BassStyle;
  arp: boolean;
  /** Added to the drum level the intensity asks for. */
  drums: number;
  crash: boolean;
};

export type MusicCue = 'calm' | 'fight';

const LOOKAHEAD = 0.18;
const STEPS = 16;
const BARS = 4;

const NOTE_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function midi(name: string): number {
  const m = /^([A-G])([#b]?)(\d)$/.exec(name);
  if (!m) throw new Error(`bad note "${name}"`);
  return 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

const hz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/**
 * A tune written out a sixteenth at a time, bars split by "|": a note starts
 * on its step, "-" holds the one before, "." is silence.
 */
function melody(src: string): (Note | null)[][] {
  return src.split('|').map((bar) => {
    const tokens = bar.trim().split(/\s+/);
    if (tokens.length !== STEPS) throw new Error(`a bar needs ${STEPS} steps: "${bar.trim()}"`);
    const steps: (Note | null)[] = new Array<Note | null>(STEPS).fill(null);
    let open: Note | null = null;
    for (let i = 0; i < STEPS; i++) {
      const tok = tokens[i];
      if (tok === '-') {
        if (open) open.len++;
        continue;
      }
      open = tok === '.' ? null : { midi: midi(tok), len: 1 };
      steps[i] = open;
    }
    return steps;
  });
}

const Am: Chord = { root: 45, minor: true };
const Dm: Chord = { root: 38, minor: true };
const E: Chord = { root: 40, minor: false };
const F: Chord = { root: 41, minor: false };
const G: Chord = { root: 43, minor: false };
const Bb: Chord = { root: 46, minor: false };

// The hook, twice: the second time it climbs back up instead of hanging on E.
const HOOK_1 = 'A4 - A4 - E5 - - - D5 - C5 - B4 - C5 - | A4 - A4 - F5 - - - E5 - D5 - C5 - D5 -';
const HOOK_2 = 'F5 - - - E5 - D5 - A5 - - - - - F5 - | E5 - - - - - C5 - A4 - - - C5 - E5 -';
const RIFF = 'A5 . A5 . G5 . F5 . E5 . F5 . C5 - - - | B5 . B5 . A5 . G5 . F5 . G5 . D5 - - -';

const SONG: Section[] = [
  {
    name: 'A', chords: [Am, F, G, E], leadLevel: 1, bass: 'octave', arp: false, drums: 0, crash: true,
    lead: melody(`${HOOK_1} | B4 - B4 - G5 - - - F5 - E5 - D5 - B4 - | G#4 - B4 - E5 - - - G#5 - - - E5 - . .`),
  },
  {
    name: 'A2', chords: [Am, F, G, E], leadLevel: 1, bass: 'octave', arp: false, drums: 0, crash: false,
    lead: melody(`${HOOK_1} | E5 - D5 - C5 - D5 - B4 - G4 - B4 - D5 - | E5 - - - B4 - - - G#4 - - - B4 - D5 -`),
  },
  {
    name: 'B', chords: [Dm, Am, Bb, E], leadLevel: 1, bass: 'drive', arp: true, drums: 0, crash: true,
    lead: melody(`${HOOK_2} | D5 - - - F5 - - - Bb5 - - - A5 - F5 - | G#5 - - - - - - - B5 - A5 - G#5 - E5 -`),
  },
  {
    name: 'B2', chords: [Dm, Am, Bb, E], leadLevel: 1, bass: 'drive', arp: true, drums: 0, crash: false,
    lead: melody(`${HOOK_2} | F5 - - - Bb5 - - - D6 - - - C6 - Bb5 - | B5 - - - G#5 - - - E5 - - - D5 - B4 -`),
  },
  {
    name: 'D', chords: [F, G, Am, Am], leadLevel: 0.9, bass: 'gallop', arp: false, drums: 0, crash: true,
    lead: melody(`${RIFF} | C6 . B5 . A5 . E5 . C5 . E5 . A5 . C6 . | B5 - - - A5 - - - . . . . . . . .`),
  },
  {
    name: 'D2', chords: [F, G, E, E], leadLevel: 0.9, bass: 'gallop', arp: false, drums: 0, crash: false,
    lead: melody(`${RIFF} | B5 . G#5 . E5 . G#5 . B5 . E6 . D6 . B5 . | G#5 - - - - - - - B4 - D5 - E5 - G#5 -`),
  },
  {
    // The breakdown: long notes ringing into the echo over the arpeggio.
    name: 'C', chords: [Am, Am, F, E], leadLevel: 0.7, bass: 'pulse', arp: true, drums: -1, crash: false,
    lead: melody(
      'A5 - - - - - - - . . . . E5 - - - | C6 - - - - - - - B5 - - - A5 - - - | ' +
      'A5 - - - - - - - . . . . C6 - - - | B5 - - - - - - - G#5 - - - E5 - - -',
    ),
  },
];

const CALM = SONG.length - 1;

/** Per sixteenth: which interval above the chord root the bass plays, and for how many steps. */
const BASS: Record<BassStyle, ({ off: number; len: number } | null)[]> = {
  octave: steps([0, 12, 0, 12, 0, 12, 0, 12].map((off, i) => [i * 2, off, 2])),
  drive: steps([0, 0, 12, 0, 0, 12, 7, 12].map((off, i) => [i * 2, off, 2])),
  gallop: steps([0, 1, 2, 3].flatMap((b) => [[b * 4, 0, 2], [b * 4 + 2, 0, 1], [b * 4 + 3, b === 3 ? 12 : 0, 1]])),
  pulse: steps([0, 0, 12, 0].map((off, i) => [i * 4, off, 3])),
};

function steps(notes: number[][]): ({ off: number; len: number } | null)[] {
  const out = new Array<{ off: number; len: number } | null>(STEPS).fill(null);
  for (const [step, off, len] of notes) out[step] = { off, len };
  return out;
}

const MINOR = [0, 3, 7, 12];
const MAJOR = [0, 4, 7, 12];

// Drum patterns by level: 0 is a light pulse, 2 is flat out.
const KICK = ['x.......x.......', 'x.......x.x.....', 'x..x....x.x..x..'];
const SNARE = ['................', '....x.......x...', '....x.......x...'];
const HAT = ['..x...x...x...x.', 'x.x.x.x.x.x.x.x.', 'xxxxxxxxxxxxxxxx'];
const OPEN = ['................', '..............o.', '......o.......o.'];
/** The last bar of a section rolls into the next one. */
const FILL = ['................', '............xxxx', '........x.x.xxxx'];

/** A pulse wave of the given duty cycle - the sound chips' bread and butter. */
function pulseWave(ctx: BaseAudioContext, duty: number): PeriodicWave {
  const n = 40;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let k = 1; k < n; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
  return ctx.createPeriodicWave(real, imag);
}

export class ArcadeMusic {
  private readonly pulse25: PeriodicWave;
  private readonly pulse12: PeriodicWave;
  private bus: GainNode | null = null;
  private leadBus: GainNode | null = null;
  private bassTone: BiquadFilterNode | null = null;
  private echo: DelayNode | null = null;

  private section = CALM;
  private bar = 0;
  private step = 0;
  private next = 0;
  private stepDur = 60 / 126 / 4;
  private level = 0;
  private calm = true;
  private cued: MusicCue | null = null;
  private crashNext = false;

  private readonly ctx: AudioContext;
  private readonly out: AudioNode;
  private readonly noise: AudioBuffer;

  constructor(ctx: AudioContext, out: AudioNode, noise: AudioBuffer) {
    this.ctx = ctx;
    this.out = out;
    this.noise = noise;
    this.pulse25 = pulseWave(ctx, 0.25);
    this.pulse12 = pulseWave(ctx, 0.125);
  }

  get playing(): boolean {
    return this.bus !== null;
  }

  /** Where the tune is, for the smoke test and anyone curious. */
  get position(): { section: string; bar: number; bpm: number; level: number } {
    return { section: SONG[this.section].name, bar: this.bar, bpm: Math.round(15 / this.stepDur), level: this.level };
  }

  /** Starts from the breakdown; the first round cues the tune proper. */
  start(): void {
    if (this.bus) {
      this.cue('calm');
      return;
    }
    const ctx = this.ctx;
    this.bus = ctx.createGain();
    this.bus.connect(this.out);

    // The lead goes out dry and into a dotted-eighth echo that darkens as it repeats.
    this.leadBus = ctx.createGain();
    this.leadBus.connect(this.bus);
    this.echo = ctx.createDelay(1.5);
    this.echo.delayTime.value = this.stepDur * 3;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const dark = ctx.createBiquadFilter();
    dark.type = 'lowpass';
    dark.frequency.value = 2400;
    const wet = ctx.createGain();
    wet.gain.value = 0.26;
    this.leadBus.connect(this.echo);
    this.echo.connect(dark);
    dark.connect(feedback);
    feedback.connect(this.echo);
    dark.connect(wet);
    wet.connect(this.bus);

    this.bassTone = ctx.createBiquadFilter();
    this.bassTone.type = 'lowpass';
    this.bassTone.frequency.value = 900;
    this.bassTone.connect(this.bus);

    this.section = CALM;
    this.calm = true;
    this.cued = null;
    this.bar = 0;
    this.step = 0;
    this.next = ctx.currentTime + 0.08;
  }

  stop(): void {
    if (!this.bus) return;
    // Whatever is already scheduled plays out into a closing fader.
    this.bus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.06);
    const bus = this.bus;
    window.setTimeout(() => bus.disconnect(), 1500);
    this.bus = this.leadBus = this.bassTone = this.echo = null;
  }

  /** Between rounds, or back into the fight. Takes effect at the next bar line. */
  cue(cue: MusicCue): void {
    this.cued = cue;
  }

  /** Schedules everything due in the next moment. Call it every frame. */
  update(intensity: number): void {
    if (!this.bus) return;
    const now = this.ctx.currentTime;
    // Nothing was scheduled for a while (paused, or the tab was hidden): carry on from here.
    if (this.next < now) this.next = now + 0.05;
    while (this.next < now + LOOKAHEAD) {
      if (this.step === 0) this.startBar(intensity);
      this.play(this.next);
      this.next += this.stepDur;
      if (++this.step === STEPS) {
        this.step = 0;
        this.bar++;
      }
    }
  }

  private startBar(intensity: number): void {
    if (this.cued) {
      this.calm = this.cued === 'calm';
      // Into the fight from the top, with a crash; into the calm unless already there.
      if (!this.calm || this.section !== CALM) {
        this.section = this.calm ? CALM : 0;
        this.bar = 0;
        this.crashNext = !this.calm;
      }
      this.cued = null;
    }
    if (this.bar >= BARS) {
      this.bar = 0;
      this.section = this.calm ? CALM : (this.section + 1) % SONG.length;
    }
    const bpm = 126 + 34 * Math.max(0, Math.min(1, intensity));
    this.stepDur = 60 / bpm / 4;
    const base = intensity < 0.12 ? 0 : intensity < 0.45 ? 1 : 2;
    this.level = Math.max(-1, Math.min(2, base + SONG[this.section].drums));
    this.echo?.delayTime.setTargetAtTime(this.stepDur * 3, this.next, 0.05);
  }

  private play(t: number): void {
    const sec = SONG[this.section];
    const s = this.step;
    const chord = sec.chords[this.bar];

    const note = sec.lead[this.bar][s];
    if (note) this.lead(t, note.midi, note.len, sec.leadLevel);

    const b = BASS[sec.bass][s];
    if (b) this.bass(t, chord.root + b.off, b.len);

    if (sec.arp || this.level >= 2) {
      const tones = chord.minor ? MINOR : MAJOR;
      this.arp(t, chord.root + 24 + tones[s % 4]);
    }

    const lv = this.level;
    if (s === 0 && this.bar === 0 && (this.crashNext || (sec.crash && lv >= 1))) {
      this.crash(t);
      this.crashNext = false;
    }
    if (lv < 0) {
      // Between rounds: just a heartbeat of a kick and a ticking hat.
      if (s === 0 || s === 8) this.kick(t, 0.5);
      if (s % 4 === 2) this.hat(t, false, 0.6);
      return;
    }
    if (KICK[lv][s] === 'x') this.kick(t, 1);
    const fill = this.bar === BARS - 1 && FILL[lv][s] === 'x';
    if (SNARE[lv][s] === 'x' || fill) this.snare(t, fill && s > 12 ? 0.8 : 1);
    if (OPEN[lv][s] === 'o') this.hat(t, true, 1);
    else if (HAT[lv][s] === 'x') this.hat(t, false, s % 4 === 0 ? 1 : s % 2 === 0 ? 0.75 : 0.5);
  }

  /* ---------------------------------------------------------- instruments */

  /** One enveloped oscillator: a fast attack, a decay to the sustain, and a release at the end. */
  private voice(
    wave: OscillatorType | PeriodicWave, freq: number, t: number, dur: number, peak: number,
    out: AudioNode, sustain: number, decay: number, release = 0.04,
  ): OscillatorNode {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    if (wave instanceof PeriodicWave) o.setPeriodicWave(wave);
    else o.type = wave;
    o.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.004);
    g.gain.setTargetAtTime(peak * sustain, t + 0.004, decay / 3);
    g.gain.setTargetAtTime(0, t + dur, release / 3);
    o.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + dur + release * 2 + 0.02);
    return o;
  }

  private lead(t: number, m: number, len: number, level: number): void {
    if (!this.leadBus) return;
    const dur = len * this.stepDur * 0.9;
    // High notes on a pulse wave get piercing; ease them back a little.
    const peak = 0.085 * level * (m > 76 ? 0.8 : 1);
    const o = this.voice(this.pulse25, hz(m), t, dur, peak, this.leadBus, 0.7, 0.12, 0.05);
    // A little scoop up into the note.
    o.detune.setValueAtTime(-35, t);
    o.detune.linearRampToValueAtTime(0, t + 0.035);
    if (dur > 0.24) {
      // Held notes get a delayed vibrato.
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 5.8;
      const depth = this.ctx.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(0, t + 0.14);
      depth.gain.linearRampToValueAtTime(16, t + 0.34);
      lfo.connect(depth);
      depth.connect(o.detune);
      lfo.start(t);
      lfo.stop(t + dur + 0.12);
    }
    // Flat out, the lead doubles an octave up on a thinner wave.
    if (this.level >= 2) this.voice(this.pulse12, hz(m + 12), t, dur, peak * 0.3, this.leadBus, 0.6, 0.1, 0.05);
  }

  private bass(t: number, m: number, len: number): void {
    if (!this.bus || !this.bassTone) return;
    const dur = len * this.stepDur * 0.78;
    this.voice('triangle', hz(m), t, dur, 0.3, this.bus, 0.85, 0.1, 0.03);
    this.voice('square', hz(m), t, dur, 0.055, this.bassTone, 0.5, 0.08, 0.03);
  }

  private arp(t: number, m: number): void {
    if (!this.bus) return;
    this.voice(this.pulse12, hz(m), t, this.stepDur * 0.55, 0.032, this.bus, 0.5, 0.05, 0.02);
  }

  private hit(t: number, type: BiquadFilterType, freq: number, peak: number, decay: number): void {
    if (!this.bus) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + decay);
    src.connect(f);
    f.connect(g);
    g.connect(this.bus);
    src.start(t, Math.random() * 0.8);
    src.stop(t + decay + 0.02);
  }

  private kick(t: number, level: number): void {
    if (!this.bus) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.62 * level, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g);
    g.connect(this.bus);
    o.start(t);
    o.stop(t + 0.26);
    this.hit(t, 'highpass', 3000, 0.07 * level, 0.012);
  }

  private snare(t: number, level: number): void {
    if (!this.bus) return;
    this.hit(t, 'highpass', 1300, 0.24 * level, 0.14);
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16 * level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(g);
    g.connect(this.bus);
    o.start(t);
    o.stop(t + 0.1);
  }

  private hat(t: number, open: boolean, level: number): void {
    this.hit(t, 'highpass', 7500, (open ? 0.05 : 0.055) * level, open ? 0.2 : 0.035);
  }

  private crash(t: number): void {
    this.hit(t, 'highpass', 4500, 0.075, 1.3);
  }
}
