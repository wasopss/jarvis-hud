#!/usr/bin/env bash
# Monta o pacote portátil do Jarvis para Windows (Node embutido, sem instalar nada).
# Uso: bash build-windows.sh    → gera dist/Jarvis-Windows.zip
set -e
NODE_VER=24.21.0
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/dist"; B="$OUT/Jarvis-Windows"
rm -rf "$B"; mkdir -p "$B/runtime" "$B/app" "$B/prompts" "$OUT/dl"

echo "1/4 Baixando Node $NODE_VER para Windows…"
curl -sSL -o "$OUT/dl/node.zip" "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-win-x64.zip"
WANT=$(curl -sSL "https://nodejs.org/dist/v$NODE_VER/SHASUMS256.txt" | grep "win-x64.zip" | awk '{print $1}')
GOT=$(shasum -a 256 "$OUT/dl/node.zip" | awk '{print $1}')
[ "$WANT" = "$GOT" ] || { echo "ERRO: soma de verificação do Node não confere"; exit 1; }
( cd "$OUT/dl" && unzip -q -o node.zip )
cp "$OUT/dl/node-v$NODE_VER-win-x64/node.exe" "$B/runtime/node.exe"

echo "2/4 Copiando o app…"
cp "$HERE/app/server.mjs" "$HERE/app/package.json" "$B/app/"
cp "$HERE/app/config.example.json" "$B/app/config.json"
mkdir -p "$B/app/public" "$B/app/tools" "$B/app/cache"
cp -R "$HERE/app/public/." "$B/app/public/"
cp "$HERE"/app/tools/*.mjs "$B/app/tools/"
cp "$HERE"/prompts/*.md "$B/prompts/" 2>/dev/null || true

echo "3/4 Instalando a dependência (SDK do Claude)…"
( cd "$B/app" && npm install --omit=dev --silent )

echo "4/4 Montando o atalho e compactando…"
cat > "$B/Jarvis.bat" <<'BAT'
@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "Jarvis (nao feche esta janela)" ".\runtime\node.exe" ".\app\server.mjs"
timeout /t 3 >nul
start "" http://localhost:4777
exit
BAT
cp "$HERE/COMECE-AQUI-Windows.txt" "$B/COMECE-AQUI.txt" 2>/dev/null || true
( cd "$OUT" && zip -rq Jarvis-Windows.zip Jarvis-Windows -x '*.DS_Store' )
echo "Pronto: $OUT/Jarvis-Windows.zip"
