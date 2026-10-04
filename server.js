// Aufträge nach Team – eigenständiger Server (Node 22.13+, eingebautes SQLite, keine weiteren Pakete)
// Daten: data/data.db (SQLite, WAL). Abgleich der Geräte per Änderungsnummer (nur Änderungen) + Live-Push (SSE).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch { console.error(`Dieser Server braucht Node.js 22.13 oder neuer (eingebautes SQLite). Aktuell: ${process.version}`); process.exit(1); }

const PORT = +process.env.PORT || 3000, HOST = process.env.HOST || '0.0.0.0';
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PIN = String(process.env.DISPO_PIN || '2510');           // PIN der Disponenten – per Umgebungsvariable ändern!
const PUB = path.join(__dirname, 'public');
fs.mkdirSync(path.join(DIR, 'backups'), { recursive: true });

// ---------- Datenbank ----------
const db = new DatabaseSync(path.join(DIR, 'data.db'));
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS orders(auftrag TEXT PRIMARY KEY, team TEXT NOT NULL, tp TEXT, art TEXT, plz TEXT, str TEXT, kurz TEXT, start TEXT, ende TEXT,
  del INTEGER NOT NULL DEFAULT 0, ts INTEGER, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS orders_seq ON orders(seq);
CREATE INDEX IF NOT EXISTS orders_team ON orders(team, del);
CREATE TABLE IF NOT EXISTS pruef(auftrag TEXT PRIMARY KEY, items TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pruef_seq ON pruef(seq);
CREATE TABLE IF NOT EXISTS ergebnis(auftrag TEXT PRIMARY KEY, team TEXT, doc TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ergebnis_seq ON ergebnis(seq, team);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);
const Q = {
  getMeta: db.prepare('SELECT v FROM meta WHERE k=?'),
  setMeta: db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
  maxSeq: db.prepare('SELECT MAX(m) AS m FROM (SELECT MAX(seq) m FROM orders UNION ALL SELECT MAX(seq) FROM pruef UNION ALL SELECT MAX(seq) FROM ergebnis)'),
  upErg: db.prepare('INSERT INTO ergebnis(auftrag,team,doc,seq) VALUES(?,?,?,?) ON CONFLICT(auftrag) DO UPDATE SET team=excluded.team, doc=excluded.doc, seq=excluded.seq'),
  tombTeam: db.prepare('UPDATE orders SET del=1, ts=?, seq=? WHERE team=? AND del=0 AND auftrag NOT IN (SELECT value FROM json_each(?))'),
  tombAll: db.prepare('UPDATE orders SET del=1, ts=?, seq=? WHERE del=0'),
  upOrder: db.prepare(`INSERT INTO orders(auftrag,team,tp,art,plz,str,kurz,start,ende,del,seq) VALUES(?,?,?,?,?,?,?,?,?,0,?)
    ON CONFLICT(auftrag) DO UPDATE SET team=excluded.team,tp=excluded.tp,art=excluded.art,plz=excluded.plz,str=excluded.str,kurz=excluded.kurz,start=excluded.start,ende=excluded.ende,del=0,seq=excluded.seq
    WHERE orders.del=1 OR orders.team IS NOT excluded.team OR orders.tp IS NOT excluded.tp OR orders.art IS NOT excluded.art OR orders.plz IS NOT excluded.plz
       OR orders.str IS NOT excluded.str OR orders.kurz IS NOT excluded.kurz OR orders.start IS NOT excluded.start OR orders.ende IS NOT excluded.ende`),
  upPruef: db.prepare('INSERT INTO pruef(auftrag,items,seq) VALUES(?,?,?) ON CONFLICT(auftrag) DO UPDATE SET items=excluded.items, seq=excluded.seq WHERE pruef.items IS NOT excluded.items'),
  wipePruef: db.prepare("UPDATE pruef SET items='[]', seq=? WHERE items<>'[]'"),
};
const getMeta = k => { const r = Q.getMeta.get(k); return r ? JSON.parse(r.v) : null; };
const setMeta = (k, v) => v == null ? db.prepare('DELETE FROM meta WHERE k=?').run(k) : Q.setMeta.run(k, JSON.stringify(v));
let seq = Math.max(+getMeta('seq') || 0, Q.maxSeq.get().m || 0);   // fortlaufende Änderungsnummer
let minseq = +getMeta('minseq') || 0;                              // davor sind Änderungen nicht mehr vollständig nachvollziehbar
const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); setMeta('seq', seq); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// mehrere gleichzeitige Schreibzugriffe in einer Transaktion bündeln (ein fsync statt vieler), Antwort erst nach dem Commit
let bq = [], bt = null;
const batched = fn => new Promise((ok, no) => { bq.push({ fn, ok, no }); if (!bt) bt = setTimeout(runBatch, 3); });
function runBatch() {
  bt = null; const q = bq; bq = [];
  try { db.exec('BEGIN IMMEDIATE'); const out = q.map(x => x.fn()); setMeta('seq', seq); db.exec('COMMIT'); q.forEach((x, i) => x.ok(out[i])); }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} q.forEach(x => x.no(e)); }
}

