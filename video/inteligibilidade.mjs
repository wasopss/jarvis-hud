// Teste de inteligibilidade: transcreve cada cena (VoiceStudio, local) e compara palavra por palavra com o roteiro.
// Uso: node inteligibilidade.mjs <pasta-com-cena-N.wav> [rótulo]
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CENAS } from './gerar-narracao.mjs';

const dir = process.argv[2], label = process.argv[3] || dir;
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
// números falados ↔ escritos que a transcrição costuma trocar
const SAME = { um: '1', dois: '2', tres: '3', quatro: '4', cinco: '5', sete: '7', nove: '9', cento: '100' };
const eq = (a, b) => a === b || SAME[a] === b || SAME[b] === a;

function align(ref, hyp) {
  // distância de edição com recuperação das palavras do roteiro que não foram reconhecidas
  const n = ref.length, m = hyp.length, d = Array.from({ length: n + 1 }, (_, i) => Array(m + 1).fill(0).map((_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (eq(ref[i - 1], hyp[j - 1]) ? 0 : 1));
  const lost = []; let i = n, j = m;
  while (i > 0 && j > 0) {
    if (eq(ref[i - 1], hyp[j - 1]) && d[i][j] === d[i - 1][j - 1]) { i--; j--; }
    else if (d[i][j] === d[i - 1][j - 1] + 1) { lost.unshift(`${ref[i - 1]}→${hyp[j - 1]}`); i--; j--; }
    else if (d[i][j] === d[i - 1][j] + 1) { lost.unshift(`${ref[i - 1]}→(sumiu)`); i--; }
    else j--;
  }
  while (i > 0) { lost.unshift(`${ref[i - 1]}→(sumiu)`); i--; }
  return { errors: d[n][m], lost };
}

let tot = 0, totErr = 0;
console.log(`== ${label} ==`);
if (dir.endsWith('.wav')) {
  // arquivo único (áudio do vídeo inteiro): compara com o roteiro completo
  const form = new FormData();
  form.set('file', new Blob([await readFile(dir)], { type: 'audio/wav' }), 'video.wav');
  form.set('model', 'whisper-1'); form.set('language', 'pt');
  const r = await fetch('http://127.0.0.1:3900/v1/audio/transcriptions', { method: 'POST', body: form, signal: AbortSignal.timeout(300000) });
  const text = (await r.json()).text || '';
  const ref = norm(CENAS.join(' ')), a = align(ref, norm(text));
  console.log(`vídeo inteiro: ${ref.length - a.errors}/${ref.length} palavras certas (${(100 * (ref.length - a.errors) / ref.length).toFixed(1)}%)`);
  console.log(a.lost.length ? 'perdidas: ' + a.lost.join(', ') : 'nenhuma palavra perdida');
  process.exit(0);
}
for (let k = 0; k < CENAS.length; k++) {
  const f = path.join(dir, `cena-${k + 1}.wav`);
  const form = new FormData();
  form.set('file', new Blob([await readFile(f)], { type: 'audio/wav' }), 'cena.wav');
  form.set('model', 'whisper-1'); form.set('language', 'pt');
  const r = await fetch('http://127.0.0.1:3900/v1/audio/transcriptions', { method: 'POST', body: form, signal: AbortSignal.timeout(180000) });
  const text = (await r.json()).text || '';
  const ref = norm(CENAS[k]), hyp = norm(text), a = align(ref, hyp);
  tot += ref.length; totErr += a.errors;
  console.log(`cena ${k + 1}: ${ref.length - a.errors}/${ref.length} palavras certas${a.lost.length ? ' · ' + a.lost.join(', ') : ''}`);
}
console.log(`TOTAL: ${(100 * (tot - totErr) / tot).toFixed(1)}% das palavras entendidas (${tot - totErr}/${tot})`);
