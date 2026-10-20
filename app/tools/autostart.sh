#!/bin/zsh
# Inicia o Jarvis no login do Mac (chamado pelo LaunchAgent com.washington.jarvis).
# 1) abre o VoiceStudio em segundo plano (a voz do Jarvis depende dele)
# 2) quando o servidor estiver no ar, abre a central no Chrome
# 3) roda o servidor do HUD
APP="$HOME/jarvis/app"
NODE="$HOME/.local/node/node-v24.21.0-darwin-arm64/bin/node"
cd "$APP" || exit 1

open -ga VoiceStudio 2>/dev/null

(
  for i in $(seq 1 60); do
    curl -s -m 2 -o /dev/null -w "%{http_code}" http://localhost:4777/ | grep -q 200 && break
    sleep 1
  done
  open -a "Google Chrome" http://localhost:4777 2>/dev/null || open http://localhost:4777
) &

exec "$NODE" server.mjs