// gelöschte Aufträge (Markierungen) nach 30 Tagen entfernen; ältere Geräte laden dann komplett neu
{
  const lim = Date.now() - 30 * 864e5, m = db.prepare('SELECT MAX(seq) m FROM orders WHERE del=1 AND ts<?').get(lim).m;
  if (m) { db.prepare('DELETE FROM orders WHERE del=1 AND ts<?').run(lim); minseq = Math.max(minseq, m); setMeta('minseq', minseq); }
}

// tägliche Sicherung (konsistenter Schnappschuss), die letzten 30 bleiben
let lastBackup = '';
function backup() {
  const day = new Date().toISOString().slice(0, 10); if (day === lastBackup) return;
  const f = path.join(DIR, 'backups', `data-${day}.db`);
  try { if (!fs.existsSync(f)) db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`); lastBackup = day; } catch (e) { console.error('Sicherung fehlgeschlagen:', e.message); return; }
  const all = fs.readdirSync(path.join(DIR, 'backups')).filter(x => x.endsWith('.db')).sort();
  for (const x of all.slice(0, Math.max(0, all.length - 30))) fs.unlinkSync(path.join(DIR, 'backups', x));
}
backup(); setInterval(backup, 3600e3).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { db.close(); } catch {} process.exit(0); });

// ---------- Live-Benachrichtigung (SSE) ----------
const sse = new Set(); let nt = null;
const notify = () => { if (nt) return; nt = setTimeout(() => { nt = null; for (const c of sse) c.write(`data: ${seq}\n\n`); }, 150); };
setInterval(() => { for (const c of sse) c.write(': ping\n\n'); }, 25000).unref();

// ---------- Hilfsfunktionen ----------
const str = (v, n = 300) => String(v ?? '').slice(0, n);
const gz = req => /\bgzip\b/.test(req.headers['accept-encoding'] || '');
function send(req, res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj)), h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (b.length > 1024 && gz(req)) zlib.gzip(b, (e, z) => { if (e) { res.writeHead(code, h); return res.end(b); } res.writeHead(code, { ...h, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }); res.end(z); });
  else { res.writeHead(code, h); res.end(b); }
}
const readBody = (req, max = 30e6) => new Promise((ok, no) => {
  let n = 0; const ch = [];
  req.on('data', c => { n += c.length; if (n > max) { no({ code: 413, msg: 'Datei zu groß' }); req.destroy(); } else ch.push(c); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(ch).toString('utf8') || '{}')); } catch { no({ code: 400, msg: 'Ungültiges JSON' }); } });
  req.on('error', () => no({ code: 400, msg: 'Lesefehler' }));
});

// Anmeldung Disponent: PIN -> signiertes Token (12 h, übersteht Neustarts); Fehlversuche begrenzt
let secret = getMeta('secret'); if (!secret) { secret = crypto.randomBytes(32).toString('hex'); setMeta('secret', secret); }
const sign = e => crypto.createHmac('sha256', secret).update(String(e)).digest('hex');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const fails = new Map();
function login(ip, pin) {
  const f = fails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 600e3) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 5) return null;
  if (eq(String(pin), PIN)) { fails.delete(ip); const e = Date.now() + 12 * 3600e3; return e + '.' + sign(e); }
  f.n++; fails.set(ip, f); return null;
}
const isDispo = req => { const [e, sig] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.'); return !!(e && sig && +e > Date.now() && eq(sign(e), sig)); };

// Ergebnis-Dokument prüfen und bereinigen (Whitelist)
function cleanErg(a, d) {
  if (!d || typeof d !== 'object') throw { code: 400, msg: 'Ungültiges Ergebnis' };
  const n = Math.min(Math.max(+d.n | 0, 0), 500), s = str(d.s, 500);
  if (!/^[ox-]*$/.test(s) || s.length !== n) throw { code: 400, msg: 'Ungültiger Status' };
  const nok = (Array.isArray(d.nok) ? d.nok : []).slice(0, 500).map(z => ({ i: z.i | 0, t: str(z.t), m: str(z.m) }));
  const o = { a, team: str(d.team, 100), n, ok: [...s].filter(c => c === 'o').length, nx: nok.length, s, nok };
  if (d.min != null) {
    const m = +d.min; if (!(m >= 1 && m <= 1440)) throw { code: 400, msg: 'Ungültige Dauer' };
    o.min = Math.round(m); o.tat = +d.tat || Date.now();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d.dat || '')) o.dat = d.dat;
    if (/^\d{2}:\d{2}$/.test(d.von || '')) o.von = d.von;
  }
  return o;
}
const ORDER = r => ({ auftrag: r.auftrag, team: r.team, tp: r.tp, art: r.art, plz: r.plz, str: r.str, kurz: r.kurz, start: r.start, ende: r.ende });

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname, m = req.method, ip = req.socket.remoteAddress, S = url.searchParams;
  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n'); sse.add(res); req.on('close', () => sse.delete(res)); return;
  }
  if (p === '/api/login' && m === 'POST') {
    const t = login(ip, (await readBody(req, 1e4)).pin);
    return t ? send(req, res, 200, { token: t }) : send(req, res, 403, { error: 'Falscher PIN (oder zu viele Versuche – 10 Minuten warten)' });
  }
  // Abgleich: nur Änderungen seit Nummer "since". team=<Name> für Monteure (nur eigene Aufträge/Ergebnisse), "-" = nur Teamliste, leer = alles (Disponent)
  if (p === '/api/sync' && m === 'GET') {
    const since = +S.get('since') || 0, team = S.get('team') || '';
    if (since === seq) return send(req, res, 200, { seq, same: true });
    const full = since === 0 || since > seq || since < minseq, from = full ? 0 : since;
    const out = { seq, full, teams: db.prepare('SELECT team, COUNT(*) n FROM orders WHERE del=0 GROUP BY team ORDER BY team').all().map(r => [r.team, r.n]),
      meta: { upload: getMeta('upload'), pruef: getMeta('pruef') }, orders: [], ergebnis: [] };
    if (team !== '-') {
      for (const r of db.prepare('SELECT * FROM orders WHERE seq>?' + (full ? ' AND del=0' : '')).all(from)) {
        if (!r.del && (!team || r.team === team)) out.orders.push(ORDER(r));
        else if (!full) out.orders.push({ auftrag: r.auftrag, del: 1 });              // gelöscht oder in anderes Team verschoben
      }
      const rows = team ? db.prepare('SELECT auftrag,doc,seq FROM ergebnis WHERE seq>? AND team=?').all(from, team) : db.prepare('SELECT auftrag,doc,seq FROM ergebnis WHERE seq>?').all(from);
      out.ergebnis = rows.map(r => ({ a: r.auftrag, doc: JSON.parse(r.doc), sq: r.seq }));
    }
    return send(req, res, 200, out);
  }
  if (p === '/api/pruef' && m === 'GET') {
    const a = S.get('a'), team = S.get('team'), since = +S.get('since') || 0;
    if (a) { const r = db.prepare('SELECT items FROM pruef WHERE auftrag=?').get(a); return send(req, res, 200, { list: r ? JSON.parse(r.items) : [] }); }
    if (team) {
      const from = since > seq ? 0 : since, map = {};
      for (const r of db.prepare('SELECT p.auftrag,p.items FROM pruef p JOIN orders o ON o.auftrag=p.auftrag WHERE o.team=? AND o.del=0 AND p.seq>?').all(team, from)) map[r.auftrag] = JSON.parse(r.items);
      return send(req, res, 200, { map, seq });
    }
    return send(req, res, 400, { error: 'a oder team angeben' });
  }
  let mm;
  if ((mm = p.match(/^\/api\/ergebnis\/(\d{1,20})$/)) && m === 'PUT') {          // Monteur: Ergebnis eines Auftrags
    const d = cleanErg(mm[1], await readBody(req, 1e6));
    const sq = await batched(() => { seq++; Q.upErg.run(mm[1], d.team, JSON.stringify(d), seq); return seq; });
    notify(); return send(req, res, 200, { ok: true, sq });
  }
  // ab hier nur Disponent
  if (!isDispo(req)) return send(req, res, 401, { error: 'Nicht angemeldet (PIN)' });
  if (p === '/api/pruef/get' && m === 'POST') {                                    // Export: Prüflisten bestimmter Aufträge
    const ids = (await readBody(req)).ids, map = {};
    if (Array.isArray(ids)) for (const r of db.prepare('SELECT auftrag,items FROM pruef WHERE auftrag IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids.map(String)))) map[r.auftrag] = JSON.parse(r.items);
    return send(req, res, 200, { map });
  }
  if (p === '/api/orders' && m === 'POST') {
    const b = await readBody(req), rows = (Array.isArray(b.rows) ? b.rows : []).filter(r => r && String(r.auftrag || '').replace(/\D/g, '') && r.team);
    tx(() => {
      seq++; const now = Date.now(), byTeam = new Map();
      for (const r of rows) { const t = str(r.team, 100); (byTeam.get(t) || byTeam.set(t, []).get(t)).push(String(r.auftrag).replace(/\D/g, '')); }
      if (!b.keep) for (const [t, ids] of byTeam) Q.tombTeam.run(now, seq, t, JSON.stringify(ids));   // nur Aufträge entfernen, die in der neuen Datei fehlen
      for (const r of rows) Q.upOrder.run(String(r.auftrag).replace(/\D/g, ''), str(r.team, 100), str(r.tp, 60), str(r.art, 30), str(r.plz, 10), str(r.str, 100), str(r.kurz), str(r.start, 20), str(r.ende, 20), seq);
      setMeta('upload', { at: now, files: str(b.files), count: rows.length });
    });
    notify(); return send(req, res, 200, { ok: true });
  }
  if (p === '/api/orders' && m === 'DELETE') { tx(() => { seq++; Q.tombAll.run(Date.now(), seq); setMeta('upload', null); }); notify(); return send(req, res, 200, { ok: true }); }
  if (p === '/api/pruef' && m === 'POST') {
    const b = await readBody(req), by = b.by && typeof b.by === 'object' ? b.by : {};
    tx(() => {
      seq++;
      for (const [a, l] of Object.entries(by)) if (/^\d{1,20}$/.test(a) && Array.isArray(l)) Q.upPruef.run(a, JSON.stringify(l.slice(0, 500).map(t => str(t, 200))), seq);
      setMeta('pruef', { at: Date.now(), files: str(b.files), count: +b.count | 0, orders: +b.orders | 0 });
    });
    notify(); return send(req, res, 200, { ok: true });
  }
  if (p === '/api/pruef' && m === 'DELETE') { tx(() => { seq++; Q.wipePruef.run(seq); setMeta('pruef', null); }); notify(); return send(req, res, 200, { ok: true }); }
  return send(req, res, 404, { error: 'Unbekannt' });
}

// ---------- Statische Dateien (gzip + ETag, im Speicher gehalten) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const sc = new Map();
function serve(req, res, url) {
  const f = path.normalize(path.join(PUB, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  let st; try { st = fs.statSync(f); } catch { st = null; }
  if (!f.startsWith(PUB + path.sep) || !st || !st.isFile()) { res.writeHead(404); return res.end('Nicht gefunden'); }
  let e = sc.get(f);
  if (!e || e.m !== st.mtimeMs) {
    const buf = fs.readFileSync(f), ext = path.extname(f);
    e = { m: st.mtimeMs, buf, type: MIME[ext] || 'application/octet-stream', etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"', gz: ext === '.png' ? null : zlib.gzipSync(buf) };
    sc.set(f, e);
  }
  if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, { ETag: e.etag }); return res.end(); }
  const z = e.gz && gz(req);
  res.writeHead(200, { 'Content-Type': e.type, ETag: e.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', ...(z ? { 'Content-Encoding': 'gzip' } : {}) });
  res.end(z ? e.gz : e.buf);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try { url.pathname.startsWith('/api/') ? await api(req, res, url) : serve(req, res, url); }
  catch (e) { if (!res.headersSent) send(req, res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.msg || 'Serverfehler' }); else res.end(); if (!e.code) console.error(e); }
}).listen(PORT, HOST, () => console.log(`Läuft auf http://localhost:${PORT}  (Daten: ${path.join(DIR, 'data.db')})`));
