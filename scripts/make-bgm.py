#!/usr/bin/env python3
"""make-bgm.py — 生成内置背景音乐（免版权，随本项目发布）

用 app.js 里已有的合成旋律（MUSIC_THEMES 的音符与和弦）离线渲染成 mp3，
音色比网页实时合成更饱满（三角波主旋律 + 正弦垫音 + 低音 + 简易混响），
体积控制在小文件（30 秒 / 单声道 / 72kbps ≈ 270KB）。

用法：
    python3 scripts/make-bgm.py            # 生成全部五套主题 BGM
    python3 scripts/make-bgm.py seaside    # 只生成指定主题

输出：assets/music/theme-<id>.mp3
依赖：python3（标准库）+ ffmpeg（转 mp3）
"""
import math
import os
import re
import struct
import subprocess
import sys
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_JS = os.path.join(ROOT, "app.js")
OUT_DIR = os.path.join(ROOT, "assets", "music")

SAMPLE_RATE = 22050
DURATION = 30.0  # 秒，循环长度
PEAK = 0.32  # 归一化峰值（留足动态余量）

# 五套主题 → 借用哪段内置旋律 + 移调（半音）
THEMES = [
    {"id": "seaside", "melody": "cover", "title": "海边暖沙", "transpose": 0, "tempo": 1.0},
    {"id": "forest", "melody": "craft", "title": "森林", "transpose": -2, "tempo": 0.95},
    {"id": "starry", "melody": "memory", "title": "星光夜", "transpose": -3, "tempo": 0.88},
    {"id": "newlywed", "melody": "resort", "title": "新婚燕尔", "transpose": 2, "tempo": 1.0},
    {"id": "christmas", "melody": "gift", "title": "圣诞颂歌", "transpose": 0, "tempo": 1.05},
]

NOTE_RE = re.compile(r"^([A-G])(sharp)?(-?\d)$")
SEMI = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def note_freq(name, transpose=0):
    m = NOTE_RE.match(name)
    if not m:
        return 0.0
    base = SEMI[m.group(1)] + (1 if m.group(2) else 0)
    octave = int(m.group(3))
    midi = (octave + 1) * 12 + base + transpose
    return 440.0 * (2 ** ((midi - 69) / 12.0))


def parse_themes():
    """从 app.js 抓取 MUSIC_THEMES 的音符/和弦/速度。"""
    src = open(APP_JS, encoding="utf-8").read()
    block = re.search(r"const MUSIC_THEMES = \{(.*?)\n\};", src, re.S)
    if not block:
        raise SystemExit("找不到 MUSIC_THEMES，请检查 app.js")
    body = block.group(1)
    themes = {}
    # 每个主题： id: { tempo: N, barBeats: N, chords: [[...]], notes: [[...]] }
    for m in re.finditer(r"\n  (\w+): \{(.*?)\n  \},", body, re.S):
        tid, chunk = m.group(1), m.group(2)
        tempo = re.search(r"tempo:\s*(\d+)", chunk)
        bar = re.search(r"barBeats:\s*(\d+)", chunk)
        chords = re.search(r"chords:\s*\[(.*?)\]", chunk, re.S)
        notes = re.search(r"notes:\s*\[(.*?)\],?\s*$", chunk, re.S)
        if not (tempo and chords and notes):
            continue
        chord_list = [
            re.findall(r'"([A-G](?:sharp)?\d)"', c)
            for c in re.findall(r"\[(.*?)\]", chords.group(1), re.S)
        ]
        note_list = [
            (n, float(b))
            for n, b in re.findall(r'\["([A-G](?:sharp)?\d)",\s*([\d.]+)\]', notes.group(1))
        ]
        themes[tid] = {
            "tempo": int(tempo.group(1)),
            "bar_beats": int(bar.group(1)) if bar else 4,
            "chords": chord_list,
            "notes": note_list,
        }
    return themes


