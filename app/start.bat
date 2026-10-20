@echo off
REM Clique duas vezes para abrir a central do Jarvis no Windows.
cd /d "%~dp0"
REM se o servidor ja estiver no ar, so abre a central no navegador
powershell -NoProfile -Command "try{ if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:4777/).StatusCode -eq 200){ Start-Process 'http://localhost:4777'; exit 0 } }catch{}"
if %errorlevel%==0 goto :eof
REM liga o servidor nesta janela e abre a central
start "" http://localhost:4777
node server.mjs
