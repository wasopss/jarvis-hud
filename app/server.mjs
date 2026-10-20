// Jarvis HUD — servidor local sem dependências.
// Lê os arquivos de estado em ~/jarvis, busca dados ao vivo (mercado, clima, notícias)
// e sintetiza a voz única do Jarvis pelo VoiceStudio local.
import http from 'node:http';
import { readFile, appendFile, readdir, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as fsSync from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveVoice, masterInPlace } from './tools/speak.mjs';
import { EventEmitter } from 'node:events';

// "Processo ao vivo": cada etapa (voz, cérebro, transcrição) vira um evento que o HUD acompanha por SSE.
const bus = new EventEmitter(); bus.setMaxListeners(50);
const emit = (e) => bus.emit('ev', { ...e, t: Date.now() });

const APP = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APP, '..');
const CACHE = path.join(APP, 'cache');
const PORT = Number(process.env.PORT || 4777);
await mkdir(CACHE, { recursive: true });

const DEFAULTS = {
  location: { name: 'São Paulo', lat: -23.55, lon: -46.63 },
  voice: {
    engine: 'voicestudio',
    url: 'http://127.0.0.1:3900',
    language: 'Portuguese',
    instruct: 'male, low pitch, british accent',
    seed: 42,
    speed: 1.0,
    profileId: null, // só para uma voz sua (gravação própria), nunca clone de terceiros
    profileName: null, // nome do perfil da SUA voz no VoiceStudio; usado quando profileId está vazio
    effect: 'broadcast',
  },
  market: [
    { s: 'BZ=F', n: 'Brent', u: 'US$' },
    { s: 'CL=F', n: 'WTI', u: 'US$' },
    { s: 'NG=F', n: 'Gás (HH)', u: 'US$' },
    { s: 'GC=F', n: 'Ouro', u: 'US$' },
    { s: 'HG=F', n: 'Cobre', u: 'US$' },
    { s: 'PETR4.SA', n: 'PETR4', u: 'R$' },
    { s: 'VALE3.SA', n: 'VALE3', u: 'R$' },
    { s: 'GGBR4.SA', n: 'GGBR4', u: 'R$' },
    { s: 'CSNA3.SA', n: 'CSNA3', u: 'R$' },
    { s: 'BRL=X', n: 'Dólar', u: 'R$' },
  ],
  news: {
    'Petróleo e gás': 'Petrobras OR ANP OR "petróleo" OR pré-sal',
    'Mineração': 'VALE3 OR mineradora OR mineração OR "minério de ferro" OR "Agência Nacional de Mineração"',
    'Indústria': '"produção industrial" OR "PMI industrial" OR CNI OR siderurgia OR "setor industrial" OR "confiança da indústria"',
    'Licitações': 'licitação OR contrato Petrobras OR fornecedores offshore OR mineradora',
  },
};

async function config() {
  try {
    const c = JSON.parse(await readFile(path.join(APP, 'config.json'), 'utf8'));
    return { ...DEFAULTS, ...c, voice: { ...DEFAULTS.voice, ...c.voice } };
  } catch { return DEFAULTS; }
}

// ---------- arquivos de estado ----------
const read = (f) => readFile(path.join(ROOT, f), 'utf8').catch(() => '');

function sections(md) {
  const out = {};
  let cur = '_';
  for (const line of md.split('\n')) {
    const h = line.match(/^#{2,3}\s+(.*)/);
    if (h) { cur = h[1].trim(); out[cur] = []; continue; }
    (out[cur] ||= []).push(line);
  }
  return out;
}
const stripLinks = (s) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*/g, '').trim();
const bullets = (lines = []) => lines.filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => stripLinks(l.replace(/^\s*[-*]\s+/, '')));
const tableRows = (lines = []) => lines
  .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l)).slice(1)
  .map((l) => l.split('|').slice(1, -1).map((c) => stripLinks(c)));

async function latestDaily() {
  const files = (await readdir(path.join(ROOT, 'daily')).catch(() => []))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  const f = files.at(-1);
  return f ? { file: f, md: await read(path.join('daily', f)) } : { file: null, md: '' };
}

async function state() {
  const [inbox, tasks, projects, daily, emailsRaw] = await Promise.all([read('inbox.md'), read('tasks.md'), read('projects.md'), latestDaily(), read('data/emails.json')]);
  let emails = null; try { emails = emailsRaw ? JSON.parse(emailsRaw) : null; } catch {}
  const d = sections(daily.md);
  const p = sections(projects);
  return {
    dailyFile: daily.file,
    inbox: inbox.split('\n').map((l) => l.match(/^- \[ \]\s+(.+)/)).filter(Boolean).map((m) => m[1].trim()),
    tasks: tableRows(tasks.split('\n')).filter((r) => r[0]),
    projects: { ativos: bullets(p['Ativos']), espera: bullets(p['Em espera']) },
    briefing: {
      precos: tableRows(d['Preços']),
      noticias: bullets(d['Notícias']),
      oportunidades: bullets(d['Oportunidades (vendas / vagas / licitações)']),
      regulacao: bullets(d['Regulação / ESG']),
    },
    prioridades: bullets(d['Prioridades do dia (1–3)']).filter((x) => !x.startsWith('_')),
    emails, // triagem do Gmail feita pelo Claude (somente leitura), em data/emails.json
    build: buildId(), // muda quando o index.html é editado: a central recarrega sozinha
  };
}
// versão da central: data de modificação do index.html (não precisa recarregar à mão)
function buildId() { try { return String(Math.round(fsSync.statSync(path.join(APP, 'public', 'index.html')).mtimeMs)); } catch { return '0'; } }

// ---------- dados ao vivo (com cache em memória) ----------
const memo = new Map();
async function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  try {
    const v = await fn();
    memo.set(key, { t: Date.now(), v });
    return v;
  } catch (e) {
    if (hit) return hit.v; // dado antigo é melhor que nada; o HUD mostra o horário
    throw e;
  }
}
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh) JarvisHUD/1.0' };

