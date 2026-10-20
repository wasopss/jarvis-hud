// Bateria de testes dos comandos de voz do Jarvis.
// Roda dentro da central (http://localhost:4777/?teste=1) com as ações SIMULADAS:
// nada é aberto, gravado, lido do Gmail ou enviado. Mostra cada frase, o que o Jarvis fez e se passou.
window.runCommandTests = async function runCommandTests() {
  const CASES = [
    // mercado
    ['Jarvis, como está o mercado?', { said: /dólares|reais/ }],
    ['como tá o mercado hoje', { said: /dólares|reais/ }],
    ['qual a cotação do petróleo', { said: /dólares/ }],
    ['quanto tá o dólar', { said: /Dólar/ }],
    ['como está a Petrobras', { said: /Petrobras/ }],
    ['e a Vale?', { said: /Vale/ }],
    ['como está a Gerdau', { said: /Gerdau/ }],
    ['e o ouro?', { said: /Ouro/ }],
    // clima
    ['como está o clima', { said: /graus/ }],
    ['como tá o tempo lá fora', { said: /graus/ }],
    ['vai chover hoje?', { said: /graus|chuva/ }],
    ['qual a temperatura', { said: /graus/ }],
    ['previsão do tempo', { said: /graus/ }],
    // notícias e licitações
    ['quais as notícias do setor', { said: /Petróleo e gás|Mineração|Indústria|Licitações|Sem manchetes/ }],
    ['tem novidade no setor?', { said: /Petróleo e gás|Mineração|Indústria|Licitações|Sem manchetes/ }],
    ['me dá as manchetes', { said: /Petróleo e gás|Mineração|Indústria|Licitações|Sem manchetes/ }],
    ['tem alguma licitação nova?', { said: /./, notCall: /brain/ }],
    // dia e briefing
    ['Jarvis, como está meu dia?', { said: /prioridade|inbox/i }],
    ['quais minhas prioridades', { said: /prioridade|inbox/i }],
    ['Jarvis, bom dia', { said: /Briefing concluído/ }],
    ['me dá o briefing', { said: /Briefing concluído/ }],
    // painéis
    ['Abra meu painel financeiro.', { view: 'financeiro' }],
    ['mostra a carteira', { view: 'financeiro' }],
    ['Mostre as fontes de dados.', { view: 'fontes' }],
    ['Abra o monitoramento.', { view: 'monitor' }],
    ['como está o sistema', { said: /Processador|Sistema/ }],
    ['quais são os comandos?', { view: 'comandos' }],
    ['ajuda', { view: 'comandos' }],
    ['o que você sabe fazer?', { view: 'comandos' }],
    ['Modo presença.', { presence: true }],
    ['tela cheia', { presence: true }],
    ['volta para o centro de comando', { view: 'centro', presence: false }],
    ['mostre o processo', { pipe: true }],
    // modos e apps
    ['Jarvis, modo foco.', { call: /\/api\/mode/ }],
    ['ativa o modo trabalho', { call: /\/api\/mode/ }],
    ['modo reunião', { call: /\/api\/mode/ }],
    ['Abre o Excel.', { call: /\/api\/app.*"open".*"Excel"/ }],
    ['abra o Excel pra mim', { call: /\/api\/app.*"open".*"Excel"/ }],
    ['abrir a calculadora', { call: /\/api\/app.*"open".*calculadora/ }],
    ['fecha o WhatsApp', { call: /\/api\/app.*"close".*WhatsApp/ }],
    ['encerra o Steam por favor', { call: /\/api\/app.*"close".*"Steam"/ }],
    // tela
    ['Leia a tela.', { call: /\/api\/screen/ }],
    ['lê a tela', { call: /\/api\/screen/ }],
    ['o que tem na minha tela?', { call: /\/api\/screen/ }],
    // memória e inbox
    ['Lembre que eu prefiro reuniões pela manhã.', { call: /\/api\/memory.*prefiro reuni/ }],
    ['guarde que meu cliente principal é a Prio', { call: /\/api\/memory.*cliente principal/ }],
    ['o que você sabe sobre mim?', { said: /memória|memorizado/i }],
    ['Anota ligar para a Prio amanhã.', { call: /\/api\/capture.*ligar para a Prio/ }],
    ['me lembra de pagar o boleto', { call: /\/api\/capture.*pagar o boleto/ }],
    ['o que tem no inbox?', { said: /inbox/i }],
    // e-mails
    ['tem algum e-mail importante?', { said: /e-mail|e-mails/i }],
    ['olha meu gmail', { said: /e-mail|e-mails/i }],
    // comunicação (só monta e pede confirmação; nada é enviado)
    ['manda um e-mail para a Ana dizendo que chego às 10', { said: /e-mail para Ana: Chego às 10\. Confirma/, notCall: /send-email|whatsapp|brain/ }],
    ['Jarvis, manda uma mensagem no WhatsApp pro João falando que já saí', { said: /WhatsApp para João: Já saí\. Confirma/, notCall: /send-email|\/api\/whatsapp|brain/ }],
    ['envia um zap pra Maria dizendo: me lembra de comprar pão', { said: /Maria: Me lembra de comprar pão/, notCall: /capture|brain/ }],
    ['envie um email pro Carlos avisando que a reunião mudou para amanhã', { said: /Carlos: A reunião mudou para amanhã/ }],
    // redes sociais (abre/copia simulado; nada é publicado)
    ['abre o Instagram', { call: /open-url.*instagram\.com\/"/, said: /Abrindo o Instagram/ }],
    ['Jarvis, abre o TikTok', { call: /open-url.*tiktok\.com\/"/ }],
    ['abre o LinkedIn pra mim', { call: /open-url.*linkedin\.com\/feed/ }],
    ['abre minhas mensagens do Instagram', { call: /open-url.*direct\/inbox/ }],
    ['mostra as notificações do TikTok', { call: /open-url.*tiktok\.com\/messages/ }],
    ['abre o perfil do arroba joão silva no instagram', { call: /open-url.*instagram\.com\/joaosilva\// }],
    ['abre o perfil da maria no tiktok', { call: /open-url.*tiktok\.com\/@maria/ }],
    ['manda uma mensagem no Instagram pro joão dizendo que o vídeo saiu', { said: /conversa com joao no Instagram.*O vídeo saiu\. Confirma/, notCall: /open-url|clipboard/ }],
    ['cria uma legenda para o Instagram sobre o vídeo do Jarvis', { call: /\/api\/brain.*Instagram sobre: o vídeo do Jarvis.*\/api\/clipboard/, said: /Legenda pronta/ }],
    ['escreve um post para o LinkedIn sobre a manutenção de bombas', { call: /\/api\/brain.*LinkedIn sobre: a manutenção de bombas/ }],
    ['posta o vídeo no TikTok', { said: /envio do TikTok.*Confirma/, notCall: /open-url/ }],
    ['publica no youtube', { said: /envio do YouTube/ }],
    // criptomoedas
    ['quanto está o bitcoin', { said: /Bitcoin a/ }],
    ['como estão as criptomoedas', { said: /Bitcoin a.*Ethereum a.*Solana a/ }],
    ['preço do ethereum', { said: /Ethereum a/ }],
    // conversa
    ['que horas são?', { said: /^(São|É) / }],
    ['obrigado, Jarvis', { said: /às ordens/ }],
    ['valeu Jarvis', { said: /às ordens/ }],
    ['atualiza os dados', { said: /sincronizados/ }],
    ['silêncio', { said: null, notCall: /brain/ }],
    // perguntas abertas → cérebro
    ['Qual a diferença entre Brent e WTI?', { call: /\/api\/brain/ }],
    ['por que o petróleo subiu?', { call: /\/api\/brain/ }],
    ['o que é PMI industrial?', { call: /\/api\/brain/ }],
  ];

  // ---- dublês: nenhuma ação real ----
  const realFetch = window.fetch.bind(window), realSpeak = window.speak, realReadScreen = window.readScreenCmd;
  let calls = [], said = [];
  window.fetch = (u, o = {}) => {
    const url = String(u), m = (o.method || 'GET').toUpperCase();
    if (/\/api\/contact/.test(url)) {
      const who = decodeURIComponent((url.match(/name=([^&]+)/) || [])[1] || '');
      return Promise.resolve(new Response(JSON.stringify({ found: [{ name: who + ' Teste', value: /kind=phone/.test(url) ? '5511999999999' : 'teste@exemplo.com' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (m !== 'GET' && /\/api\/(app|screen|mode|capture|memory|brain|trace|send-email|whatsapp|open-url|clipboard|reveal-video)/.test(url)) {
      calls.push(url + ' ' + (o.body || ''));
      const fake = /mode/.test(url) ? { plan: { id: 'foco', label: 'Modo teste', open: ['Visual Studio Code'], close: [] }, executed: false }
        : /screen/.test(url) ? { lines: ['teste'], alerts: [] } : /brain/.test(url) ? { ok: true, text: '(resposta do cérebro)' }
        : { ok: true, app: 'App de teste', done: true };
      return Promise.resolve(new Response(JSON.stringify(fake), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return realFetch(u, o);
  };
  window.speak = async (t) => { said.push(t); return true; };
  window.BRAIN = { ...(window.BRAIN || {}), ready: true };
  const was = { view: document.body.dataset.view, presence: document.body.classList.contains('presence'), pipe: document.body.classList.contains('pipe') };

  const results = [];
  for (const [u, exp] of CASES) {
    calls = []; said = [];
    clearConfirm?.(); setPresence(false); setPipe(false); setView('centro');
    await Promise.race([handle(u), new Promise((r) => setTimeout(r, 4000))]);
    const s = said.join(' '), c = calls.join(' | '), problems = [];
    if (exp.said === null && said.length) problems.push('não devia falar');
    if (exp.said && !exp.said.test(s)) problems.push('fala: ' + (s.slice(0, 70) || '(nada)'));
    if (exp.call && !exp.call.test(c)) problems.push('ação: ' + (c.slice(0, 90) || '(nenhuma)'));
    if (exp.notCall && exp.notCall.test(c)) problems.push('foi para o cérebro sem precisar');
    if (exp.view && document.body.dataset.view !== exp.view) problems.push('painel: ' + document.body.dataset.view);
    if (exp.presence !== undefined && document.body.classList.contains('presence') !== exp.presence) problems.push('modo presença errado');
    if (exp.pipe && !document.body.classList.contains('pipe')) problems.push('painel do processo não abriu');
    results.push({ frase: u, ok: !problems.length, problema: problems.join(' · ') });
  }
  // ---- restaura tudo ----
  window.fetch = realFetch; window.speak = realSpeak; if (realReadScreen) window.readScreenCmd = realReadScreen;
  setPresence(was.presence); setPipe(was.pipe); setView(was.view || 'centro');
  const ok = results.filter((r) => r.ok).length;
  return { total: results.length, passaram: ok, falharam: results.filter((r) => !r.ok) };
};
