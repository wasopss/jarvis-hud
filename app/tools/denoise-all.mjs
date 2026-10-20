// Tira o ruído, no lugar, dos áudios já masterizados (cache da central, falas do add-on e narração do vídeo),
// sem equalizar de novo. Um registro .denoised.json em cada pasta evita repetir.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterInPlace } from './speak.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = [path.join(APP, '..', 'video', 'audio'), path.join(APP, 'cache'), path.join(homedir(), '.claude', 'jarvis', 'voice-override')];
for (const dir of DIRS) {
  const reg = path.join(dir, '.denoised.json');
  let done = new Set(); try { done = new Set(JSON.parse(await readFile(reg, 'utf8'))); } catch {}
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.wav') && !f.endsWith('.m.wav') && !done.has(f));
  console.log(`${dir}: ${files.length} para limpar`);
  let n = 0;
  for (const f of files) {
    const r = await masterInPlace(path.join(dir, f), { onlyDenoise: true, stereo: true });
    if (r) { done.add(f); n++; if (n % 50 === 0) { await writeFile(reg, JSON.stringify([...done])); console.log(`  ${n}/${files.length}`); } }
  }
  await writeFile(reg, JSON.stringify([...done]));
  console.log(`  pronto: ${n}/${files.length}`);
}