async function quote({ s, n, u }) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1mo&interval=1d`, { headers: UA, signal: AbortSignal.timeout(8000) });
  const res = (await r.json()).chart.result[0];
  const closes = (res.indicators.quote[0].close || []).filter((x) => x != null);
  const price = res.meta.regularMarketPrice;
  const prev = closes.length > 1 ? closes.at(-2) : res.meta.chartPreviousClose;
  return { s, n, u, price, change: prev ? ((price - prev) / prev) * 100 : null, spark: closes.slice(-22), time: res.meta.regularMarketTime * 1000 };
}

const market = async () => cached('market', 5 * 60e3, async () => {
  const { market } = await config();
  const out = await Promise.allSettled(market.map(quote));
  return out.filter((x) => x.status === 'fulfilled').map((x) => x.value);
});

// ---------- criptomoedas (CoinGecko, sem chave) ----------
const CRYPTO = [['bitcoin', 'Bitcoin'], ['ethereum', 'Ethereum'], ['solana', 'Solana'], ['ripple', 'XRP'], ['tether', 'Tether']];
const crypto = async () => cached('crypto', 2 * 60e3, async () => {
  const ids = CRYPTO.map(([id]) => id).join(',');
  const r = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=brl&ids=${ids}&sparkline=true&price_change_percentage=24h`, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
  const rows = await r.json();
  return CRYPTO.map(([id, n]) => rows.find((x) => x.id === id)).filter(Boolean).map((x) => {
    const sp = x.sparkline_in_7d?.price || [];
    return { s: x.id, n: CRYPTO.find(([id]) => id === x.id)[1], u: 'R$', cat: 'cripto', price: x.current_price, change: x.price_change_percentage_24h,
      spark: sp.filter((_, i) => i % 8 === 0).slice(-22), time: Date.parse(x.last_updated) };
  });
});

