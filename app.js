import { firebaseConfig } from './firebase-config.js';

const FB_VERSION = '10.12.2';
const FB = `https://www.gstatic.com/firebasejs/${FB_VERSION}`;

// ===================================================================
//  Datas (sempre no formato "AAAA-MM-DD", sem fuso horário)
// ===================================================================
const DAY = 86400000;
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MESES_L = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const toISO = (d) => d.toISOString().slice(0, 10);
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const today = () => { const n = new Date(); return toISO(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()))); };
const addDays = (s, n) => toISO(new Date(parseISO(s).getTime() + n * DAY));
const diff = (a, b) => Math.round((parseISO(b) - parseISO(a)) / DAY);
const fmtShort = (s) => { const d = parseISO(s); return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`; };
const fmtLong = (s) => { const d = parseISO(s); return `${SEMANA[d.getUTCDay()]}, ${d.getUTCDate()} de ${MESES_L[d.getUTCMonth()]}`; };
const fmtFull = (s) => { const d = parseISO(s); return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const isValidISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && toISO(parseISO(s)) === s;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ===================================================================
//  PREVISÃO
//  - Usa só as datas de início (o ciclo é o intervalo entre dois inícios).
//  - Média ponderada dos últimos 6 ciclos: os mais recentes pesam mais.
//  - A margem (± dias) vem da variação real dela.
//  - Ciclos fora de 15–60 dias são ignorados (provável registro esquecido).
// ===================================================================
const MAX_CICLOS = 6;

// ---- Métodos candidatos. O app testa todos no histórico dela e usa o que mais acertou. ----
const wavg = (a) => { let sw = 0, s = 0; a.forEach((x, i) => { sw += i + 1; s += (i + 1) * x; }); return s / sw; };
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const trimmed = (a) => { if (a.length < 5) return a.reduce((x, y) => x + y, 0) / a.length; const s = [...a].sort((x, y) => x - y).slice(1, -1); return s.reduce((x, y) => x + y, 0) / s.length; };
export const METHODS = [
  { id: 'wavg6', name: 'média dos últimos 6 ciclos, com mais peso nos recentes', fn: (c) => wavg(c.slice(-6)) },
  { id: 'wavg3', name: 'média dos últimos 3 ciclos, com mais peso nos recentes', fn: (c) => wavg(c.slice(-3)) },
  { id: 'wavg12', name: 'média dos últimos 12 ciclos, com mais peso nos recentes', fn: (c) => wavg(c.slice(-12)) },
  { id: 'med5', name: 'mediana dos últimos 5 ciclos (ignora meses fora do normal)', fn: (c) => median(c.slice(-5)) },
  { id: 'med9', name: 'mediana dos últimos 9 ciclos (ignora meses fora do normal)', fn: (c) => median(c.slice(-9)) },
  { id: 'trim8', name: 'média dos últimos 8 ciclos, sem o maior e o menor', fn: (c) => trimmed(c.slice(-8)) }
];
const MIN_TREINO = 3;   // ciclos mínimos antes de começar a testar
const MIN_TESTES = 3;   // testes mínimos para confiar no resultado

export function backtest(lens) {
  if (lens.length < MIN_TREINO + MIN_TESTES) return null;
  const res = METHODS.map((m) => {
    const errs = [];
    for (let i = MIN_TREINO; i < lens.length; i++) {
      // usa só os ciclos de antes, prevê o seguinte e compara com o que aconteceu
      errs.push(Math.abs(Math.round(m.fn(lens.slice(0, i))) - lens[i]));
    }
    const recentErrs = errs.slice(-12); // o desempenho recente é o que importa
    const mae = recentErrs.reduce((a, b) => a + b, 0) / recentErrs.length;
    return { ...m, errs: recentErrs, mae };
  });
  // o menor erro médio vence; empate fica com o método padrão (primeiro da lista)
  const best = res.reduce((b, r) => (r.mae < b.mae - 0.05 ? r : b), res[0]);
  const sortedErrs = [...best.errs].sort((a, b) => a - b);
  const p80 = sortedErrs[Math.min(sortedErrs.length - 1, Math.ceil(sortedErrs.length * 0.8) - 1)];
  const within = (k) => best.errs.filter((e) => e <= k).length / best.errs.length;
  return { best, all: res, tests: best.errs.length, p80, within };
}

export function predict(periods, hoje = today()) {
  const ps = [...periods].filter((p) => p.start).sort((a, b) => (a.start < b.start ? -1 : 1));
  if (!ps.length) return null;

  const cycles = [];
  for (let i = 1; i < ps.length; i++) {
    const len = diff(ps[i - 1].start, ps[i].start);
    if (len >= 15 && len <= 60) cycles.push({ len, start: ps[i - 1].start });
  }
  const recent = cycles.slice(-MAX_CICLOS);

  let avg = 28, sd = null;
  if (recent.length) {
    let sw = 0, s = 0;
    recent.forEach((c, i) => { const w = i + 1; sw += w; s += w * c.len; });
    avg = s / sw;
    let v = 0;
    recent.forEach((c, i) => { v += (i + 1) * (c.len - avg) ** 2; });
    sd = Math.sqrt(v / sw);
  }

  const durs = ps.filter((p) => p.end && diff(p.start, p.end) >= 0 && diff(p.start, p.end) < 15)
    .slice(-MAX_CICLOS).map((p) => diff(p.start, p.end) + 1);
  const avgDur = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 5;

  let margin;
  if (sd === null) margin = 4;
  else margin = Math.min(7, Math.max(1, Math.round(sd)));
  if (recent.length > 0 && recent.length < 3) margin = Math.max(margin, 3);

  // Com histórico suficiente: testa os métodos e usa o que mais acertou para ela.
  // A margem passa a ser o erro real: cobre ~80% dos ciclos antigos.
  const lens = cycles.map((c) => c.len);
  const bt = backtest(lens);
  let method = METHODS[0];
  if (bt) {
    method = bt.best;
    avg = bt.best.fn(lens);
    margin = Math.min(7, Math.max(1, bt.p80));
  }

  const last = ps[ps.length - 1];
  const avgR = Math.round(avg);
  const next = addDays(last.start, avgR);

  let confidence;
  if (bt) {
    const pct = Math.round(bt.within(margin) * 100);
    confidence = { level: bt.best.mae <= 1.5 ? 3 : 2, text: `Acertou ${pct}% dos ciclos antigos com ±${margin} ${margin === 1 ? 'dia' : 'dias'}` };
  } else if (recent.length === 0) confidence = { level: 0, text: 'Estimativa padrão de 28 dias' };
  else if (recent.length < 3) confidence = { level: 1, text: `Baseada em ${recent.length} ${recent.length === 1 ? 'ciclo' : 'ciclos'}` };
  else if (sd <= 2) confidence = { level: 3, text: `Ciclo regular · ${recent.length} ciclos` };
  else if (sd <= 4) confidence = { level: 2, text: `Pouca variação · ${recent.length} ciclos` };
  else confidence = { level: 2, text: `Ciclo variável · ${recent.length} ciclos` };

  const daysSinceStart = diff(last.start, hoje);
  const ongoing = !last.end && daysSinceStart >= 0 && daysSinceStart < 15;

  return {
    ps, cycles, recent, avg, avgR, sd, margin, avgDur, last, next, bt, method,
    from: addDays(next, -margin), to: addDays(next, margin),
    daysUntil: diff(hoje, next),
    cycleDay: daysSinceStart + 1,
    ongoing, confidence
  };
}

// Dias previstos para os próximos ciclos (para o calendário)
function predictedDays(pr, hoje = today()) {
  const out = new Set();
  if (!pr) return out;
  for (let k = 1; k <= 8; k++) {
    const s = addDays(pr.last.start, Math.round(pr.avg * k));
    for (let j = 0; j < pr.avgDur; j++) {
      const d = addDays(s, j);
      if (d >= hoje) out.add(d);
    }
  }
  return out;
}

// Dias registrados
function recordedDays(periods, pr, hoje = today()) {
  const out = new Map();
  const dur = pr ? pr.avgDur : 5;
  for (const p of periods) {
    let end = p.end;
    if (!end) {
      const since = diff(p.start, hoje);
      end = since >= 0 && since < 15 ? hoje : addDays(p.start, dur - 1);
    }
    const n = Math.min(diff(p.start, end), 20);
    for (let i = 0; i <= n; i++) out.set(addDays(p.start, i), p);
  }
  return out;
}

// ===================================================================
//  IMPORTAÇÃO de texto (ex.: lista feita pelo ChatGPT)
//  Aceita por linha: "12/03/2025 - 17/03/2025", "12/03/2025", "2025-03-12", "12/03"
// ===================================================================
export function parseImport(text, hoje = today()) {
  const out = [];
  const re = /(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?/g;
  const hy = Number(hoje.slice(0, 4));
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const found = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line)) && found.length < 2) {
      let y, mo, d;
      if (m[1]) { y = +m[1]; mo = +m[2]; d = +m[3]; }
      else { d = +m[4]; mo = +m[5]; y = m[6] ? +m[6] : null; if (y !== null && y < 100) y += 2000; }
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      found.push({ y, mo, d });
    }
    if (!found.length) continue;
    const mk = (o) => `${o.y}-${String(o.mo).padStart(2, '0')}-${String(o.d).padStart(2, '0')}`;
    const s = found[0];
    if (s.y === null) { s.y = hy; if (mk(s) > hoje) s.y = hy - 1; }
    const start = mk(s);
    if (!isValidISO(start)) continue;
    let end = null;
    if (found[1]) {
      const e = found[1];
      if (e.y === null) { e.y = s.y; if (mk(e) < start) e.y = s.y + 1; }
      const iso = mk(e);
      if (isValidISO(iso) && diff(start, iso) >= 0 && diff(start, iso) < 15) end = iso;
    }
    out.push({ start, end });
  }
  out.sort((a, b) => (a.start < b.start ? -1 : 1));
  return out;
}

// ===================================================================
//  ARMAZENAMENTO
//  - Firebase (nuvem) quando configurado
//  - Modo teste (só no aparelho) quando não configurado
// ===================================================================
const state = { periods: [], tab: 'home', calMonth: null, user: null, mode: 'local' };
const configured = firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('COLE');

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

const LocalStore = {
  key: 'meu_ciclo_periodos',
  read() { try { return JSON.parse(localStorage.getItem(this.key)) || []; } catch { return []; } },
  write(l) { try { localStorage.setItem(this.key, JSON.stringify(l)); } catch { } setPeriods(l); },
  start() { setPeriods(this.read()); },
  async add(p) { this.write([...this.read(), { id: uid(), start: p.start, end: p.end || null }]); },
  async addMany(list) { this.write([...this.read(), ...list.map((p) => ({ id: uid(), start: p.start, end: p.end || null }))]); },
  async update(id, data) { this.write(this.read().map((p) => (p.id === id ? { ...p, ...data } : p))); },
  async remove(id) { this.write(this.read().filter((p) => p.id !== id)); },
  async signOut() { }
};

let Store = LocalStore;

async function createFirebaseStore() {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-auth.js`),
    import(`${FB}/firebase-firestore.js`)
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  let db;
  try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache() }); }
  catch { db = F.getFirestore(app); }

  let unsub = null;
  const col = () => F.collection(db, 'users', auth.currentUser.uid, 'periods');

  const store = {
    auth, A,
    start(user) {
      if (unsub) unsub();
      unsub = F.onSnapshot(F.collection(db, 'users', user.uid, 'periods'),
        (snap) => setPeriods(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => { console.error(err); toast('Não consegui carregar seus dados. Confira as regras do Firestore.'); });
    },
    stop() { if (unsub) unsub(); unsub = null; setPeriods([]); },
    async add(p) { await F.addDoc(col(), { start: p.start, end: p.end || null, createdAt: F.serverTimestamp() }); },
    async addMany(list) {
      for (let i = 0; i < list.length; i += 400) {
        const b = F.writeBatch(db);
        list.slice(i, i + 400).forEach((p) => b.set(F.doc(col()), { start: p.start, end: p.end || null, createdAt: F.serverTimestamp() }));
        await b.commit();
      }
    },
    async update(id, data) { await F.updateDoc(F.doc(col(), id), data); },
    async remove(id) { await F.deleteDoc(F.doc(col(), id)); },
    async signOut() { await A.signOut(auth); }
  };
  return store;
}

