// Versão de 1 minuto: tira silêncios das pontas e, nos passos, o prefixo "Passo X:" (até a 1ª pausa).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const PREFIXO = new Set([2, 3, 5, 6]);
function readWav(f) {
  const b = readFileSync(f); let p = 12, fmt, data;
  while (p < b.length) { const id = b.toString('ascii', p, p + 4), sz = b.readUInt32LE(p + 4); if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) }; if (id === 'data') data = b.subarray(p + 8, p + 8 + sz); p += 8 + sz + (sz % 2); }
  return { ...fmt, data };
}
function writeWav(f, { ch, sr, bits }, data) {
  const h = Buffer.alloc(44), ba = ch * bits / 8;
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * ba, 28); h.writeUInt16LE(ba, 32); h.writeUInt16LE(bits, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(f, Buffer.concat([h, data]));
}
for (let n = 1; n <= 10; n++) {
  const w = readWav(path.join(DIR, 'audio', `cena-${n}.wav`)), fb = w.ch * w.bits / 8, frames = w.data.length / fb, win = Math.round(w.sr * 0.01);
  const rms = []; for (let i = 0; i + win <= frames; i += win) { let e = 0; for (let j = i; j < i + win; j++) { const v = w.data.readIntLE(j * fb, 3) / 8388608; e += v * v; } rms.push(Math.sqrt(e / win)); }
  const thr = Math.max(...rms) * 0.06, on = rms.map((r) => r > thr);
  const first = on.indexOf(true), last = on.lastIndexOf(true);
  let start = Math.max(0, first - 4), cut = 0, pauses = [];
  for (let i = first, run = 0; i <= last; i++) { if (!on[i]) run++; else { if (run >= 10) pauses.push([(i - run) / 100, i / 100]); run = 0; } }
  if (PREFIXO.has(n)) { const p = pauses.find(([a]) => a > first / 100 + 0.3); if (p) { start = Math.round(p[1] * 100) - 4; cut = start / 100; } }
  const end = Math.min(rms.length, last + 10);
  writeWav(path.join(DIR, 'audio-curta', `cena-${n}.wav`), w, w.data.subarray(start * win * fb, end * win * fb));
  console.log(`cena ${n}: ${(frames / w.sr).toFixed(2)} s → ${((end - start) / 100).toFixed(2)} s · corte inicial ${(start / 100).toFixed(2)} s · pausas ${pauses.map(([a, b]) => a.toFixed(2) + '-' + b.toFixed(2)).join(' ')}`);
}