const WMO = { 0: 'céu limpo', 1: 'predominantemente limpo', 2: 'parcialmente nublado', 3: 'nublado', 45: 'neblina', 48: 'neblina', 51: 'garoa', 53: 'garoa', 55: 'garoa forte', 61: 'chuva fraca', 63: 'chuva', 65: 'chuva forte', 80: 'pancadas', 81: 'pancadas', 82: 'temporal', 95: 'trovoadas', 96: 'trovoadas', 99: 'trovoadas' };
const weather = async () => cached('weather', 15 * 60e3, async () => {
  const { location: L } = await config();
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${L.lat}&longitude=${L.lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`, { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  return {
    place: L.name,
    temp: j.current.temperature_2m, hum: j.current.relative_humidity_2m, wind: j.current.wind_speed_10m,
    desc: WMO[j.current.weather_code] || '—',
    max: j.daily.temperature_2m_max[0], min: j.daily.temperature_2m_min[0], rain: j.daily.precipitation_probability_max[0],
  };
});

const decode = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
async function rss(q) {
  const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&hl=pt-BR&gl=BR&ceid=BR:pt-419`, { headers: UA, signal: AbortSignal.timeout(8000) });
  const xml = await r.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map(([, it]) => {
    const g = (tag) => decode(it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] || '');
    const source = g('source');
    return { title: g('title').replace(new RegExp(`\\s-\\s${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ''), link: g('link'), source, date: Date.parse(g('pubDate')) || null };
  });
}
const news = async () => cached('news', 15 * 60e3, async () => {
  const { news } = await config();
  const entries = await Promise.all(Object.entries(news).map(async ([k, q]) => [k, await rss(q).catch(() => [])]));
  return Object.fromEntries(entries);
});

// ---------- voz ----------
const run = (cmd, args, timeout) => new Promise((ok, fail) => execFile(cmd, args, { timeout }, (e) => (e ? fail(e) : ok())));
// ---------- multiplataforma (macOS, Windows, Linux) ----------
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32';
// abre um site ou arquivo no app padrão (ou num app específico, só no Mac)
function openExternal(target, app) {
  if (MAC) return run('open', app ? ['-a', app, target] : [target], 10000);
  if (WIN) return run('cmd', ['/c', 'start', '', target], 10000);
  return run('xdg-open', [target], 10000);
}
// mostra o arquivo na pasta (Finder / Explorer)
function revealInFolder(file) {
  if (MAC) return run('open', ['-R', file], 10000);
  if (WIN) return run('explorer', ['/select,', file.replace(/\//g, String.fromCharCode(92))], 10000).catch(() => {});
  return run('xdg-open', path.dirname(file) ? [path.dirname(file)] : [file], 10000).catch(() => {});
}

// A voz em uso vem de tools/speak.mjs: o perfil clonado só entra com autorização registrada no VoiceStudio.
let activePid = undefined;
const ADDON_MARK = () => path.join(os.homedir(), '.claude', 'jarvis', 'voice-override', '.voice-pid');
async function resolveProfile(voice) {
  const r = await resolveVoice(voice);
  if (activePid === undefined) {
    // ao ligar: se as falas do add-on foram gravadas com outra voz, regrava
    const mark = (await readFile(ADDON_MARK(), 'utf8').catch(() => 'original')).trim();
    if (mark !== String(r.pid || 'original')) onVoiceChanged(r, voice);
  } else if (r.pid !== activePid) onVoiceChanged(r, voice);
  activePid = r.pid;
  return r.pid;
}

// Troca de voz: pré-gera as frases do HUD e regrava as falas do add-on do Claude Code
// numa pasta nova. Até terminar, o add-on fica mudo (nunca toca duas vozes); no fim, troca a pasta.
const ADDON = path.join(os.homedir(), '.claude', 'jarvis');
let regen = null;
function onVoiceChanged(r, voice = {}) {
  console.log(`[voz] nova voz: ${r.pid ? r.name : 'original'} (${r.status})`);
  setTimeout(warmUp, 0);
  // voice.regenAddon: false → não regrava o add-on sozinho (pesa muito num Mac de 8 GB)
  if (voice.regenAddon === false || !existsSync(path.join(ADDON, 'lines.mjs')) || regen) return;
  const next = path.join(ADDON, 'voice-override-new');
  // continua de onde parou se a pasta nova já é desta mesma voz; senão começa do zero
  let same = false; try { same = fsSync.readFileSync(path.join(next, '.voice-pid'), 'utf8').trim() === String(r.pid || 'original'); } catch {}
  if (!same) { fsSync.rmSync(next, { recursive: true, force: true }); fsSync.mkdirSync(next, { recursive: true }); }
  fsSync.writeFileSync(path.join(next, '.voice-pid'), String(r.pid || 'original'));
  regen = execFile(process.execPath, [path.join(APP, 'tools', 'gen-addon-voice.mjs')], { env: { ...process.env, JARVIS_VOICE_OUT: next }, maxBuffer: 16 << 20 }, async (e, out = '') => {
    regen = null;
    if (e || !/concluído: (\d+)\/\1/.test(out)) return console.warn('[voz] regravação do add-on incompleta; tente de novo depois');
    const { renameSync, rmSync } = await import('node:fs');
    const cur = path.join(ADDON, 'voice-override'), old = path.join(ADDON, `voice-override-old-${Date.now()}`);
    if (existsSync(cur)) renameSync(cur, old);
    renameSync(next, cur);
    rmSync(old, { recursive: true, force: true });
    await writeFile(ADDON_MARK(), String(r.pid || 'original'));
    console.log('[voz] falas do add-on regravadas com a nova voz');
  });
}

async function voiceStatus() {
  const { voice } = await config();
  try {
    const r = await fetch(`${voice.url}/profiles`, { signal: AbortSignal.timeout(1500) });
    const v = await resolveVoice(voice);
    await resolveProfile(voice);
    return { engine: v.pid ? `VoiceStudio · ${v.name}` : 'VoiceStudio', online: r.ok, status: v.status, addonRegen: !!regen };
  } catch { return { engine: 'VoiceStudio', online: false }; }
}

const MASTERED = path.join(CACHE, '.mastered.json');
let mastered = new Set(); try { mastered = new Set(JSON.parse(fsSync.readFileSync(MASTERED, 'utf8'))); } catch {}
function markMastered(f) { mastered.add(path.basename(f)); fsSync.writeFileSync(MASTERED, JSON.stringify([...mastered])); }
const inflight = new Map();
const voiceKey = (text, v, pid) => createHash('sha1').update(JSON.stringify([text, v.instruct, v.seed, v.speed, pid, v.effect, v.steps || null])).digest('hex');

// Uma única voz: a original do Jarvis no VoiceStudio. Sem voz reserva, para nunca misturar timbres.
// Se o VoiceStudio estiver fora do ar, o HUD mostra a fala só em texto.
// Fila única para o VoiceStudio: uma geração por vez (em paralelo uma atrasa a outra) e
// o que o senhor pede agora (live) sempre passa na frente do que é feito em segundo plano.
let hudVoiceAt = 0; // último pedido ao vivo: a regravação do add-on e o pré-aquecimento esperam
const VS = { busy: false, live: [], bg: [] };
function vsAcquire(live) { return new Promise((ok) => { if (!VS.busy) { VS.busy = true; ok(); } else (live ? VS.live : VS.bg).push(ok); }); }
function vsRelease() { const next = VS.live.shift() || VS.bg.shift(); if (next) next(); else VS.busy = false; }
const vsWaiting = () => VS.live.length;

async function tts(text, { live = true, rid = null } = {}) {
  if (live) hudVoiceAt = Date.now();
  const { voice } = await config();
  const pid = await resolveProfile(voice);
  const key = voiceKey(text, voice, pid);
  const file = path.join(CACHE, `${key}.wav`);
  const ev = (stage, extra = {}) => rid && emit({ type: 'tts', rid, stage, ...extra });
  if (existsSync(file)) { ev('cache'); return file; }
  if (inflight.has(key)) { ev('join'); return inflight.get(key); }
  const gen = (async () => {
    // segundo plano só ocupa a voz com o Jarvis em silêncio há 15 s (num Mac de 8 GB cada frase leva ~45 s)
    if (!live) while (Date.now() - hudVoiceAt < 15e3 || VS.live.length) await new Promise((r) => setTimeout(r, 2000));
    ev('queued', { ahead: (VS.busy ? 1 : 0) + VS.live.length });
    await vsAcquire(live);
    const t0 = Date.now();
    const v = await resolveVoice(voice);
    ev('generating', { profile: v.name || 'voz original', steps: voice.steps || 'padrão', chars: text.length });
    try {
      const form = new FormData();
      form.set('text', text);
      form.set('language', voice.language);
      form.set('speed', String(voice.speed));
      form.set('effect_preset', voice.effect);
      if (voice.steps) form.set('num_step', String(voice.steps)); // menos passos = voz bem mais rápida
      if (pid) form.set('profile_id', pid);
      else { form.set('instruct', voice.instruct); form.set('seed', String(voice.seed)); }
      const r = await fetch(`${voice.url}/generate`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`VoiceStudio ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      await writeFile(file, buf);
      if (voice.master?.enabled !== false) {
        ev('mastering');
        const rep = await masterInPlace(file, { lufs: voice.master?.lufs ?? -16, stereo: voice.master?.stereo !== false });
        if (rep) markMastered(file);
      }
      ev('done', { ms: Date.now() - t0, kb: Math.round(buf.length / 1024) });
      return file;
    } catch (e) { ev('error', { error: e.message }); throw e; } finally { vsRelease(); }
  })().finally(() => inflight.delete(key));
  inflight.set(key, gen);
  return gen;
}

// Frases frequentes geradas com antecedência, uma por vez, só quando o senhor não está usando o Jarvis.
const WARM = ['Bom dia, senhor. Todos os sistemas operacionais.', 'Boa tarde, senhor. Todos os sistemas operacionais.',
  'Boa noite, senhor. Todos os sistemas operacionais.', 'Sim, senhor?', 'Anotado, senhor.', 'Memorizado, senhor.', 'Briefing concluído. Estou à disposição, senhor.', 'Sempre às ordens, senhor.',
  'Dados sincronizados.', 'Modo presença ativado.', 'Centro de comando aberto.', 'Às suas ordens, senhor.',
  'Um momento, senhor.', 'Consultando.', 'Verificando, senhor.', 'Analisando.', 'Pesquisando, senhor.', 'Cruzando os dados.',
  'Estes são os comandos disponíveis, senhor.', 'Mostrando o processo ao vivo, senhor.', 'Painel financeiro aberto.',
  'Cancelado, senhor.', 'Confirma, senhor?', 'Não há nada aguardando confirmação, senhor.', 'Não consegui, senhor.'
  ];
let warming = false;
async function warmUp() {
  if (warming) return; warming = true;
  try {
    for (const t of WARM) {
      while (Date.now() - hudVoiceAt < 30e3 || vsWaiting() > 0) await new Promise((r) => setTimeout(r, 5000));
      const { voice } = await config();
      if (existsSync(path.join(CACHE, `${voiceKey(t, voice, await resolveProfile(voice))}.wav`))) continue;
      await tts(t, { live: false }).catch(() => {});
    }
  } finally { warming = false; }
}

const SOCIAL_HOSTS = ['instagram.com', 'ig.me', 'tiktok.com', 'youtube.com', 'linkedin.com', 'x.com', 'twitter.com', 'facebook.com', 'm.me', 'threads.net', 'threads.com', 'mail.google.com', 'web.whatsapp.com'];
// ---------- comunicação: contatos, e-mail e WhatsApp (sempre depois da confirmação do senhor) ----------
// AppleScript com os dados passados como argumentos (nunca colados no código do script)
const osaArgs = (script, args, timeout = 30000) => new Promise((ok) =>
  execFile('osascript', ['-e', script, ...args], { timeout }, (e, out = '', err = '') => ok({ ok: !e, out: out.trim(), err: String(err || e?.message || '').trim() })));
const CONTACTS = path.join(ROOT, 'data', 'contatos.json'); // atalhos opcionais: { "nome": { "email": "...", "whatsapp": "55..." } }
async function findContact(name, kind) {
  const want = fold(name);
  const local = JSON.parse(await readFile(CONTACTS, 'utf8').catch(() => '{}'));
  for (const [n, c] of Object.entries(local)) {
    const v = kind === 'phone' ? c.whatsapp || c.phone : c.email;
    if (v && fold(n) === want) return { found: [{ name: n, value: v }] };
  }
  if (!MAC) return { found: [], error: 'contatos do sistema indisponíveis' }; // Windows/Linux: use atalhos em data/contatos.json
  const script = `on run argv
  set q to item 1 of argv
  set k to item 2 of argv
  set out to ""
  tell application "Contacts"
    set ps to (every person whose name contains q)
    repeat with p in ps
      if k is "phone" then
        repeat with v in (phones of p)
          set out to out & (name of p) & tab & (value of v) & linefeed
        end repeat
      else
        repeat with v in (emails of p)
          set out to out & (name of p) & tab & (value of v) & linefeed
        end repeat
      end if
    end repeat
  end tell
  return out
end run`;
  const r = await osaArgs(script, [name, kind]);
  if (!r.ok) return { found: [], error: /not allowed|não tem permissão|-1743|-10004/i.test(r.err) ? 'sem permissão para os Contatos' : 'Contatos indisponível' };
  const found = r.out.split('\n').filter(Boolean).map((l) => { const [n, v] = l.split('\t'); return { name: n, value: v }; });
  // nome exato primeiro
  found.sort((a, b) => (fold(b.name) === want) - (fold(a.name) === want));
  return { found };
}
async function sendEmail(to, subject, text) {
  // 1) Mail do Mac, se tiver uma conta configurada
  const script = `on run argv
  tell application "Mail"
    if (count of accounts) is 0 then return "sem-conta"
    set m to make new outgoing message with properties {subject:(item 2 of argv), content:(item 3 of argv), visible:false}
    tell m to make new to recipient at end of to recipients with properties {address:(item 1 of argv)}
    send m
  end tell
  return "enviado"
end run`;
  if (MAC) {
    const r = await osaArgs(script, [to, subject, text], 45000);
    if (r.ok && r.out === 'enviado') return { sent: true, via: 'Mail' };
    if (r.ok && r.out === 'sem-conta') await osaArgs('tell application "Mail" to quit', []);
  }
  // reserva (e padrão no Windows/Linux): rascunho pronto no Gmail, no navegador; o senhor só clica em Enviar
  const u = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  await openExternal(u);
  return { sent: false, via: 'Gmail', draft: true, reason: MAC ? 'Mail sem conta' : 'sistema sem Mail do Mac' };
}
async function sendWhatsApp(digits, text) {
  if (digits.length <= 11) digits = '55' + digits; // número brasileiro sem DDI
  await openExternal(`whatsapp://send?phone=${digits}&text=${encodeURIComponent(text)}`);
  if (!MAC) return { sent: false, via: 'WhatsApp', prefilled: true, reason: 'sistema sem envio automático' };
  await new Promise((r) => setTimeout(r, 3500)); // o WhatsApp abre a conversa com o texto já escrito
  const r = await osaArgs(`tell application "WhatsApp" to activate
delay 0.6
tell application "System Events" to tell process "WhatsApp" to key code 36`, [], 15000);
  if (r.ok) return { sent: true, via: 'WhatsApp' };
  return { sent: false, via: 'WhatsApp', prefilled: true, reason: /not allowed|assistive|-1719|-25211/i.test(r.err) ? 'sem permissão de Acessibilidade' : r.err.slice(0, 120) };
}

// ---------- memória de longo prazo (visível e apagável) ----------
const MEM = path.join(ROOT, 'data', 'memory.json');
const loadMem = async () => JSON.parse(await readFile(MEM, 'utf8').catch(() => '[]'));
const saveMem = (m) => writeFile(MEM, JSON.stringify(m, null, 2) + '\n');

// ---------- telemetria real do Mac ----------
let cpuPrev = os.cpus();
function cpuUsage() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const a = c.times, b = cpuPrev[i]?.times || a;
    const t = Object.keys(a).reduce((s, k) => s + (a[k] - b[k]), 0);
    total += t; idle += a.idle - b.idle;
  });
  cpuPrev = now;
  return total ? Math.round((1 - idle / total) * 100) : 0;
}
async function battery() {
  return new Promise((ok) => execFile('pmset', ['-g', 'batt'], { timeout: 2000 }, (e, out = '') => {
    const m = out.match(/(\d+)%;\s*([^;]+)/);
    ok(m ? { pct: Number(m[1]), state: m[2].trim() } : null);
  }));
}
async function telemetry() {
  const total = os.totalmem(), free = os.freemem();
  return {
    cpu: cpuUsage(), cores: os.cpus().length, load: os.loadavg()[0],
    mem: Math.round((1 - free / total) * 100), memTotalGB: Math.round(total / 2 ** 30),
    uptimeH: Math.round(os.uptime() / 3600), battery: await battery(),
    host: os.hostname().replace(/\.local$/, ''), net: Object.values(os.networkInterfaces()).flat().filter((i) => !i.internal && i.family === 'IPv4').length,
  };
}

