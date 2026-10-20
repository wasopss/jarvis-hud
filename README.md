# J.A.R.V.I.S. — assistente pessoal de voz

Central de comando por voz (HUD no navegador) para o dia a dia, com foco em engenharia e operação em óleo, gás, mineração e indústria. Servidor local em Node, sem dependências além do SDK da Anthropic.

![HUD](https://img.shields.io/badge/HUD-Chrome-4fe3ff) ![Node](https://img.shields.io/badge/Node-24-3ee6a2)

## Recursos
- **Comando por voz** (palavra de ativação "Jarvis") e por texto, com reconhecimento do Chrome e reserva local.
- **Mercado ao vivo:** petróleo (Brent/WTI), gás, metais, ações do setor, câmbio e criptomoedas (Yahoo Finance e CoinGecko).
- **Clima, notícias e licitações** do setor; triagem de e-mail (somente leitura).
- **Cérebro** para perguntas abertas, via Claude (API ou Claude Code).
- **Controle do Mac:** abrir/fechar apps, ler a tela (OCR), e-mail, WhatsApp e redes sociais — ações que enviam ou publicam sempre pedem confirmação.
- **HUD tecnológico:** medidores circulares, radar, varredura e voz sintetizada com masterização.

## Como rodar
```bash
cd app && npm install
# compile as ferramentas de áudio/OCR (macOS)
cd tools && swiftc -O master.swift -o master && swiftc -O noisemeter.swift -o noisemeter && swiftc -O ocr.swift -o ocr
cd .. && cp config.example.json config.json && node server.mjs
```
Abra `http://localhost:4777` no Chrome.

A síntese de voz usa um motor TTS local (compatível com a API em `127.0.0.1:3900`). As perguntas abertas usam a API do Claude (chave em `config.json`) ou o login do Claude Code.

## Voz
Este repositório **não inclui nenhuma voz**. Configure em `config.json` o seu próprio motor e perfil de voz. Nunca clone a voz de uma pessoa real sem o consentimento dela.

## Estrutura
- `app/server.mjs` — servidor local (porta 4777).
- `app/public/` — a central (HUD) e a bateria de testes de comandos (`/?teste=1`).
- `app/tools/` — síntese e masterização de voz, OCR e autostart.
- `prompts/` — a personalidade do cérebro.
- `video/` — roteiro e estúdio 3D (scripts, sem mídia).

## Licença
MIT. As vozes, músicas e dados que você usar com o Jarvis são de sua responsabilidade e podem ter licença própria.
