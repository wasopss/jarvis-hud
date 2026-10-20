// Gera a narração de cada cena com a voz única do Jarvis (perfil do dublador), uma por vez.
import { synth } from '../app/tools/speak.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'audio');
// qualidade máxima para o vídeo: mais passos, sem efeito do VoiceStudio (a masterização cuida disso) e -14 LUFS (redes sociais)
const QUALIDADE = { steps: 32, effect: 'raw', lufs: -14 };
export const CENAS = [
  'Olá, senhor Uósh. Eu sou o Jarvis, o seu assistente pessoal. Vou mostrar como eu funciono e tudo o que eu sei fazer.',
  'Passo um: eu escuto. Quando ele diz Jarvis, o microfone transforma a fala em texto, em menos de um segundo.',
  'Passo dois: eu entendo. Eu identifico o pedido. Pode ser abrir um programa, anotar uma tarefa ou consultar o mercado.',
  'Passo três: eu busco os dados. Cotações, clima, notícias do setor e a minha memória, sempre com fonte. Eu não invento números.',
  'Passo quatro: eu respondo com voz. O texto vira fala no próprio computador, sem mandar a voz para a nuvem.',
  'Passo cinco: eu peço permissão. Enviar, apagar ou comprar, só com a aprovação dele.',
  'E eu faço muito mais: agendo mensagens, envio e-mails, abro programas, leio a tela, guardo lembretes e preparo o resumo do dia às sete da manhã. Tudo com a sua aprovação.',
  'Você conversa comigo como com uma pessoa. Me conte o problema: eu analiso a situação, comparo as opções e sugiro o próximo passo.',
  'E eu acompanho o mercado ao vivo: ações, petróleo, Bitcoin e Etérium. Eu analiso o cenário e explico os riscos, mas a decisão de investir é sempre sua.',
  'Quer um assistente assim? Comente a palavra Jarvis, que eu explico.',
];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [i, t] of CENAS.entries()) {
    const f = path.join(DIR, `cena-${i + 1}.wav`);
    if (existsSync(f)) { console.log(`cena ${i + 1}: já pronta`); continue; }
    const t0 = Date.now();
    await synth(t, f, QUALIDADE);
    console.log(`cena ${i + 1}: pronta em ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  console.log('narração concluída');
}
