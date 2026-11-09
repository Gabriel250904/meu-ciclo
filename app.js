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

export function predict(periods, hoje = today(), opts = {}) {
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

  let from = addDays(next, -margin), to = addDays(next, margin), nextFinal = next;

  // ---- Cólica (opcional): ajusta a previsão do ciclo atual quando o padrão dela ajuda ----
  let cramp = null;
  if (opts.cramps) {
    cramp = crampModel(ps, opts.cramps);
    if (cramp.status === 'active' && !ongoing) {
      const minDate = addDays(last.start, CRAMP_AFTER_START);
      const lowWin = addDays(from, -CRAMP_WINDOW);
      const lo = minDate > lowWin ? minDate : lowWin;
      const onset = cramp.dates.find((d) => d >= lo && d <= hoje);
      if (onset) {
        nextFinal = addDays(onset, cramp.medLag);
        from = addDays(onset, cramp.minLag);
        to = addDays(onset, cramp.maxLag);
        margin = Math.max(diff(from, nextFinal), diff(nextFinal, to), 1);
        cramp.live = { onset };
        confidence = { level: 3, text: `Ajustada pela cólica de ${fmtShort(onset)}` };
      }
    }
  }

  return {
    ps, cycles, recent, avg, avgR, sd, margin, avgDur, last, next: nextFinal, bt, method, cramp,
    from, to,
    daysUntil: diff(hoje, nextFinal),
    cycleDay: daysSinceStart + 1,
    ongoing, confidence
  };
}

// ===================================================================
//  MODELO DA CÓLICA
//  - Só conta cólicas nos 10 dias antes de cada menstruação (a de TPM).
//    Cólica no meio do ciclo (ovulação) fica de fora automaticamente.
//  - Para cada menstruação: "lag" = dias entre a 1ª cólica e o início.
//  - Precisa de pelo menos 3 menstruações com cólica registrada.
//  - Testa nos meses antigos (deixando um de fora por vez) se a cólica
//    acerta mais do que a previsão só pelas datas. Só usa se acertar mais.
// ===================================================================
export const CRAMP_WINDOW = 10;
export const CRAMP_MIN = 3;
const CRAMP_AFTER_START = 12; // ignora cólicas da própria menstruação

function basePredictionFor(ps, n) {
  // previsão que o app faria para o início ps[n] usando só o que veio antes
  const lens = [];
  for (let i = 1; i < n; i++) {
    const l = diff(ps[i - 1].start, ps[i].start);
    if (l >= 15 && l <= 60) lens.push(l);
  }
  let avg = 28;
  if (lens.length) {
    const bt = backtest(lens);
    avg = bt ? bt.best.fn(lens) : wavg(lens.slice(-6));
  }
  return addDays(ps[n - 1].start, Math.round(avg));
}

export function crampModel(ps, cramps) {
  const dates = [...new Set(cramps.map((c) => c.date).filter(isValidISO))].sort();
  const items = [];
  for (let n = 1; n < ps.length; n++) {
    const P = ps[n].start;
    const prevMin = addDays(ps[n - 1].start, CRAMP_AFTER_START);
    const win = addDays(P, -CRAMP_WINDOW);
    const lo = prevMin > win ? prevMin : win;
    const hi = addDays(P, -1);
    const onset = dates.find((d) => d >= lo && d <= hi);
    if (onset) items.push({ start: P, onset, lag: diff(onset, P), baseErr: Math.abs(diff(basePredictionFor(ps, n), P)) });
  }
  const res = { dates, items, count: items.length, needed: CRAMP_MIN, status: 'learning' };
  if (items.length < CRAMP_MIN) return res;

  const lags = items.map((x) => x.lag);
  res.medLag = Math.round(median(lags));
  res.minLag = Math.min(...lags);
  res.maxLag = Math.max(...lags);
  // teste: prevê cada mês só com os outros meses, e compara com a previsão pelas datas
  const recentItems = items.slice(-12);
  let ce = 0, be = 0;
  recentItems.forEach((it) => {
    const others = items.filter((o) => o !== it).map((o) => o.lag);
    ce += Math.abs(Math.round(median(others)) - it.lag);
    be += it.baseErr;
  });
  res.crampMAE = ce / recentItems.length;
  res.baseMAE = be / recentItems.length;
  res.status = res.crampMAE < res.baseMAE ? 'active' : 'unhelpful';
  return res;
}

