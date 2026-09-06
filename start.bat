@echo off
chcp 65001 >nul
rem 生日旅行 · 一键打开（制作向导）
rem 双击本文件：自动启动本地服务并打开制作向导页面。
rem 需要电脑装有 Python。关闭：在黑色窗口里按 Ctrl + C。

cd /d "%~dp0"
set PORT=8765

echo ==================================================
echo   生日旅行 · 制作向导
echo   正在启动本地服务，会自动打开浏览器...
echo   若没有自动打开，请手动访问：
echo   http://127.0.0.1:%PORT%/builder/
echo   按 Ctrl + C 可停止服务并关闭窗口
echo ==================================================

start "" http://127.0.0.1:%PORT%/builder/
python -m http.server %PORT%
