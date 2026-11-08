"""Synthesise the game's sound effects (16-bit mono WAV, 22.05 kHz). Run: python tools/make-sounds.py"""
import math, random, struct, wave, pathlib

RATE = 22050
OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "assets" / "sounds"
random.seed(22)


def write(name, samples):
    OUT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT / name), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32000)) for s in samples))


def env(i, n, attack=0.005, power=2.0):
    t = i / RATE
    a = min(1.0, t / attack) if attack else 1.0
    return a * (1 - i / n) ** power


def shoot():  # machine-gun "tak": noise click + low thump
    n = int(0.11 * RATE)
    return [env(i, n, 0.001, 3) * (0.6 * random.uniform(-1, 1) + 0.5 * math.sin(2 * math.pi * 140 * i / RATE)) for i in range(n)]


def hit():  # metallic clank
    n = int(0.18 * RATE)
    return [env(i, n, 0.001, 2.5) * (0.5 * math.sin(2 * math.pi * 820 * i / RATE) + 0.3 * math.sin(2 * math.pi * 1270 * i / RATE) + 0.3 * random.uniform(-1, 1)) for i in range(n)]


def explosion():  # low-passed noise with a long tail
    n = int(0.9 * RATE); out = []; y = 0.0
    for i in range(n):
        k = 0.02 + 0.2 * (1 - i / n)
        y += k * (random.uniform(-1, 1) - y)
        out.append(3.2 * y * env(i, n, 0.004, 1.6))
    return out


def pickup():  # rising three-note arpeggio
    out = []
    for f in (523.25, 659.25, 783.99):
        n = int(0.09 * RATE)
        out += [0.45 * env(i, n, 0.003, 1.2) * math.sin(2 * math.pi * f * i / RATE) for i in range(n)]
    return out


for name, fn in {"shoot.wav": shoot, "hit.wav": hit, "explosion.wav": explosion, "pickup.wav": pickup}.items():
    write(name, fn())
    print("wrote", name)
