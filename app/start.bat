@echo off
chcp 65001 >nul
title Jarvis
cd /d "%~dp0"

REM 1) precisa do Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   O Jarvis precisa do Node.js, e ele nao esta instalado.
  echo   Vou abrir a pagina oficial. Baixe o "LTS", instale,
  echo   feche esta janela e clique no start.bat de novo.
  echo.
  start "" https://nodejs.org/pt-br/download
  pause
  exit /b
)

REM 2) primeira vez: instala as bibliotecas
if not exist node_modules (
  echo Instalando pela primeira vez. Isso leva um ou dois minutos...
  call npm install
)

REM 3) cria a configuracao se ainda nao existir
if not exist config.json copy config.example.json config.json >nul

REM 4) abre a central no navegador e liga o Jarvis
start "" http://localhost:4777
echo.
echo   Jarvis ligado. A central abriu no navegador (http://localhost:4777).
echo   Para desligar, feche esta janela.
echo.
node server.mjs
