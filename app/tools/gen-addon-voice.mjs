// Regrava as falas do add-on J.A.R.V.I.S. do Claude Code com a voz única do Jarvis.
// Lê ~/.claude/jarvis/lines.mjs e grava ~/.claude/jarvis/voice-override/{cat}-{i}.wav.
// Pula o que já existe, então pode ser interrompido e retomado.
import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { synth } from './speak.mjs';

const ADDON = path.join(homedir(), '.claude', 'jarvis');
const OUT = process.env.JARVIS_VOICE_OUT || path.join(ADDON, 'voice-override');
await mkdir(OUT, { recursive: true });
const { LINES } = await import(pathToFileURL(path.join(ADDON, 'lines.mjs')).href);

const jobs = Object.entries(LINES).flatMap(([cat, lines]) => lines.map((text, i) => ({ text, file: path.join(OUT, `${cat}-${i + 1}.wav`) })));
let done = jobs.filter((j) => existsSync(j.file)).length;
console.log(`falas: ${jobs.length} · já prontas: ${done}`);
// até 3 passadas: o que falhar (VoiceStudio ocupado, memória cheia) é tentado de novo
for (let pass = 1; pass <= 3; pass++) {
  const todo = jobs.filter((j) => !existsSync(j.file));
  if (!todo.length) break;
  if (pass > 1) { console.log(`nova tentativa ${pass}/3 para ${todo.length} falas`); await new Promise((r) => setTimeout(r, 30000)); }
  for (const j of todo) {
    // prioridade do senhor: enquanto o HUD estiver em uso (pedidos de voz nos últimos 5 min), espera
    for (;;) {
      const busy = await fetch('http://localhost:4777/api/hud-busy', { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).then((j) => j.busy).catch(() => false);
      if (!busy) break;
      await new Promise((r) => setTimeout(r, 20000));
    }
    try {
      await synth(j.text, j.file + '.tmp');
      await rename(j.file + '.tmp', j.file); // só aparece quando completo
      done++;
      console.log(`${done}/${jobs.length} ${path.basename(j.file)}`);
    } catch (e) {
      console.log(`falhou ${path.basename(j.file)}: ${e.message}`);
    }
  }
}
console.log(`concluído: ${done}/${jobs.length}`);