// ---------- apps do Mac (abrir/fechar por voz) ----------
// Só abre/fecha apps .app instalados; nunca executa texto livre no shell.
const APP_DIRS = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];
const APP_ALIASES = {
  'vs code': 'Visual Studio Code', vscode: 'Visual Studio Code', codigo: 'Visual Studio Code', code: 'Visual Studio Code',
  chrome: 'Google Chrome', navegador: 'Google Chrome', whats: 'WhatsApp', zap: 'WhatsApp',
  agenda: 'Calendar', calendario: 'Calendar', notas: 'Notes', lembretes: 'Reminders', email: 'Mail', 'e-mail': 'Mail',
  outlook: 'Microsoft Outlook', excel: 'Microsoft Excel', planilha: 'Microsoft Excel', word: 'Microsoft Word',
  powerpoint: 'Microsoft PowerPoint', teams: 'Microsoft Teams', zoom: 'zoom.us', musica: 'Music', calculadora: 'Calculator',
  configuracoes: 'System Settings', ajustes: 'System Settings', fotos: 'Photos', mapas: 'Maps', mensagens: 'Messages',
  tiktok: 'TikTok LIVE Studio', obs: 'OBS', claude: 'Claude', obsidian: 'Obsidian',
};
// Nunca fechados pelo Jarvis: ele próprio depende deles.
const PROTECTED = ['Claude', 'VoiceStudio', 'Finder'];
const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

