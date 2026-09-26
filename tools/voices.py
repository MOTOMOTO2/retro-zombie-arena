"""
Bakes the voice lines in src/core/voicelines.json into public/voice/*.mp3.

The lines are spoken by Chatterbox (https://github.com/resemble-ai/chatterbox,
MIT licence), an open neural text-to-speech model with a dial for how much
emotion goes into a line, run locally on the GPU. Each speaker's voice comes
from a short reference clip in tools/voice-refs/. Those are synthetic voices
spoken by Kokoro (see --make-refs), so no real person's voice is cloned.

A hot take can mumble, swallow a word or add one, so every line is generated
several times with the emotion dial and the guidance nudged about. Each take is
transcribed with Whisper and thrown away unless it says the line, and of the
takes that pass the liveliest is kept: the one whose pitch moves the most
(measured with Praat), which is most of what makes a voice sound excited
rather than read out - short of cracking or squawking, which counts against it.

Setup (Python 3.11 and an NVIDIA GPU; about 6 GB of downloads, all kept in
tools/.voicegen/):

    py -3.11 -m venv tools/.voicegen/env
    tools/.voicegen/env/Scripts/python -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
    tools/.voicegen/env/Scripts/python -m pip install chatterbox-tts openai-whisper soundfile praat-parselmouth

Then:

    tools/.voicegen/env/Scripts/python tools/voices.py                 # bake lines that are missing
    tools/.voicegen/env/Scripts/python tools/voices.py --force         # re-bake everything
    tools/.voicegen/env/Scripts/python tools/voices.py --only player.teddy announcer.nuke
    tools/.voicegen/env/Scripts/python tools/voices.py --only player.teddy --seed 2 --takes 10   # a fresh roll
"""

import argparse
import difflib
import json
import os
import re
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LINES = ROOT / "src" / "core" / "voicelines.json"
OUT = ROOT / "public" / "voice"
REFS = ROOT / "tools" / "voice-refs"
CACHE = ROOT / "tools" / ".voicegen"

# Kokoro reads these to make the reference voices (--make-refs).
REF_SCRIPTS = {
    "player": ("am_michael", 1.05, "Alright, listen up! We are getting out of here, and nobody gets left behind. "
                                   "Grab whatever you can carry, keep your head down, and stay close to me. Ready? Let's go!"),
    "announcer": ("am_onyx", 0.9, "Ladies and gentlemen, welcome to the arena! Tonight, only one of you walks out alive. "
                                  "Are you ready? Then let the games begin!"),
}

TAKES = 6
MAX_TAKES = 12
# Each take nudges the emotion dial and the guidance; lower guidance lets the delivery run freer.
NUDGES = [(0.0, 0.3), (0.1, 0.3), (-0.1, 0.4), (0.2, 0.3), (0.05, 0.4), (0.15, 0.35)]


def letters(text: str) -> str:
    return re.sub(r"[^a-z]", "", text.lower())


def says(heard: str, text: str) -> float:
    """How closely a transcript matches the line, 0..1, ignoring case, spacing and punctuation."""
    return difflib.SequenceMatcher(None, letters(heard), letters(text)).ratio()


def trim(samples, rate):
    import numpy as np
    level = np.abs(samples)
    loud = np.flatnonzero(level > level.max() * 0.02)
    if loud.size:
        pad = int(rate * 0.03)
        samples = samples[max(0, loud[0] - pad): loud[-1] + pad * 3]
    return samples