// Dias previstos para os próximos ciclos (para o calendário)
function predictedDays(pr, hoje = today()) {
  const out = new Set();
  if (!pr) return out;
  for (let k = 1; k <= 8; k++) {
    const s = k === 1 ? pr.next : addDays(pr.next, Math.round(pr.avg * (k - 1)));
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
const state = { periods: [], cramps: [], settings: { cramps: false }, tab: 'home', calMonth: null, user: null, mode: 'local' };
const configured = firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('COLE');

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

const LocalStore = {
  key: 'meu_ciclo_periodos',
  read() { try { return JSON.parse(localStorage.getItem(this.key)) || []; } catch { return []; } },
  write(l) { try { localStorage.setItem(this.key, JSON.stringify(l)); } catch { } setPeriods(l); },
  start() { state.cramps = this.readC(); state.settings = { cramps: false, ...this.readS() }; setPeriods(this.read()); },
  async add(p) { this.write([...this.read(), { id: uid(), start: p.start, end: p.end || null }]); },
  async addMany(list) { this.write([...this.read(), ...list.map((p) => ({ id: uid(), start: p.start, end: p.end || null }))]); },
  async update(id, data) { this.write(this.read().map((p) => (p.id === id ? { ...p, ...data } : p))); },
  async remove(id) { this.write(this.read().filter((p) => p.id !== id)); },
  // cólicas e ajustes
  ckey: 'meu_ciclo_colicas', skey: 'meu_ciclo_ajustes',
  readC() { try { return JSON.parse(localStorage.getItem(this.ckey)) || []; } catch { return []; } },
  writeC(l) { try { localStorage.setItem(this.ckey, JSON.stringify(l)); } catch { } setCramps(l); },
  async addCramp(date) { const l = this.readC(); if (!l.some((c) => c.date === date)) this.writeC([...l, { id: uid(), date }]); },
  async removeCramp(id) { this.writeC(this.readC().filter((c) => c.id !== id)); },
  readS() { try { return JSON.parse(localStorage.getItem(this.skey)) || {}; } catch { return {}; } },
  async setSetting(k, v) { const s = { ...this.readS(), [k]: v }; try { localStorage.setItem(this.skey, JSON.stringify(s)); } catch { } setSettings(s); },
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

  let unsub = null, unsubC = null, unsubS = null;
  const col = () => F.collection(db, 'users', auth.currentUser.uid, 'periods');
  const colC = () => F.collection(db, 'users', auth.currentUser.uid, 'cramps');
  const docS = () => F.doc(db, 'users', auth.currentUser.uid, 'meta', 'settings');

  const store = {
    auth, A,
    start(user) {
      if (unsub) unsub();
      unsub = F.onSnapshot(F.collection(db, 'users', user.uid, 'periods'),
        (snap) => setPeriods(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => { console.error(err); toast('Não consegui carregar seus dados. Confira as regras do Firestore.'); });
      if (unsubC) unsubC();
      unsubC = F.onSnapshot(F.collection(db, 'users', user.uid, 'cramps'),
        (snap) => setCramps(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), (err) => console.error(err));
      if (unsubS) unsubS();
      unsubS = F.onSnapshot(F.doc(db, 'users', user.uid, 'meta', 'settings'),
        (snap) => setSettings(snap.exists() ? snap.data() : {}), (err) => console.error(err));
    },
    stop() {
      [unsub, unsubC, unsubS].forEach((u) => u && u());
      unsub = unsubC = unsubS = null;
      state.cramps = []; state.settings = { cramps: false };
      setPeriods([]);
    },
    async addCramp(date) { if (!state.cramps.some((c) => c.date === date)) await F.addDoc(colC(), { date, createdAt: F.serverTimestamp() }); },
    async removeCramp(id) { await F.deleteDoc(F.doc(colC(), id)); },
    async setSetting(k, v) { await F.setDoc(docS(), { [k]: v }, { merge: true }); },
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
function setCramps(list) { state.cramps = list.filter((c) => c.date && isValidISO(c.date)); render(); }
function setSettings(obj) { state.settings = { cramps: false, ...obj }; render(); }

// previsão usada nas telas (inclui a cólica só se ela ativou)
function getPred() {
  return predict(state.periods, today(), state.settings.cramps ? { cramps: state.cramps } : {});
}

async function toggleCramp(date) {
  if (date > today()) return toast('Não dá pra marcar uma data no futuro.');
  const ex = state.cramps.find((c) => c.date === date);
  try {
    if (ex) { await Store.removeCramp(ex.id); toast('Cólica removida'); }
    else { await Store.addCramp(date); toast(date === today() ? 'Cólica registrada. Melhoras 💗' : `Cólica registrada em ${fmtShort(date)}`); }
  } catch (e) { console.error(e); toast('Erro ao salvar. Tente de novo.'); }
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
  const pr = getPred();
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

  const upcoming = [0, 1, 2, 3].map((k) => addDays(pr.next, Math.round(pr.avg * k))).filter((s) => s >= hoje).slice(0, 3);
  const up = upcoming.length ? `
    <div class="section-title">Próximas previsões</div>
    <div class="card" style="padding:6px 18px">
      ${upcoming.map((s) => `<div class="row"><span>${fmtLong(s)}</span><span class="muted small">em ${diff(hoje, s)} dias</span></div>`).join('')}
    </div>` : '';

  let crampCard = '';
  if (state.settings.cramps && !pr.ongoing) {
    const todayC = state.cramps.find((c) => c.date === hoje);
    const live = pr.cramp && pr.cramp.live;
    let info = '';
    if (live && pr.cramp.minLag === pr.cramp.maxLag) info = `Pela sua história, a menstruação vem ${pr.cramp.medLag} dias depois da primeira cólica.`;
    else if (live) info = `Pela sua história, a menstruação vem de ${pr.cramp.minLag} a ${pr.cramp.maxLag} dias depois da primeira cólica.`;
    else if (pr.cramp && pr.cramp.status === 'learning') info = `Aprendendo seu padrão: ${pr.cramp.count} de ${CRAMP_MIN} meses com cólica registrada.`;
    crampCard = `
      <div class="card" style="padding:16px 18px">
        ${todayC
          ? `<div style="display:flex;justify-content:space-between;align-items:center"><b>✓ Cólica registrada hoje</b><button class="btn-ghost" style="padding:4px 0;color:var(--red-dark);font-weight:600" data-act="cramp-today">Desfazer</button></div>`
          : `<button class="btn btn-soft" data-act="cramp-today">Senti cólica hoje</button>`}
        <div class="small muted" style="margin-top:8px;text-align:center">${info || 'Marque só cólica de TPM, não a da ovulação.'}</div>
      </div>`;
  }

  return `${head}${banner}${hero}${crampCard}${stats}${up}`;
}

// ---------- Calendário ----------
function renderCal() {
  const hoje = today();
  if (!state.calMonth) state.calMonth = hoje.slice(0, 7);
  const [y, m] = state.calMonth.split('-').map(Number);
  const pr = getPred();
  const rec = recordedDays(state.periods, pr);
  const pred = predictedDays(pr);
  const crampSet = new Set(state.settings.cramps ? state.cramps.map((c) => c.date) : []);

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
    if (crampSet.has(d)) cls.push('cramp');
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
        ${state.settings.cramps ? `<span><i class="lg-cramp"></i>Cólica</span>` : ''}
      </div>
    </div>
    <div class="hint">Toque num dia para marcar início ou fim${state.settings.cramps ? ' ou cólica' : ''}.</div>
    ${state.calMonth !== hoje.slice(0, 7) ? `<div style="text-align:center;margin-top:8px"><button class="btn-ghost btn" style="width:auto;display:inline-block" data-act="cal-today">Voltar para hoje</button></div>` : ''}`;
}

function daySheet(d) {
  const hoje = today();
  const pr = getPred();
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
  const hasCramp = state.cramps.some((c) => c.date === d);
  openSheet(`
    <h3>${fmtLong(d)}</h3>
    <p>O que aconteceu neste dia?</p>
    <div class="stack">
      <button class="btn btn-primary" id="ds-start">Menstruação começou</button>
      ${canEnd ? `<button class="btn btn-soft" id="ds-end">Menstruação acabou</button>` : ''}
      ${state.settings.cramps ? `<button class="btn btn-soft" id="ds-cramp">${hasCramp ? 'Remover cólica deste dia' : 'Senti cólica neste dia'}</button>` : ''}
      <button class="btn btn-ghost" data-close>Cancelar</button>
    </div>`, (s) => {
    $('#ds-start', s).onclick = async () => { closeSheet(); await markStart(d); };
    const e = $('#ds-end', s); if (e) e.onclick = async () => { closeSheet(); await markEnd(d); };
    const c = $('#ds-cramp', s); if (c) c.onclick = async () => { closeSheet(); await toggleCramp(d); };
  });
}

// ---------- Histórico ----------
function renderHist() {
  const ps = sorted();
  const pr = getPred();
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
function crampSettingsHTML() {
  const pr = getPred();
  const m = pr ? pr.cramp : null;
  const fmtE = (x) => x.toFixed(1).replace('.', ',');
  let status;
  if (!m || m.status === 'learning') {
    const n = m ? m.count : 0;
    status = `<b>Aprendendo seu padrão: ${n} de ${CRAMP_MIN} meses</b><br>Faltam ${CRAMP_MIN - n} ${CRAMP_MIN - n === 1 ? 'mês' : 'meses'} com cólica registrada antes da menstruação. Aí o app testa se a cólica melhora a previsão.`;
  } else if (m.status === 'active') {
    const faixa = m.minLag === m.maxLag ? `${m.medLag} dias` : `${m.minLag} a ${m.maxLag} dias`;
    status = `<b>Ativa ✓</b><br>Sua menstruação costuma vir <b>${faixa}</b> depois da primeira cólica. Nos testes com seus meses antigos, errou em média ${fmtE(m.crampMAE)} dias, contra ${fmtE(m.baseMAE)} dias usando só as datas.`;
  } else {
    status = `<b>Ainda não ajudou</b><br>Com seus ${m.count} meses registrados, a cólica errou em média ${fmtE(m.crampMAE)} dias, contra ${fmtE(m.baseMAE)} dias usando só as datas. O app continua usando só as datas e testa de novo a cada mês.`;
  }
  return `
    <div class="tip-box">
      <b>Marque só a cólica de TPM</b>, aquela que aparece nos dias antes de menstruar.<br><br>
      <b>Não marque a cólica da ovulação.</b> Ela costuma vir no meio do ciclo, umas duas semanas antes da menstruação, às vezes de um lado só da barriga. Ela não ajuda a prever e atrapalha a conta. Também não marque dores por outros motivos.<br><br>
      Para se proteger de enganos, o app só considera cólicas dos ${CRAMP_WINDOW} dias antes de cada menstruação.
    </div>
    <div class="small" style="margin:12px 0;line-height:1.5">${status}</div>
    <button class="btn btn-soft" data-act="import-cramps">Importar cólicas do ChatGPT</button>
    <div class="small muted" style="margin-top:8px;text-align:center">Também dá pra marcar cólicas antigas tocando no dia, no Calendário.</div>`;
}

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
    <div class="section-title">Cólica</div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:14px">
        <div><b>Registrar cólicas</b><div class="small muted">Usa a cólica de TPM para ajustar a previsão.</div></div>
        <button class="switch ${state.settings.cramps ? 'on' : ''}" data-act="toggle-cramps" role="switch" aria-checked="${state.settings.cramps}" aria-label="Registrar cólicas"><i></i></button>
      </div>
      ${state.settings.cramps ? crampSettingsHTML() : ''}
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
    ${!isStandalone ? `<div class="section-title">Instalar</div>
    <div class="card"><button class="btn btn-soft" data-act="install">Como instalar no iPhone</button></div>` : ''}
    <div class="section-title">Sobre</div>
    <div class="card small muted">
      A previsão usa as datas de início. Quando há pelo menos ${MIN_TREINO + MIN_TESTES} ciclos registrados, o app testa ${METHODS.length} métodos no seu próprio histórico e usa o que mais acertou. A margem de dias vem do erro real desses testes. Veja os detalhes na aba Histórico.<br><br>
      É uma estimativa para você se organizar. Não serve como método anticoncepcional nem substitui sua médica.
    </div>`;
}

const CHATGPT_CRAMP_PROMPT = 'Liste todos os dias em que eu te contei que senti cólica, um por linha, no formato DD/MM/AAAA. Não escreva mais nada além da lista.';

function importCrampsSheet() {
  openSheet(`
    <h3>Importar cólicas</h3>
    <p>Um dia por linha, por exemplo: <b>06/09/2026</b>.</p>
    <p class="small" style="margin-top:-6px">Mande esta mensagem na conversa do ChatGPT onde você contava as datas, e cole aqui a resposta:</p>
    <div class="prompt-box">${CHATGPT_CRAMP_PROMPT}</div>
    <button class="btn btn-soft" id="ic-copy" style="padding:12px;margin-bottom:12px">Copiar mensagem</button>
    <textarea id="ic-text" placeholder="06/09/2026&#10;09/11/2026&#10;..."></textarea>
    <div id="ic-preview"></div>
    <div class="stack" style="margin-top:14px">
      <button class="btn btn-primary" id="ic-check">Conferir</button>
      <button class="btn btn-ghost" data-close>Cancelar</button>
    </div>`, (s) => {
    $('#ic-copy', s).onclick = async () => {
      try { await navigator.clipboard.writeText(CHATGPT_CRAMP_PROMPT); toast('Mensagem copiada'); }
      catch { toast('Não consegui copiar. Segure o texto para copiar.'); }
    };
    let ready = null;
    $('#ic-text', s).oninput = () => { ready = null; $('#ic-check', s).textContent = 'Conferir'; $('#ic-preview', s).innerHTML = ''; };
    $('#ic-check', s).onclick = async () => {
      if (ready) {
        const btn = $('#ic-check', s); btn.disabled = true; btn.textContent = 'Importando…';
        try {
          for (const d of ready) await Store.addCramp(d);
          closeSheet(); toast(`${ready.length} ${ready.length === 1 ? 'cólica importada' : 'cólicas importadas'} ✓`);
        } catch (e) { console.error(e); btn.disabled = false; btn.textContent = 'Tentar de novo'; toast('Erro ao importar.'); }
        return;
      }
      const list = parseImport($('#ic-text', s).value).map((p) => p.start);
      if (!list.length) return toast('Não encontrei nenhuma data no texto.');
      const existing = new Set(state.cramps.map((c) => c.date));
      const seen = new Set(); const hoje = today();
      const rows = list.map((d) => {
        let skip = null;
        if (d > hoje) skip = 'futuro';
        else if (existing.has(d)) skip = 'já existe';
        else if (seen.has(d)) skip = 'repetida';
        seen.add(d);
        return { d, skip };
      });
      const ok = rows.filter((r) => !r.skip);
      $('#ic-preview', s).innerHTML = `
        <p class="small" style="margin:14px 0 4px"><b>${ok.length}</b> para importar${rows.length - ok.length ? `, ${rows.length - ok.length} ignoradas` : ''}:</p>
        <div class="preview">${rows.map((r) => `<div><span>${fmtLong(r.d)} ${parseISO(r.d).getUTCFullYear()}</span>${r.skip ? `<span class="tag skip">${r.skip}</span>` : `<span class="tag">ok</span>`}</div>`).join('')}</div>
        <p class="small muted" style="margin-top:8px">Cólicas fora dos ${CRAMP_WINDOW} dias antes de uma menstruação ficam salvas, mas não entram na previsão.</p>`;
      if (ok.length) { ready = ok.map((r) => r.d); $('#ic-check', s).textContent = `Importar ${ok.length}`; }
    };
  });
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
  if (act === 'install') return showInstall();
  if (act === 'cramp-today') return toggleCramp(today());
  if (act === 'import-cramps') return importCrampsSheet();
  if (act === 'toggle-cramps') {
    try { await Store.setSetting('cramps', !state.settings.cramps); }
    catch (err) { console.error(err); toast('Erro ao salvar o ajuste.'); }
    return;
  }
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
  $('#au-eye').onclick = () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    $('#au-eye .eye-on').classList.toggle('hidden', show);
    $('#au-eye .eye-off').classList.toggle('hidden', !show);
    $('#au-eye').setAttribute('aria-label', show ? 'Esconder senha' : 'Mostrar senha');
  };
}

// ===================================================================
//  TUTORIAL DE INSTALAÇÃO
//  Aparece quando o app é aberto pelo Safari do iPhone (ainda não instalado).
//  Para ver em qualquer aparelho: adicione ?instalar no fim do link.
// ===================================================================
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

function showInstall() {
  if (document.getElementById('install')) return;
  const share = `<span class="iicon"><svg viewBox="0 0 24 24" fill="none" stroke="#0A84FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg></span>`;
  const more = `<span class="iicon" style="font-weight:700;letter-spacing:1px;font-size:13px">•••</span>`;
  const plus = `<span class="iicon"><svg viewBox="0 0 24 24" fill="none" stroke="#2B1A22" stroke-width="2" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg></span>`;
  const el = document.createElement('section');
  el.id = 'install';
  el.className = 'install';
  el.innerHTML = `
    <div class="wrap">
      <img class="logo" src="icons/icon-180.png" alt="">
      <h1>Instale o Meu Ciclo</h1>
      <p class="sub">Leva 10 segundos. Ele fica na sua tela inicial, igual a um app.</p>
      <div class="istep"><div class="num">1</div><div>
        <b>Toque em Compartilhar ${share}</b>
        <span>Fica na barra do Safari, embaixo. Se não aparecer, toque em ${more} primeiro e depois em Compartilhar.</span>
      </div></div>
      <div class="istep"><div class="num">2</div><div>
        <b>Toque em "Adicionar à Tela de Início" ${plus}</b>
        <span>Role a lista para baixo. Se não estiver lá, toque em "Ver mais".</span>
      </div></div>
      <div class="istep"><div class="num">3</div><div>
        <b>Toque em Adicionar</b>
        <span>Depois feche o Safari e abra o Meu Ciclo pelo ícone <img src="icons/icon-180.png" style="width:20px;height:20px;border-radius:5px;vertical-align:-5px"> na sua tela.</span>
      </div></div>
      ${isIOS && /CriOS|FxiOS|EdgiOS/.test(navigator.userAgent) ? `<div class="banner" style="margin-top:14px">Você está em outro navegador. Se não encontrar a opção, copie o link e abra no <b>Safari</b>.</div>` : ''}
      <button class="skip" id="install-skip">Continuar sem instalar</button>
    </div>
    <div class="arrow">Compartilhar fica aqui embaixo<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v15M6 13l6 6 6-6"/></svg></div>`;
  document.body.appendChild(el);
  el.querySelector('#install-skip').onclick = () => {
    try { sessionStorage.setItem('meu_ciclo_skip_install', '1'); } catch { }
    el.remove();
  };
}

function maybeShowInstall() {
  const forced = /[?&]instalar/.test(location.search);
  let skipped = false;
  try { skipped = sessionStorage.getItem('meu_ciclo_skip_install') === '1'; } catch { }
  if (forced || (isIOS && !isStandalone && !skipped)) showInstall();
}

// ===================================================================
//  INÍCIO
// ===================================================================
async function boot() {
  maybeShowInstall();
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
