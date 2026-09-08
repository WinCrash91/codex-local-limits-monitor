@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js en PATH. Instala Node.js 18 o posterior y vuelve a intentarlo.
  exit /b 1
)
node launcher.cjs
if errorlevel 1 pause