function setPeriods(list) {
  state.periods = list.filter((p) => p.start && isValidISO(p.start));
  render();
}

// ===================================================================
//  AÇÕES
// ===================================================================
function sorted() { return [...state.periods].sort((a, b) => (a.start < b.start ? -1 : 1)); }

async function markStart(date) {
  const hoje = today();
  if (date > hoje) return toast('Não dá pra marcar uma data no futuro.');
  const ps = sorted();
  if (ps.some((p) => p.start === date)) return toast('Esse dia já está marcado como início.');
  const pr = predict(ps);
  const rec = recordedDays(ps, pr);
  if (rec.has(date)) return toast('Esse dia já faz parte de uma menstruação registrada.');
  const near = ps.find((p) => Math.abs(diff(p.start, date)) < 12);
  if (near && !confirm(`Já existe uma menstruação começando em ${fmtShort(near.start)}, bem perto dessa data. Registrar mesmo assim?`)) return;
  try {
    // se havia uma menstruação aberta antes, fecha com a duração média
    const open = ps.filter((p) => !p.end && p.start < date).pop();
    if (open && diff(open.start, date) >= 15) {
      await Store.update(open.id, { end: addDays(open.start, (pr ? pr.avgDur : 5) - 1) });
    }
    await Store.add({ start: date, end: null });
    toast(date === hoje ? 'Registrado. Melhoras! 💗' : `Início registrado em ${fmtShort(date)}`);
  } catch (e) { console.error(e); toast('Erro ao salvar. Tente de novo.'); }
}