let appIndex = null;
async function apps() {
  if (appIndex) return appIndex;
  const found = new Map();
  if (MAC) for (const d of APP_DIRS) {
    for (const f of await readdir(d).catch(() => [])) if (f.endsWith('.app')) found.set(f.slice(0, -4), path.join(d, f));
  }
  appIndex = found;
  setTimeout(() => { appIndex = null; }, 10 * 60e3);
  return found;
}
async function resolveApp(name) {
  const all = await apps();
  const n = fold(name).replace(/^(o|a|os|as)\s+/, '').replace(/[.!?]$/, '');
  const alias = APP_ALIASES[n];
  if (alias && (!MAC || all.has(alias))) return alias;
  if (!MAC) return name.replace(/^(o|a|os|as)\s+/i, '').replace(/[.!?]$/, '').trim() || null; // Windows/Linux: abre pelo nome dito
  const names = [...all.keys()];
  return names.find((a) => fold(a) === n) || names.find((a) => fold(a).startsWith(n)) || names.find((a) => n.length >= 3 && fold(a).includes(n)) || null;
}
const osa = (script) => new Promise((ok) => execFile('osascript', ['-e', script], { timeout: 15000 }, (e, out = '') => ok(e ? null : out.trim())));
const exeName = (app) => (/\.exe$/i.test(app) ? app : app + '.exe');
async function isRunning(app) {
  if (MAC) return (await osa(`application "${app.replace(/"/g, '')}" is running`)) === 'true';
  if (WIN) { const out = await new Promise((ok) => execFile('tasklist', ['/FI', `IMAGENAME eq ${exeName(app)}`], { timeout: 8000 }, (e, o = '') => ok(o))); return out.toLowerCase().includes(exeName(app).toLowerCase()); }
  const out = await new Promise((ok) => execFile('pgrep', ['-fi', app], { timeout: 8000 }, (e, o = '') => ok(o))); return !!out.trim();
}
async function openApp(app) {
  if (MAC) { const all = await apps(); await new Promise((ok, fail) => execFile('open', ['-a', all.get(app) || app], { timeout: 15000 }, (e) => (e ? fail(e) : ok()))); return; }
  if (WIN) { await run('cmd', ['/c', 'start', '', app], 12000); return; } // abre pelo nome/registro do Windows
  await run('xdg-open', [app], 12000).catch(() => run(app.toLowerCase(), [], 12000));
}
async function closeApp(app) {
  if (PROTECTED.includes(app)) throw new Error(`${app} é protegido`);
  if (!(await isRunning(app))) return false;
  if (MAC) await osa(`tell application "${app.replace(/"/g, '')}" to quit`); // fechamento normal: pede para salvar se precisar
  else if (WIN) await run('taskkill', ['/IM', exeName(app)], 8000).catch(() => {}); // sem /F: fecha a janela normalmente
  else await run('pkill', ['-fi', app], 8000).catch(() => {});
  return true;
}

// Modos de produtividade (editáveis em config.json → "modes").
const DEFAULT_MODES = {
  foco: { label: 'Modo foco', open: ['Visual Studio Code', 'Obsidian'], close: ['WhatsApp', 'Discord', 'Steam', 'TikTok LIVE Studio', 'Kick'] },
  trabalho: { label: 'Modo trabalho', open: ['Microsoft Outlook', 'Microsoft Excel', 'Calendar'], close: ['Steam', 'Discord', 'TikTok LIVE Studio'] },
  reuniao: { label: 'Modo reunião', open: ['zoom.us', 'Calendar', 'Notes'], close: ['Steam', 'Discord', 'TikTok LIVE Studio', 'Music'] },
  lazer: { label: 'Modo lazer', open: ['Steam', 'Discord'], close: ['Microsoft Outlook', 'Microsoft Teams', 'Microsoft Excel'] },
};
async function modePlan(id) {
  const cfg = await config();
  const m = (cfg.modes || DEFAULT_MODES)[id];
  if (!m) return null;
  const all = await apps();
  const open = m.open.filter((a) => all.has(a));
  const close = [];
  for (const a of m.close) if (all.has(a) && !PROTECTED.includes(a) && (await isRunning(a))) close.push(a);
  return { id, label: m.label, open, close };
}

// ---------- leitura de tela (captura + OCR local) ----------
async function readScreen() {
  if (!MAC) { const e = new Error('leitura de tela disponível só no macOS por enquanto'); e.unsupported = true; throw e; }
  const png = path.join(os.tmpdir(), `jarvis-tela-${Date.now()}.png`);
  try {
    await new Promise((ok, fail) => execFile('screencapture', ['-x', '-m', png], { timeout: 15000 }, (e, _o, err) => (e ? fail(new Error(String(err || e.message).trim())) : ok())));
    const out = await new Promise((ok, fail) => execFile(path.join(APP, 'tools', 'ocr'), [png], { timeout: 30000, maxBuffer: 4 << 20 }, (e, o) => (e ? fail(e) : ok(o))));
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    const alerts = lines.filter((l) => /\b(error|erro|exception|traceback|failed|falhou|falha|warning|aviso|denied|negad)/i.test(l));
    return { lines, alerts, at: Date.now() };
  } finally {
    await unlink(png).catch(() => {}); // a imagem nunca fica salva
  }
}

// ---------- cérebro: Claude Code headless (somente leitura) ----------
// Usa o Claude Code que vem com o app do Claude. Só funciona depois do login dele no terminal.
// Ferramentas permitidas: leitura de arquivos e pesquisa na web. Nada que escreva, apague ou execute.
const BRAIN_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
const BRAIN_BLOCK = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'MultiEdit'];
// O prompt fica em ~/jarvis/prompts/jarvis-cerebro.md (editável). Este é só o mínimo de segurança se o arquivo sumir.
const BRAIN_FALLBACK = 'Você é o Jarvis, assistente pessoal do Washington. Responda em português, tratando-o por "senhor", em até 3 frases curtas, sem markdown. Só leia arquivos e pesquise na web; nunca envie, apague, compre ou altere nada. Nunca invente números.';
const HISTORY = []; // conversa recente (memória de curto prazo, só enquanto o servidor estiver ligado)

