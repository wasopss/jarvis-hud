# J.A.R.V.I.S. — assistente pessoal de voz

Central de comando por voz (HUD no navegador) para o dia a dia, com foco em engenharia e operação em óleo, gás, mineração e indústria. Servidor local em Node, sem dependências além do SDK da Anthropic. **Roda em macOS e Windows** (e Linux).

![HUD](https://img.shields.io/badge/HUD-Chrome-4fe3ff) ![Node](https://img.shields.io/badge/Node-24-3ee6a2) ![SO](https://img.shields.io/badge/macOS%20%7C%20Windows-888)

## Recursos
- **Comando por voz** (palavra de ativação "Jarvis") e por texto, com reconhecimento do Chrome e reserva local.
- **Mercado ao vivo:** petróleo (Brent/WTI), gás, metais, ações do setor, câmbio e criptomoedas (Yahoo Finance e CoinGecko).
- **Clima, notícias e licitações** do setor; triagem de e-mail (somente leitura).
- **Cérebro** para perguntas abertas, via Claude (API ou Claude Code).
- **Controle do computador:** abrir/fechar apps, e-mail, WhatsApp e redes sociais — ações que enviam ou publicam sempre pedem confirmação.
- **HUD tecnológico:** medidores circulares, radar, varredura, abertura com reator, efeitos sonoros e voz sintetizada.

## Instalação

Pré-requisitos: **Node 24+** e, para a voz, um motor TTS local na API `127.0.0.1:3900`.

### macOS
```bash
cd app && npm install
cd tools && swiftc -O master.swift -o master && swiftc -O noisemeter.swift -o noisemeter && swiftc -O ocr.swift -o ocr   # opcional (polimento da voz e leitura de tela)
cd .. && cp config.example.json config.json && node server.mjs
```
Ou dê dois cliques em `app/start.command`.

### Windows
```bat
cd app && npm install
copy config.example.json config.json
node server.mjs
```
Ou dê dois cliques em `app/start.bat`.

Depois, abra `http://localhost:4777` no Chrome.

## Diferenças por sistema
| Recurso | macOS | Windows |
|---|---|---|
| Comando de voz, mercado, clima, notícias, cérebro | ✅ | ✅ |
| Abrir / fechar apps | ✅ (AppleScript) | ✅ (nome / taskkill) |
| E-mail e WhatsApp (com confirmação) | ✅ (Mail nativo ou Gmail) | ✅ (Gmail / WhatsApp Web; você envia) |
| Polimento da voz (masterização) | ✅ (ferramenta Swift) | voz toca sem polimento |
| Leitura de tela (OCR) | ✅ | ainda não |

As partes exclusivas do Mac se desativam sozinhas no Windows, sem quebrar o resto.

## Voz
Este repositório **não inclui nenhuma voz**. Configure em `config.json` o seu próprio motor e perfil de voz. Nunca clone a voz de uma pessoa real sem o consentimento dela.

## Estrutura
- `app/server.mjs` — servidor local (porta 4777), multiplataforma.
- `app/public/` — a central (HUD) e a bateria de testes de comandos (`/?teste=1`).
- `app/tools/` — síntese e masterização de voz, OCR e autostart.
- `app/start.command` / `app/start.bat` — abrir a central no Mac / Windows.
- `prompts/` — a personalidade do cérebro.
- `video/` — roteiro e estúdio 3D (scripts, sem mídia).

## Licença
MIT. As vozes, músicas e dados que você usar com o Jarvis são de sua responsabilidade e podem ter licença própria.