async function markEnd(date) {
  if (date > today()) return toast('Não dá pra marcar uma data no futuro.');
  const ps = sorted().filter((p) => p.start <= date);
  const p = ps[ps.length - 1];
  if (!p) return toast('Marque primeiro o dia em que começou.');
  const d = diff(p.start, date);
  if (d >= 15) return toast(`Esse dia está longe demais do início (${fmtShort(p.start)}). Marque o início primeiro.`);
  try {
    await Store.update(p.id, { end: date });
    toast(`Fim registrado: ${d + 1} ${d === 0 ? 'dia' : 'dias'} de duração`);
  } catch (e) { console.error(e); toast('Erro ao salvar. Tente de novo.'); }
}

// ===================================================================
//  INTERFACE
// ===================================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function openSheet(html, onMount) {
  const s = $('#sheet'), b = $('#backdrop');
  s.innerHTML = `<div class="grip"></div>${html}`;
  s.classList.remove('hidden'); b.classList.remove('hidden');
  requestAnimationFrame(() => { s.classList.add('show'); b.classList.add('show'); });
  b.onclick = closeSheet;
  $$('[data-close]', s).forEach((el) => (el.onclick = closeSheet));
  if (onMount) onMount(s);
}
function closeSheet() {
  const s = $('#sheet'), b = $('#backdrop');
  s.classList.remove('show'); b.classList.remove('show');
  setTimeout(() => { s.classList.add('hidden'); b.classList.add('hidden'); s.innerHTML = ''; }, 250);
}

