#!/bin/bash
# 生日旅行 · 一键打开（制作向导）
# 双击本文件：会自动启动本地服务并打开制作向导页面。
# 关闭：在终端里按 Ctrl + C 即可停止。

cd "$(dirname "$0")" || exit 1

PORT=8765
echo "=================================================="
echo "  生日旅行 · 制作向导"
echo "  正在启动本地服务，稍等 1 秒会自动打开浏览器…"
echo "  若没有自动打开，请手动访问："
echo "  http://127.0.0.1:$PORT/builder/"
echo "  按 Ctrl + C 可停止服务并关闭窗口"
echo "=================================================="

python3 -m http.server "$PORT" &
SERVER_PID=$!

sleep 1
open "http://127.0.0.1:$PORT/builder/"

wait "$SERVER_PID"