async function brainContext() {
  const persona = (await read('prompts/jarvis-cerebro.md')) || BRAIN_FALLBACK;
  const mem = (await loadMem()).slice(-40).map((m) => `- ${m.text}`).join('\n') || '- (nada memorizado ainda)';
  const mk = await market().catch(() => []);
  const fmtN = (n) => n == null ? '—' : n.toLocaleString('pt-BR', { maximumFractionDigits: n < 10 ? 3 : 2 });
  const mkt = mk.map((q) => `- ${q.n}: ${q.u} ${fmtN(q.price)} (${q.change == null ? '—' : (q.change >= 0 ? '+' : '') + q.change.toFixed(2) + '% no dia'})`).join('\n') || '- indisponível';
  const mktWhen = mk.length ? new Date(Math.max(...mk.map((q) => q.time || 0))).toLocaleString('pt-BR') : '';
  const st = await state().catch(() => null);
  const b = st?.briefing || {};
  const brief = [...(b.noticias || []), ...(b.regulacao || []), ...(b.oportunidades || [])].slice(0, 10).map((x) => `- ${x}`).join('\n') || '- (sem briefing hoje)';
  const hist = HISTORY.slice(-6).map((h) => `Senhor: ${h.q}\nJarvis: ${h.a}`).join('\n') || '(início da conversa)';
  return [persona,
    `## Hoje\n${new Date().toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' })}`,
    `## Memória\n${mem}`,
    `## Mercado agora (Yahoo Finance, última cotação ${mktWhen})\n${mkt}`,
    `## Briefing do dia (${st?.dailyFile || 'nenhum'})\n${brief}`,
    `## Conversa recente\n${hist}`].join('\n\n');
}

// Linhas "MEMORIZAR: ..." viram memória de longo prazo (sem duplicar) e saem do texto falado.
async function absorbMemories(text) {
  const found = [...text.matchAll(/^\s*MEMORIZAR:\s*(.+)$/gim)].map((m) => m[1].trim()).filter(Boolean).slice(0, 2);
  const clean = text.replace(/^\s*MEMORIZAR:.*$/gim, '').trim();
  if (!found.length) return { clean, saved: [] };
  const m = await loadMem();
  const have = new Set(m.map((x) => x.text.toLowerCase()));
  const saved = [];
  for (const f of found) {
    if (have.has(f.toLowerCase()) || /senha|cpf|cart[aã]o|conta banc/i.test(f)) continue;
    m.push({ id: createHash('sha1').update(f + Date.now()).digest('hex').slice(0, 8), text: f, at: new Date().toISOString(), origem: 'cerebro' });
    saved.push(f);
  }
  if (saved.length) await saveMem(m);
  return { clean, saved };
}

async function brainBin() {
  const { brain } = await config();
  if (brain?.bin && existsSync(brain.bin)) return brain.bin;
  // macOS e Windows guardam o Claude Code em lugares diferentes
  const base = MAC ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code')
    : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code');
  const versions = (await readdir(base).catch(() => [])).filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => a.split('.').map(Number).reduce((r, x, i) => r || x - b.split('.').map(Number)[i], 0));
  for (const v of versions.reverse()) {
    for (const h of await readdir(path.join(base, v)).catch(() => [])) {
      const bin = MAC ? path.join(base, v, h, 'claude.app', 'Contents', 'MacOS', 'claude') : path.join(base, v, h, 'claude.exe');
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}
const runJson = (bin, args, timeout) => new Promise((ok) => execFile(bin, args, { cwd: ROOT, timeout, maxBuffer: 8 << 20 }, (e, out = '') => {
  try { ok(JSON.parse(out)); } catch { ok({ is_error: true, result: e?.message || 'resposta inválida' }); }
}));
let brainState = { t: 0, v: null };
// Cérebro pela API do Claude (SDK oficial). A chave fica em config.json → "brain": { "apiKey": "..." }
// ou na variável ANTHROPIC_API_KEY. Sem chave, usa o Claude Code logado (se houver).
async function apiKey() {
  const { brain } = await config();
  return (brain?.apiKey || process.env.ANTHROPIC_API_KEY || '').trim();
}
async function brainStatus() {
  if (Date.now() - brainState.t < 60e3) return brainState.v;
  const key = await apiKey();
  const bin = await brainBin();
  let cliLogged = false;
  if (!key && bin) { const s = await runJson(bin, ['auth', 'status'], 15000); cliLogged = !!s.loggedIn; }
  const v = { api: !!key, installed: !!bin, loggedIn: cliLogged, ready: !!key || cliLogged, via: key ? 'API do Claude' : cliLogged ? 'Claude Code' : null };
  brainState = { t: Date.now(), v };
  return v;
}

let anthropic = null, anthropicKey = '';
async function askClaudeApi(text) {
  const key = await apiKey();
  if (!anthropic || anthropicKey !== key) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: key, timeout: 120000, maxRetries: 2 });
    anthropicKey = key;
  }
  const { brain } = await config();
  const ctx = await brainContext();
  const cut = ctx.indexOf('\n\n## Hoje');
  // prompt fixo primeiro (vai para o cache), contexto do momento depois
  const system = [
    { type: 'text', text: cut > 0 ? ctx.slice(0, cut) : ctx, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: cut > 0 ? ctx.slice(cut + 2) : '' },
  ].filter((x) => x.text);
  const messages = [{ role: 'user', content: text }];
  let answer = '';
  for (let turn = 0; turn < 3; turn++) { // pause_turn: a pesquisa na web pode pedir continuação
    const r = await anthropic.beta.messages.create({
      model: brain?.model || 'claude-opus-5-5',
      max_tokens: 4000,
      output_config: { effort: brain?.effort || 'low' }, // respostas curtas faladas: rápido e barato
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
      system,
      messages,
    });
    if (r.stop_reason === 'refusal') return { ok: false, reason: 'refusal' };
    answer += r.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    if (r.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: r.content });
  }
  return { ok: true, raw: answer };
}