function dateSheet({ title, text, label, action, value }) {
  const hoje = today();
  openSheet(`
    <h3>${title}</h3><p>${text}</p>
    <div class="field"><label>${label}</label><input type="date" id="sd-date" value="${value || hoje}" max="${hoje}"></div>
    <div class="stack" style="margin-top:18px">
      <button class="btn btn-primary" id="sd-ok">Salvar</button>
      <button class="btn btn-ghost" data-close>Cancelar</button>
    </div>`, (s) => {
    $('#sd-ok', s).onclick = async () => {
      const v = $('#sd-date', s).value;
      if (!isValidISO(v)) return toast('Escolha uma data.');
      closeSheet();
      await action(v);
    };
  });
}

function editSheet(p) {
  const hoje = today();
  openSheet(`
    <h3>Editar menstruação</h3>
    <p>Começou em ${fmtFull(p.start)}</p>
    <div class="field"><label>Começou em</label><input type="date" id="ed-start" value="${p.start}" max="${hoje}"></div>
    <div class="field"><label>Acabou em (pode deixar vazio)</label><input type="date" id="ed-end" value="${p.end || ''}" max="${hoje}"></div>
    <div class="stack" style="margin-top:18px">
      <button class="btn btn-primary" id="ed-save">Salvar</button>
      <button class="btn btn-ghost btn-danger" id="ed-del">Apagar este registro</button>
      <button class="btn btn-ghost" data-close>Cancelar</button>
    </div>`, (s) => {
    $('#ed-save', s).onclick = async () => {
      const start = $('#ed-start', s).value;
      const end = $('#ed-end', s).value || null;
      if (!isValidISO(start)) return toast('Data de início inválida.');
      if (end && (diff(start, end) < 0 || diff(start, end) >= 15)) return toast('O fim precisa ser até 14 dias depois do início.');
      if (state.periods.some((x) => x.id !== p.id && x.start === start)) return toast('Já existe outro registro com esse início.');
      closeSheet();
      try { await Store.update(p.id, { start, end }); toast('Atualizado'); } catch (e) { console.error(e); toast('Erro ao salvar.'); }
    };
    $('#ed-del', s).onclick = async () => {
      if (!confirm('Apagar este registro?')) return;
      closeSheet();
      try { await Store.remove(p.id); toast('Apagado'); } catch (e) { console.error(e); toast('Erro ao apagar.'); }
    };
  });
}

// ---------- Início ----------
function renderHome() {
  const hoje = today();
  const pr = predict(state.periods);
  const head = `<div class="topbar"><h1>Meu Ciclo</h1><span class="date">${fmtShort(hoje)}</span></div>`;
  const banner = state.mode === 'local'
    ? `<div class="banner"><b>Modo teste:</b> os dados estão salvos só neste aparelho. Configure o Firebase para salvar na nuvem.</div>` : '';

  if (!pr) {
    return `${head}${banner}
      <div class="card empty">
        <div style="font-size:44px">🌸</div>
        <h2>Vamos começar</h2>
        <p>Marque quando sua menstruação começar. Se você já tem datas anteriores, importe o histórico: a previsão fica certeira bem mais rápido.</p>
        <div class="stack">
          <button class="btn btn-primary" data-act="start-today">Menstruei hoje</button>
          <button class="btn btn-soft" data-act="start-other">Foi em outro dia</button>
          <button class="btn btn-ghost" data-act="go-import">Importar histórico</button>
        </div>
      </div>`;
  }

  let hero;
  const conf = `<div class="confidence"><span class="dot"></span>${pr.confidence.text}</div>`;
  if (pr.ongoing) {
    const fimPrev = addDays(pr.last.start, pr.avgDur - 1);
    const restam = diff(hoje, fimPrev);
    hero = `
      <div class="card hero on">
        <div class="label">Você está menstruada</div>
        <div class="big">${pr.cycleDay}º<small>dia</small></div>
        <div class="when">${restam > 0 ? `Deve acabar por volta de ${fmtShort(fimPrev)}` : restam === 0 ? 'Deve acabar hoje' : 'Já passou da duração média'}</div>
        <div class="range">Começou ${fmtLong(pr.last.start)}</div>
        ${conf}
        <div class="actions stack">
          <button class="btn btn-white" data-act="end-today">Acabou hoje</button>
          <button class="btn btn-ghost" data-act="end-other">Acabou em outro dia</button>
        </div>
      </div>`;
  } else {
    const d = pr.daysUntil;
    const pct = Math.max(0, Math.min(100, (pr.cycleDay / pr.avgR) * 100));
    let big, when, cls = '';
    if (d > 1) { big = `${d}<small>dias</small>`; when = fmtLong(pr.next); }
    else if (d === 1) { big = `amanhã`; when = fmtLong(pr.next); }
    else if (d === 0) { big = `hoje`; when = 'Previsão para hoje'; }
    else { cls = 'late'; big = `${-d}<small>${-d === 1 ? 'dia' : 'dias'}</small>`; when = `de atraso em relação à previsão (${fmtShort(pr.next)})`; }
    const label = d >= 0 ? 'Próxima menstruação' : 'Atrasada';
    const range = d >= -pr.margin
      ? `Pode vir entre ${fmtShort(pr.from)} e ${fmtShort(pr.to)}`
      : 'Ciclos às vezes atrasam. Se estiver preocupada, vale falar com sua médica.';
    const big2 = big.startsWith('amanhã') || big.startsWith('hoje') ? `<span style="font-size:52px">${big}</span>` : big;
    hero = `
      <div class="card hero ${cls}">
        <div class="label">${label}</div>
        <div class="big">${big2}</div>
        <div class="when">${when}</div>
        <div class="range">${range}</div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="progress-caption"><span>Dia ${pr.cycleDay} do ciclo</span><span>~${pr.avgR} dias</span></div>
        ${conf}
        <div class="actions stack">
          <button class="btn btn-primary" data-act="start-today">Menstruei hoje</button>
          <button class="btn btn-ghost" data-act="start-other">Foi em outro dia</button>
        </div>
      </div>`;
  }

  const sdTxt = pr.sd === null ? '–' : `±${Math.max(0, Math.round(pr.sd))}`;
  const stats = `
    <div class="stats">
      <div class="stat"><b>${pr.recent.length ? pr.avgR : '–'}</b><span>ciclo médio</span></div>
      <div class="stat"><b>${pr.avgDur}</b><span>dias de duração</span></div>
      <div class="stat"><b>${sdTxt}</b><span>variação</span></div>
    </div>`;

  const upcoming = [1, 2, 3].map((k) => addDays(pr.last.start, Math.round(pr.avg * k))).filter((s) => s >= hoje).slice(0, 3);
  const up = upcoming.length ? `
    <div class="section-title">Próximas previsões</div>
    <div class="card" style="padding:6px 18px">
      ${upcoming.map((s) => `<div class="row"><span>${fmtLong(s)}</span><span class="muted small">em ${diff(hoje, s)} dias</span></div>`).join('')}
    </div>` : '';

  return `${head}${banner}${hero}${stats}${up}`;
}

