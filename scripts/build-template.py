#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-template.py —— 把「成品引擎」打包进 builder，让制作向导离线自包含可用。

用法（在仓库根目录执行）：
    python3 scripts/build-template.py

输入：
    index.html / styles.css / app.js         成品引擎
    assets/ai  assets/icons  assets/map      内置示例素材（webp/png → data URL）

输出：
    builder/template.inline.js               window.TEMPLATE_SRC
    修改过成品引擎或素材后，重新跑一次即可。
"""
import base64
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEDIA_DIRS = [
    "assets/ai",
    "assets/icons",
    "assets/map",
    "assets/photos/sample",
]
MEDIA_EXTS = {".webp", ".png", ".jpg", ".jpeg", ".svg", ".gif"}


def load_text(rel: str) -> str:
    p = ROOT / rel
    if not p.exists():
        raise SystemExit(f"[build-template] 缺少文件: {rel}")
    return p.read_text(encoding="utf-8")


def media_map() -> dict:
    out = {}
    for folder in MEDIA_DIRS:
        d = ROOT / folder
        if not d.is_dir():
            continue
        for f in sorted(d.iterdir()):
            if f.suffix.lower() not in MEDIA_EXTS:
                continue
            rel = f"{folder}/{f.name}"
            mime = {
                ".webp": "image/webp",
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".svg": "image/svg+xml",
                ".gif": "image/gif",
            }[f.suffix.lower()]
            b64 = base64.b64encode(f.read_bytes()).decode("ascii")
            out[rel] = f"data:{mime};base64,{b64}"
    return out


def js_string(obj) -> str:
    # 关键：json.dumps 不会转义 "/"，字符串内容里的 "</script>" 会提前闭合
    # 外层 <script> 标签。把 "</" 写成 "<\\/"（JS 字符串解析后仍是 "</script>"，
    # 但 HTML 解析器不会再把它当成闭合标签）。
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")


def main() -> None:
    html = load_text("index.html")
    css = load_text("styles.css")
    js = load_text("app.js")
    config = load_text("config.js")
    media = media_map()
    print(
        f"[build-template] html={len(html)}B css={len(css)}B js={len(js)}B "
        f"config={len(config)}B media={len(media)} 图"
    )

    builder_dir = ROOT / "builder"
    builder_dir.mkdir(exist_ok=True)
    out = builder_dir / "template.inline.js"
    content = (
        "// 本文件由 scripts/build-template.py 自动生成，请勿手改。\n"
        "// 重新生成：python3 scripts/build-template.py\n"
        "window.TEMPLATE_SRC = {\n"
        f"  html: {js_string(html)},\n"
        f"  css: {js_string(css)},\n"
        f"  js: {js_string(js)},\n"
        f"  config: {js_string(config)},\n"
        f"  media: {js_string(media)},\n"
        "};\n"
    )
    out.write_text(content, encoding="utf-8")
    size_kb = out.stat().st_size / 1024
    print(f"[build-template] 已生成 {out.relative_to(ROOT)} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
