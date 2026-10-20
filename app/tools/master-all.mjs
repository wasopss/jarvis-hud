// Masteriza, no lugar, os áudios já gerados (cache da central e falas do add-on do Claude Code).
// Um registro .mastered.json em cada pasta evita masterizar o mesmo arquivo duas vezes.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterInPlace, voiceConfig } from './speak.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = [path.join(APP, 'cache'), path.join(homedir(), '.claude', 'jarvis', 'voice-override')];
const v = await voiceConfig();
const opts = { lufs: v.master?.lufs ?? -16, stereo: v.master?.stereo !== false };

for (const dir of DIRS) {
  const reg = path.join(dir, '.mastered.json');
  let done = new Set(); try { done = new Set(JSON.parse(await readFile(reg, 'utf8'))); } catch {}
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.wav') && !f.endsWith('.m.wav') && !done.has(f));
  console.log(`${dir}: ${files.length} para masterizar`);
  let n = 0;
  for (const f of files) {
    const r = await masterInPlace(path.join(dir, f), opts);
    if (r) { done.add(f); n++; if (n % 25 === 0) { await writeFile(reg, JSON.stringify([...done])); console.log(`  ${n}/${files.length}`); } }
  }
  await writeFile(reg, JSON.stringify([...done]));
  console.log(`  pronto: ${n}/${files.length}`);
}