// ---------- Calendário ----------
function renderCal() {
  const hoje = today();
  if (!state.calMonth) state.calMonth = hoje.slice(0, 7);
  const [y, m] = state.calMonth.split('-').map(Number);
  const pr = predict(state.periods);
  const rec = recordedDays(state.periods, pr);
  const pred = predictedDays(pr);

  const first = new Date(Date.UTC(y, m - 1, 1));
  const startOffset = first.getUTCDay();
  const gridStart = addDays(toISO(first), -startOffset);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const total = Math.ceil((startOffset + daysInMonth) / 7) * 7;

  let cells = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((d) => `<div class="wd">${d}</div>`).join('');
  for (let i = 0; i < total; i++) {
    const d = addDays(gridStart, i);
    const dt = parseISO(d);
    const cls = ['day'];
    if (dt.getUTCMonth() !== m - 1) cls.push('out');
    if (rec.has(d)) cls.push('period');
    else if (pred.has(d)) cls.push('pred');
    if (d === hoje) cls.push('today');
    cells += `<button class="${cls.join(' ')}" data-day="${d}">${dt.getUTCDate()}</button>`;
  }

  return `
    <div class="topbar"><h1>Calendário</h1></div>
    <div class="card">
      <div class="cal-head">
        <button class="cal-nav" data-act="prev-month" aria-label="Mês anterior">‹</button>
        <h2>${MESES_L[m - 1]} ${y}</h2>
        <button class="cal-nav" data-act="next-month" aria-label="Próximo mês">›</button>
      </div>
      <div class="grid">${cells}</div>
      <div class="legend">
        <span><i class="lg-period"></i>Menstruação</span>
        <span><i class="lg-pred"></i>Previsão</span>
        <span><i class="lg-today"></i>Hoje</span>
      </div>
    </div>
    <div class="hint">Toque num dia para marcar início ou fim.</div>
    ${state.calMonth !== hoje.slice(0, 7) ? `<div style="text-align:center;margin-top:8px"><button class="btn-ghost btn" style="width:auto;display:inline-block" data-act="cal-today">Voltar para hoje</button></div>` : ''}`;
}

function daySheet(d) {
  const hoje = today();
  const pr = predict(state.periods);
  const rec = recordedDays(state.periods, pr);
  const p = rec.get(d);
  if (p) {
    const dur = p.end ? `${diff(p.start, p.end) + 1} dias` : 'fim ainda não marcado';
    openSheet(`
      <h3>${fmtLong(d)}</h3>
      <p>Menstruação de ${fmtShort(p.start)}${p.end ? ` a ${fmtShort(p.end)}` : ''} · ${dur}</p>
      <div class="stack">
        ${d !== p.start && d <= hoje ? `<button class="btn btn-soft" id="ds-end">Acabou neste dia</button>` : ''}
        <button class="btn btn-soft" id="ds-edit">Editar datas</button>
        <button class="btn btn-ghost" data-close>Fechar</button>
      </div>`, (s) => {
      const e = $('#ds-end', s); if (e) e.onclick = async () => { closeSheet(); await markEnd(d); };
      $('#ds-edit', s).onclick = () => { closeSheet(); setTimeout(() => editSheet(p), 260); };
    });
    return;
  }
  if (d > hoje) {
    const isPred = predictedDays(pr).has(d);
    openSheet(`<h3>${fmtLong(d)}</h3><p>${isPred ? 'Dia previsto de menstruação.' : 'Dia no futuro.'} Você só pode marcar dias até hoje.</p>
      <button class="btn btn-ghost" data-close>Fechar</button>`);
    return;
  }
  const before = sorted().filter((x) => x.start < d).pop();
  const canEnd = before && diff(before.start, d) < 15;
  openSheet(`
    <h3>${fmtLong(d)}</h3>
    <p>O que aconteceu neste dia?</p>
    <div class="stack">
      <button class="btn btn-primary" id="ds-start">Menstruação começou</button>
      ${canEnd ? `<button class="btn btn-soft" id="ds-end">Menstruação acabou</button>` : ''}
      <button class="btn btn-ghost" data-close>Cancelar</button>
    </div>`, (s) => {
    $('#ds-start', s).onclick = async () => { closeSheet(); await markStart(d); };
    const e = $('#ds-end', s); if (e) e.onclick = async () => { closeSheet(); await markEnd(d); };
  });
}

