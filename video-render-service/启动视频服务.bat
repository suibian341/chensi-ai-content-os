@echo off
setlocal
cd /d "%~dp0"
set "PATH=C:\Users\q3413\tools\ffmpeg\bin;%PATH%"
set "HF_HOME=C:\Users\q3413\tools\whisper-models"
set "HF_ENDPOINT=https://hf-mirror.com"
echo ==========================================
echo   chensi video render service
echo   http://127.0.0.1:4399   health: /health
echo   (ffmpeg + faster-whisper already installed)
echo ==========================================
node server.js
pause
