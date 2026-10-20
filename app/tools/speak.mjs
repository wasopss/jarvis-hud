// Voz única do Jarvis, fora do HUD: mesma voz e mesmos parâmetros do config.json.
// Uso:  node speak.mjs "Bom dia, senhor."      -> gera (VoiceStudio) e toca
//       import { synth, resolveVoice } from './speak.mjs'
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function voiceConfig() {
  const DEF = { url: 'http://127.0.0.1:3900', language: 'Portuguese', instruct: 'male, low pitch, british accent', seed: 42, speed: 1.0, effect: 'broadcast', profileId: null, profileName: null };
  try { return { ...DEF, ...JSON.parse(await readFile(path.join(APP, 'config.json'), 'utf8')).voice }; } catch { return DEF; }
}

// Um perfil clonado só vira a voz do Jarvis com autorização registrada no VoiceStudio
// e com uma gravação nova (não o monólogo do clipe "jarvis" de terceiros).
const OLD_CLIP = /paradoxo do observador|alteram minha natureza|interessante reflex[aã]o/i;
export function profileProblem(p) {
  const consent = (p.consent_text || '').trim() || (p.consent_audio_path || '').trim() || p.verified_own_voice;
  if (!consent) return 'sem autorização registrada no VoiceStudio';
  if (!(p.ref_text || '').trim()) return 'sem transcrição da gravação';
  if (OLD_CLIP.test(p.ref_text)) return 'a gravação é o mesmo clipe antigo do Jarvis';
  return null;
}

// Nome do perfil sem acento, pontuação ou espaços extras ("Voz do Jarvis," == "voz do jarvis").
const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Decide a voz em uso: { pid, status, name }. pid null = voz original (instruct + seed).
let cache = { t: 0, key: '', v: null };
export async function resolveVoice(v) {
  const wanted = v.profileId || v.profileName;
  if (!wanted) return { pid: null, status: 'original' };
  const key = `${v.profileId}|${v.profileName}`;
  if (cache.key === key && Date.now() - cache.t < 60e3) return cache.v;
  let out;
  try {
    const list = await (await fetch(`${v.url}/profiles`, { signal: AbortSignal.timeout(3000) })).json();
    const p = v.profileId ? list.find((x) => x.id === v.profileId)
      : list.find((x) => normName(x.name) === normName(v.profileName));
    if (!p) out = { pid: null, status: `aguardando o perfil “${wanted}”` };
    else {
      const problem = profileProblem(p);
      out = problem ? { pid: null, status: `perfil “${p.name}” recusado: ${problem}` } : { pid: p.id, status: 'ativa', name: p.name };
    }
  } catch {
    out = cache.v || { pid: null, status: 'VoiceStudio indisponível' };
  }
  cache = { t: Date.now(), key, v: out };
  return out;
}

// Masterização (tools/master): EQ de voz, compressor, loudness em LUFS e limitador. Se falhar, mantém o original.
const MASTER_BIN = path.join(APP, 'tools', process.platform === 'win32' ? 'master.exe' : 'master');
export function masterFile(inPath, outPath, { lufs = -16, stereo = true, onlyDenoise = false } = {}) {
  // sem o binário (Windows, ou Mac sem compilar) a masterização é pulada: a voz toca sem polimento
  if (!existsSync(MASTER_BIN)) return Promise.resolve(null);
  const args = [inPath, outPath, '--lufs', String(lufs)];
  if (stereo) args.push('--stereo');
  if (onlyDenoise) args.push('--so-ruido'); // só tira o ruído (para áudios já masterizados)
  return new Promise((ok) => execFile(MASTER_BIN, args, { timeout: 60000 }, (e, out) => ok(e ? null : String(out).trim())));
}
export async function masterInPlace(file, opts) {
  const tmp = file + '.m.wav';
  const report = await masterFile(file, tmp, opts);
  if (!report) { await unlink(tmp).catch(() => {}); return null; }
  await rename(tmp, file);
  return report;
}

export async function synth(text, out, { steps, effect, lufs } = {}) {
  const v = await voiceConfig();
  if (steps !== undefined) v.steps = steps;   // qualidade: mais passos = voz mais fiel (e mais lenta)
  if (effect) v.effect = effect;
  const { pid } = await resolveVoice(v);
  const form = new FormData();
  form.set('text', text);
  form.set('language', v.language);
  form.set('speed', String(v.speed));
  form.set('effect_preset', v.effect);
  if (v.steps) form.set('num_step', String(v.steps));
  if (pid) form.set('profile_id', pid);
  else { form.set('instruct', v.instruct); form.set('seed', String(v.seed)); }
  const r = await fetch(`${v.url}/generate`, { method: 'POST', body: form, signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`VoiceStudio ${r.status}`);
  await writeFile(out, Buffer.from(await r.arrayBuffer()));
  if (v.master?.enabled !== false) await masterInPlace(out, { lufs: lufs ?? v.master?.lufs ?? -16, stereo: v.master?.stereo !== false });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = process.argv.slice(2).join(' ').trim();
  if (!text) { console.error('uso: node speak.mjs "texto"'); process.exit(1); }
  const out = path.join(tmpdir(), `jarvis-fala-${Date.now()}.wav`);
  try {
    await synth(text, out);
    const play = process.platform === 'darwin' ? ['afplay', [out]]
      : process.platform === 'win32' ? ['powershell', ['-c', `(New-Object Media.SoundPlayer '${out}').PlaySync()`]]
      : ['aplay', [out]];
    await new Promise((ok) => execFile(play[0], play[1], ok));
  } catch (e) {
    // sem voz disponível: não troca de voz, apenas mostra o texto
    console.log(`[Jarvis] ${text}`);
    console.error(`voz indisponível: ${e.message}`);
    process.exitCode = 2;
  }
}