def clean(samples, rate):
    """Trims the silence either side, fades the ends and normalises to -1 dBFS."""
    import numpy as np
    samples = trim(np.asarray(samples, dtype=np.float32), rate).copy()
    fade = min(len(samples) // 4, int(rate * 0.012))
    if fade:
        ramp = np.linspace(0, 1, fade, dtype=np.float32)
        samples[:fade] *= ramp
        samples[-fade:] *= ramp[::-1]
    peak = np.abs(samples).max()
    return samples * (0.89 / peak) if peak > 0 else samples


def prosody(samples, rate):
    """Median pitch (Hz), its spread in semitones (10th to 90th percentile), and how often it cracks."""
    import numpy as np
    import parselmouth
    snd = parselmouth.Sound(np.asarray(samples, dtype=np.float64), sampling_frequency=rate)
    pitch = snd.to_pitch_ac(time_step=0.01, pitch_floor=65, pitch_ceiling=450, octave_jump_cost=0.6, voicing_threshold=0.5)
    f0 = pitch.selected_array["frequency"]
    voiced = f0[f0 > 0]
    if len(voiced) < 5:
        return 0.0, 0.0, 1.0
    st = 12 * np.log2(voiced / np.median(voiced))
    # Leaps of more than five semitones between neighbouring voiced frames are cracks and squeaks, not intonation.
    both = (f0[1:] > 0) & (f0[:-1] > 0)
    leaps = np.abs(12 * np.log2(f0[1:][both] / f0[:-1][both])) > 5 if both.any() else np.array([0.0])
    return float(np.median(voiced)), float(np.percentile(st, 90) - np.percentile(st, 10)), float(np.mean(leaps))


def liveliness(samples, rate, home: float) -> float:
    """
    How excited a take sounds, as a score: the more the pitch moves the better,
    up to about sixteen semitones - past that it is a squawk, not a voice -
    less for every crack, and less for going up into falsetto from the
    speaker's usual pitch (`home`, in Hz).
    """
    median, spread, cracks = prosody(samples, rate)
    score = min(spread, 16.0) - max(0.0, spread - 16.0) * 1.5
    score -= cracks * 40
    score -= max(0.0, median / home - 1.6) * 20
    return score


def make_refs() -> None:
    """Speaks the reference voices with Kokoro. Needs `pip install kokoro-onnx` (numpy 2, so not in the Chatterbox env)."""
    import numpy as np
    import soundfile as sf
    from kokoro_onnx import Kokoro
    kdir = ROOT / "tools" / ".kokoro"
    kokoro = Kokoro(str(kdir / "kokoro-v1.0.onnx"), str(kdir / "voices-v1.0.bin"))
    REFS.mkdir(parents=True, exist_ok=True)
    for name, (voice, speed, text) in REF_SCRIPTS.items():
        s, rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
        s = np.asarray(s)
        sf.write(REFS / f"{name}.flac", s / np.abs(s).max() * 0.89, rate)
        print(f"wrote {name}.flac ({voice})")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="re-bake lines that already exist")
    ap.add_argument("--only", nargs="*", default=[], help="speaker.event pairs to bake, e.g. player.teddy")
    ap.add_argument("--make-refs", action="store_true", help="speak the reference voices with Kokoro and stop")
    ap.add_argument("--takes", type=int, default=TAKES, help=f"takes to choose between for each line (default {TAKES})")
    ap.add_argument("--seed", type=int, default=0, help="change it to get a fresh set of takes for a line you do not like")
    args = ap.parse_args()

    if args.make_refs:
        make_refs()
        return 0

    os.environ.setdefault("HF_HOME", str(CACHE / "hf"))
    import numpy as np
    import soundfile as sf
    import torch
    import whisper
    from chatterbox.tts import ChatterboxTTS

    speakers = json.loads(LINES.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    wanted = {}
    for speaker, spec in speakers.items():
        for event, texts in spec["lines"].items():
            for n, text in enumerate(texts):
                wanted[f"{speaker}-{event}-{n}.mp3"] = (speaker, event, text)

    todo = []
    for name, (speaker, event, text) in wanted.items():
        if args.only and f"{speaker}.{event}" not in args.only:
            continue
        if (OUT / name).exists() and not args.force and not args.only:
            continue
        todo.append((name, speaker, event, text))

    if todo:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = ChatterboxTTS.from_pretrained(device=device)
        ear = whisper.load_model("small.en", device=device, download_root=str(CACHE / "whisper"))
        rate = model.sr

    loaded = None
    for name, speaker, event, text in todo:
        spec = speakers[speaker]
        if loaded != speaker:
            ref = REFS / f"{spec['voice']}.flac"
            model.prepare_conditionals(str(ref), exaggeration=spec["exaggeration"])
            ref_samples, ref_rate = sf.read(ref, dtype="float32")
            home = prosody(ref_samples, ref_rate)[0]
            loaded = speaker
        best = None
        fallback = None
        for i in range(max(MAX_TAKES, args.takes)):
            if i >= args.takes and best is not None:
                break
            nudge, cfg = NUDGES[i % len(NUDGES)]
            torch.manual_seed(zlib.crc32(f"{name}/{i}/{args.seed}".encode()))
            wav = model.generate(text, exaggeration=spec["exaggeration"] + nudge, cfg_weight=cfg, temperature=0.8)
            samples = trim(wav.squeeze(0).cpu().numpy().astype(np.float32), rate)
            seconds = len(samples) / rate
            # Much longer than the words need means it wandered off or hung on a pause.
            if seconds > len(text) / 6 + 0.9 or seconds < 0.25:
                continue
            heard = ear.transcribe(
                _to16k(samples, rate), language="en", fp16=device == "cuda", temperature=0,
                condition_on_previous_text=False,
            )["text"].strip()
            match = says(heard, text)
            take = {"samples": samples, "heard": heard, "match": match, "lively": 0.0, "nudge": nudge, "cfg": cfg}
            if fallback is None or match > fallback["match"]:
                fallback = take
            if match < 0.92:
                continue
            take["lively"] = liveliness(samples, rate, home)
            if best is None or take["lively"] > best["lively"]:
                best = take
        pick = best or fallback
        if pick is None:
            print(f"!! {name}: no usable take", file=sys.stderr)
            continue
        old = ""
        if (OUT / name).exists():
            prev, prev_rate = sf.read(OUT / name, dtype="float32")
            old = f"  (was {liveliness(prev, prev_rate, home):5.1f})"
        sf.write(OUT / name, clean(pick["samples"], rate), rate, format="MP3", subtype="MPEG_LAYER_III", compression_level=0.35)
        flag = "" if best else "  !! best effort, check it"
        print(f"{name:32} lively {pick['lively']:5.1f}{old}  heard {pick['heard']!r}{flag}")

    stale = [p for p in OUT.glob("*.mp3") if p.name not in wanted]
    for p in stale:
        p.unlink()
        print(f"removed {p.name}")
    print(f"{len(todo)} baked, {len(wanted)} lines in all")
    return 0


def _to16k(samples, rate):
    """Whisper listens at 16 kHz."""
    import librosa
    return librosa.resample(samples, orig_sr=rate, target_sr=16000)


if __name__ == "__main__":
    sys.exit(main())