// ---------- Histórico ----------
function renderHist() {
  const ps = sorted();
  const pr = predict(ps);
  if (!ps.length) {
    return `<div class="topbar"><h1>Histórico</h1></div>
      <div class="card empty"><div style="font-size:40px">📅</div><h2>Nada por aqui ainda</h2>
      <p>Seus registros vão aparecer aqui.</p>
      <button class="btn btn-soft" data-act="go-import">Importar histórico</button></div>`;
  }

  let chart = '';
  if (pr.cycles.length >= 2) {
    const cs = pr.cycles.slice(-10);
    const max = Math.max(...cs.map((c) => c.len)), min = Math.min(...cs.map((c) => c.len));
    const span = Math.max(1, max - min);
    chart = `
      <div class="section-title">Duração dos ciclos</div>
      <div class="card">
        <div class="chart">
          ${cs.map((c, i) => `<div class="bar ${i === cs.length - 1 ? 'last' : ''}"><b>${c.len}</b><i style="height:${30 + ((c.len - min) / span) * 70}%"></i><span>${fmtShort(c.start).replace(' ', ' ')}</span></div>`).join('')}
        </div>
        <div class="chart-avg">Próximo ciclo previsto: <b>${pr.avg.toFixed(1).replace('.', ',')} dias</b>.</div>
      </div>`;
  }

  let how = '';
  if (pr.bt) {
    const fmtE = (x) => x.toFixed(1).replace('.', ',');
    const rows = [...pr.bt.all].sort((a, b) => a.mae - b.mae);
    how = `
      <div class="section-title">Como a previsão é feita</div>
      <div class="card">
        <p class="small" style="margin:0 0 10px">O app testou ${METHODS.length} métodos nos seus ${pr.bt.tests} ciclos anteriores: pra cada um, previu a data sem saber a resposta e conferiu o erro. Usa o que mais acertou pra você:</p>
        <div style="background:var(--red-soft);border-radius:14px;padding:12px 14px;margin-bottom:10px">
          <b>${pr.method.name[0].toUpperCase() + pr.method.name.slice(1)}</b><br>
          <span class="small">Erro médio: ${fmtE(pr.method.mae)} ${pr.method.mae === 1 ? 'dia' : 'dias'} · ${Math.round(pr.bt.within(1) * 100)}% dos ciclos com até 1 dia de diferença</span>
        </div>
        <details><summary class="small" style="color:var(--red-dark);font-weight:600">Ver todos os métodos</summary>
          ${rows.map((r) => `<div class="row small"><span>${r.name}</span><span class="muted" style="white-space:nowrap;margin-left:10px">${fmtE(r.mae)} d</span></div>`).join('')}
        </details>
      </div>`;
  } else if (pr.cycles.length) {
    const falta = MIN_TREINO + MIN_TESTES - pr.cycles.length;
    how = `<div class="section-title">Como a previsão é feita</div>
      <div class="card small muted">Por enquanto o app usa a média dos últimos ciclos, com mais peso nos recentes. Com mais ${falta} ${falta === 1 ? 'ciclo registrado' : 'ciclos registrados'}, ele começa a testar ${METHODS.length} métodos no seu histórico e escolhe o que mais acerta pra você.</div>`;
  }
  chart += how;

  const items = ps.map((p, i) => {
    const nextP = ps[i + 1];
    const cyc = nextP ? diff(p.start, nextP.start) : null;
    const dur = p.end ? `${diff(p.start, p.end) + 1} dias` : (pr.ongoing && p === pr.last ? 'em andamento' : 'fim não marcado');
    return { p, html: `
      <button class="item" data-edit="${esc(p.id)}">
        <div class="drop">💧</div>
        <div class="main"><b>${fmtShort(p.start)}${p.end ? ` – ${fmtShort(p.end)}` : ''}</b><span>${parseISO(p.start).getUTCFullYear()} · ${dur}</span></div>
        <div class="side">${cyc ? `<b>${cyc}</b>dias de ciclo` : '<b>atual</b>'}</div>
        <span class="chev">›</span>
      </button>` };
  }).reverse();

  return `<div class="topbar"><h1>Histórico</h1><span class="date">${ps.length} ${ps.length === 1 ? 'registro' : 'registros'}</span></div>
    ${chart}
    <div class="section-title">Registros</div>
    <div class="card" style="padding:4px 16px">${items.map((x) => x.html).join('')}</div>`;
}