let brainBusy = false;
async function askBrain(text) {
  const st = await brainStatus();
  if (!st.ready) return { ok: false, reason: st.installed ? 'not-logged-in' : 'not-configured' };
  if (brainBusy) return { ok: false, reason: 'busy' };
  brainBusy = true;
  try {
    let raw;
    if (st.api) {
      try {
        const r = await askClaudeApi(text);
        if (!r.ok) return r;
        raw = r.raw;
      } catch (e) {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        if (e instanceof Anthropic.AuthenticationError) { brainState.t = 0; return { ok: false, reason: 'bad-key' }; }
        if (e instanceof Anthropic.RateLimitError) return { ok: false, reason: 'busy' };
        if (e instanceof Anthropic.APIError) return { ok: false, reason: 'error', detail: `API ${e.status}: ${String(e.message).slice(0, 160)}` };
        return { ok: false, reason: 'error', detail: String(e.message || e).slice(0, 160) };
      }
    } else {
      // voz: poucas rodadas e tempo-limite curto para o senhor não esperar; modelo rápido vindo do config
      const { brain } = await config();
      const model = brain?.model || 'claude-sonnet-5-5';
      const maxTurns = String(brain?.maxTurns ?? 3);
      const r = await runJson(await brainBin(), ['-p', text, '--output-format', 'json', '--max-turns', maxTurns,
        '--model', model, '--allowedTools', ...BRAIN_TOOLS, '--disallowedTools', ...BRAIN_BLOCK,
        '--append-system-prompt', await brainContext()], brain?.timeoutMs ?? 60000);
      if (r.is_error) return { ok: false, reason: 'error', detail: String(r.result || '').slice(0, 200) };
      raw = String(r.result || '');
    }
    const { clean, saved } = await absorbMemories(raw);
    let spoken = clean.replace(/[*#`_>]/g, '').trim();
    // mantém a resposta curta (voz): no máximo ~3 frases
    const sents = spoken.match(/[^.!?]+[.!?]+/g);
    if (sents && sents.length > 3) spoken = sents.slice(0, 3).join(' ').trim();
    HISTORY.push({ q: text.slice(0, 300), a: spoken.slice(0, 400) });
    if (HISTORY.length > 12) HISTORY.shift();
    return { ok: true, text: spoken, saved, via: st.via };
  } finally { brainBusy = false; }
}

// ---------- HTTP ----------
async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
const send = (res, code, data, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, await readFile(path.join(APP, 'public/index.html')), 'text/html; charset=utf-8');
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/audio\/[a-z0-9-]+\.(mp3|m4a)$/.test(url.pathname)) {
      const f = path.join(APP, 'public', url.pathname);
      const type = url.pathname.endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg';
      if (!existsSync(f)) return send(res, 404, { error: 'não encontrado' });
      if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': type }); return res.end(); }
      return send(res, 200, await readFile(f), type);
    }
    if (req.method === 'GET' && url.pathname === '/api/opening') {
      const { opening } = await config();
      return send(res, 200, { youtubeId: opening?.youtubeId || null, inicio: Math.max(0, Number(opening?.inicio) || 0), titulo: opening?.titulo || '' });
    }
    // estúdio de vídeo: ~/jarvis/video (página, narração) e gravação do resultado em ~/jarvis/video/saida
    if (req.method === 'GET' && /^\/video\/[a-z0-9-]+(\/[a-z0-9-]+)?\.(html|wav|json)$/.test(url.pathname)) {
      const f = path.join(ROOT, url.pathname);
      if (!f.startsWith(path.join(ROOT, 'video')) || !existsSync(f)) return send(res, 404, { error: 'não encontrado' });
      const type = f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.wav') ? 'audio/wav' : 'application/json';
      return send(res, 200, await readFile(f), type);
    }
    if (req.method === 'POST' && url.pathname === '/api/video/save') {
      const name = (url.searchParams.get('nome') || 'video').replace(/[^a-z0-9-]/gi, '') || 'video';
      const ext = String(req.headers['content-type'] || '').includes('mp4') ? 'mp4' : 'webm';
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 300 << 20) return send(res, 413, { error: 'grande demais' }); chunks.push(c); }
      await mkdir(path.join(ROOT, 'video', 'saida'), { recursive: true });
      const f = path.join(ROOT, 'video', 'saida', `${name}.${ext}`);
      await writeFile(f, Buffer.concat(chunks));
      return send(res, 200, { ok: true, file: f, mb: +(size / 1048576).toFixed(1) });
    }
    if (req.method === 'POST' && url.pathname === '/api/trace') {
      // rastro completo de cada pedido (o mesmo do painel Processo ao vivo), para conferir testes
      const t = await body(req);
      await appendFile(path.join(CACHE, 'traces.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...t }) + '\n');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const f = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      bus.on('ev', f);
      req.on('close', () => { clearInterval(ping); bus.off('ev', f); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/warm') {
      // antecipação: o HUD manda as frases que provavelmente vai falar; a voz é gerada em segundo plano
      const { texts = [] } = await body(req);
      const { voice } = await config();
      const pid = await resolveProfile(voice);
      const todo = [...new Set(texts.map((x) => String(x).trim()).filter((x) => x && x.length <= 600))].slice(0, 40)
        .filter((x) => !existsSync(path.join(CACHE, `${voiceKey(x, voice, pid)}.wav`)));
      (async () => { for (const x of todo) await tts(x, { live: false }).catch(() => {}); })();
      return send(res, 200, { queued: todo.length });
    }
    if (req.method === 'GET' && url.pathname === '/api/hud-busy') return send(res, 200, { busy: Date.now() - hudVoiceAt < 5 * 60e3 || VS.busy });
    if (req.method === 'POST' && url.pathname === '/api/stt') {
      // transcrição local (reserva do microfone): áudio curto do navegador -> VoiceStudio, nada sai do Mac
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 4 << 20) return send(res, 413, { error: 'áudio grande demais' }); chunks.push(c); }
      const type = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm';
      const { voice } = await config();
      const rid = url.searchParams.get('rid'), t0 = Date.now();
      if (rid) emit({ type: 'stt', rid, stage: 'start', kb: Math.round(size / 1024) });
      const form = new FormData();
      form.set('file', new Blob([Buffer.concat(chunks)], { type }), `fala.${ext}`);
      form.set('model', 'whisper-1'); form.set('language', 'pt');
      form.set('prompt', 'Jarvis, senhor, Brent, WTI, Petrobras, Vale, Gerdau, ANP, ANM, Excel, modo foco, modo presença.');
      try {
        const r = await fetch(`${voice.url}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
        const j = await r.json().catch(() => ({}));
        if (rid) emit({ type: 'stt', rid, stage: r.ok ? 'done' : 'error', ms: Date.now() - t0 });
        return send(res, r.ok ? 200 : 502, r.ok ? { text: String(j.text || '').trim() } : { error: 'transcrição falhou' });
      } catch (e) { return send(res, 503, { error: 'VoiceStudio indisponível: ' + e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/brain/context') return send(res, 200, await brainContext(), 'text/plain; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/brain') return send(res, 200, await brainStatus());
    if (req.method === 'POST' && url.pathname === '/api/brain') {
      const { text, rid } = await body(req);
      if (!text?.trim()) return send(res, 400, { error: 'texto vazio' });
      const t0 = Date.now(), st = await brainStatus();
      if (rid) emit({ type: 'brain', rid, stage: 'start', via: st.via || 'sem cérebro configurado' });
      const out = await askBrain(text.trim().slice(0, 1000));
      if (rid) emit({ type: 'brain', rid, stage: out.ok ? 'done' : 'error', ms: Date.now() - t0, reason: out.reason, saved: out.saved?.length || 0 });
      return send(res, 200, out);
    }
    if (req.method === 'GET' && url.pathname === '/teste-comandos.js') return send(res, 200, await readFile(path.join(APP, 'public', 'teste-comandos.js')), 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, await state());
    if (req.method === 'GET' && url.pathname === '/api/live') {
      const [m, w, n, v, c] = await Promise.allSettled([market(), weather(), news(), voiceStatus(), crypto()]);
      const val = (x) => (x.status === 'fulfilled' ? x.value : null);
      return send(res, 200, { market: [...(val(m) || []), ...(val(c) || [])], weather: val(w), news: val(n) || {}, voice: val(v), at: Date.now() });
    }
    if (req.method === 'GET' && url.pathname === '/api/tts') {
      const text = (url.searchParams.get('text') || '').trim().slice(0, 600);
      if (!text) return send(res, 400, { error: 'texto vazio' });
      try { return send(res, 200, await readFile(await tts(text, { rid: url.searchParams.get('rid') })), 'audio/wav'); }
      catch (e) { return send(res, 503, { error: 'voz indisponível: ' + e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/telemetry') return send(res, 200, await telemetry());
    if (req.method === 'POST' && url.pathname === '/api/app') {
      const { action, name } = await body(req);
      const app = name && (await resolveApp(name));
      if (!app) return send(res, 404, { error: `não encontrei o app “${name || ''}”` });
      if (action === 'open') { await openApp(app); return send(res, 200, { app, done: true }); }
      if (action === 'close') {
        if (PROTECTED.includes(app)) return send(res, 403, { app, error: 'protegido' });
        return send(res, 200, { app, done: await closeApp(app) });
      }
      return send(res, 400, { error: 'ação inválida' });
    }
    if (req.method === 'GET' && url.pathname === '/api/modes') {
      const cfg = await config();
      return send(res, 200, Object.fromEntries(Object.entries(cfg.modes || DEFAULT_MODES).map(([k, m]) => [k, m.label])));
    }
    if (req.method === 'POST' && url.pathname === '/api/mode') {
      const { mode, confirm } = await body(req);
      const plan = await modePlan(mode);
      if (!plan) return send(res, 404, { error: 'modo desconhecido' });
      if (!confirm) return send(res, 200, { plan, executed: false });
      const closed = [], opened = [], failed = [];
      for (const a of plan.close) await closeApp(a).then(() => closed.push(a)).catch(() => failed.push(a));
      for (const a of plan.open) await openApp(a).then(() => opened.push(a)).catch(() => failed.push(a));
      return send(res, 200, { plan, executed: true, closed, opened, failed });
    }
    if (req.method === 'POST' && url.pathname === '/api/screen') {
      try { return send(res, 200, await readScreen()); }
      catch (e) {
        const perm = /could not create image|not permitted|permission/i.test(e.message);
        return send(res, perm ? 403 : 500, { error: perm ? 'sem permissão de Gravação de Tela' : e.message });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/memory') return send(res, 200, await loadMem());
    if (req.method === 'POST' && url.pathname === '/api/memory') {
      const { text } = await body(req);
      if (!text?.trim()) return send(res, 400, { error: 'texto vazio' });
      const m = await loadMem();
      const item = { id: createHash('sha1').update(text + Date.now()).digest('hex').slice(0, 8), text: text.trim(), at: new Date().toISOString() };
      m.push(item); await saveMem(m);
      return send(res, 200, item);
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/memory/')) {
      const id = url.pathname.split('/').pop();
      const m = await loadMem();
      await saveMem(m.filter((x) => x.id !== id));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/capture') {
      const { text } = await body(req);
      if (!text?.trim()) return send(res, 400, { error: 'texto vazio' });
      await appendFile(path.join(ROOT, 'inbox.md'), `- [ ] ${text.trim().replace(/\n/g, ' ')}\n`);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/contact') {
      const name = (url.searchParams.get('name') || '').trim(), kind = url.searchParams.get('kind') === 'phone' ? 'phone' : 'email';
      if (!name) return send(res, 400, { error: 'nome vazio' });
      return send(res, 200, await findContact(name, kind));
    }
    if (req.method === 'POST' && url.pathname === '/api/send-email') {
      // só chega aqui depois do "sim" do senhor na central
      const { to, subject, body: text, confirm } = await body(req);
      if (!confirm) return send(res, 400, { error: 'falta a confirmação' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to || '') || !text?.trim()) return send(res, 400, { error: 'destinatário ou texto inválido' });
      return send(res, 200, await sendEmail(to, subject || 'Mensagem', text));
    }
    if (req.method === 'POST' && url.pathname === '/api/whatsapp') {
      const { phone, text, confirm } = await body(req);
      if (!confirm) return send(res, 400, { error: 'falta a confirmação' });
      const digits = String(phone || '').replace(/\D/g, '');
      if (digits.length < 10 || !text?.trim()) return send(res, 400, { error: 'número ou texto inválido' });
      return send(res, 200, await sendWhatsApp(digits, text));
    }
    if (req.method === 'POST' && url.pathname === '/api/heard') {
      // o que o microfone ouviu (só neste Mac): ajuda a achar comandos perdidos
      const { said, used } = await body(req);
      const f = path.join(CACHE, 'heard.log');
      const line = `${new Date().toLocaleString('pt-BR')}\t${String(used || '').slice(0, 40)}\t${String(said || '').replace(/\s+/g, ' ').slice(0, 300)}\n`;
      const old = (await readFile(f, 'utf8').catch(() => '')).split('\n').filter(Boolean).slice(-299);
      await writeFile(f, old.join('\n') + (old.length ? '\n' : '') + line);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/open-url') {
      // só redes sociais e serviços conhecidos; nada de endereço ditado solto
      const { url: u } = await body(req);
      let host = ''; try { host = new URL(u).hostname.replace(/^www\./, ''); } catch {}
      if (!SOCIAL_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return send(res, 400, { error: 'site não permitido' });
      await openExternal(u);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/clipboard') {
      const { text } = await body(req);
      if (!text?.trim()) return send(res, 400, { error: 'texto vazio' });
      await new Promise((ok) => { const p = execFile('pbcopy', [], () => ok()); p.stdin.end(String(text)); });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/reveal-video') {
      // mostra no Finder o vídeo mais recente da pasta de saída (para arrastar na página de envio)
      const dir = path.join(ROOT, 'video', 'saida');
      const files = (await readdir(dir).catch(() => [])).filter((f) => /\.(mp4|mov)$/i.test(f) && !/rascunho|sem-limpeza/i.test(f));
      if (!files.length) return send(res, 404, { error: 'nenhum vídeo em video/saida' });
      const newest = files.map((f) => ({ f, t: fsSync.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0].f;
      await revealInFolder(path.join(dir, newest));
      return send(res, 200, { ok: true, file: newest });
    }
    send(res, 404, { error: 'não encontrado' });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, '127.0.0.1', () => { console.log(`Jarvis HUD em http://localhost:${PORT}`); warmUp(); });
