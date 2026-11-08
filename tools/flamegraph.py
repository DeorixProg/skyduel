"""Aggregated flame graph from a Chrome .cpuprofile: identical stacks merged,
width = total time over the whole recording, (idle)/(program) excluded.

Usage: python tools/flamegraph.py <cpu.cpuprofile> <out.png> [title]
"""
import json
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

src, out = sys.argv[1], sys.argv[2]
title = sys.argv[3] if len(sys.argv) > 3 else src
prof = json.load(open(src, encoding="utf-8"))
nodes = {n["id"]: n for n in prof["nodes"]}
parent = {c: n["id"] for n in prof["nodes"] for c in n.get("children", [])}
SKIP = {"(root)", "(idle)", "(program)"}


def path(node_id):
    s = []
    while node_id is not None:
        nm = nodes[node_id]["callFrame"]["functionName"] or "(anonymous)"
        if nm != "(root)":
            s.append(nm)
        node_id = parent.get(node_id)
    return tuple(reversed(s))


tree = {}  # path → ms
for sid, dt in zip(prof["samples"], prof["timeDeltas"]):
    p = path(sid)
    if not p or p[0] in SKIP:
        continue
    for i in range(1, len(p) + 1):
        tree[p[:i]] = tree.get(p[:i], 0.0) + dt / 1000.0

total = sum(v for k, v in tree.items() if len(k) == 1)
fig, ax = plt.subplots(figsize=(13, 5), dpi=110)
NATIVE = {"fillText", "fillRect", "drawImage", "arc", "fill", "measureText", "requestAnimationFrame", "stroke", "save", "restore", "beginPath", "set"}


def color(nm):
    if "garbage" in nm:
        return "#c0392b"
    if nm in NATIVE:
        return "#e59866"
    return "#5d9bd5"


def draw(prefix, x0, depth):
    kids = sorted((k for k in tree if len(k) == len(prefix) + 1 and k[: len(prefix)] == prefix), key=lambda k: -tree[k])
    x = x0
    for k in kids:
        w = tree[k]
        ax.add_patch(plt.Rectangle((x, depth), w, 0.92, color=color(k[-1]), ec="white", lw=0.4))
        if w > total / 60:
            ax.text(x + w / 2, depth + 0.46, f"{k[-1]} {w:.0f}", ha="center", va="center", fontsize=6.5, clip_on=True)
        if depth < 14:
            draw(k, x, depth + 1)
        x += w


draw((), 0.0, 0)
ax.set_xlim(0, total)
ax.set_ylim(15, 0)
ax.set_xlabel(f"ms of CPU over the recording (busy time {total:.0f} ms; idle excluded)")
ax.set_yticks([])
ax.set_title(title, fontsize=10)
fig.tight_layout()
fig.savefig(out)
print("saved", out, f"busy {total:.0f} ms")