// ---------- Ajustes ----------
const CHATGPT_PROMPT = 'Liste todas as datas de menstruação que eu te passei, uma por linha, no formato DD/MM/AAAA - DD/MM/AAAA (início - fim). Se não souber o fim, coloque só a data de início. Não escreva mais nada além da lista.';

function renderSet() {
  const email = state.user ? esc(state.user.email || '') : '';
  return `<div class="topbar"><h1>Ajustes</h1></div>
    <div class="section-title">Histórico</div>
    <div class="card">
      <b>Importar datas antigas</b>
      <p class="muted small" style="margin:6px 0 14px">Cole uma lista de datas, uma menstruação por linha. Quanto mais ciclos, mais precisa fica a previsão.</p>
      <button class="btn btn-soft" data-act="import">Importar datas</button>
    </div>
    <div class="section-title">Conta</div>
    <div class="card" style="padding:4px 18px">
      ${state.mode === 'cloud'
      ? `<div class="row"><span>Conectada como</span><span class="muted small">${email}</span></div>
         <div class="row"><span>Dados</span><span class="muted small">salvos na nuvem ☁️</span></div>
         <div class="row"><button class="btn-ghost btn-danger" style="padding:0" data-act="logout">Sair da conta</button></div>`
      : `<div class="row"><span>Modo</span><span class="muted small">teste (só neste aparelho)</span></div>
         <div class="row"><button class="btn-ghost btn-danger" style="padding:0" data-act="wipe">Apagar dados de teste</button></div>`}
    </div>
    <div class="section-title">Sobre</div>
    <div class="card small muted">
      A previsão usa as datas de início. Quando há pelo menos ${MIN_TREINO + MIN_TESTES} ciclos registrados, o app testa ${METHODS.length} métodos no seu próprio histórico e usa o que mais acertou. A margem de dias vem do erro real desses testes. Veja os detalhes na aba Histórico.<br><br>
      É uma estimativa para você se organizar. Não serve como método anticoncepcional nem substitui sua médica.
    </div>`;
}

function importSheet() {
  openSheet(`
    <h3>Importar datas</h3>
    <p>Uma menstruação por linha. Exemplos: <b>12/03/2025 - 16/03/2025</b> ou só <b>12/03/2025</b>.</p>
    <details style="margin-bottom:12px"><summary style="color:var(--red-dark);font-weight:600">As datas estão no ChatGPT?</summary>
      <p class="small" style="margin-top:10px">Mande esta mensagem na conversa onde você contava as datas para ele e cole aqui a resposta:</p>
      <div class="prompt-box" id="im-prompt">${CHATGPT_PROMPT}</div>
      <button class="btn btn-soft" id="im-copy" style="padding:12px">Copiar mensagem</button>
    </details>
    <textarea id="im-text" placeholder="12/03/2025 - 16/03/2025&#10;09/04/2025 - 13/04/2025&#10;..."></textarea>
    <div id="im-preview"></div>
    <div class="stack" style="margin-top:14px">
      <button class="btn btn-primary" id="im-check">Conferir</button>
      <button class="btn btn-ghost" data-close>Cancelar</button>
    </div>`, (s) => {
    $('#im-copy', s).onclick = async () => {
      try { await navigator.clipboard.writeText(CHATGPT_PROMPT); toast('Mensagem copiada'); }
      catch { toast('Não consegui copiar. Segure o texto para copiar.'); }
    };
    let ready = null;
    $('#im-text', s).oninput = () => { ready = null; $('#im-check', s).textContent = 'Conferir'; $('#im-preview', s).innerHTML = ''; };
    $('#im-check', s).onclick = async () => {
      if (ready) {
        const btn = $('#im-check', s); btn.disabled = true; btn.textContent = 'Importando…';
        try { await Store.addMany(ready); closeSheet(); toast(`${ready.length} ${ready.length === 1 ? 'registro importado' : 'registros importados'} ✓`); }
        catch (e) { console.error(e); btn.disabled = false; btn.textContent = 'Tentar de novo'; toast('Erro ao importar.'); }
        return;
      }
      const list = parseImport($('#im-text', s).value);
      if (!list.length) return toast('Não encontrei nenhuma data no texto.');
      const existing = new Set(state.periods.map((p) => p.start));
      const seen = new Set();
      const hoje = today();
      const rows = list.map((p) => {
        let skip = null;
        if (p.start > hoje) skip = 'futuro';
        else if (existing.has(p.start)) skip = 'já existe';
        else if (seen.has(p.start)) skip = 'repetida';
        seen.add(p.start);
        return { ...p, skip };
      });
      const ok = rows.filter((r) => !r.skip);
      $('#im-preview', s).innerHTML = `
        <p class="small" style="margin:14px 0 4px"><b>${ok.length}</b> para importar${rows.length - ok.length ? `, ${rows.length - ok.length} ignoradas` : ''}:</p>
        <div class="preview">${rows.map((r) => `<div><span>${fmtFull(r.start)}${r.end ? ` → ${fmtShort(r.end)}` : ''}</span>${r.skip ? `<span class="tag skip">${r.skip}</span>` : `<span class="tag">ok</span>`}</div>`).join('')}</div>`;
      if (ok.length) { ready = ok.map(({ start, end }) => ({ start, end })); $('#im-check', s).textContent = `Importar ${ok.length}`; }
    };
  });
}