def add_tone(buf, start, dur, note, amp, timbre="tri", transpose=0):
    """把一段音加到缓冲区（三角波近似 + 指数衰减包络）。note 为音名，如 C4 / Gsharp4。"""
    if amp <= 0:
        return
    f = note_freq(note, transpose)
    if f <= 0:
        return
    i0 = int(start * SAMPLE_RATE)
    n = int(dur * SAMPLE_RATE)
    if n <= 0:
        return
    attack = int(0.012 * SAMPLE_RATE)
    two_pi_f = 2 * math.pi * f / SAMPLE_RATE
    third = 3 * two_pi_f
    for i in range(n):
        idx = i0 + i
        if idx >= len(buf):
            break
        t = i / SAMPLE_RATE
        if i < attack:
            env = i / attack
        else:
            env = math.exp(-2.4 * (t - attack / SAMPLE_RATE))
            if env <= 0.0005:
                break
        s = math.sin(two_pi_f * i)
        if timbre == "tri":
            s += math.sin(third * i) / 9.0  # 让正弦更接近三角波的柔和感
        buf[idx] += amp * env * s


def render(theme_cfg, themes):
    src = themes[theme_cfg["melody"]]
    total = int(DURATION * SAMPLE_RATE)
    buf = [0.0] * total
    tr = theme_cfg["transpose"]
    beat = 60.0 / (src["tempo"] * theme_cfg["tempo"])

    # 1) 主旋律（循环铺满整首）
    pos = 0.0
    guard = 0
    while pos < DURATION - 0.2 and guard < 4000:
        for name, beats in src["notes"]:
            dur = max(0.18, beats * 0.55)
            add_tone(buf, pos, dur, name, 0.30, "tri", tr)
            pos += beats * beat
            guard += 1
            if pos >= DURATION - 0.2:
                break

    # 2) 垫音和弦（每小节一个，长音）
    bar_len = beat * src["bar_beats"]
    chords = src["chords"] or []
    if chords:
        k = 0
        t = 0.0
        while t < DURATION:
            chord = chords[k % len(chords)]
            for name in chord:
                add_tone(buf, t, bar_len * 1.15, name, 0.085, "sine", tr)
            # 低音：和弦根音低八度
            root = NOTE_RE.match(chord[0])
            if root:
                bass = root.group(1) + ("sharp" if root.group(2) else "") + str(int(root.group(3)) - 1)
                add_tone(buf, t, bar_len * 1.1, bass, 0.11, "sine", tr)
            t += bar_len
            k += 1

    # 3) 简易反馈混响（0.26s，衰减 0.22）
    delay = int(0.26 * SAMPLE_RATE)
    for i in range(delay, total):
        buf[i] += buf[i - delay] * 0.2

    # 4) 归一化 + 首尾淡入淡出（循环不爆音）
    peak = max((abs(v) for v in buf), default=0.0)
    if peak < 1e-4:
        raise SystemExit("生成的音频是静音（peak=%.6f），请检查旋律解析与合成参数" % peak)
    scale = PEAK / peak
    fade = int(0.25 * SAMPLE_RATE)
    frames = bytearray()
    for i, v in enumerate(buf):
        if i < fade:
            v *= i / fade
        elif i > total - fade:
            v *= (total - i) / fade
        s = int(max(-1.0, min(1.0, v * scale)) * 32000)
        frames += struct.pack("<h", s)
    return bytes(frames)


def write_mp3(frames, path):
    tmp_wav = path.replace(".mp3", ".tmp.wav")
    with wave.open(tmp_wav, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(frames)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", tmp_wav, "-b:a", "72k", "-ac", "1", path],
        check=True,
    )
    os.remove(tmp_wav)


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    themes = parse_themes()
    os.makedirs(OUT_DIR, exist_ok=True)
    for cfg in THEMES:
        if only and cfg["id"] != only:
            continue
        if cfg["melody"] not in themes:
            print("跳过", cfg["id"], "（找不到旋律", cfg["melody"], "）")
            continue
        frames = render(cfg, themes)
        out = os.path.join(OUT_DIR, "theme-%s.mp3" % cfg["id"])
        write_mp3(frames, out)
        kb = os.path.getsize(out) // 1024
        print("%-12s %-10s -> %s  (%d KB)" % (cfg["id"], cfg["title"], os.path.basename(out), kb))


if __name__ == "__main__":
    main()
