// Aufträge nach Team – eigenständiger Server (Node 22.13+, eingebautes SQLite, keine weiteren Pakete)
// Daten: data/data.db (SQLite, WAL). Abgleich der Geräte per Änderungsnummer (nur Änderungen) + Live-Push (SSE).
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch { console.error(`Dieser Server braucht Node.js 22.13 oder neuer (eingebautes SQLite). Aktuell: ${process.version}`); process.exit(1); }

const PORT = +process.env.PORT || 3000, HOST = process.env.HOST || '0.0.0.0';
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PIN = String(process.env.DISPO_PIN || '2510');           // PIN der Disponenten – per Umgebungsvariable ändern!
const UPLOAD_PIN = String(process.env.UPLOAD_PIN || '1025');   // zusätzlicher PIN für Upload & Löschen – per Umgebungsvariable ändern!
const PUB = path.join(__dirname, 'public');
const NAG_MIN = Math.max(1, +process.env.NAG_MIN || 5);         // Push-Erinnerung alle X Minuten wiederholen, bis bestätigt
const MSG_H = Math.max(1, +process.env.MSG_HOURS || 12);        // spätestens nach X Stunden hört die Erinnerung auf
const PUSH_CONTACT = process.env.PUSH_CONTACT || 'mailto:admin@example.com';   // Kontakt für die Push-Dienste (VAPID "sub")
// nur an echte Push-Dienste senden (schützt davor, dass der Server beliebige Adressen aufruft)
const PUSH_HOSTS = new RegExp(process.env.PUSH_HOSTS || '^https://((fcm|android)\\.googleapis\\.com|updates\\.push\\.services\\.mozilla\\.com|web\\.push\\.apple\\.com|[a-z0-9-]+\\.notify\\.windows\\.com)/');
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
-- Abhaken durch den Disponenten (nur Disponentenansicht): v=1 abgehakt, v=0 zurückgenommen
CREATE TABLE IF NOT EXISTS dmark(auftrag TEXT PRIMARY KEY, v INTEGER NOT NULL, at INTEGER, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS dmark_seq ON dmark(seq);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- Geräte der Monteure (Team + Push-Abo), Nachrichten des Disponenten und Bestätigungen je Gerät
CREATE TABLE IF NOT EXISTS dev(did TEXT PRIMARY KEY, team TEXT, sub TEXT, seen INTEGER);
CREATE TABLE IF NOT EXISTS msg(id INTEGER PRIMARY KEY AUTOINCREMENT, team TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mack(id INTEGER NOT NULL, did TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(id, did));
`);
const Q = {
  getMeta: db.prepare('SELECT v FROM meta WHERE k=?'),
  setMeta: db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
  maxSeq: db.prepare('SELECT MAX(m) AS m FROM (SELECT MAX(seq) m FROM orders UNION ALL SELECT MAX(seq) FROM pruef UNION ALL SELECT MAX(seq) FROM ergebnis UNION ALL SELECT MAX(seq) FROM dmark UNION ALL SELECT MAX(seq) FROM msg)'),
  upMark: db.prepare('INSERT INTO dmark(auftrag,v,at,seq) VALUES(?,?,?,?) ON CONFLICT(auftrag) DO UPDATE SET v=excluded.v, at=excluded.at, seq=excluded.seq'),
  upErg: db.prepare('INSERT INTO ergebnis(auftrag,team,doc,seq) VALUES(?,?,?,?) ON CONFLICT(auftrag) DO UPDATE SET team=excluded.team, doc=excluded.doc, seq=excluded.seq'),
  tombTeam: db.prepare('UPDATE orders SET del=1, ts=?, seq=? WHERE team=? AND del=0 AND auftrag NOT IN (SELECT value FROM json_each(?))'),
  tombAll: db.prepare('UPDATE orders SET del=1, ts=?, seq=? WHERE del=0'),
  upOrder: db.prepare(`INSERT INTO orders(auftrag,team,tp,art,plz,str,kurz,start,ende,del,seq) VALUES(?,?,?,?,?,?,?,?,?,0,?)
    ON CONFLICT(auftrag) DO UPDATE SET team=excluded.team,tp=excluded.tp,art=excluded.art,plz=excluded.plz,str=excluded.str,kurz=excluded.kurz,start=excluded.start,ende=excluded.ende,del=0,seq=excluded.seq
    WHERE orders.del=1 OR orders.team IS NOT excluded.team OR orders.tp IS NOT excluded.tp OR orders.art IS NOT excluded.art OR orders.plz IS NOT excluded.plz
       OR orders.str IS NOT excluded.str OR orders.kurz IS NOT excluded.kurz OR orders.start IS NOT excluded.start OR orders.ende IS NOT excluded.ende`),
  upPruef: db.prepare('INSERT INTO pruef(auftrag,items,seq) VALUES(?,?,?) ON CONFLICT(auftrag) DO UPDATE SET items=excluded.items, seq=excluded.seq WHERE pruef.items IS NOT excluded.items'),
  wipePruef: db.prepare("UPDATE pruef SET items='[]', seq=? WHERE items<>'[]'"),
  getErg: db.prepare('SELECT doc, seq FROM ergebnis WHERE auftrag=?'),
  getDev: db.prepare('SELECT team, sub FROM dev WHERE did=?'),
  seenDev: db.prepare('UPDATE dev SET seen=? WHERE did=?'),
  upDev: db.prepare('INSERT INTO dev(did,team,sub,seen) VALUES(?,?,?,?) ON CONFLICT(did) DO UPDATE SET team=excluded.team, sub=excluded.sub, seen=excluded.seen'),
  dupSub: db.prepare('UPDATE dev SET sub=NULL WHERE sub=? AND did<>?'),
  dropSub: db.prepare('UPDATE dev SET sub=NULL WHERE did=?'),
  resub: db.prepare("UPDATE dev SET sub=? WHERE json_extract(sub,'$.endpoint')=?"),
  addMsg: db.prepare('INSERT INTO msg(team,text,at,seq) VALUES(?,?,?,?)'),
  closeTeamMsg: db.prepare('UPDATE msg SET closed=1, seq=? WHERE team=? AND closed=0'),
  closeMsg: db.prepare('UPDATE msg SET closed=1, seq=? WHERE id=?'),
  activeMsgs: db.prepare('SELECT id, team, text, at FROM msg WHERE closed=0 AND at>?'),
  ack: db.prepare('INSERT OR IGNORE INTO mack(id,did,at) VALUES(?,?,?)'),
  nagDevs: db.prepare('SELECT did, sub FROM dev WHERE team=? AND sub IS NOT NULL AND did NOT IN (SELECT did FROM mack WHERE id=?)'),
  msgState: db.prepare('SELECT closed, at, (SELECT 1 FROM mack a WHERE a.id=msg.id AND a.did=?) ack FROM msg WHERE id=?'),
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
// Upload-PIN: eigenes Token (Bereich "up:", 30 Min) – nötig für Upload und Löschen
let secret = getMeta('secret'); if (!secret) { secret = crypto.randomBytes(32).toString('hex'); setMeta('secret', secret); }
const sign = e => crypto.createHmac('sha256', secret).update(String(e)).digest('hex');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const fails = new Map();
function login(ip, pin, want = PIN, scope = '') {
  const k = scope + ip, f = fails.get(k) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 600e3) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 5) return null;
  if (eq(String(pin), want)) { fails.delete(k); const e = Date.now() + (scope ? 30 * 60e3 : 12 * 3600e3); return e + '.' + sign(scope + e); }
  f.n++; fails.set(k, f); return null;
}
const tokOk = (t, scope = '') => { const [e, sig] = String(t || '').split('.'); return !!(e && sig && +e > Date.now() && eq(sign(scope + e), sig)); };
const isDispo = req => tokOk((req.headers.authorization || '').replace(/^Bearer /, ''));
const isUpload = req => tokOk(req.headers['x-upload-token'], 'up:');

// ---- Web Push (RFC 8291 Verschlüsselung + RFC 8292 VAPID), nur Node-Bordmittel ----
let vapid = getMeta('vapid');
if (!vapid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), j = publicKey.export({ format: 'jwk' });
  vapid = { priv: privateKey.export({ format: 'jwk' }), pub: Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url') };
  setMeta('vapid', vapid);
}
const vapidKey = crypto.createPrivateKey({ key: vapid.priv, format: 'jwk' });
const jwtCache = new Map();
function vapidAuth(endpoint, contact = PUSH_CONTACT, key = vapidKey, pub = vapid.pub) {
  const aud = new URL(endpoint).origin, c = jwtCache.get(aud), now = Math.floor(Date.now() / 1000);
  if (c && c.exp - now > 3600 && key === vapidKey) return c.h;
  const exp = now + 12 * 3600, b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = b({ typ: 'JWT', alg: 'ES256' }) + '.' + b({ aud, exp, sub: contact });
  const h = `vapid t=${data}.${crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}, k=${pub}`;
  if (key === vapidKey) jwtCache.set(aud, { exp, h });
  return h;
}
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
function pushEncrypt(keys, payload, salt = crypto.randomBytes(16), ecdh = null) {   // aes128gcm, ein Datensatz
  const ua = Buffer.from(keys.p256dh, 'base64url'), auth = Buffer.from(keys.auth, 'base64url');
  if (!ecdh) { ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); }
  const as = ecdh.getPublicKey(), ikm = hmac(hmac(auth, ecdh.computeSecret(ua)), Buffer.concat([Buffer.from('WebPush: info\0'), ua, as, Buffer.from([1])]));
  const prk = hmac(salt, ikm), cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce), body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = as.length;
  return Buffer.concat([head, as, body]);
}
// ---- Ende Web Push Kern ----
async function pushTo(d, payload) {
  const sub = JSON.parse(d.sub);
  try {
    const r = await fetch(sub.endpoint, { method: 'POST', body: pushEncrypt(sub.keys, JSON.stringify(payload)), signal: AbortSignal.timeout(15000),
      headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(MSG_H * 3600), Urgency: 'high', Topic: 'nachricht', Authorization: vapidAuth(sub.endpoint) } });
    if (r.status === 404 || r.status === 410) { Q.dropSub.run(d.did); return false; }     // Abo abgelaufen/abgemeldet
    if (!r.ok) console.error(`Push an ${new URL(sub.endpoint).host} fehlgeschlagen: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.ok;
  } catch (e) { console.error('Push fehlgeschlagen:', e.message); return false; }
}
const lastNag = new Map();
async function nag(m) {   // an alle Geräte des Teams, die noch nicht bestätigt haben
  lastNag.set(m.id, Date.now());
  const devs = Q.nagDevs.all(m.team, m.id);
  const ok = await Promise.all(devs.map(d => pushTo(d, { id: m.id, did: d.did, team: m.team, title: 'Nachricht vom Disponenten', body: m.text, at: m.at })));
  return ok.filter(Boolean).length;
}
setInterval(async () => {   // „nervig“: wiederholen, bis bestätigt (höchstens MSG_H Stunden)
  for (const m of Q.activeMsgs.all(Date.now() - MSG_H * 3600e3)) if (Date.now() - (lastNag.get(m.id) || 0) >= NAG_MIN * 60e3 - 2e3) await nag(m);
}, 15e3).unref();

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
    if (since === seq) return send(req, res, 200, { seq, same: true, ver: appVer() });
    const full = since === 0 || since > seq || since < minseq, from = full ? 0 : since;
    const out = { seq, full, ver: appVer(), teams: db.prepare('SELECT team, COUNT(*) n FROM orders WHERE del=0 GROUP BY team ORDER BY team').all().map(r => [r.team, r.n]),
      meta: { upload: getMeta('upload'), pruef: getMeta('pruef') }, orders: [], ergebnis: [] };
    if (team !== '-') {
      for (const r of db.prepare('SELECT * FROM orders WHERE seq>?' + (full ? ' AND del=0' : '')).all(from)) {
        if (!r.del && (!team || r.team === team)) out.orders.push(ORDER(r));
        else if (!full) out.orders.push({ auftrag: r.auftrag, del: 1 });              // gelöscht oder in anderes Team verschoben
      }
      const rows = team ? db.prepare('SELECT auftrag,doc,seq FROM ergebnis WHERE seq>? AND team=?').all(from, team) : db.prepare('SELECT auftrag,doc,seq FROM ergebnis WHERE seq>?').all(from);
      out.ergebnis = rows.map(r => ({ a: r.auftrag, doc: JSON.parse(r.doc), sq: r.seq }));
      const lim = Date.now() - MSG_H * 3600e3;
      if (team) out.msgs = db.prepare('SELECT m.id, m.text, m.at, (SELECT 1 FROM mack a WHERE a.id=m.id AND a.did=?) ack FROM msg m WHERE m.team=? AND m.closed=0 AND m.at>?')
        .all(str(S.get('did'), 64), team, lim).map(r => ({ id: r.id, team, text: r.text, at: r.at, ack: !!r.ack }));
      else {
        out.msgs = db.prepare('SELECT m.id, m.team, m.text, m.at, m.closed, (SELECT COUNT(*) FROM mack a WHERE a.id=m.id) acks FROM msg m WHERE m.at>?').all(Date.now() - 24 * 3600e3)
          .map(r => ({ id: r.id, team: r.team, text: r.text, at: r.at, closed: !!r.closed || r.at <= lim, acks: r.acks }));
        out.devs = Object.fromEntries(db.prepare('SELECT team, COUNT(*) n, SUM(sub IS NOT NULL) p FROM dev WHERE team IS NOT NULL AND seen>? GROUP BY team').all(Date.now() - 30 * 864e5).map(r => [r.team, [r.n, r.p]]));
        out.cfg = { nag: NAG_MIN, hours: MSG_H };
      }
      if (!team) out.marks = db.prepare('SELECT auftrag,v,at,seq FROM dmark WHERE seq>?' + (full ? ' AND v=1' : '')).all(from).map(r => ({ a: r.auftrag, v: r.v, at: r.at, sq: r.seq }));   // nur Disponentenansicht
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
    // _b = Stand (Änderungsnummer), auf dem die Eingabe beruht. Hat inzwischen ein anderes Gerät gespeichert, gewinnt der Server:
    // die Eingabe wird abgelehnt (409) und das Gerät bekommt den aktuellen Stand zurück. Ohne _b (alte App-Version): wie bisher.
    const b = await readBody(req, 1e6), d = cleanErg(mm[1], b), base = b._b == null ? null : Number(b._b);
    const r = await batched(() => {
      const cur = Q.getErg.get(mm[1]);
      if (base !== null && (cur ? cur.seq : 0) !== base) return { cur: cur || null };
      seq++; Q.upErg.run(mm[1], d.team, JSON.stringify(d), seq); return { sq: seq };
    });
    if (r.sq == null) return send(req, res, 409, { error: 'Inzwischen auf einem anderen Gerät geändert', doc: r.cur ? JSON.parse(r.cur.doc) : null, sq: r.cur ? r.cur.seq : 0 });
    notify(); return send(req, res, 200, { ok: true, sq: r.sq });
  }
  // Push: öffentlicher Schlüssel, Gerät/Team/Abo melden, Bestätigen
  if (p === '/api/push/key' && m === 'GET') return send(req, res, 200, { key: vapid.pub });
  if (p === '/api/push/sub' && m === 'POST') {
    const b = await readBody(req, 1e4), did = str(b.did, 64), team = b.team == null || b.team === '' ? null : str(b.team, 100);
    if (!/^[a-f0-9]{32}$/.test(did)) return send(req, res, 400, { error: 'Ungültige Geräte-ID' });
    let sub = null;
    if (b.sub) {
      const ep = str(b.sub.endpoint, 1000), k = b.sub.keys || {};
      if (!PUSH_HOSTS.test(ep) || Buffer.from(str(k.p256dh, 200), 'base64url').length !== 65 || Buffer.from(str(k.auth, 100), 'base64url').length !== 16)
        return send(req, res, 400, { error: 'Ungültiges Push-Abo' });
      sub = JSON.stringify({ endpoint: ep, keys: { p256dh: str(k.p256dh, 200), auth: str(k.auth, 100) } });
    }
    const old = Q.getDev.get(did), now = Date.now();
    if (old && old.team === team && old.sub === sub) { Q.seenDev.run(now, did); return send(req, res, 200, { ok: true }); }
    if (!old && team === null) return send(req, res, 200, { ok: true });
    tx(() => { seq++; if (sub) Q.dupSub.run(sub, did); Q.upDev.run(did, team, sub, now); });
    notify(); return send(req, res, 200, { ok: true });
  }
  if (p === '/api/push/resub' && m === 'POST') {             // Browser hat das Abo erneuert (aus dem Service Worker)
    const b = await readBody(req, 1e4), ep = str(b.sub && b.sub.endpoint, 1000), k = (b.sub && b.sub.keys) || {};
    if (!PUSH_HOSTS.test(ep) || !k.p256dh || !k.auth) return send(req, res, 400, { error: 'Ungültiges Push-Abo' });
    Q.resub.run(JSON.stringify({ endpoint: ep, keys: { p256dh: str(k.p256dh, 200), auth: str(k.auth, 100) } }), str(b.old, 1000));
    return send(req, res, 200, { ok: true });
  }
  if (p === '/api/msg/ack' && m === 'POST') {
    const b = await readBody(req, 1e4), id = +b.id | 0, did = str(b.did, 64);
    if (!id || !/^[a-f0-9]{32}$/.test(did)) return send(req, res, 400, { error: 'Ungültig' });
    if (Q.ack.run(id, did, Date.now()).changes) { tx(() => { seq++; }); notify(); }
    return send(req, res, 200, { ok: true });
  }
  if (p === '/api/msg/state' && m === 'GET') {               // für den Service Worker: Benachrichtigung noch nötig?
    const r = Q.msgState.get(str(S.get('did'), 64), +S.get('id') | 0);
    return send(req, res, 200, { open: !!(r && !r.closed && !r.ack && r.at > Date.now() - MSG_H * 3600e3) });
  }
  // ab hier nur Disponent
  if (!isDispo(req)) return send(req, res, 401, { error: 'Nicht angemeldet (PIN)' });
  if (p === '/api/msg' && m === 'POST') {                    // Nachricht an ein Team (ersetzt eine noch offene)
    const b = await readBody(req, 1e4), team = str(b.team, 100), text = str(b.text, 300).trim();
    if (!team || !text) return send(req, res, 400, { error: 'Team und Text angeben' });
    const at = Date.now(); let id;
    tx(() => { seq++; Q.closeTeamMsg.run(seq, team); id = Number(Q.addMsg.run(team, text, at, seq).lastInsertRowid); });
    notify();
    return send(req, res, 200, { ok: true, id, pushed: await nag({ id, team, text, at }) });
  }
  if (p === '/api/msg/close' && m === 'POST') {
    const id = +(await readBody(req, 1e4)).id | 0;
    tx(() => { seq++; Q.closeMsg.run(seq, id); }); notify(); return send(req, res, 200, { ok: true });
  }
  if (p === '/api/login-upload' && m === 'POST') {
    const t = login(ip, (await readBody(req, 1e4)).pin, UPLOAD_PIN, 'up:');
    return t ? send(req, res, 200, { token: t }) : send(req, res, 403, { error: 'Falscher Upload-PIN (oder zu viele Versuche – 10 Minuten warten)' });
  }
  // Upload und Löschen von Aufträgen/Prüflosen nur mit zusätzlichem Upload-PIN
  if ((p === '/api/orders' || p === '/api/pruef') && (m === 'POST' || m === 'DELETE') && !isUpload(req))
    return send(req, res, 401, { error: 'Bitte den Upload-PIN (erneut) eingeben', up: 1 });
  if (p === '/api/pruef/get' && m === 'POST') {                                    // Export: Prüflisten bestimmter Aufträge
    const ids = (await readBody(req)).ids, map = {};
    if (Array.isArray(ids)) for (const r of db.prepare('SELECT auftrag,items FROM pruef WHERE auftrag IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids.map(String)))) map[r.auftrag] = JSON.parse(r.items);
    return send(req, res, 200, { map });
  }
  if (p === '/api/mark' && m === 'POST') {                                        // Aufträge abhaken / Haken entfernen
    const b = await readBody(req, 2e6), ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter(a => /^\d{1,20}$/.test(a)))].slice(0, 20000);
    if (!ids.length) return send(req, res, 400, { error: 'Keine Aufträge angegeben' });
    const now = Date.now(), sq = tx(() => { seq++; for (const a of ids) Q.upMark.run(a, b.v ? 1 : 0, now, seq); return seq; });
    notify(); return send(req, res, 200, { ok: true, sq, at: now });
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

// ---------- Version der Oberfläche: ändert sich index.html oder sw.js, laden die Geräte neu ----------
let verC = { k: '', v: '' };
function appVer() {
  const fs2 = ['index.html', 'sw.js'].map(n => path.join(PUB, n)), k = fs2.map(f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join();
  if (k !== verC.k) { const h = crypto.createHash('sha1'); for (const f of fs2) { try { h.update(fs.readFileSync(f)); } catch {} } verC = { k, v: h.digest('hex').slice(0, 12) }; }
  return verC.v;
}

// ---------- Statische Dateien (gzip + ETag, im Speicher gehalten) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const sc = new Map();
function serve(req, res, url) {
  const f = path.normalize(path.join(PUB, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  let st; try { st = fs.statSync(f); } catch { st = null; }
  if (!f.startsWith(PUB + path.sep) || !st || !st.isFile()) { res.writeHead(404); return res.end('Nicht gefunden'); }
  let e = sc.get(f);
  const html = path.extname(f) === '.html', ver = html ? appVer() : '';
  if (!e || e.m !== st.mtimeMs || e.ver !== ver) {                       // HTML trägt die Versionsnummer -> bei neuer Version neu aufbauen
    const ext = path.extname(f), raw = fs.readFileSync(f), buf = html ? Buffer.from(raw.toString('utf8').replace(/__APPVER__/g, ver)) : raw;
    e = { m: st.mtimeMs, ver, buf, type: MIME[ext] || 'application/octet-stream', etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"', gz: ext === '.png' ? null : zlib.gzipSync(buf) };
    sc.set(f, e);
  }
  if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, { ETag: e.etag }); return res.end(); }
  const z = e.gz && gz(req);
  res.writeHead(200, { 'Content-Type': e.type, ETag: e.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', ...(z ? { 'Content-Encoding': 'gzip' } : {}) });
  res.end(z ? e.gz : e.buf);
}

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try { url.pathname.startsWith('/api/') ? await api(req, res, url) : serve(req, res, url); }
  catch (e) { if (!res.headersSent) send(req, res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.msg || 'Serverfehler' }); else res.end(); if (!e.code) console.error(e); }
};

// ---------- HTTP oder HTTPS ----------
// HTTPS direkt mit Node: TLS_CERT + TLS_KEY (PEM-Dateien) oder TLS_PFX (.pfx/.p12, z. B. von der IT), Passwort in TLS_PASS
const { TLS_CERT, TLS_KEY, TLS_PFX, TLS_PASS } = process.env, TLS = !!(TLS_PFX || (TLS_CERT && TLS_KEY));
const tlsFiles = () => (TLS_PFX ? [TLS_PFX] : [TLS_CERT, TLS_KEY]);
const tlsOpts = () => TLS_PFX ? { pfx: fs.readFileSync(TLS_PFX), passphrase: TLS_PASS } : { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY), passphrase: TLS_PASS };
let server;
try { server = TLS ? https.createServer(tlsOpts(), handler) : http.createServer(handler); }
catch (e) { console.error(`Zertifikat konnte nicht geladen werden (${tlsFiles().join(', ')}): ${e.message}`); process.exit(1); }
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} ist schon belegt.` : e.code === 'EACCES' ? `Keine Berechtigung für Port ${PORT}.` : e.message); process.exit(1); });
server.listen(PORT, HOST, () => console.log(`Läuft auf ${TLS ? 'https' : 'http'}://localhost:${PORT}  (Daten: ${path.join(DIR, 'data.db')})`));
if (TLS) {
  // erneuertes Zertifikat (z. B. Let's Encrypt, IT) ohne Neustart übernehmen: stündlich prüfen
  const stamp = () => tlsFiles().map(f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join();
  let last = stamp();
  setInterval(() => {
    const now = stamp(); if (now === last) return;
    try { server.setSecureContext(tlsOpts()); last = now; console.log('Neues Zertifikat übernommen.'); } catch (e) { console.error('Neues Zertifikat fehlerhaft, altes bleibt aktiv:', e.message); }
  }, 3600e3).unref();
  // optional: Aufrufe über http:// auf https:// umleiten (HTTP_REDIRECT_PORT, z. B. 80)
  const RP = +process.env.HTTP_REDIRECT_PORT;
  if (RP) http.createServer((req, res) => {
    const host = String(req.headers.host || 'localhost').replace(/:\d+$/, '');
    res.writeHead(301, { Location: `https://${host}${PORT === 443 ? '' : ':' + PORT}${req.url}` }); res.end();
  }).on('error', e => console.error(`Umleitung auf Port ${RP} nicht möglich: ${e.message}`)).listen(RP, HOST);
}