// ---------- render principal ----------
function render() {
  const v = $('#view');
  if (!v || $('#app').classList.contains('hidden')) return;
  const views = { home: renderHome, cal: renderCal, hist: renderHist, set: renderSet };
  v.innerHTML = views[state.tab]();
  $$('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
}

function goTab(t) { state.tab = t; render(); window.scrollTo(0, 0); }

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('nav.tabs button');
  if (tab) return goTab(tab.dataset.tab);

  const day = e.target.closest('[data-day]');
  if (day) return daySheet(day.dataset.day);

  const ed = e.target.closest('[data-edit]');
  if (ed) { const p = state.periods.find((x) => x.id === ed.dataset.edit); if (p) editSheet(p); return; }

  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'start-today') return markStart(today());
  if (act === 'start-other') return dateSheet({ title: 'Quando começou?', text: 'Escolha o dia em que a menstruação começou.', label: 'Data de início', action: markStart });
  if (act === 'end-today') return markEnd(today());
  if (act === 'end-other') return dateSheet({ title: 'Quando acabou?', text: 'Escolha o último dia da menstruação.', label: 'Último dia', action: markEnd });
  if (act === 'go-import') { goTab('set'); return importSheet(); }
  if (act === 'import') return importSheet();
  if (act === 'prev-month' || act === 'next-month') {
    const [y, m] = state.calMonth.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + (act === 'next-month' ? 1 : -1), 1));
    state.calMonth = toISO(d).slice(0, 7);
    return render();
  }
  if (act === 'cal-today') { state.calMonth = today().slice(0, 7); return render(); }
  if (act === 'logout') { if (confirm('Sair da conta?')) await Store.signOut(); return; }
  if (act === 'wipe') { if (confirm('Apagar todos os dados de teste deste aparelho?')) LocalStore.write([]); return; }
});

// ===================================================================
//  LOGIN
// ===================================================================
const AUTH_ERRORS = {
  'auth/invalid-credential': 'E-mail ou senha incorretos.',
  'auth/wrong-password': 'E-mail ou senha incorretos.',
  'auth/user-not-found': 'E-mail ou senha incorretos.',
  'auth/invalid-email': 'Esse e-mail não parece válido.',
  'auth/email-already-in-use': 'Já existe uma conta com esse e-mail. Toque em Entrar.',
  'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
  'auth/missing-password': 'Digite a senha.',
  'auth/network-request-failed': 'Sem internet. Tente de novo.',
  'auth/too-many-requests': 'Muitas tentativas. Espere um pouco e tente de novo.',
  'auth/operation-not-allowed': 'Login por e-mail não está ativado no Firebase (tutorial, passo 1.4).',
  'auth/unauthorized-domain': 'Este site não está autorizado no Firebase (tutorial, passo 3.4).'
};

function show(id) {
  ['loading', 'auth', 'app'].forEach((x) => $('#' + x).classList.toggle('hidden', x !== id));
  if (id === 'app') render();
}

function setupAuthScreen(fb) {
  const email = $('#au-email'), pass = $('#au-pass'), err = $('#au-err');
  const run = async (fn, btn) => {
    err.textContent = '';
    if (!email.value.trim()) { err.textContent = 'Digite seu e-mail.'; return; }
    btn.disabled = true;
    try { await fn(); }
    catch (e) { err.textContent = AUTH_ERRORS[e.code] || `Erro: ${e.code || e.message}`; }
    finally { btn.disabled = false; }
  };
  $('#au-login').onclick = (e) => run(() => fb.A.signInWithEmailAndPassword(fb.auth, email.value.trim(), pass.value), e.currentTarget);
  $('#au-signup').onclick = (e) => run(() => fb.A.createUserWithEmailAndPassword(fb.auth, email.value.trim(), pass.value), e.currentTarget);
  $('#au-reset').onclick = (e) => run(async () => {
    await fb.A.sendPasswordResetEmail(fb.auth, email.value.trim());
    err.textContent = '';
    toast('Enviamos um e-mail para você trocar a senha. Confira o spam.');
  }, e.currentTarget);
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#au-login').click(); });
}

// ===================================================================
//  INÍCIO
// ===================================================================
async function boot() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => { });
  }
  if (!configured) {
    state.mode = 'local';
    Store = LocalStore;
    show('app');
    LocalStore.start();
    return;
  }
  try {
    const fb = await createFirebaseStore();
    Store = fb;
    state.mode = 'cloud';
    setupAuthScreen(fb);
    fb.A.onAuthStateChanged(fb.auth, (user) => {
      state.user = user;
      if (user) { show('app'); fb.start(user); }
      else { fb.stop(); state.tab = 'home'; show('auth'); }
    });
  } catch (e) {
    console.error(e);
    $('#loading').innerHTML = `<div style="text-align:center;padding:30px">Não consegui conectar.<br><span class="small">Confira a internet e o arquivo firebase-config.js.</span><br><br><button class="btn btn-soft" onclick="location.reload()">Tentar de novo</button></div>`;
  }
}

if (typeof window !== 'undefined' && !window.__TEST__) boot();
