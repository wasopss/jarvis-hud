#!/bin/zsh
# Clique duas vezes para abrir a central do Jarvis.
# Se o Jarvis já estiver ligado (ele liga sozinho no login), só abre a central no Chrome.
cd "$(dirname "$0")"
open_hud() { open -a "Google Chrome" http://localhost:4777 2>/dev/null || open http://localhost:4777; }
if curl -s -m 2 -o /dev/null -w "%{http_code}" http://localhost:4777/ | grep -q 200; then
  open_hud; exit 0
fi
# servidor desligado: pede para o serviço de login religar (ele mesmo abre a central)
if launchctl kickstart "gui/$(id -u)/com.washington.jarvis" 2>/dev/null; then exit 0; fi
# sem o serviço instalado: roda aqui mesmo, nesta janela
export PATH="$HOME/.local/node/node-v24.21.0-darwin-arm64/bin:$PATH"
(sleep 1 && open_hud) &
node server.mjs
