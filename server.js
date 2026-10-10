/* =================================================================================================
 * Heiz-Hawara – eigenständiger Server (Node.js 22.13+, eingebautes SQLite, keine weiteren Pakete)
 *
 * AUFGABEN
 *   · liefert die Oberfläche aus public/ (gzip + ETag) und die JSON-API unter /api/
 *   · speichert alles in data/data.db (SQLite, WAL) und sichert sie täglich nach data/backups/
 *   · Abgleich der Geräte per fortlaufender Änderungsnummer (`changeSeq`): jede Änderung bekommt die nächste Nummer,
 *     Geräte holen nur, was neuer ist als ihr letzter Stand; Live-Hinweis an alle offenen Geräte per SSE
 *   · Push-Nachrichten des Disponenten an Monteur-Geräte (Web Push, VAPID, ohne Fremdbibliothek)
 *   · Meldung an die Monteure eines Teams, wenn ihnen ein Auftrag disponiert oder die Disposition geändert wurde (flushDispoNotes)
 *
 * TABELLEN
 *   orders    Aufträge (del = 1: gelöscht/verschoben, bleibt als Markierung, damit Geräte es erfahren). kind = Auftragsart der App:
 *             war Wartung (3NAW/FWS) · dau Dauerauftrag (3NAW/FWD) · rep Reparatur (3NAR) · ent Entstörung (3NAE). Reparaturen und
 *             Entstörungen muss der Disponent erst disponieren (dteam, dvon, dbis: Team und Zeitraum, POST /api/dispo) – vorher sieht sie
 *             kein Monteur; eteam/mteam (berechnete Spalten) sagen, unter welchem Team ein Auftrag geführt bzw. von Monteuren gesehen wird. Bei Reparaturen ist
 *             jeder Vorgang ein eigener Eintrag: auftrag = „Nummer-Vorgang“ (z. B. 65046778-0010), nr = die echte Auftragsnummer;
 *             ext = Vorgänge externer Firmen (FW-IHEXT) zum Auftrag (JSON, nur zur Anzeige); geplante Teams („…P“) werden gar nicht geladen
 *             Die Aufträge werden aus den Rohdaten der SAP-Dateien zusammengesetzt (rebuildOrders):
 *   src_auftrag / src_vorgang   Zeilen der Aufträge-Excel bzw. der Vorgänge-Excel, wie hochgeladen. Jede Datei (Aufträge, Vorgänge,
 *             Meldungen, Prüflose) wird einzeln und in beliebiger Reihenfolge hochgeladen; nach jedem Upload von Aufträgen oder
 *             Vorgängen wird `orders` daraus neu berechnet
 *   meldung   Meldungen (Schäden): mit Auftrag (auftrag = echte Auftragsnummer) oder noch ohne (auftrag = '')
 *   pruef     Prüfobjekt-Liste je Auftrag (JSON)       ergebnis  Bewertung/Zeit je Auftrag (JSON, Format siehe index.html).
 *             Daueraufträge, Reparaturen und Entstörungen haben mehrere Zeiteinträge: je Eintrag eine Zeile mit dem Schlüssel „Auftrag#Kennung“
 *             (Format wie die Zeit eines Auftrags: min, dat, von, mit …); ein Eintrag ohne `min` gilt als gelöscht. Bei Reparatur/Entstörung
 *             ist der Eintrag mit `fin` = 1 die Endrückmeldung (Auftrag fertig), die übrigen sind Teilrückmeldungen. `go` (ms) = Start gedrückt,
 *             solange noch keine Zeit gespeichert ist
 *   dmark     „Abgehakt“ des Disponenten               meta      Schlüssel/Werte (Änderungsnummer, Geheimnis, VAPID, Upload-Infos)
 *   dev       Geräte (Rolle, Team, Spitzname, zuletzt aktiv, Push-Abo und Push-Status laut Gerät, Abmeldung, letzter Standort). Die Abgleich-Antwort
 *             sagt Monteur-Geräten in `dev`, ob der Server sie samt Abo kennt – fehlt es, melden sie sich neu an (Datenbank-Wechsel, 404/410)
 *             msg / mack  Nachrichten des Disponenten / Bestätigungen je Gerät
 *   dnote     vorgemerkte Änderungen der Disposition je Team und Auftrag (Stand davor, letzte Änderung) – daraus wird nach DISPO_NOTE_S Ruhe eine Meldung
 *   gas       tägliche Bestätigung des Gaswarngeräts je Team (Tag, Team, Uhrzeit, Gerät, Benutzer) – wird nur angefügt, nie geändert
 *   usr       Benutzer der Monteure (SAP-User, Name, Team, Passwort als scrypt-Hash); beim ersten Start aus users.json befüllt
 *   act       Protokoll: wer (Benutzer, Gerät) hat wann was getan (Anmeldung, Ergebnis, Gaswarngerät, Bestätigung, Benutzerverwaltung)
 *   geo       Koordinaten der Auftragsadressen (PLZ|Straße -> Breite/Länge) für die Sortierung der Monteur-Liste nach Entfernung
 *
 * ZUGRIFFSSTUFEN
 *   offen            Anmeldung (Monteur: SAP-User + Passwort, Disponent: PIN), Nachricht bestätigen, Push-Erneuerung, Standort
 *   Monteur          Header „X-User-Token“ (Token nach der Anmeldung, 60 Tage): Abgleich, Prüfobjekte lesen, Ergebnis speichern,
 *                    Gaswarngerät bestätigen, Push-Anmeldung als Monteur
 *   Disponent        Header „Authorization: Bearer <Token>“ (Token nach PIN-Eingabe, 12 h)
 *   Upload/Löschen   zusätzlich Header „X-Upload-Token“ (Token nach Upload-PIN-Eingabe, 30 min)
 *
 * EINSTELLUNGEN (Umgebungsvariablen)
 *   MONTEUR_PASSWORD (Startpasswort aller Monteur-Benutzer, Standard siehe unten) · DB_SYNC=FULL (Festschreiben wie bisher, siehe unten) ·
 *   PORT, HOST · DATA_DIR · TIMEZONE (bestimmt, wann für die Gaswarngerät-Bestätigung ein neuer Tag beginnt) · DISPO_PIN, UPLOAD_PIN (unbedingt ändern!) · NAG_MIN, MSG_HOURS · DISPO_NOTE_S (Sekunden Ruhe, bis die Monteure die Meldung „Auftrag disponiert“ bekommen, Standard 120) · PUSH_CONTACT, PUSH_HOSTS ·
 *   TRUST_PROXY=1 (hinter Proxy: echte Client-IP) · DB_JOURNAL=DELETE · TLS_CERT + TLS_KEY oder TLS_PFX (+ TLS_PASS) ·
 *   HTTP_REDIRECT_PORT · Koordinaten der Adressen: GEOCODER_WIEN_URL (Adressdienst der Stadt Wien, Standard data.wien.gv.at, "off" = nicht
 *   verwenden), GEOCODER_URL (Nominatim, Standard OpenStreetMap; "wien" = nur der Wiener Dienst, "off" = gar nichts abfragen),
 *   GEOCODER_CONTACT (Kontaktadresse für Nominatim, sonst PUSH_CONTACT), GEOCODER_DELAY_MS
 * ================================================================================================= */
const http = require('http'),
  https = require('https'),
  fs = require('fs'),
  path = require('path'),
  crypto = require('crypto'),
  zlib = require('zlib');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error(
    `Dieser Server braucht Node.js 22.13 oder neuer (eingebautes SQLite). Aktuell: ${process.version}`
  );
  process.exit(1);
}

// ---------- Einstellungen ----------
const PORT = +process.env.PORT || 3000,
  HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DISPO_PIN = String(process.env.DISPO_PIN || '2510'); // PIN der Disponenten – per Umgebungsvariable ändern!
const UPLOAD_PIN = String(process.env.UPLOAD_PIN || '1025'); // zusätzlicher PIN für Upload & Löschen – per Umgebungsvariable ändern!
// Startpasswort aller Monteur-Benutzer (beim Anlegen und beim „Passwort zurücksetzen“) – per Umgebungsvariable ändern!
const MONTEUR_PASSWORD = String(process.env.MONTEUR_PASSWORD || 'Fernwärme1');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Die Standardwerte stehen öffentlich im Quelltext: wer sie nicht ändert, hat praktisch keinen Schutz
for (const [name, standard] of [['DISPO_PIN', '2510'], ['UPLOAD_PIN', '1025'], ['MONTEUR_PASSWORD', 'Fernwärme1']])
  if (String(process.env[name] || standard) === standard)
    console.warn(`Warnung: ${name} hat noch den Standardwert – bitte per Umgebungsvariable ändern (siehe README, Abschnitt Sicherheit).`);
// Zeitzone, nach der „heute“ für die Gaswarngerät-Bestätigung gilt (um Mitternacht beginnt ein neuer Tag)
const TIMEZONE = process.env.TIMEZONE || 'Europe/Vienna';
const dayFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
// Kalendertag (JJJJ-MM-TT) eines Zeitpunkts in der Zeitzone des Betriebs
const dayOf = t => dayFormat.format(t);
const NAG_INTERVAL_MIN = Math.max(1, +process.env.NAG_MIN || 5); // Push-Erinnerung alle X Minuten wiederholen, bis bestätigt
const MESSAGE_HOURS = Math.max(1, +process.env.MSG_HOURS || 12); // spätestens nach X Stunden hört die Erinnerung auf
// Meldung „Auftrag disponiert“ an die Monteure: erst X Sekunden nach der letzten Änderung des Disponenten für das Team (Standard 2 Minuten –
// er bearbeitet den Auftrag vielleicht noch); die Push-Nachricht bleibt höchstens DISPO_NOTE_HOURS Stunden beim Push-Dienst liegen
const DISPO_NOTE_MS = (process.env.DISPO_NOTE_S !== undefined && +process.env.DISPO_NOTE_S >= 0 ? +process.env.DISPO_NOTE_S : 120) * 1000;
const DISPO_NOTE_HOURS = 6;
const PUSH_CONTACT = process.env.PUSH_CONTACT || 'mailto:admin@example.com'; // Kontakt für die Push-Dienste (VAPID "sub")
// IP des Clients (für die Begrenzung von PIN-Fehlversuchen); hinter einem Proxy (TRUST_PROXY=1) aus X-Forwarded-For
const clientIp = req =>
  (process.env.TRUST_PROXY === '1' &&
    String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .pop()
      .trim()
      .replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1')) ||
  req.socket.remoteAddress;

// nur an echte Push-Dienste senden (schützt davor, dass der Server beliebige Adressen aufruft)
const PUSH_HOSTS = new RegExp(
  process.env.PUSH_HOSTS ||
    '^https://((fcm|android)\\.googleapis\\.com|updates\\.push\\.services\\.mozilla\\.com|web\\.push\\.apple\\.com|[a-z0-9-]+\\.notify\\.windows\\.com)/'
);
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

// ---------- Datenbank ----------
// Schema: siehe Kopfkommentar. Die Spalte `seq` enthält die Änderungsnummer der letzten Änderung der Zeile (Grundlage des Abgleichs).
// Festschreiben: Im WAL-Modus genügt `synchronous=NORMAL` – ein Absturz der App oder des Servers verliert nichts, nur bei einem
// Stromausfall/Systemabsturz kann die allerletzte Änderung fehlen (die Datenbank bleibt in jedem Fall heil). Das spart bei jedem
// Speichern das Warten auf die Festplatte. DB_SYNC=FULL stellt die maximale Sicherheit wieder her (ohne WAL gilt immer FULL).
const JOURNAL = process.env.DB_JOURNAL === 'DELETE' ? 'DELETE' : 'WAL',
  SYNCHRONOUS = JOURNAL === 'WAL' && process.env.DB_SYNC !== 'FULL' ? 'NORMAL' : 'FULL';
const db = new DatabaseSync(path.join(DATA_DIR, 'data.db'));
db.exec(`
PRAGMA journal_mode=${JOURNAL}; PRAGMA synchronous=${SYNCHRONOUS}; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS orders(auftrag TEXT PRIMARY KEY, team TEXT NOT NULL, tp TEXT, art TEXT, plz TEXT, str TEXT, kurz TEXT, start TEXT, ende TEXT,
  del INTEGER NOT NULL DEFAULT 0, ts INTEGER, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS orders_seq ON orders(seq);
CREATE INDEX IF NOT EXISTS orders_team ON orders(team, del);
-- Meldungen (Schäden): nr = Meldungsnummer, dat = Angelegt am (wie im Auftrag als Text), txt = Beschreibung, code = Codierung (Schaden, Gebrechen …),
-- auftrag = verknüpfter Auftrag (leer = noch ohne Auftrag), team = verantwortlicher Arbeitsplatz
CREATE TABLE IF NOT EXISTS meldung(nr TEXT PRIMARY KEY, dat TEXT, txt TEXT, str TEXT, plz TEXT, auftrag TEXT, code TEXT, tp TEXT, stat TEXT, team TEXT, grp TEXT,
  del INTEGER NOT NULL DEFAULT 0, ts INTEGER, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS meldung_seq ON meldung(seq);
-- Rohdaten der Aufträge-Excel (kind = Auftragsart der App, siehe kindOfArt) und der Vorgänge-Excel (team = Team des Auftrags, vteam = Arbeitsplatz des Vorgangs)
CREATE TABLE IF NOT EXISTS src_auftrag(nr TEXT PRIMARY KEY, team TEXT NOT NULL, tp TEXT, art TEXT, lart TEXT, plz TEXT, str TEXT, kurz TEXT, start TEXT, ende TEXT, mel TEXT, kind TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS src_auftrag_team ON src_auftrag(team, kind);
CREATE TABLE IF NOT EXISTS src_vorgang(nr TEXT NOT NULL, vg TEXT NOT NULL, art TEXT, kurz TEXT, vtxt TEXT, team TEXT, vteam TEXT, lart TEXT, start TEXT, ende TEXT, arb TEXT, uhr TEXT, uhr2 TEXT, PRIMARY KEY(nr, vg));
CREATE INDEX IF NOT EXISTS src_vorgang_team ON src_vorgang(team);
CREATE TABLE IF NOT EXISTS pruef(auftrag TEXT PRIMARY KEY, items TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pruef_seq ON pruef(seq);
CREATE TABLE IF NOT EXISTS ergebnis(auftrag TEXT PRIMARY KEY, team TEXT, doc TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ergebnis_seq ON ergebnis(seq, team);
-- Abhaken durch den Disponenten: v=1 abgehakt (der Auftrag ist für Monteure gesperrt), v=0 zurückgenommen
CREATE TABLE IF NOT EXISTS dmark(auftrag TEXT PRIMARY KEY, v INTEGER NOT NULL, at INTEGER, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS dmark_seq ON dmark(seq);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- Geräte (Rolle/Team, Spitzname, zuletzt aktiv, Push-Abo, Abmeldung durch den Disponenten), Nachrichten des Disponenten und Bestätigungen je Gerät
CREATE TABLE IF NOT EXISTS dev(did TEXT PRIMARY KEY, team TEXT, sub TEXT, seen INTEGER, role TEXT, name TEXT, ua TEXT, first INTEGER, kick INTEGER NOT NULL DEFAULT 0, kick_at INTEGER, loc_lat REAL, loc_lon REAL, loc_acc REAL, loc_at INTEGER, loc_err TEXT);
CREATE TABLE IF NOT EXISTS msg(id INTEGER PRIMARY KEY AUTOINCREMENT, team TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mack(id INTEGER NOT NULL, did TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(id, did));
-- Meldung „Auftrag disponiert / geändert“ an die Monteure (siehe flushDispoNotes): je Team und Auftrag der Stand, den das Team vor den noch nicht
-- gemeldeten Änderungen des Disponenten kannte (was = 1: der Auftrag war beim Team, von/bis = damalige Zeiten), at = letzte Änderung.
-- Ist die letzte Änderung des Teams DISPO_NOTE_S Sekunden her, wird mit dem heutigen Stand verglichen und gemeldet; die Zeilen sind dann erledigt.
CREATE TABLE IF NOT EXISTS dnote(team TEXT NOT NULL, auftrag TEXT NOT NULL, was INTEGER NOT NULL, von TEXT, bis TEXT, at INTEGER NOT NULL, PRIMARY KEY(team, auftrag));
-- Gaswarngerät: ein Team bestätigt es vor der Arbeit jeden Tag. at = Zeitpunkt der Bestätigung am Gerät, rec = Eingang beim Server
-- (weicht ab, wenn ohne Netz bestätigt wurde), did = bestätigendes Gerät. Je Tag und Team zählt die erste Bestätigung.
CREATE TABLE IF NOT EXISTS gas(day TEXT NOT NULL, team TEXT NOT NULL, at INTEGER NOT NULL, rec INTEGER NOT NULL, did TEXT, seq INTEGER NOT NULL, PRIMARY KEY(day, team));
CREATE INDEX IF NOT EXISTS gas_seq ON gas(seq);
-- Benutzer der Monteure: sap = SAP-User (Großbuchstaben, Anmeldename), pw = „Salt:Hash“ (scrypt), pw_at = Zeitpunkt der letzten
-- Passwortänderung (frühere Anmeldungen werden ungültig), active = 0 sperrt den Benutzer, login_at = letzte Anmeldung
CREATE TABLE IF NOT EXISTS usr(sap TEXT PRIMARY KEY, last TEXT NOT NULL, first TEXT NOT NULL DEFAULT '', team TEXT, pw TEXT NOT NULL,
  pw_at INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created INTEGER, login_at INTEGER);
-- Protokoll: kind = login | login_fail | ergebnis | gas | ack | user_new | user_edit | user_del | user_reset; usr = SAP-User (leer bei Disponent)
CREATE TABLE IF NOT EXISTS act(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, usr TEXT, did TEXT, team TEXT, kind TEXT NOT NULL, ref TEXT, info TEXT);
CREATE INDEX IF NOT EXISTS act_usr ON act(usr, at);
-- Koordinaten der Auftragsadressen (Sortierung der Monteur-Liste nach Entfernung): k = "PLZ|Straße" genau wie im Auftrag,
-- q = 'h' Hausnummer gefunden | 's' nur die Straße; lat/lon NULL = nicht gefunden (wird nach 7 Tagen erneut versucht).
-- Die Nummer id wächst bei jedem Eintrag: Geräte holen mit ?since=<id> nur Neues.
CREATE TABLE IF NOT EXISTS geo(id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL UNIQUE, lat REAL, lon REAL, q TEXT, at INTEGER NOT NULL);
`);
// Spalte nachrüsten, falls eine ältere Datenbank sie noch nicht hat
const addColumn = (table, column, type) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
};
// Benutzer, der etwas getan hat: dev.usr = angemeldeter Benutzer des Geräts, die übrigen = wer bestätigt/bewertet hat
// Auftragsarten: bisherige Aufträge sind Wartungsaufträge. nr = echte Auftragsnummer (bei Reparaturen hat `auftrag` noch den Vorgang
// angehängt), vg/vtxt = Vorgang und dessen Kurztext, lart = Leistungsart, uhr/uhr2 = Uhrzeit von/bis, arb = geplante Arbeit (Stunden),
// mel = Meldungsnummer laut Aufträge-Excel
for (const [column, type] of [['kind', 'TEXT'], ['nr', 'TEXT'], ['vg', 'TEXT'], ['vtxt', 'TEXT'], ['lart', 'TEXT'], ['uhr', 'TEXT'], ['uhr2', 'TEXT'], ['arb', 'TEXT'], ['mel', 'TEXT'], ['ext', 'TEXT']])
  addColumn('orders', column, type);
db.exec("UPDATE orders SET kind='war' WHERE kind IS NULL; UPDATE orders SET nr=auftrag WHERE nr IS NULL; CREATE INDEX IF NOT EXISTS orders_nr ON orders(nr)");
// Disposition (nur Reparatur und Entstörung): Der Disponent legt Team (dteam) und Zeitraum (dvon bis dbis, Ortszeit „JJJJ-MM-TTTHH:MM“)
// fest, dat = Zeitpunkt der Disposition. Erst damit sehen Monteure den Auftrag. Beim Upload bleibt die Disposition erhalten (upOrder
// fasst diese Spalten nicht an). Zwei berechnete Spalten sagen, wo ein Auftrag erscheint:
//   eteam  das Team, unter dem der Auftrag geführt wird: die Disposition, sonst das Team aus SAP (Disponent, Teamliste)
//   mteam  das Team, dessen Monteure ihn sehen: Wartung/Dauerauftrag wie bisher das Team aus SAP, Reparatur/Entstörung erst nach der
//          Disposition (vorher NULL = kein Monteur sieht den Auftrag)
const firstDispoStart = !db.prepare('PRAGMA table_info(orders)').all().some(c => c.name === 'dteam'); // erster Start mit Disposition
for (const [column, type] of [['dteam', 'TEXT'], ['dvon', 'TEXT'], ['dbis', 'TEXT'], ['dat', 'INTEGER']]) addColumn('orders', column, type);
for (const [column, expr] of [
  ['eteam', 'COALESCE(dteam, team)'],
  ['mteam', "CASE WHEN kind IN ('rep','ent') THEN dteam ELSE team END"]
])
  // (berechnete Spalten fehlen in table_info, darum table_xinfo)
  if (!db.prepare('PRAGMA table_xinfo(orders)').all().some(c => c.name === column))
    db.exec(`ALTER TABLE orders ADD COLUMN ${column} TEXT GENERATED ALWAYS AS (${expr}) VIRTUAL`);
db.exec('CREATE INDEX IF NOT EXISTS orders_mteam ON orders(mteam, del); CREATE INDEX IF NOT EXISTS orders_eteam ON orders(eteam, del)');
// Meldungen werden nach Auftrag gesucht (touchMeldungOfOrders, meldungFullTeam), Geräte nach Benutzer (Benutzerliste, Kollegen)
db.exec('CREATE INDEX IF NOT EXISTS meldung_auftrag ON meldung(auftrag)');
// Ältere Datenbank (Aufträge aus der Zeit vor den getrennten Uploads): die vorhandenen Aufträge sind die Rohdaten der Aufträge-Excel,
// sonst würde der erste Upload einer anderen Datei sie als „nicht mehr vorhanden“ löschen. (Reparatur-Vorgänge gehen nicht: neu hochladen.)
if (!db.prepare('SELECT 1 FROM src_auftrag LIMIT 1').get())
  db.exec(`INSERT OR IGNORE INTO src_auftrag(nr,team,tp,art,lart,plz,str,kurz,start,ende,mel,kind)
    SELECT nr, team, COALESCE(tp,''), COALESCE(art,''), COALESCE(lart,''), COALESCE(plz,''), COALESCE(str,''), COALESCE(kurz,''), COALESCE(start,''), COALESCE(ende,''), COALESCE(mel,''), kind
    FROM orders WHERE del=0 AND COALESCE(vg,'')='' AND nr<>''`);
addColumn('dev', 'usr', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS dev_usr ON dev(usr)');
addColumn('gas', 'usr', 'TEXT');
addColumn('mack', 'usr', 'TEXT');
addColumn('ergebnis', 'usr', 'TEXT');
// team_lock = 1: der Monteur darf sein Team nicht selbst wechseln (der Disponent kann es immer ändern)
addColumn('usr', 'team_lock', 'INTEGER NOT NULL DEFAULT 0');
// Ältere Datenbanken haben in `dev` noch nicht alle Spalten: beim Start ergänzen. Bisherige Geräte mit Team waren Monteure.
{
  const have = new Set(
    db
      .prepare('PRAGMA table_info(dev)')
      .all()
      .map(c => c.name)
  );
  const added = {
    role: 'TEXT',
    name: 'TEXT',
    ua: 'TEXT',
    first: 'INTEGER',
    kick: 'INTEGER NOT NULL DEFAULT 0',
    kick_at: 'INTEGER',
    loc_lat: 'REAL',
    loc_lon: 'REAL',
    loc_acc: 'REAL',
    loc_at: 'INTEGER',
    loc_err: 'TEXT',
    // Push-Status laut Gerät: „Berechtigung|Detail“ (granted | default | denied | unsupported, Detail = Fehlertext), zeigt dem Disponenten, WARUM ein Gerät keine Benachrichtigungen hat
    pstat: 'TEXT'
  };
  for (const [column, type] of Object.entries(added))
    if (!have.has(column)) db.exec(`ALTER TABLE dev ADD COLUMN ${column} ${type}`);
  if (!have.has('role')) db.exec("UPDATE dev SET role='monteur' WHERE team IS NOT NULL");
}
// Vorbereitete SQL-Anweisungen (einmal kompiliert, vielfach genutzt). up… = einfügen/aktualisieren, tomb… = als gelöscht markieren
const sql = {
  getMeta: db.prepare('SELECT v FROM meta WHERE k=?'),
  setMeta: db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
  delMeta: db.prepare('DELETE FROM meta WHERE k=?'),
  // Teams mit Aufträgen (eteam: nach der Disposition das disponierte Team, sonst das aus SAP)
  teamCounts: db.prepare('SELECT eteam team, COUNT(*) n FROM orders WHERE del=0 GROUP BY eteam ORDER BY eteam'),
  // Meldungen: Monteure bekommen die ihres Teams (ohne Auftrag) und die zu Aufträgen ihres Teams
  meldungFullTeam: db.prepare(
    'SELECT * FROM meldung WHERE del=0 AND (team=?1 OR auftrag IN (SELECT nr FROM orders WHERE mteam=?1 AND del=0 AND nr<>\'\'))'
  ),
  // mine = 0: gelöscht oder nicht mehr (zu) diesem Team – das Gerät soll sie vergessen
  meldungSinceTeam: db.prepare(
    'SELECT *, (del=0 AND (team=?2 OR auftrag IN (SELECT nr FROM orders WHERE mteam=?2 AND del=0 AND nr<>\'\'))) AS mine FROM meldung WHERE seq>?1'
  ),
  meldungSince: db.prepare('SELECT * FROM meldung WHERE seq>?'),
  meldungSinceLive: db.prepare('SELECT * FROM meldung WHERE seq>? AND del=0'),
  upMeldung: db.prepare(`INSERT INTO meldung(nr,dat,txt,str,plz,auftrag,code,tp,stat,team,grp,del,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)
    ON CONFLICT(nr) DO UPDATE SET dat=excluded.dat,txt=excluded.txt,str=excluded.str,plz=excluded.plz,auftrag=excluded.auftrag,code=excluded.code,tp=excluded.tp,
      stat=excluded.stat,team=excluded.team,grp=excluded.grp,del=0,seq=excluded.seq
    WHERE meldung.del=1 OR meldung.dat IS NOT excluded.dat OR meldung.txt IS NOT excluded.txt OR meldung.str IS NOT excluded.str OR meldung.plz IS NOT excluded.plz
       OR meldung.auftrag IS NOT excluded.auftrag OR meldung.code IS NOT excluded.code OR meldung.tp IS NOT excluded.tp OR meldung.stat IS NOT excluded.stat
       OR meldung.team IS NOT excluded.team OR meldung.grp IS NOT excluded.grp`),
  // Meldungen der Teams in der Datei, die dort fehlen, als gelöscht markieren
  tombMeldungTeam: db.prepare(
    'UPDATE meldung SET del=1, ts=?, seq=? WHERE team=? AND del=0 AND nr NOT IN (SELECT value FROM json_each(?))'
  ),
  tombMeldungAll: db.prepare('UPDATE meldung SET del=1, ts=?, seq=? WHERE del=0'),
  // Meldungen zu Aufträgen, die sich gerade geändert haben (neuer Auftrag, anderes Team): neue Nummer, damit die Geräte sie mitholen
  touchMeldungOfOrders: db.prepare(
    'UPDATE meldung SET seq=? WHERE del=0 AND auftrag<>\'\' AND auftrag IN (SELECT nr FROM orders WHERE seq=?)'
  ),
  meldungMax: db.prepare('SELECT MAX(seq) m FROM meldung'),
  // Monteure bekommen nur, was ihr Team sieht (mteam): Reparaturen/Entstörungen erst nach der Disposition
  ordersFullTeam: db.prepare('SELECT * FROM orders WHERE del=0 AND mteam=?'),
  ergebnisTeam: db.prepare('SELECT auftrag,doc,seq FROM ergebnis WHERE seq>? AND team=?'),
  ergebnisAll: db.prepare('SELECT auftrag,doc,seq FROM ergebnis WHERE seq>?'),
  ordersSince: db.prepare('SELECT * FROM orders WHERE seq>?'),
  ordersSinceLive: db.prepare('SELECT * FROM orders WHERE seq>? AND del=0'),
  msgsTeam: db.prepare(
    'SELECT m.id, m.text, m.at, (SELECT 1 FROM mack a WHERE a.id=m.id AND a.did=?) ack FROM msg m WHERE m.team=? AND m.closed=0 AND m.at>?'
  ),
  msgsAll: db.prepare(
    'SELECT m.id, m.team, m.text, m.at, m.closed, (SELECT COUNT(*) FROM mack a WHERE a.id=m.id) acks FROM msg m WHERE m.at>?'
  ),
  devsByTeam: db.prepare(
    'SELECT team, COUNT(*) n, SUM(sub IS NOT NULL) p FROM dev WHERE team IS NOT NULL AND seen>? GROUP BY team'
  ),
  marksSince: db.prepare('SELECT auftrag,v,at,seq FROM dmark WHERE seq>?'),
  marksSinceLive: db.prepare('SELECT auftrag,v,at,seq FROM dmark WHERE seq>? AND v=1'),
  // Haken der Aufträge eines Teams (Monteure sehen sie, damit abgehakte Aufträge gesperrt sind)
  marksSinceTeam: db.prepare(
    'SELECT d.auftrag,d.v,d.at,d.seq FROM dmark d JOIN orders o ON o.auftrag=d.auftrag WHERE d.seq>? AND o.mteam=?'
  ),
  marksSinceLiveTeam: db.prepare(
    'SELECT d.auftrag,d.v,d.at,d.seq FROM dmark d JOIN orders o ON o.auftrag=d.auftrag WHERE d.seq>? AND d.v=1 AND o.del=0 AND o.mteam=?'
  ),
  getMark: db.prepare('SELECT v,at,seq FROM dmark WHERE auftrag=?'),
  // Zeiteinträge eines Auftrags (Schlüssel „Auftrag#Kennung“)
  getOrderKind: db.prepare('SELECT kind FROM orders WHERE auftrag=? AND del=0'),
  // Disposition (siehe /api/dispo): Zustand eines Auftrags, setzen, aufheben, Teams zur Auswahl
  getOrderDispo: db.prepare('SELECT * FROM orders WHERE auftrag=?'),
  setDispo: db.prepare('UPDATE orders SET dteam=?, dvon=?, dbis=?, dat=?, seq=? WHERE auftrag=?'),
  clearDispo: db.prepare('UPDATE orders SET dteam=NULL, dvon=NULL, dbis=NULL, dat=NULL, seq=? WHERE auftrag=?'),
  dispoTeams: db.prepare(
    "SELECT eteam t FROM orders WHERE del=0 AND eteam IS NOT NULL UNION SELECT team FROM usr WHERE active=1 AND COALESCE(team,'')<>''"
  ),
  // Einträge „Auftrag#…“: Bereich von „Auftrag#“ bis „Auftrag$“ ('$' folgt in der Zeichentabelle direkt auf '#'), nutzt den Primärschlüssel
  countEntries: db.prepare('SELECT COUNT(*) n FROM ergebnis WHERE auftrag >= ?1 AND auftrag < ?2'),
  // Team, dessen Monteure den Auftrag sehen (für die Prüfung beim Speichern eines Ergebnisses)
  getOrderTeam: db.prepare('SELECT mteam FROM orders WHERE auftrag=?'),
  ordersOfIds: db.prepare('SELECT auftrag, mteam team FROM orders WHERE auftrag IN (SELECT value FROM json_each(?))'),
  pruefOne: db.prepare('SELECT items FROM pruef WHERE auftrag=?'),
  maxSeq: db.prepare(
    'SELECT MAX(m) AS m FROM (SELECT MAX(seq) m FROM orders UNION ALL SELECT MAX(seq) FROM meldung UNION ALL SELECT MAX(seq) FROM pruef UNION ALL SELECT MAX(seq) FROM ergebnis UNION ALL SELECT MAX(seq) FROM dmark UNION ALL SELECT MAX(seq) FROM msg UNION ALL SELECT MAX(seq) FROM gas)'
  ),
  upMark: db.prepare(
    'INSERT INTO dmark(auftrag,v,at,seq) VALUES(?,?,?,?) ON CONFLICT(auftrag) DO UPDATE SET v=excluded.v, at=excluded.at, seq=excluded.seq'
  ),
  upErg: db.prepare(
    'INSERT INTO ergebnis(auftrag,team,doc,seq,usr) VALUES(?,?,?,?,?) ON CONFLICT(auftrag) DO UPDATE SET team=excluded.team, doc=excluded.doc, seq=excluded.seq, usr=excluded.usr'
  ),
  // Rohdaten (siehe rebuildOrders): Aufträge ersetzen je Team UND Auftragsart, Vorgänge je Auftrag
  upSrcAuftrag: db.prepare(
    'INSERT OR REPLACE INTO src_auftrag(nr,team,tp,art,lart,plz,str,kurz,start,ende,mel,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
  ),
  delSrcAuftragGroup: db.prepare(
    'DELETE FROM src_auftrag WHERE team=? AND kind=? AND nr NOT IN (SELECT value FROM json_each(?))'
  ),
  allSrcAuftrag: db.prepare('SELECT * FROM src_auftrag'),
  upSrcVorgang: db.prepare(
    'INSERT OR REPLACE INTO src_vorgang(nr,vg,art,kurz,vtxt,team,vteam,lart,start,ende,arb,uhr,uhr2) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ),
  delSrcVorgangOfOrders: db.prepare('DELETE FROM src_vorgang WHERE nr IN (SELECT value FROM json_each(?))'),
  delSrcVorgangTeams: db.prepare(
    'DELETE FROM src_vorgang WHERE team IN (SELECT value FROM json_each(?)) AND nr NOT IN (SELECT value FROM json_each(?))'
  ),
  allSrcVorgang: db.prepare('SELECT * FROM src_vorgang'),
  // Aufträge, die aus den Rohdaten nicht mehr hervorgehen, als gelöscht markieren
  tombMissing: db.prepare(
    'UPDATE orders SET del=1, ts=?, seq=? WHERE del=0 AND auftrag NOT IN (SELECT value FROM json_each(?))'
  ),
  tombAll: db.prepare('UPDATE orders SET del=1, ts=?, seq=? WHERE del=0'),
  upOrder:
    db.prepare(`INSERT INTO orders(auftrag,team,tp,art,plz,str,kurz,start,ende,kind,nr,vg,vtxt,lart,uhr,uhr2,arb,mel,ext,del,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
    ON CONFLICT(auftrag) DO UPDATE SET team=excluded.team,tp=excluded.tp,art=excluded.art,plz=excluded.plz,str=excluded.str,kurz=excluded.kurz,start=excluded.start,
      ende=COALESCE(NULLIF(excluded.ende,''),orders.ende),kind=excluded.kind,nr=excluded.nr,vg=excluded.vg,vtxt=excluded.vtxt,lart=excluded.lart,uhr=excluded.uhr,uhr2=excluded.uhr2,
      arb=excluded.arb,mel=excluded.mel,ext=excluded.ext,del=0,seq=excluded.seq
    WHERE orders.del=1 OR orders.team IS NOT excluded.team OR orders.tp IS NOT excluded.tp OR orders.art IS NOT excluded.art OR orders.plz IS NOT excluded.plz
       OR orders.str IS NOT excluded.str OR orders.kurz IS NOT excluded.kurz OR orders.start IS NOT excluded.start
       OR orders.ende IS NOT COALESCE(NULLIF(excluded.ende,''),orders.ende) OR orders.kind IS NOT excluded.kind OR orders.nr IS NOT excluded.nr
       OR orders.vg IS NOT excluded.vg OR orders.vtxt IS NOT excluded.vtxt OR orders.lart IS NOT excluded.lart OR orders.uhr IS NOT excluded.uhr
       OR orders.uhr2 IS NOT excluded.uhr2 OR orders.arb IS NOT excluded.arb OR orders.mel IS NOT excluded.mel OR orders.ext IS NOT excluded.ext`),
  upPruef: db.prepare(
    'INSERT INTO pruef(auftrag,items,seq) VALUES(?,?,?) ON CONFLICT(auftrag) DO UPDATE SET items=excluded.items, seq=excluded.seq WHERE pruef.items IS NOT excluded.items'
  ),
  wipePruef: db.prepare("UPDATE pruef SET items='[]', seq=? WHERE items<>'[]'"),
  getErg: db.prepare('SELECT doc, seq FROM ergebnis WHERE auftrag=?'),
  getDev: db.prepare('SELECT role, team, sub, kick, usr, pstat FROM dev WHERE did=?'),
  seenDev: db.prepare('UPDATE dev SET seen=? WHERE did=?'),
  // „zuletzt aktiv“ nur dann schreiben, wenn der letzte Eintrag älter als eine Minute ist (nicht bei jedem Abgleich)
  touchDev: db.prepare('UPDATE dev SET seen=? WHERE did=? AND (seen IS NULL OR seen<?)'),
  getKick: db.prepare('SELECT kick, kick_at FROM dev WHERE did=?'),
  // Anmeldung auf dem Gerät: die Abmeldung durch den Disponenten ist damit erledigt (sonst würde das Gerät gleich wieder abgemeldet)
  clearKick: db.prepare('UPDATE dev SET kick=0 WHERE did=? AND kick=1'),
  // meldet das Gerät an/um/ab (Rolle, Team, Push-Abo) und hebt eine angeforderte Abmeldung auf; Spitzname bleibt erhalten
  upDev: db.prepare(
    'INSERT INTO dev(did,role,team,sub,seen,ua,first,kick,usr,pstat) VALUES(?,?,?,?,?,?,?,0,?,?) ON CONFLICT(did) DO UPDATE SET role=excluded.role, team=excluded.team, sub=excluded.sub, seen=excluded.seen, ua=excluded.ua, kick=0, usr=excluded.usr, pstat=excluded.pstat'
  ),
  listDevs: db.prepare(
    "SELECT d.did, d.name, d.role, d.team, d.sub IS NOT NULL AS push, d.pstat, d.seen, d.first, d.ua, d.kick, d.loc_lat, d.loc_lon, d.loc_acc, d.loc_at, d.loc_err, d.usr, trim(u.first || ' ' || u.last) AS uname FROM dev d LEFT JOIN usr u ON u.sap=d.usr WHERE d.seen>? ORDER BY d.seen DESC"
  ),
  // letzter Standort bzw. Fehler (nur das Neueste, kein Verlauf); nur für angemeldete Monteur-Geräte
  setLoc: db.prepare(
    "UPDATE dev SET loc_lat=?, loc_lon=?, loc_acc=?, loc_err=?, loc_at=? WHERE did=? AND role='monteur'"
  ),
  clearLoc: db.prepare(
    'UPDATE dev SET loc_lat=NULL, loc_lon=NULL, loc_acc=NULL, loc_err=NULL, loc_at=NULL WHERE did=?'
  ),
  nameDev: db.prepare('UPDATE dev SET name=? WHERE did=?'),
  // Ausloggen: das Gerät ist sofort abgemeldet (Rolle, Team, Standort weg); `kick` merkt vor, dass es das beim nächsten
  // Kontakt auch selbst erfährt (Startbildschirm), `kick_at` entwertet seine bisherigen Tokens
  kickDev: db.prepare(
    'UPDATE dev SET kick=1, kick_at=?, role=NULL, team=NULL, usr=NULL, loc_lat=NULL, loc_lon=NULL, loc_acc=NULL, loc_err=NULL, loc_at=NULL WHERE did=?'
  ),
  dupSub: db.prepare('UPDATE dev SET sub=NULL WHERE sub=? AND did<>?'),
  dropSub: db.prepare('UPDATE dev SET sub=NULL WHERE did=?'),
  resub: db.prepare("UPDATE dev SET sub=? WHERE json_extract(sub,'$.endpoint')=?"),
  addMsg: db.prepare('INSERT INTO msg(team,text,at,seq) VALUES(?,?,?,?)'),
  closeTeamMsg: db.prepare('UPDATE msg SET closed=1, seq=? WHERE team=? AND closed=0'),
  closeMsg: db.prepare('UPDATE msg SET closed=1, seq=? WHERE id=?'),
  activeMsgs: db.prepare('SELECT id, team, text, at FROM msg WHERE closed=0 AND at>?'),
  ack: db.prepare('INSERT OR IGNORE INTO mack(id,did,at,usr) VALUES(?,?,?,?)'),
  nagDevs: db.prepare(
    'SELECT did, sub FROM dev WHERE team=? AND sub IS NOT NULL AND did NOT IN (SELECT did FROM mack WHERE id=?)'
  ),
  // Geräte, die eine Meldung „Auftrag disponiert“ bekommen: angemeldete Monteur-Geräte des Teams mit Push-Abo
  teamPushDevs: db.prepare("SELECT did, sub FROM dev WHERE role='monteur' AND team=? AND sub IS NOT NULL"),
  // Geräte des Teams, die zuletzt aktiv waren (n), davon mit Push-Abo (p) – für die Zeile im Protokoll, wenn niemand erreichbar ist
  teamDevCount: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(sub IS NOT NULL), 0) p FROM dev WHERE role='monteur' AND team=? AND seen>?"),
  // noch nicht gemeldete Änderungen der Disposition (Stand davor bleibt, nur der Zeitpunkt der letzten Änderung rückt vor)
  noteDispo: db.prepare(
    'INSERT INTO dnote(team,auftrag,was,von,bis,at) VALUES(?,?,?,?,?,?) ON CONFLICT(team,auftrag) DO UPDATE SET at=excluded.at'
  ),
  dueNoteTeams: db.prepare('SELECT team FROM dnote GROUP BY team HAVING MAX(at)<=?'),
  notesOfTeam: db.prepare('SELECT auftrag, was, von, bis FROM dnote WHERE team=? ORDER BY at, auftrag'),
  delNotesOfTeam: db.prepare('DELETE FROM dnote WHERE team=?'),
  hasTeam: db.prepare('SELECT 1 FROM orders WHERE eteam=? LIMIT 1'),
  getGas: db.prepare('SELECT day, team, at, rec, seq FROM gas WHERE day=? AND team=?'),
  addGas: db.prepare('INSERT OR IGNORE INTO gas(day,team,at,rec,did,seq,usr) VALUES(?,?,?,?,?,?,?)'),
  // Bestätigungen seit Änderungsnummer ab (mit Spitzname des Geräts und Benutzer); für Monteure nur die des eigenen Teams
  gasSince: db.prepare(
    "SELECT g.day d, g.team t, g.at, g.rec, g.seq sq, v.name n, g.usr u, trim(w.first || ' ' || w.last) un FROM gas g LEFT JOIN dev v ON v.did=g.did LEFT JOIN usr w ON w.sap=g.usr WHERE g.seq>? AND g.day>=? ORDER BY g.day, g.team"
  ),
  gasSinceTeam: db.prepare(
    'SELECT day d, team t, at, rec, seq sq FROM gas WHERE seq>? AND day>=? AND team=? ORDER BY day'
  ),
  // gesamtes Protokoll für den CSV-Export
  gasAll: db.prepare(
    "SELECT g.day, g.team, g.at, g.rec, v.name, substr(g.did, -4) did, g.usr, trim(w.first || ' ' || w.last) uname FROM gas g LEFT JOIN dev v ON v.did=g.did LEFT JOIN usr w ON w.sap=g.usr ORDER BY g.day DESC, g.team"
  ),
  // Benutzer und Protokoll
  getUsr: db.prepare('SELECT * FROM usr WHERE sap=?'),
  listUsr: db.prepare(
    'SELECT sap, last, first, team, team_lock, active, created, login_at, (SELECT MAX(seen) FROM dev WHERE usr=usr.sap) seen, (SELECT COUNT(*) FROM dev WHERE usr=usr.sap) devs FROM usr ORDER BY team, last, first'
  ),
  addUsr: db.prepare('INSERT INTO usr(sap,last,first,team,pw,pw_at,active,created,team_lock) VALUES(?,?,?,?,?,?,1,?,?)'),
  editUsr: db.prepare('UPDATE usr SET last=?, first=?, team=?, active=?, team_lock=? WHERE sap=?'),
  pwUsr: db.prepare('UPDATE usr SET pw=?, pw_at=? WHERE sap=?'),
  loginUsr: db.prepare('UPDATE usr SET login_at=? WHERE sap=?'),
  delUsr: db.prepare('DELETE FROM usr WHERE sap=?'),
  unlinkDevs: db.prepare('UPDATE dev SET usr=NULL WHERE usr=?'),
  // Kollegen für „mit wem gearbeitet“: alle aktiven Benutzer außer dem anfragenden; here = hat in letzter Zeit ein Gerät in diesem Team
  colleagues: db.prepare(
    "SELECT sap, trim(first || ' ' || last) name, team, EXISTS(SELECT 1 FROM dev WHERE dev.usr=usr.sap AND dev.team=? AND dev.seen>?) here FROM usr WHERE active=1 AND sap<>? ORDER BY last, first"
  ),
  usrNames: db.prepare("SELECT sap, trim(first || ' ' || last) name FROM usr ORDER BY last, first"),
  addAct: db.prepare('INSERT INTO act(at,usr,did,team,kind,ref,info) VALUES(?,?,?,?,?,?,?)'),
  listAct: db.prepare('SELECT at, did, team, kind, ref, info FROM act WHERE usr=? ORDER BY id DESC LIMIT ?'),
  msgState: db.prepare(
    'SELECT closed, at, (SELECT 1 FROM mack a WHERE a.id=msg.id AND a.did=?) ack FROM msg WHERE id=?'
  ),
  // Adressen der Aufträge, für die noch keine Koordinaten da sind (und kein Fehlversuch jünger als `?` ist)
  // (zuerst die Adressen der Teams, deren Geräte gerade Entfernungen brauchen: 2. Parameter = JSON-Liste dieser Teams)
  geoNext: db.prepare(
    `SELECT o.plz, o.str FROM orders o WHERE o.del=0 AND COALESCE(o.str,'')<>''
     AND NOT EXISTS (SELECT 1 FROM geo g WHERE g.k=COALESCE(o.plz,'') || '|' || o.str AND (g.lat IS NOT NULL OR g.at>?))
     GROUP BY o.plz, o.str ORDER BY MAX(o.team IN (SELECT value FROM json_each(?))) DESC LIMIT 1`
  ),
  geoOpen: db.prepare(
    `SELECT COUNT(*) n FROM (SELECT 1 FROM orders o WHERE o.del=0 AND COALESCE(o.str,'')<>''
     AND NOT EXISTS (SELECT 1 FROM geo g WHERE g.k=COALESCE(o.plz,'') || '|' || o.str AND (g.lat IS NOT NULL OR g.at>?))
     GROUP BY o.plz, o.str)`
  ),
  // REPLACE statt UPDATE: der Eintrag bekommt eine neue Nummer, damit Geräte die Änderung bei ?since= mitbekommen
  geoSet: db.prepare('INSERT OR REPLACE INTO geo(k,lat,lon,q,at) VALUES(?,?,?,?,?)'),
  geoSince: db.prepare('SELECT id, k, lat, lon, q FROM geo WHERE id>? AND lat IS NOT NULL ORDER BY id'),
  geoMax: db.prepare('SELECT MAX(id) m FROM geo')
};
// Wert aus der Tabelle meta lesen (JSON) bzw. null
// Zwischenspeicher: meta wird bei jedem Abgleich gelesen (JSON parsen), ändert sich aber selten
const metaCache = new Map();
const getMeta = k => {
  if (metaCache.has(k)) return metaCache.get(k);
  const r = sql.getMeta.get(k),
    value = r ? JSON.parse(r.v) : null;
  metaCache.set(k, value);
  return value;
};
// Wert in meta speichern; null löscht den Eintrag
const setMeta = (k, v) => {
  metaCache.set(k, v ?? null);
  return v == null ? sql.delMeta.run(k) : sql.setMeta.run(k, JSON.stringify(v));
};
// Katalog (Aufträge, Prüflisten) geändert: Teamliste/Meta werden neu aufgebaut. usersVer: Benutzerliste geändert.
let catalogVer = 1,
  usersVer = Date.now();
// Teamliste [[Team, Anzahl]] – wird nur neu berechnet, wenn sich der Katalog (Aufträge) geändert hat
let teamsCache = { v: 0, list: [] };
const teamsList = () => {
  if (teamsCache.v !== catalogVer) teamsCache = { v: catalogVer, list: sql.teamCounts.all().map(r => [r.team, r.n]) };
  return teamsCache.list;
};
// Teams, auf die der Disponent Aufträge disponieren kann: alle Teams mit Aufträgen und alle Teams der aktiven Benutzer (auch „Springer“
// ohne Aufträge); keine externen Firmen und keine geplanten Teams („…P“). Wird nur neu berechnet, wenn sich Aufträge oder Benutzer ändern.
let dispoTeamsCache = { v: '', list: [] };
const dispoTeamList = () => {
  const v = catalogVer + ':' + usersVer;
  if (dispoTeamsCache.v !== v)
    dispoTeamsCache = {
      v,
      list: [...new Set(sql.dispoTeams.all().map(r => String(r.t || '').trim()))]
        .filter(t => t && !isPlanned(t) && !isExternal(t))
        .sort((a, b) => a.localeCompare(b, 'de', { numeric: true }))
    };
  return dispoTeamsCache.list;
};
// vorbereitete Anweisung merken (SQL-Text -> Statement), damit dynamische Abfragen nicht bei jedem Aufruf neu übersetzt werden
const prepCache = new Map();
const prep = text => prepCache.get(text) || (prepCache.set(text, db.prepare(text)), prepCache.get(text));
// fortlaufende Änderungsnummer: jede Änderung zählt hoch; Geräte holen nur Zeilen mit seq > ihrem Stand
// (beim Start: die größte Nummer, die in der Datenbank vorkommt)
let changeSeq = Math.max(+getMeta('seq') || 0, sql.maxSeq.get().m || 0); // fortlaufende Änderungsnummer
let minSeq = +getMeta('minseq') || 0; // davor sind Änderungen nicht mehr vollständig nachvollziehbar
// Erster Start mit Disposition: vorhandene Reparaturen und Entstörungen sind nun für Monteure unsichtbar, bis der Disponent sie disponiert.
// Geräte, die sie noch kennen, müssen davon erfahren: neue Änderungsnummer, dann bekommen sie den Auftrag als „gelöscht“ geliefert.
if (firstDispoStart && db.prepare("SELECT 1 FROM orders WHERE kind IN ('rep','ent') LIMIT 1").get()) {
  changeSeq++;
  db.prepare("UPDATE orders SET seq=? WHERE kind IN ('rep','ent')").run(changeSeq);
  setMeta('seq', changeSeq);
}
// Früher bekamen Geräte beim Disponieren eines Auftrags dessen Meldungen nicht mit (siehe POST /api/dispo): einmalig neue Nummer für die
// Meldungen der bereits disponierten Aufträge, damit Geräte, die sie noch nicht haben, sie beim nächsten Abgleich nachholen
if (getMeta('meldispo') !== 1) {
  const todo = db.prepare("SELECT 1 FROM meldung WHERE del=0 AND auftrag<>'' AND auftrag IN (SELECT nr FROM orders WHERE del=0 AND dteam IS NOT NULL) LIMIT 1").get();
  if (todo) {
    changeSeq++;
    db.prepare("UPDATE meldung SET seq=? WHERE del=0 AND auftrag<>'' AND auftrag IN (SELECT nr FROM orders WHERE del=0 AND dteam IS NOT NULL)").run(changeSeq);
    setMeta('seq', changeSeq);
  }
  setMeta('meldispo', 1);
}
// Führt fn in einer Transaktion aus und sichert dabei die Änderungsnummer mit (alles oder nichts)
const transaction = fn => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    setMeta('seq', changeSeq);
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};

// mehrere gleichzeitige Schreibzugriffe in einer Transaktion bündeln (ein fsync statt vieler), Antwort erst nach dem Commit
let batchQueue = [],
  batchTimer = null;
const inBatch = fn =>
  new Promise((ok, no) => {
    batchQueue.push({ fn, ok, no });
    if (!batchTimer) batchTimer = setTimeout(runBatch, 3);
  });
// Führt alle gesammelten Schreibaufträge in einer Transaktion aus und beantwortet sie erst nach dem Commit
function runBatch() {
  batchTimer = null;
  const queue = batchQueue;
  batchQueue = [];
  try {
    db.exec('BEGIN IMMEDIATE');
    const out = queue.map(x => x.fn());
    setMeta('seq', changeSeq);
    db.exec('COMMIT');
    queue.forEach((x, i) => x.ok(out[i]));
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    queue.forEach(x => x.no(e));
  }
}

// gelöschte Aufträge (Markierungen) nach 30 Tagen entfernen; ältere Geräte laden dann komplett neu
{
  const lim = Date.now() - 30 * 864e5,
    m = db.prepare('SELECT MAX(seq) m FROM orders WHERE del=1 AND ts<?').get(lim).m;
  if (m) {
    db.prepare('DELETE FROM orders WHERE del=1 AND ts<?').run(lim);
    minSeq = Math.max(minSeq, m);
    setMeta('minseq', minSeq);
  }
}

// tägliche Sicherung (konsistenter Schnappschuss), die letzten 30 bleiben
let lastBackup = '';
// Sicherung einmal pro Tag (VACUUM INTO = konsistenter Schnappschuss), die letzten 30 bleiben
function backup() {
  const day = new Date().toISOString().slice(0, 10);
  if (day === lastBackup) return;
  const file = path.join(DATA_DIR, 'backups', `data-${day}.db`);
  try {
    if (!fs.existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    lastBackup = day;
  } catch (e) {
    console.error('Sicherung fehlgeschlagen:', e.message);
    return;
  }
  try {
    const existing = fs
      .readdirSync(path.join(DATA_DIR, 'backups'))
      .filter(x => x.endsWith('.db'))
      .sort();
    for (const x of existing.slice(0, Math.max(0, existing.length - 30)))
      fs.unlinkSync(path.join(DATA_DIR, 'backups', x));
  } catch (e) {
    console.error('Alte Sicherungen konnten nicht entfernt werden:', e.message); // darf den Server (Timer) nicht beenden
  }
}
backup();
setInterval(backup, 3600e3).unref();
// Eine übersehene Ausnahme in einer async-Funktion (Node 22 beendet dann den Prozess) soll nicht alle Geräte vom Server trennen:
// protokollieren und weiterlaufen. (Die Datenbank bleibt heil: jede Änderung läuft in einer Transaktion.)
process.on('unhandledRejection', e => console.error('Unbehandelter Fehler:', e));
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    try {
      db.close();
    } catch {}
    process.exit(0);
  });

// ---------- Live-Verteilung (Server-Sent Events) ----------
// Jede Änderung zählt `changeSeq` genau um 1 hoch und wird danach mit ihrer Nummer `sq` angekündigt (announce). Die Geräte
// bekommen sofort – ohne eigene Anfrage – das Nötige:
//   { s }        Änderung betrifft dieses Gerät nicht (z. B. anderes Team): es merkt sich nur die neue Nummer
//   { s, d }     Änderung samt Daten (Ergebnis eines Auftrags, Haken des Disponenten): das Gerät übernimmt sie direkt
//   { s, n: 1 }  Änderung betrifft das Gerät, ist aber größer (Upload, Nachricht, Gaswarngerät …): das Gerät gleicht ab
// Reißt die Kette ab (ein Gerät verpasst eine Nummer), gleicht es mit /api/sync ab – dort bleibt alles wie bisher.
// Clients: { res, kind: 'dispo' (Disponent mit Token, sieht alles) | 'team' (Monteur mit Token, nur sein Team) | 'anon' (ohne Anmeldung
// bzw. ältere App: bekommt bei jeder Änderung { s, n: 1 }), team }
const sseClients = new Set();
const MAX_LIVE_CLIENTS = 5000, // Live-Verbindungen insgesamt
  MAX_LIVE_ANON = 200; // davon ohne Anmeldung (die aktuelle App verbindet sich nur angemeldet)
/**
 * scope: 'all' (alle Geräte betroffen) | 'dispo' (nur Disponenten) | { team } (dieses Team und Disponenten) |
 *        { teams: Set } (mehrere Teams und Disponenten)
 * delta: optionale Daten, die betroffene Geräte direkt übernehmen (siehe oben); oder eine Funktion (client) => Daten | null,
 *        wenn jedes Gerät nur seinen Teil bekommen soll (null = das Gerät gleicht ab)
 */
function announce(sq, scope = 'all', delta = null) {
  if (!sseClients.size) return;
  const ping = `data: ${JSON.stringify({ s: sq })}\n\n`,
    sync = `data: ${JSON.stringify({ s: sq, n: 1 })}\n\n`,
    shared = delta && typeof delta !== 'function' ? `data: ${JSON.stringify({ s: sq, d: delta })}\n\n` : sync;
  for (const c of sseClients) {
    if (c.res.writableLength > 262144) {
      c.res.destroy(); // Gerät liest nicht mehr (hängende Verbindung): nicht endlos Daten aufstauen
      continue;
    }
    const relevant =
      c.kind === 'dispo' ||
      scope === 'all' ||
      (scope !== 'dispo' &&
        c.kind === 'team' &&
        (scope.team === c.team || (scope.teams !== undefined && scope.teams.has(c.team))));
    let data = shared;
    if (relevant && typeof delta === 'function') {
      const d = delta(c);
      data = d ? `data: ${JSON.stringify({ s: sq, d })}\n\n` : sync;
    }
    c.res.write(c.kind === 'anon' ? sync : relevant ? data : ping);
  }
}
setInterval(() => {
  for (const c of sseClients) c.res.write(': ping\n\n');
}, 25000).unref();

// ---------- Hilfsfunktionen ----------
// Text auf höchstens n Zeichen kürzen (aus null/undefined wird ein leerer Text) – begrenzt Eingaben
const clipString = (v, n = 300) => String(v ?? '').slice(0, n);
// Standortabfrage: Solange der Disponent die Geräteübersicht offen hat, hält er die Abfrage am Leben (`locateUntil`).
// Nur dann melden Monteur-Geräte (beim Abgleich über `locate` informiert) ihren Standort. `locateRound` zählt die
// Abfragerunden: eine neue Runde (Tab geöffnet / „jetzt aktualisieren“) lässt die Geräte sofort antworten.
let locateUntil = 0,
  locateRound = 0;
const LOCATE_WINDOW_MS = 90e3;
// Feld für die Abgleich-Antwort: `locate: <Runde>` nur, wenn die Abfrage gerade aktiv ist
const locateField = () => (Date.now() < locateUntil ? { locate: locateRound } : {});
// Wie kennt der Server dieses Gerät? (Monteur mit Team) 0 = gar nicht bzw. mit anderem Team/anderer Rolle, 1 = angemeldet ohne Push-Abo,
// 2 = angemeldet mit Push-Abo. Die App meldet sich bei 0 neu an und holt bei 1 das Abo nach, wenn der Browser Push erlaubt: So heilen sich ein
// Wechsel der Datenbank, ein abgelaufenes Abo (404/410) und eine zwischenzeitliche Abmeldung von selbst. Ohne diese Angabe merkt ein Gerät nicht,
// dass der Server es nicht (mehr) per Push erreichen kann, und niemand bekommt je wieder eine Benachrichtigung.
const deviceState = (did, team) => {
  const d = sql.getDev.get(did);
  return d && d.role === 'monteur' && d.team === team ? (d.sub ? 2 : 1) : 0;
};
// gültige Geräte-ID (32 Hex-Zeichen) oder '' – die ID erzeugt die App einmalig je Gerät
const validDeviceId = v => (/^[a-f0-9]{32}$/.test(String(v ?? '')) ? String(v) : '');
// versteht der Client gzip?
const acceptsGzip = req => /\bgzip\b/.test(req.headers['accept-encoding'] || '');
// Antwort als JSON; ab 1 KB gzip-komprimiert, falls der Client das kann
function sendJson(req, res, code, obj) {
  const bytes = Buffer.from(JSON.stringify(obj)),
    headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (bytes.length > 1024 && acceptsGzip(req))
    zlib.gzip(bytes, (e, z) => {
      if (e) {
        res.writeHead(code, headers);
        return res.end(bytes);
      }
      res.writeHead(code, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      res.end(z);
    });
  else {
    res.writeHead(code, headers);
    res.end(bytes);
  }
}
// JSON-Body lesen (höchstens max Bytes); Fehler als { code, msg }, die der Handler in eine Antwort umsetzt
const readBody = (req, max = 30e6) =>
  new Promise((ok, no) => {
    let received = 0;
    const chunks = [];
    req.on('data', c => {
      received += c.length;
      if (received > max) {
        no({ code: 413, msg: 'Datei zu groß' });
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        no({ code: 400, msg: 'Ungültiges JSON' });
      }
    });
    req.on('error', () => no({ code: 400, msg: 'Lesefehler' }));
  });

// Anmeldung Disponent: PIN -> signiertes Token (12 h, übersteht Neustarts); Fehlversuche begrenzt
// Upload-PIN: eigenes Token (Bereich "up:", 30 Min) – nötig für Upload und Löschen
let secret = getMeta('secret');
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  setMeta('secret', secret);
}
// Signatur (HMAC) für Token
const sign = e => crypto.createHmac('sha256', secret).update(String(e)).digest('hex');
// Vergleich in konstanter Zeit (gegen Timing-Angriffe)
const safeEqual = (a, b) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
// Fehlversuche je IP (und Bereich): nach 5 Fehlversuchen 10 Minuten gesperrt
const loginFailures = new Map();
// abgelaufene Einträge (älter als 10 Minuten) regelmäßig entfernen, damit die Liste nicht endlos wächst
setInterval(() => {
  const limit = Date.now() - 600e3;
  for (const [key, f] of loginFailures) if (f.t < limit) loginFailures.delete(key);
}, 600e3).unref();
// Gültigkeit der Anmelde-Tokens: Disponent 12 Stunden, Upload (scope 'up:') 30 Minuten
const DISPO_TOKEN_MS = 12 * 3600e3,
  UPLOAD_TOKEN_MS = 30 * 60e3;
/**
 * Prüft die PIN und gibt ein Token zurück (null bei falscher PIN oder Sperre):
 * „<Ablaufzeit>.<Geräte-ID>.<Signatur>“, ohne Geräte-ID (ältere Apps) „<Ablaufzeit>.<Signatur>“.
 * Mit Geräte-ID kann der Disponent das Gerät später abmelden, dann wird das Token ungültig (siehe tokenValid).
 */
function login(ip, pin, want = DISPO_PIN, scope = '', did = '') {
  const key = scope + ip,
    failure = loginFailures.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - failure.t > 600e3) {
    failure.n = 0;
    failure.t = Date.now();
  }
  if (failure.n >= 5) return null;
  if (safeEqual(String(pin), want)) {
    loginFailures.delete(key);
    const expiresAt = Date.now() + (scope ? UPLOAD_TOKEN_MS : DISPO_TOKEN_MS);
    return did
      ? `${expiresAt}.${did}.${sign(scope + expiresAt + '.' + did)}`
      : expiresAt + '.' + sign(scope + expiresAt);
  }
  failure.n++;
  loginFailures.set(key, failure);
  return null;
}
// Gerät ab? Das hat der Disponent mit „Ausloggen“ angefordert (kick_at = Zeitpunkt)
const deviceKickedAt = did => {
  const k = sql.getKick.get(did);
  return (k && k.kick_at) || 0;
};
// Token gültig? (Signatur stimmt, Ablaufzeit nicht überschritten, richtiger Bereich, nicht durch eine Abmeldung des Geräts
// entwertet: Tokens, die vor der Abmeldung ausgestellt wurden, gelten nicht mehr)
const tokenValid = (t, scope = '') => {
  const parts = String(t || '').split('.');
  if (parts.length !== 2 && parts.length !== 3) return false;
  const e = parts[0],
    sig = parts[parts.length - 1],
    did = parts.length === 3 ? parts[1] : '';
  if (!(e && sig && +e > Date.now() && safeEqual(sign(scope + e + (did ? '.' + did : '')), sig)))
    return false;
  return !did || deviceKickedAt(did) <= +e - (scope ? UPLOAD_TOKEN_MS : DISPO_TOKEN_MS);
};
// Anfrage mit gültigem Disponenten-Token?
const isDispo = req => tokenValid((req.headers.authorization || '').replace(/^Bearer /, ''));
// Anfrage mit gültigem Upload-Token?
const isUpload = req => tokenValid(req.headers['x-upload-token'], 'up:');

// ---- Benutzer der Monteure (SAP-User + Passwort) ----
const USER_TOKEN_MS = 60 * 864e5; // Anmeldung bleibt 60 Tage gültig (die Monteure sollen nicht täglich tippen müssen)
// SAP-User: nur Buchstaben und Ziffern, gespeichert in Großbuchstaben (Anmeldung ohne Beachtung der Schreibweise)
const normalizeSap = v => String(v ?? '').trim().toUpperCase();
const validSap = v => /^[A-Z0-9]{2,20}$/.test(v);
// Passwort-Hash „Salt:Hash“ (scrypt); Unicode wird normalisiert, damit „ä“ auf jedem Gerät gleich ankommt
const hashPassword = (password, salt = crypto.randomBytes(16)) =>
  salt.toString('hex') + ':' + crypto.scryptSync(String(password).normalize('NFC'), salt, 32).toString('hex');
// Prüfung im Hintergrund-Thread (crypto.scrypt): der Server bleibt währenddessen für alle anderen Geräte ansprechbar
const passwordMatches = async (password, stored) => {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const key = await new Promise((ok, no) =>
    crypto.scrypt(String(password).normalize('NFC'), Buffer.from(salt, 'hex'), 32, (e, k) => (e ? no(e) : ok(k)))
  );
  return safeEqual(key.toString('hex'), hash);
};
// Hash eines Passworts, das niemand hat: gleiche Rechenzeit, auch wenn der Benutzer gar nicht existiert
const UNKNOWN_USER_HASH = hashPassword('x');
// Anzeigename: „Vorname Nachname“
const fullName = u => (String(u.first || '') + ' ' + String(u.last || '')).trim();
// Protokolleintrag (wer, auf welchem Gerät, wann, was); Disponent-Aktionen ohne Benutzer
const logAct = (kind, usr, did, team, ref, info) => {
  try {
    sql.addAct.run(Date.now(), usr || null, did || null, team || null, kind, ref == null ? null : clipString(ref, 100), info == null ? null : clipString(info, 300));
  } catch (e) {
    console.error('Protokoll fehlgeschlagen:', e.message);
  }
};
// Token des Monteurs: „<Ablauf>.<Geräte-ID oder ->.<SAP-User>.<Signatur>“
const userTokenFor = (sap, did) => {
  const expiresAt = Date.now() + USER_TOKEN_MS,
    d = did || '-';
  return `${expiresAt}.${d}.${sap}.${sign('u:' + expiresAt + '.' + d + '.' + sap)}`;
};
/**
 * Prüft den Monteur-Token (Header X-User-Token): Signatur und Ablauf stimmen, der Benutzer existiert und ist nicht gesperrt,
 * das Passwort wurde seit der Anmeldung nicht geändert und das Gerät wurde nicht ausgeloggt. Gibt { sap, did, name, team }
 * oder null zurück.
 */
function userFromRequest(req) {
  const parts = String(req.headers['x-user-token'] || '').split('.');
  if (parts.length !== 4) return null;
  const [e, d, sap, sig] = parts;
  if (!(+e > Date.now() && validSap(sap) && safeEqual(sign('u:' + e + '.' + d + '.' + sap), sig))) return null;
  const row = sql.getUsr.get(sap);
  if (!row || !row.active || +e - USER_TOKEN_MS < row.pw_at) return null;
  if (d !== '-' && deviceKickedAt(d) > +e - USER_TOKEN_MS) return null;
  // lock: Team ist fest zugewiesen (nur wirksam, wenn es ein Team gibt)
  return { sap, did: d === '-' ? '' : d, name: fullName(row), team: row.team, lock: !!row.team_lock && !!row.team };
}
// Monteur mit festem Team darf nur dieses Team abfragen/bearbeiten
const teamAllowed = (user, team) => !user.lock || team === user.team;
const meOf = user => ({ sap: user.sap, name: user.name, team: user.team, lock: user.lock });
// Anmeldung eines Monteurs: nach 5 Fehlversuchen je Benutzer und IP sowie 40 je IP (gemeinsames WLAN) 10 Minuten gesperrt
async function userLogin(ip, sapInput, password) {
  const keys = ['ul:' + sapInput.slice(0, 20) + ':' + ip, 'ui:' + ip],
    limits = [5, 40],
    now = Date.now();
  const failures = keys.map(k => {
    const f = loginFailures.get(k) || { n: 0, t: now };
    if (now - f.t > 600e3) {
      f.n = 0;
      f.t = now;
    }
    return f;
  });
  if (failures.some((f, i) => f.n >= limits[i])) return { locked: true };
  const row = validSap(sapInput) ? sql.getUsr.get(sapInput) : null;
  // Der Versuch zählt SOFORT (vor dem Warten auf scrypt): sonst kämen beliebig viele gleichzeitige Versuche an der Sperre vorbei.
  // Bei Erfolg wird er zurückgenommen.
  failures.forEach((f, i) => {
    f.n++;
    loginFailures.set(keys[i], f);
  });
  // gleiche Rechenzeit, ob der Benutzer existiert oder nicht (kein Hinweis, welche Namen es gibt)
  const ok = (await passwordMatches(password, row ? row.pw : UNKNOWN_USER_HASH)) && !!row && !!row.active;
  if (ok) {
    loginFailures.delete(keys[0]);
    failures[1].n = Math.max(0, failures[1].n - 1);
    return { row };
  }
  return { bad: true };
}

// Benutzer beim ersten Start aus users.json (Team, Nachname, Vorname, SAP-User) anlegen, alle mit dem Startpasswort.
// Danach pflegt der Disponent sie in der App; die Datei wird nicht noch einmal eingelesen.
if (!getMeta('usersSeeded')) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8'));
  } catch (e) {
    console.error('users.json konnte nicht gelesen werden:', e.message);
  }
  list = (Array.isArray(list) ? list : []).filter(u => u && validSap(normalizeSap(u.sap)) && u.last);
  if (list.length) {
    const now = Date.now();
    transaction(() => {
      for (const u of list)
        if (!sql.getUsr.get(normalizeSap(u.sap)))
          sql.addUsr.run(
            normalizeSap(u.sap),
            clipString(u.last, 60),
            clipString(u.first, 60),
            clipString(u.team, 100) || null,
            hashPassword(MONTEUR_PASSWORD),
            now,
            now,
            0
          );
    });
    setMeta('usersSeeded', true);
    console.log(`${list.length} Benutzer aus users.json angelegt (Startpasswort: siehe MONTEUR_PASSWORD).`);
  }
}
// Protokoll nach 400 Tagen aufräumen
db.prepare('DELETE FROM act WHERE at<?').run(Date.now() - 400 * 864e5);

// ---- Web Push (RFC 8291 Verschlüsselung + RFC 8292 VAPID), nur Node-Bordmittel ----
let vapid = getMeta('vapid');
if (!vapid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    j = publicKey.export({ format: 'jwk' });
  vapid = {
    priv: privateKey.export({ format: 'jwk' }),
    pub: Buffer.concat([
      Buffer.from([4]),
      Buffer.from(j.x, 'base64url'),
      Buffer.from(j.y, 'base64url')
    ]).toString('base64url')
  };
  setMeta('vapid', vapid);
}
// Schlüsselpaar des Servers für Web Push (VAPID); wird beim ersten Start erzeugt und in meta gespeichert
const vapidKey = crypto.createPrivateKey({ key: vapid.priv, format: 'jwk' });
// VAPID-Anmeldung je Push-Dienst zwischenspeichern (12 h gültig)
const vapidJwtCache = new Map();
// Authorization-Header (VAPID, RFC 8292) für einen Push-Dienst: signiertes JWT + öffentlicher Schlüssel
function vapidAuth(endpoint, contact = PUSH_CONTACT, key = vapidKey, pub = vapid.pub) {
  const aud = new URL(endpoint).origin,
    cached = vapidJwtCache.get(aud),
    now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - now > 3600 && key === vapidKey) return cached.h;
  const exp = now + 12 * 3600,
    toBase64Url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = toBase64Url({ typ: 'JWT', alg: 'ES256' }) + '.' + toBase64Url({ aud, exp, sub: contact });
  const header = `vapid t=${data}.${crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}, k=${pub}`;
  if (key === vapidKey) vapidJwtCache.set(aud, { exp, h: header });
  return header;
}
const hmacSha256 = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
// Nachricht für ein Gerät verschlüsseln (RFC 8291, aes128gcm): keys = { p256dh, auth } des Push-Abos
function pushEncrypt(keys, payload, salt = crypto.randomBytes(16), ecdh = null) {
  // aes128gcm, ein Datensatz
  const browserKey = Buffer.from(keys.p256dh, 'base64url'),
    auth = Buffer.from(keys.auth, 'base64url');
  if (!ecdh) {
    ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
  }
  const serverPublicKey = ecdh.getPublicKey(),
    ikm = hmacSha256(
      hmacSha256(auth, ecdh.computeSecret(browserKey)),
      Buffer.concat([Buffer.from('WebPush: info\0'), browserKey, serverPublicKey, Buffer.from([1])])
    );
  const prk = hmacSha256(salt, ikm),
    cek = hmacSha256(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16),
    nonce = hmacSha256(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce),
    body = Buffer.concat([
      cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])),
      cipher.final(),
      cipher.getAuthTag()
    ]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = serverPublicKey.length;
  return Buffer.concat([head, serverPublicKey, body]);
}
// Push an ein Gerät senden; false, wenn nicht zugestellt (404/410 = Abo abgelaufen -> Abo am Gerät löschen).
// topic: gleiches Thema ersetzt beim Push-Dienst eine noch nicht zugestellte Nachricht (Nachrichten des Disponenten und Meldungen zur
// Disposition dürfen sich nicht gegenseitig ersetzen), hours: so lange hält der Push-Dienst die Nachricht für ein Gerät ohne Netz bereit
async function pushToDevice(device, payload, { topic = 'nachricht', hours = MESSAGE_HOURS } = {}) {
  let sub;
  try {
    sub = JSON.parse(device.sub);
    new URL(sub.endpoint);
  } catch {
    // unbrauchbares Abo in der Datenbank: löschen, das Gerät meldet sich neu an (siehe `dev` in der Abgleich-Antwort)
    console.error(`Push: Abo von Gerät ${String(device.did).slice(0, 8)} ist unbrauchbar – gelöscht`);
    sql.dropSub.run(device.did);
    return false;
  }
  try {
    const response = await fetch(sub.endpoint, {
      method: 'POST',
      body: pushEncrypt(sub.keys, JSON.stringify(payload)),
      signal: AbortSignal.timeout(15000),
      redirect: 'manual', // ein Push-Dienst antwortet direkt; eine Weiterleitung würde die Prüfung der Adresse (PUSH_HOSTS) umgehen
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(hours * 3600),
        Urgency: 'high',
        Topic: topic,
        Authorization: vapidAuth(sub.endpoint)
      }
    });
    if (response.status === 404 || response.status === 410) {
      // Abo abgelaufen/abgemeldet: am Gerät löschen (es meldet sich beim nächsten Öffnen der App neu an) – und sagen, dass es passiert ist
      console.error(`Push an ${new URL(sub.endpoint).host}: Abo von Gerät ${String(device.did).slice(0, 8)} abgelaufen (${response.status}) – Push dort aus, bis sich das Gerät neu anmeldet`);
      sql.dropSub.run(device.did);
      return false;
    }
    if (!response.ok)
      console.error(
        `Push an ${new URL(sub.endpoint).host} fehlgeschlagen: ${response.status} ${(await response.text()).slice(0, 200)}`
      );
    return response.ok;
  } catch (e) {
    // „fetch failed“ allein sagt nichts: die Ursache (ENOTFOUND, ETIMEDOUT, Zertifikat …) steckt in `cause` (geoReason, weiter unten)
    console.error(`Push an ${new URL(sub.endpoint).host} fehlgeschlagen: ${geoReason(e)}`);
    return false;
  }
}
// Push an mehrere Geräte zugleich; Rückgabe { ok: zugestellt, total: versucht }. payload: Objekt oder Funktion (Gerät) => Objekt. Mit `label` kommt
// EINE Zeile ins Protokoll – auch dann, wenn es keinen Empfänger gibt, denn das ist der häufigste Grund für „es kommt nichts an“: kein Gerät des Teams
// hat Benachrichtigungen erlaubt oder sich nach einem Datenbank-Wechsel neu angemeldet (die Abos stehen in der Datenbank). `team` zählt die Geräte dafür.
async function pushToDevices(devices, payload, options, label = '', team = '') {
  const ok = (
      await Promise.all(devices.map(d => pushToDevice(d, typeof payload === 'function' ? payload(d) : payload, options)))
    ).filter(Boolean).length,
    count = n => `${n} ${n === 1 ? 'Gerät' : 'Geräte'}`;
  if (label && devices.length) console.log(`Push ${label}: ${ok} von ${count(devices.length)} zugestellt`);
  else if (label) {
    const known = sql.teamDevCount.get(team, Date.now() - 30 * 864e5);
    console.log(
      `Push ${label}: kein Gerät mit Push-Abo (${known.n ? `${count(known.n)} des Teams angemeldet, davon ${known.p} mit Abo` : 'kein Gerät des Teams angemeldet'})`
    );
  }
  return { ok, total: devices.length };
}
// Nachricht-ID -> Zeitpunkt der letzten Erinnerung
const lastNagAt = new Map();
// Erinnerung an alle Geräte des Teams, die noch nicht bestätigt haben; Rückgabe: { ok: zugestellte Pushs, total: Geräte mit Abo }.
// first = die erste Zustellung einer neuen Nachricht (die Wiederholungen stehen nicht im Protokoll, nur ihre Fehler)
async function sendReminders(message, first = false) {
  lastNagAt.set(message.id, Date.now());
  const devs = sql.nagDevs.all(message.team, message.id);
  return pushToDevices(
    devs,
    d => ({ id: message.id, did: d.did, team: message.team, title: 'Nachricht vom Disponenten', body: message.text, at: message.at }),
    undefined,
    first ? `„Nachricht vom Disponenten“ an Team ${message.team}` : '',
    message.team
  );
}
setInterval(async () => {
  // „nervig“: wiederholen, bis bestätigt (höchstens MESSAGE_HOURS Stunden)
  try {
    for (const m of sql.activeMsgs.all(Date.now() - MESSAGE_HOURS * 3600e3))
      if (Date.now() - (lastNagAt.get(m.id) || 0) >= NAG_INTERVAL_MIN * 60e3 - 2e3) await sendReminders(m);
  } catch (e) {
    console.error('Erinnerung fehlgeschlagen:', e.message); // ein Fehler darf den Server nicht beenden
  }
}, 15e3).unref();

// ---- Meldung an die Monteure: Auftrag disponiert / geändert / entfernt ----
// Nur eine Benachrichtigung, die nichts sperrt und nicht bestätigt werden muss (anders als Nachricht und Gaswarngerät). Der Disponent ändert oft
// mehrere Male hintereinander: POST /api/dispo merkt sich je Team und Auftrag den Stand davor (dnote); erst wenn das Team DISPO_NOTE_MS lang
// keine Änderung mehr hatte, wird der Stand verglichen und EINE Meldung geschickt – neue Aufträge, geänderte Zeiten, entfernte Aufträge. Wurde
// alles wieder zurückgesetzt, gibt es keine Meldung. Dieselbe Meldung geht als Push an die Geräte des Teams und, solange die App offen ist,
// als Live-Nachricht { dn: { title, brief, at } }: Geräte ohne Push (nicht erlaubt, nicht möglich) zeigen sie als kurzen Hinweis oben.
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
// Zeitraum lesbar: „Mo 12.10. 07:30–09:00“, über Mitternacht „Mo 12.10. 22:00 – Di 13.10. 05:30“ (Eingabe „JJJJ-MM-TTTHH:MM“)
function slotText(von, bis) {
  const part = s => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(s || '');
    return m && { day: m[1] + m[2] + m[3], date: `${WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]} ${+m[3]}.${+m[2]}.`, time: m[4] };
  };
  const a = part(von),
    b = part(bis);
  if (!a) return '';
  if (!b) return `${a.date} ${a.time}`;
  return a.day === b.day ? `${a.date} ${a.time}–${b.time}` : `${a.date} ${a.time} – ${b.date} ${b.time}`;
}
/**
 * Setzt aus den vorgemerkten Änderungen (dnote) eines Teams die Meldung zusammen. items: [{ type: 'new' | 'chg' | 'gone', o: Auftrag }].
 * Titel nennt Art und Anzahl, der Text die ersten Aufträge (Nummer, Kurztext, Zeitraum); brief ist die kurze Fassung für den Hinweis oben in
 * der App (ein Auftrag: dieselbe Zeile, mehrere: nur die Nummern); null, wenn es nichts zu melden gibt.
 */
function composeDispoNote(items) {
  if (!items.length) return null;
  const count = type => items.filter(i => i.type === type).length,
    TITLES = {
      new: ['Neuer Auftrag disponiert', k => `${k} neue Aufträge disponiert`],
      chg: ['Disponierter Auftrag geändert', k => `${k} disponierte Aufträge geändert`],
      gone: ['Auftrag entfernt', k => `${k} Aufträge entfernt`]
    },
    PREFIX = { new: 'Neu: ', chg: 'Geändert: ', gone: 'Entfernt: ' },
    types = Object.keys(TITLES).filter(type => count(type)),
    mixed = types.length > 1;
  const title = mixed
    ? 'Disposition geändert: ' + types.map(type => `${count(type)} ${{ new: 'neu', chg: 'geändert', gone: 'entfernt' }[type]}`).join(', ')
    : count(types[0]) === 1
      ? TITLES[types[0]][0]
      : TITLES[types[0]][1](count(types[0]));
  const MAX_LINES = 4,
    sorted = types.flatMap(type => items.filter(i => i.type === type)),
    lines = sorted.slice(0, MAX_LINES).map(({ type, o }) => {
      const what = [o.nr || o.auftrag, clipString(o.kurz, 50).trim()];
      if (o.vtxt && o.vtxt !== o.kurz) what.push(clipString(o.vtxt, 40).trim());
      if (type !== 'gone') what.push(slotText(o.dvon, o.dbis));
      return (mixed ? PREFIX[type] : '') + what.filter(Boolean).join(' · ');
    });
  const more = sorted.length - MAX_LINES,
    brief = sorted.length === 1 ? lines[0] : sorted.slice(0, MAX_LINES).map(({ o }) => o.nr || o.auftrag).join(', ') + (more > 0 ? ` und ${more} weitere` : '');
  if (more > 0) lines.push(`und ${more} weitere`);
  return { title, body: lines.join('\n'), brief };
}
/**
 * Meldungen, die jetzt fällig sind: Teams, deren letzte Änderung mindestens DISPO_NOTE_MS her ist. Die vorgemerkten Zeilen werden dabei
 * entfernt (in einem Zug, bevor irgendetwas gesendet wird – Änderungen währenddessen fangen eine neue Runde an). Stand davor gegen heute:
 * war nicht beim Team, ist es jetzt -> neu · war beim Team, ist es nicht mehr -> entfernt · war und ist beim Team, Zeitraum anders -> geändert.
 * Rückgabe: [{ team, title, body, count }]
 */
function dueDispoNotes(now = Date.now()) {
  const out = [];
  for (const { team } of sql.dueNoteTeams.all(now - DISPO_NOTE_MS)) {
    const rows = sql.notesOfTeam.all(team);
    sql.delNotesOfTeam.run(team);
    const items = [];
    for (const r of rows) {
      const o = sql.getOrderDispo.get(r.auftrag);
      if (!o) continue;
      const has = !o.del && o.mteam === team;
      if (!r.was && has) items.push({ type: 'new', o });
      else if (r.was && !has) items.push({ type: 'gone', o });
      else if (r.was && has && (o.dvon !== r.von || o.dbis !== r.bis)) items.push({ type: 'chg', o });
    }
    const note = composeDispoNote(items);
    if (note) out.push({ team, ...note, count: items.length });
  }
  return out;
}
// Live-Nachricht an die offenen Apps der Monteure dieses Teams (ohne Änderungsnummer: nichts zum Abgleichen, nur zum Anzeigen)
function announceDispoNote(team, note) {
  const data = `data: ${JSON.stringify({ dn: note })}\n\n`;
  for (const c of sseClients) if (c.kind === 'team' && c.team === team) c.res.write(data);
}
let flushingNotes = false;
async function flushDispoNotes() {
  if (flushingNotes) return;
  flushingNotes = true;
  try {
    for (const n of dueDispoNotes()) {
      const at = Date.now(),
        payload = { t: 'dispo', title: n.title, body: n.body, at, n: n.count };
      announceDispoNote(n.team, { title: n.title, brief: n.brief, at });
      await pushToDevices(
        sql.teamPushDevs.all(n.team),
        payload,
        { topic: 'dispo', hours: DISPO_NOTE_HOURS },
        `„${n.title}“ an Team ${n.team}`,
        n.team
      );
    }
  } catch (e) {
    console.error('Meldung zur Disposition fehlgeschlagen:', e.message);
  } finally {
    flushingNotes = false;
  }
}
setInterval(flushDispoNotes, Math.min(10e3, Math.max(250, DISPO_NOTE_MS / 4))).unref();

// Ergebnis-Dokument prüfen und bereinigen (Whitelist)
function cleanResultDoc(orderNo, doc) {
  if (!doc || typeof doc !== 'object') throw { code: 400, msg: 'Ungültiges Ergebnis' };
  const count = Math.min(Math.max(+doc.n | 0, 0), 500),
    state = clipString(doc.s, 500);
  if (!/^[ox-]*$/.test(state) || state.length !== count) throw { code: 400, msg: 'Ungültiger Status' };
  const nok = (Array.isArray(doc.nok) ? doc.nok : [])
    .slice(0, 500)
    .map(z => ({ i: z.i | 0, t: clipString(z.t), m: clipString(z.m) }));
  const clean = {
    a: orderNo,
    team: clipString(doc.team, 100),
    n: count,
    ok: [...state].filter(c => c === 'o').length,
    nx: nok.length,
    s: state,
    nok
  };
  if (doc.min != null) {
    const minutes = +doc.min;
    if (!(minutes >= 1 && minutes <= 1440)) throw { code: 400, msg: 'Ungültige Dauer' };
    clean.min = Math.round(minutes);
    clean.tat = +doc.tat || Date.now();
    // Endrückmeldung (Reparatur/Entstörung): mit dieser Zeit ist der Auftrag fertig; ohne den Haken ist es eine Teilrückmeldung
    if (doc.fin) clean.fin = 1;
    if (/^\d{4}-\d{2}-\d{2}$/.test(doc.dat || '')) clean.dat = doc.dat;
    if (/^\d{2}:\d{2}$/.test(doc.von || '')) clean.von = doc.von;
    // mit wem gearbeitet (SAP-User der Kollegen, höchstens 10); der Server streicht unbekannte und den Speichernden selbst
    if (Array.isArray(doc.mit)) {
      const mit = [...new Set(doc.mit.map(normalizeSap).filter(x => validSap(x) && sql.getUsr.get(x)))].slice(0, 10);
      if (mit.length) clean.mit = mit;
    }
  } else {
    // Start gedrückt (go, ms): der Auftrag läuft gerade. Gilt nur, solange noch keine Zeit gespeichert ist – die Zeit ersetzt den Start.
    // Der Disponent sieht ihn so im Diagramm und in den Listen (farbig markiert), die anderen Geräte des Teams ebenfalls.
    const go = Math.round(+doc.go);
    if (go > 1e12 && go < Date.now() + 864e5) clean.go = go;
  }
  return clean;
}
// Vorgänge externer Firmen zum Auftrag: [{ vg, t (Text), h (Stunden) }] höchstens 30 Stück als JSON-Text, sonst null
const cleanExt = list => {
  const clean = (Array.isArray(list) ? list : [])
    .slice(0, 30)
    .map(x => ({ vg: clipString(x && x.vg, 8), t: clipString(x && x.t, 200), ...(+(x && x.h) > 0 ? { h: +x.h } : {}) }));
  return clean.length ? JSON.stringify(clean) : null;
};
// nur die bekannten Felder eines Auftrags an die Geräte schicken
const MAX_ENTRIES = 500; // Zeiteinträge je Auftrag (Dauerauftrag, Reparatur, Entstörung)

// ---------- Aufträge aus den SAP-Dateien zusammensetzen ----------
// Team mit angehängtem „P“ („FW-IH01P“): geplant und vorgemerkt, aber noch nicht fix – wird nicht angezeigt
const isPlanned = team => /\d+P$/i.test(String(team || '').trim());
// Arbeitsplatz „FW-IHEXT“: externe Firmen (kein Team)
const isExternal = team => /EXT$/i.test(String(team || '').trim());
/**
 * Auftragsart der App nach SAP-Auftragsart und Leistungsart: war Wartung (3NAW/FWS; fehlt die Spalte „IH-Leistungsart“ ganz, gilt jeder
 * 3NAW als Wartung – ältere Dateien), dau Dauerauftrag (3NAW/FWD), rep Reparatur (3NAR), ent Entstörung (3NAE). Alles andere: '' (gehört nicht dazu).
 */
const kindOfArt = (art, lart, hasLart) => {
  art = String(art || '').toUpperCase();
  if (art === '3NAW') return !hasLart || lart === 'FWS' ? 'war' : lart === 'FWD' ? 'dau' : '';
  return art === '3NAR' ? 'rep' : art === '3NAE' ? 'ent' : '';
};
/**
 * Setzt aus den Rohdaten (src_auftrag + src_vorgang) die Aufträge der App zusammen:
 *   · Wartung, Dauerauftrag, Entstörung: ein Auftrag je Auftragsnummer (Schlüssel = Nummer)
 *   · Reparatur: ein Auftrag je Vorgang (Schlüssel = „Nummer-Vorgang“, Team = Arbeitsplatz des Vorgangs)
 * Vorgänge geplanter Teams („…P“) entfallen (planned). Vorgänge der externen Firmen (FW-IHEXT) sind kein Team: sie hängen als `ext` an den
 * Aufträgen der internen Teams; hat eine Reparatur nur externe Vorgänge (oder gar keine Vorgänge-Datei), bekommt das verantwortliche Team des
 * Auftrags einen Auftrag ohne Vorgang. Ergebnis { rows, planned }.
 */
function buildUnits() {
  const stepsOf = new Map();
  for (const v of sql.allSrcVorgang.all()) (stepsOf.get(v.nr) || stepsOf.set(v.nr, []).get(v.nr)).push(v);
  for (const l of stepsOf.values()) l.sort((a, b) => a.vg.localeCompare(b.vg, 'de', { numeric: true }));
  const rows = [];
  let planned = 0;
  for (const o of sql.allSrcAuftrag.all()) {
    const kind = o.kind;
    // Auftrag eines geplanten Teams: noch nicht fix
    if (isPlanned(o.team)) {
      planned++;
      continue;
    }
    const base = { kind, nr: o.nr, vg: '', vtxt: '', lart: o.lart, art: o.art, tp: o.tp, plz: o.plz, str: o.str, kurz: o.kurz, mel: o.mel };
    // Vorgänge gibt es nur bei Reparatur und Entstörung
    const all = kind === 'rep' || kind === 'ent' ? stepsOf.get(o.nr) || [] : [],
      fix = all.filter(v => !isPlanned(v.vteam)),
      own = fix.filter(v => !isExternal(v.vteam)),
      ext = fix.filter(v => isExternal(v.vteam)).map(v => ({ vg: v.vg, t: v.vtxt, h: +v.arb || 0 }));
    planned += all.length - fix.length;
    if (kind === 'rep' && own.length)
      for (const v of own)
        rows.push({
          ...base,
          auftrag: o.nr + '-' + v.vg,
          vg: v.vg,
          vtxt: v.vtxt,
          team: v.vteam || o.team,
          start: v.start || o.start || '',
          ende: v.ende || '',
          uhr: v.uhr,
          uhr2: v.uhr2,
          arb: v.arb,
          ext
        });
    else if (kind === 'rep' && all.length && !fix.length) continue; // nur geplante Vorgänge: noch nichts anzuzeigen
    else {
      const first = fix[0],
        last = fix[fix.length - 1];
      rows.push({
        ...base,
        auftrag: o.nr,
        vtxt: kind === 'rep' ? '' : (first && first.vtxt) || '',
        team: o.team,
        start: (first && first.start) || o.start || '',
        ende: (last && last.ende) || o.ende || '',
        uhr: (first && first.uhr) || '',
        uhr2: (last && last.uhr2) || '',
        arb: first ? String(fix.reduce((a, v) => a + (+v.arb || 0), 0)) : '',
        ext
      });
    }
  }
  return { rows, planned };
}
/**
 * Berechnet `orders` aus den Rohdaten neu (innerhalb einer Transaktion, changeSeq ist schon erhöht): geänderte Aufträge bekommen die neue
 * Nummer, was nicht mehr hervorgeht, wird als gelöscht markiert. Ergebnis { counts (je Auftragsart), planned, steps (Vorgänge vorhanden) }.
 */
function rebuildOrders() {
  const { rows, planned } = buildUnits(),
    now = Date.now(),
    counts = { war: 0, dau: 0, rep: 0, ent: 0 };
  for (const r of rows) {
    counts[r.kind]++;
    sql.upOrder.run(
      r.auftrag,
      clipString(r.team, 100),
      clipString(r.tp, 60),
      clipString(r.art, 30),
      clipString(r.plz, 10),
      clipString(r.str, 100),
      clipString(r.kurz),
      clipString(r.start, 20),
      clipString(r.ende, 20),
      r.kind,
      r.nr,
      clipString(r.vg, 8),
      clipString(r.vtxt, 200),
      clipString(r.lart, 10),
      clipString(r.uhr, 5),
      clipString(r.uhr2, 5),
      clipString(r.arb, 10),
      clipString(r.mel, 20),
      cleanExt(r.ext),
      changeSeq
    );
  }
  sql.tombMissing.run(now, changeSeq, JSON.stringify(rows.map(r => r.auftrag)));
  // Geräte, die einen Auftrag neu bekommen, brauchen auch dessen Meldungen
  sql.touchMeldungOfOrders.run(changeSeq, changeSeq);
  catalogVer++;
  return { counts, planned, steps: !!db.prepare('SELECT 1 FROM src_vorgang LIMIT 1').get() };
}
/**
 * Auftrag, wie ihn die Geräte bekommen. Ist er disponiert (dteam), gelten Team und Termin der Disposition: team, start/uhr (Beginn) und
 * ende/uhr2 (Ende) sind die disponierten Werte und `dis` ist 1. Der Disponent (forDispo) bekommt zusätzlich `sap` mit den Angaben aus
 * SAP (Team und Termin), damit er sie als Vorschlag sieht und die Disposition aufheben kann.
 */
const orderFields = (r, forDispo = false) => {
  const dispatched = !!r.dteam && (r.kind === 'rep' || r.kind === 'ent'),
    sap = { team: r.team, start: r.start, ende: r.ende, uhr: r.uhr || '', uhr2: r.uhr2 || '' },
    here = dispatched
      ? { team: r.dteam, start: r.dvon.slice(0, 10), uhr: r.dvon.slice(11, 16), ende: r.dbis.slice(0, 10), uhr2: r.dbis.slice(11, 16) }
      : sap;
  return {
    auftrag: r.auftrag,
    team: here.team,
    tp: r.tp,
    art: r.art,
    plz: r.plz,
    str: r.str,
    kurz: r.kurz,
    start: here.start,
    ende: here.ende,
    kind: r.kind || 'war',
    nr: r.nr || r.auftrag,
    ...(r.vg ? { vg: r.vg, vtxt: r.vtxt } : r.vtxt ? { vtxt: r.vtxt } : {}),
    ...(r.lart ? { lart: r.lart } : {}),
    ...(here.uhr ? { uhr: here.uhr } : {}),
    ...(here.uhr2 ? { uhr2: here.uhr2 } : {}),
    ...(r.arb ? { arb: r.arb } : {}),
    ...(r.mel ? { mel: r.mel } : {}),
    ...(r.ext ? { ext: JSON.parse(r.ext) } : {}),
    ...(dispatched ? { dis: 1, ...(forDispo ? { sap } : {}) } : {})
  };
};
// nur die bekannten Felder einer Meldung an die Geräte schicken (leere Felder weglassen)
const meldungFields = r => ({
  nr: r.nr,
  ...Object.fromEntries(
    ['dat', 'txt', 'str', 'plz', 'auftrag', 'code', 'tp', 'stat', 'team', 'grp'].filter(k => r[k]).map(k => [k, r[k]])
  )
});

// ---------- Koordinaten der Adressen (Entfernungs-Sortierung der Monteure) ----------
/**
 * Die Aufträge haben nur PLZ und Straße. Damit die Monteur-Liste nach Entfernung sortiert werden kann, wandelt der Server jede
 * Adresse einmal im Hintergrund in Koordinaten um und merkt sie dauerhaft in der Tabelle `geo`. Die Geräte holen die Tabelle über
 * GET /api/geo und rechnen die Entfernung zum eigenen Standort selbst; der Standort verlässt das Gerät nie. Gesendet werden nur
 * Straße (mit Hausnummer) und PLZ, keine Namen.
 * Quellen (in dieser Reihenfolge, eine gesperrte oder gestörte wird 10 Minuten übersprungen):
 *   1. „Wien“: der Adressdienst der Stadt Wien (data.wien.gv.at, amtliche Hauskoordinaten, nur für Wiener PLZ 1xxx) – kein Schlüssel,
 *      für viele Adressen gedacht. GEOCODER_WIEN_URL = andere Adresse, "off" = nicht verwenden.
 *   2. „Nominatim“ (OpenStreetMap): GEOCODER_URL = eigene Instanz, Standard nominatim.openstreetmap.org. Der öffentliche Dienst sperrt
 *      (HTTP 403) Server, die viele Adressen auf einmal abfragen oder sich nicht mit echter Kontaktadresse melden (GEOCODER_CONTACT,
 *      sonst PUSH_CONTACT). GEOCODER_URL=wien: nur Quelle 1 · GEOCODER_URL=off: gar nichts abfragen (dann gilt die Bezirksmitte).
 * GEOCODER_DELAY_MS = Pause zwischen zwei Anfragen an Nominatim (Standard 1100, der öffentliche Dienst erlaubt eine pro Sekunde).
 * Reihenfolge: Die Adressen der Teams, deren Geräte gerade „Entfernung“ nutzen (GET /api/geo?team=…), kommen zuerst an die Reihe –
 * sonst müsste ein Team in 1210/1220 warten, bis alle Bezirke davor fertig sind.
 * Bis die Koordinaten da sind, rechnen die Geräte mit der Bezirksmitte (dann haben fast alle Aufträge eines Teams dieselbe Entfernung).
 */
const GEOCODER = String(process.env.GEOCODER_URL ?? 'https://nominatim.openstreetmap.org').replace(/\/+$/, ''),
  GEOCODER_ALL_OFF = GEOCODER.toLowerCase() === 'off' || GEOCODER === '',
  NOMINATIM_ON = !GEOCODER_ALL_OFF && GEOCODER.toLowerCase() !== 'wien',
  WIEN_URL = String(process.env.GEOCODER_WIEN_URL ?? 'https://data.wien.gv.at/daten/OGDAddressService.svc/GetAddressInfo'),
  WIEN_ON = !GEOCODER_ALL_OFF && WIEN_URL.toLowerCase() !== 'off' && WIEN_URL !== '',
  GEOCODER_ON = NOMINATIM_ON || WIEN_ON,
  GEOCODER_CONTACT = process.env.GEOCODER_CONTACT || PUSH_CONTACT,
  GEOCODER_DELAY_MS = process.env.GEOCODER_DELAY_MS === undefined ? 1100 : Math.max(0, +process.env.GEOCODER_DELAY_MS || 0),
  GEO_RETRY_MS = 7 * 864e5, // nicht gefundene Adressen nach so langer Zeit erneut versuchen
  GEO_OFFLINE_RETRY_MS = 10 * 60e3; // Quelle nicht erreichbar / gesperrt: nach so langer Zeit wieder probieren
if (NOMINATIM_ON && /example\.(com|org)/i.test(GEOCODER_CONTACT))
  console.warn(
    'Hinweis: PUSH_CONTACT/GEOCODER_CONTACT ist noch die Platzhalteradresse – der öffentliche Nominatim-Dienst sperrt Anfragen ohne echte Kontaktadresse (HTTP 403). Bitte eine echte Adresse setzen.'
  );
// GEO_EPOCH: Stand der Koordinaten-Tabelle. Koordinaten, die vor der Prüfung auf zu grobe Treffer gespeichert wurden (Epoche 1), können
// ein ganzes PLZ-Gebiet statt der Straße sein (dann hätten alle Aufträge der PLZ dieselbe Entfernung): sie werden einmal verworfen und
// neu ermittelt. Geräte mit einer anderen Epoche ersetzen ihren Zwischenspeicher (GET /api/geo liefert dann `full`).
const GEO_EPOCH = 2;
if (getMeta('geoq') !== GEO_EPOCH) {
  const n = db.prepare('DELETE FROM geo').run().changes;
  setMeta('geoq', GEO_EPOCH);
  if (n) console.log(`Koordinaten der Adressen: ${n} früher gespeicherte werden neu ermittelt (strengere Prüfung).`);
}
// geoWanted: Team -> Zeitpunkt, zu dem ein Gerät zuletzt Entfernungen dieses Teams brauchte (eine Stunde lang bevorzugt) ·
// geoError: letzter Fehler ('' = in Ordnung; nur wenn gar keine Quelle antwortet) · geoTriedAt: Zeitpunkt der letzten Abfrage
const geoWanted = new Map();
let geoError = '',
  geoTriedAt = 0;
const geoWantedJson = () => {
  for (const [team, at] of geoWanted) if (at < Date.now() - 3600e3) geoWanted.delete(team);
  return JSON.stringify([...geoWanted.keys()]);
};
// „fetch failed (ENOTFOUND)“ statt nur „fetch failed“: Node versteckt die eigentliche Ursache in `cause`
const geoReason = e => (e && e.cause ? `${e.message} (${e.cause.code || e.cause.message})` : (e && e.message) || String(e));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Anfang der Antwort bei einem Fehler (zeigt, ob der Dienst selbst oder eine Firewall/ein Proxy dahintersteckt)
const bodySnippet = async response => {
  const text = await response.text().catch(() => '');
  return text ? ' – ' + text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : '';
};
// „Autokaderstraße 5, 25“ -> { name: 'Autokaderstraße', num: '5' } (nach dem Komma folgen Stiege/Tür, bei „12-14“ zählt die erste Nummer)
const splitStreet = text => {
  const first = String(text || '').split(',')[0].trim(),
    m = /^(.+?)\s+(\d+\s?[A-Za-z]?)(?:\s*[-–/].*)?$/.exec(first);
  return m ? { name: m[1], num: m[2].replace(/\s/g, '') } : { name: first, num: '' };
};
// „Straße“ -> „Strasse“ (der Wiener Adressdienst nimmt auch Schreibweisen ohne Sonderzeichen)
const asciiOf = text => text.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss');
// Liegt der Treffer im erwarteten Gebiet? (1xxx = Wien; sonst Österreich) – schützt vor Treffern am anderen Ende der Welt
const geoPlausible = (plz, lat, lon) =>
  /^1\d{3}$/.test(plz)
    ? lat > 48.1 && lat < 48.35 && lon > 16.17 && lon < 16.59
    : lat > 46.3 && lat < 49.1 && lon > 9.5 && lon < 17.2;
// ungefähre Mitte der Wiener Bezirke nach PLZ (wie PLZ_CENTER in index.html): wählt unter mehreren gleichnamigen Straßen die des Bezirks
const PLZ_CENTER = {
  1010: [48.2082, 16.373], 1020: [48.217, 16.4], 1030: [48.198, 16.4], 1040: [48.192, 16.369], 1050: [48.188, 16.356],
  1060: [48.196, 16.348], 1070: [48.203, 16.348], 1080: [48.211, 16.343], 1090: [48.226, 16.356], 1100: [48.162, 16.378],
  1110: [48.169, 16.44], 1120: [48.174, 16.332], 1130: [48.185, 16.29], 1140: [48.201, 16.276], 1150: [48.196, 16.327],
  1160: [48.214, 16.307], 1170: [48.233, 16.3], 1180: [48.233, 16.331], 1190: [48.253, 16.345], 1200: [48.24, 16.378],
  1210: [48.28, 16.4], 1220: [48.235, 16.475], 1230: [48.138, 16.29]
};
const distKm = (lat1, lon1, lat2, lon2) => {
  const rad = Math.PI / 180,
    a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
};
// alle Koordinatenpaare einer GeoJSON-Geometrie (Punkt, Linie, Fläche …) als Liste von [x, y]
const coordPairs = c =>
  Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number' ? [c] : Array.isArray(c) ? c.flatMap(coordPairs) : [];
// Quelle 1: Adressdienst der Stadt Wien. { lat, lon } oder null (nicht gefunden); wirft bei Fehlern und unerwartetem Format.
// Der Dienst kennt keine PLZ: gibt es die Straße in mehreren Bezirken, zählt der Treffer, der der Bezirksmitte der PLZ am nächsten liegt.
// Die Achsenreihenfolge (Länge/Breite oder Breite/Länge) wird an den Werten erkannt, eine Fläche (Straße ohne Nummer) durch ihre Mitte ersetzt.
async function wienQuery(plz, street) {
  const url = new URL(WIEN_URL);
  url.search = new URLSearchParams({ crs: 'EPSG:4326', Address: street });
  const response = await fetch(url, {
    headers: { 'User-Agent': `Heiz-Hawara/1.0 (${GEOCODER_CONTACT})`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('HTTP ' + response.status + (await bodySnippet(response)));
  const data = await response.json();
  if (!data || !Array.isArray(data.features)) throw new Error('unerwartete Antwort (kein GeoJSON)');
  const centre = PLZ_CENTER[plz],
    candidates = [];
  for (const feature of data.features) {
    const pairs = coordPairs(feature && feature.geometry && feature.geometry.coordinates);
    if (!pairs.length) continue;
    let [x, y] = [pairs.reduce((n, c) => n + c[0], 0) / pairs.length, pairs.reduce((n, c) => n + c[1], 0) / pairs.length];
    if (x > 47 && y < 17) [x, y] = [y, x]; // Breite/Länge statt Länge/Breite
    if (geoPlausible(plz, y, x)) candidates.push({ lat: y, lon: x });
  }
  if (data.features.length && !candidates.length && data.features.some(f => f && f.geometry && coordPairs(f.geometry.coordinates).length))
    return null; // Treffer außerhalb von Wien: nicht brauchbar
  if (data.features.length && !data.features.some(f => f && f.geometry))
    throw new Error('unerwartete Antwort (Treffer ohne Koordinaten)');
  if (!candidates.length) return null;
  candidates.sort((p, q) => (centre ? distKm(p.lat, p.lon, centre[0], centre[1]) - distKm(q.lat, q.lon, centre[0], centre[1]) : 0));
  const best = candidates[0];
  if (centre && distKm(best.lat, best.lon, centre[0], centre[1]) > 9) return null; // liegt nicht im Bezirk dieser PLZ
  return { lat: Math.round(best.lat * 1e5) / 1e5, lon: Math.round(best.lon * 1e5) / 1e5, rank: 0 };
}
// Quelle 2: Nominatim. { lat, lon, rank } oder null (nicht gefunden). Wirft bei Netzfehler, Sperre (403/429) und Serverfehlern.
async function nominatimQuery(plz, street) {
  const url = new URL(GEOCODER + '/search');
  url.search = new URLSearchParams({
    format: 'jsonv2',
    limit: '1',
    countrycodes: 'at',
    street,
    ...(plz ? { postalcode: plz } : {}),
    ...(/^mailto:/i.test(GEOCODER_CONTACT) ? { email: GEOCODER_CONTACT.replace(/^mailto:/i, '') } : {})
  });
  const response = await fetch(url, {
    headers: { 'User-Agent': `Heiz-Hawara/1.0 (${GEOCODER_CONTACT})`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (response.status === 403 || response.status === 429 || response.status >= 500)
    throw new Error('HTTP ' + response.status + (await bodySnippet(response)));
  if (!response.ok) return null;
  const hit = (await response.json())[0],
    lat = hit && Number(hit.lat),
    lon = hit && Number(hit.lon),
    rank = hit ? Number(hit.place_rank) : NaN; // 30 Haus, 26–27 Straße, darunter Ort/Bezirk/PLZ-Gebiet
  // Ein Treffer, der nur den Ort, Bezirk oder das PLZ-Gebiet bezeichnet, ist zu grob (alle Aufträge der PLZ bekämen dieselbe
  // Entfernung): dann lieber „nicht gefunden“. Dienste ohne place_rank werden nicht beanstandet.
  if (!hit || !geoPlausible(plz, lat, lon) || rank < 26) return null;
  return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, rank: rank || 0 };
}
// Die Quellen: on = eingeschaltet, applies = gilt für diese PLZ, delay = Pause zwischen zwei Anfragen, ascii = auch ohne Sonderzeichen
// probieren, blockedUntil = bis dahin gesperrt/gestört (wird übersprungen), error = letzter Fehler
const geoSources = [
  { name: 'Wien', on: WIEN_ON, applies: plz => /^1\d{3}$/.test(plz), delay: Math.min(GEOCODER_DELAY_MS, 300), ascii: true, preferAscii: false, query: wienQuery, blockedUntil: 0, error: '' },
  { name: 'Nominatim', on: NOMINATIM_ON, applies: () => true, delay: GEOCODER_DELAY_MS, ascii: false, query: nominatimQuery, blockedUntil: 0, error: '' }
];
// Koordinaten einer Adresse bei einer Quelle: zuerst mit Hausnummer (q = 'h'), sonst nur die Straße (q = 's'); { lat, lon, q } oder null
async function lookupAt(source, plz, str) {
  const { name, num } = splitStreet(str),
    // „Kürschnergasse S“: ein einzelner Großbuchstabe am Ende gehört nicht zum Straßennamen
    bare = name.replace(/\s+[A-ZÄÖÜ]$/, ''),
    base = [...(num ? [[`${name} ${num}`, 'h']] : []), [name, 's'], ...(bare && bare !== name ? [[bare, 's']] : [])],
    // Straßen mit Sonderzeichen (ä, ö, ü, ß): auch ohne probieren, und zwar zuerst die Schreibweise, die dieser Dienst zuletzt angenommen hat
    tries = base.flatMap(([street, q]) => {
      const plain = { street, q, ascii: false, pair: false };
      if (!source.ascii || asciiOf(street) === street) return [plain];
      const other = { street: asciiOf(street), q, ascii: true, pair: true };
      plain.pair = true;
      return source.preferAscii ? [other, plain] : [plain, other];
    });
  for (const [i, t] of tries.entries()) {
    if (i) await sleep(source.delay); // zwischen zwei Anfragen die Pause einhalten
    const hit = await source.query(plz, t.street);
    if (hit) {
      if (t.pair) source.preferAscii = t.ascii; // diese Schreibweise nimmt der Dienst an: beim nächsten Mal zuerst
      return { lat: hit.lat, lon: hit.lon, q: hit.rank ? (hit.rank >= 28 ? 'h' : 's') : t.q }; // q nach dem, was der Dienst wirklich fand
    }
  }
  return null;
}
/**
 * Koordinaten einer Adresse über die Quellen der Reihe nach. Eine Quelle, die einen Fehler meldet (gesperrt, nicht erreichbar,
 * unerwartetes Format), wird 10 Minuten übersprungen; die nächste springt ein. Ergebnis: { hit, delay, degraded } – hit = { lat, lon, q }
 * oder null (nicht gefunden), degraded = es fehlte eine Quelle (ein „nicht gefunden“ gilt dann nur kurz). Wirft, wenn keine Quelle antwortet.
 */
async function geocodeAddress(plz, str) {
  let delay = 0,
    answered = 0, // Quellen, die geantwortet haben (auch mit „nicht gefunden“)
    failed = 0; // Quellen, die gesperrt/gestört waren oder jetzt einen Fehler meldeten
  const reasons = [];
  for (const source of geoSources) {
    if (!source.on || !source.applies(plz)) continue;
    if (source.blockedUntil > Date.now()) {
      failed++;
      reasons.push(`${source.name}: ${source.error}`);
      continue;
    }
    delay = Math.max(delay, source.delay);
    try {
      const hit = await lookupAt(source, plz, str);
      source.error = '';
      answered++;
      if (hit) return { hit, delay, degraded: failed > 0 };
    } catch (e) {
      source.error = geoReason(e).slice(0, 140);
      source.blockedUntil = Date.now() + GEO_OFFLINE_RETRY_MS;
      failed++;
      reasons.push(`${source.name}: ${source.error}`);
      console.error(`Koordinaten der Adressen: ${source.name} nicht brauchbar – ${source.error} (wird 10 Minuten übersprungen)`);
    }
  }
  if (!answered && failed) throw new Error(reasons.join(' · '));
  return { hit: null, delay, degraded: failed > 0 };
}
let geoBusy = false,
  geoTimer = null;
// Startet (nach `delay` ms) das Abarbeiten der offenen Adressen – ruft man es mehrfach auf, läuft immer nur eines.
// now = true: eine wartende Wiederholung (nach einem Fehler) vorziehen
function geocodeKick(delay = 0, now = false) {
  if (!GEOCODER_ON || geoBusy) return;
  if (geoTimer && !now) return;
  clearTimeout(geoTimer);
  geoTimer = setTimeout(() => {
    geoTimer = null;
    geocodeRun();
  }, delay);
  geoTimer.unref();
}
async function geocodeRun() {
  if (geoBusy) return;
  geoBusy = true;
  let retryIn = 0,
    done = 0;
  try {
    const open = sql.geoOpen.get(Date.now() - GEO_RETRY_MS).n;
    if (open) console.log(`Koordinaten der Adressen: ${open} offen, Quellen: ${geoSources.filter(s => s.on).map(s => s.name).join(' → ')}`);
    for (;;) {
      const row = sql.geoNext.get(Date.now() - GEO_RETRY_MS, geoWantedJson());
      if (!row) break;
      let result;
      geoTriedAt = Date.now();
      try {
        result = await geocodeAddress(row.plz || '', row.str);
        geoError = '';
      } catch (e) {
        geoError = geoReason(e).slice(0, 160);
        console.error(`Koordinaten der Adressen: keine Quelle erreichbar – ${geoError} (neuer Versuch in 10 Minuten; bis dahin gilt die Bezirksmitte)`);
        retryIn = GEO_OFFLINE_RETRY_MS;
        break;
      }
      const { hit, delay, degraded } = result;
      // nicht gefunden, aber eine Quelle fehlte: schon nach einer Stunde noch einmal versuchen (nicht erst nach 7 Tagen)
      sql.geoSet.run((row.plz || '') + '|' + row.str, hit ? hit.lat : null, hit ? hit.lon : null, hit ? hit.q : null, Date.now() - (!hit && degraded ? GEO_RETRY_MS - 3600e3 : 0));
      done++;
      if (done % 100 === 0) console.log(`Koordinaten der Adressen: ${done} neu ermittelt, ${sql.geoOpen.get(Date.now() - GEO_RETRY_MS).n} offen`);
      await sleep(delay);
    }
  } catch (e) {
    geoError = geoReason(e).slice(0, 160);
    console.error('Koordinaten der Adressen:', geoError);
    retryIn = GEO_OFFLINE_RETRY_MS;
  } finally {
    geoBusy = false;
  }
  if (done) console.log(`Koordinaten der Adressen: ${done} neu ermittelt.`);
  if (retryIn) geocodeKick(retryIn);
}

// ---------- API ----------
/**
 * Alle Aufrufe unter /api/. Reihenfolge = Zugriffsstufen: zuerst offene Aufrufe (Anmeldung, Abgleich, Prüfobjekte,
 * Ergebnis, Push), dann – nach der Prüfung des Disponenten-Tokens – die Aufrufe des Disponenten.
 * Jede Änderung zählt `changeSeq` hoch und wird mit announce() live verteilt.
 */
async function handleApi(req, res, url) {
  const pathname = url.pathname,
    method = req.method,
    ip = clientIp(req),
    params = url.searchParams;
  // Live-Verbindung (Server-Sent Events): der Server meldet jede neue Änderungsnummer
  if (pathname === '/api/events') {
    // Wer ist das? Disponent (PIN-Token) sieht alle Ankündigungen mit Daten, ein angemeldeter Monteur nur die seines Teams
    // (bei festem Team immer des eigenen); ohne Anmeldung (ältere App) gibt es nur den Hinweis „bitte abgleichen“
    const client = { res, kind: 'anon', team: '' };
    if (isDispo(req)) client.kind = 'dispo';
    else {
      const user = userFromRequest(req);
      if (user) {
        client.kind = 'team';
        client.team = clipString(params.get('team'), 100);
        if (!teamAllowed(user, client.team)) client.team = user.team || '';
      }
    }
    // Obergrenzen: jede Verbindung belegt Speicher und einen Dateizugriff, ohne Anmeldung kann sie jeder aufbauen (Überlastung)
    let anonymous = 0;
    if (client.kind === 'anon') for (const c of sseClients) if (c.kind === 'anon') anonymous++;
    if (sseClients.size >= MAX_LIVE_CLIENTS || (client.kind === 'anon' && anonymous >= MAX_LIVE_ANON))
      return sendJson(req, res, 503, { error: 'Zu viele Live-Verbindungen' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }
  // Monteur: SAP-User + Passwort (+ Geräte-ID) -> Token und Benutzerdaten (Name, Team)
  if (pathname === '/api/user/login' && method === 'POST') {
    const body = await readBody(req, 1e4),
      sap = normalizeSap(body.user),
      did = validDeviceId(body.did),
      result = await userLogin(ip, sap, String(body.password ?? '').slice(0, 200));
    if (result.locked)
      return sendJson(req, res, 429, { error: 'Zu viele Fehlversuche – bitte 10 Minuten warten.' });
    if (!result.row) {
      logAct('login_fail', null, did, null, sap.slice(0, 20));
      return sendJson(req, res, 403, { error: 'SAP-User oder Passwort falsch.' });
    }
    sql.loginUsr.run(Date.now(), sap);
    if (did) sql.clearKick.run(did);
    logAct('login', sap, did, result.row.team);
    return sendJson(req, res, 200, {
      token: userTokenFor(sap, did),
      user: {
        sap,
        name: fullName(result.row),
        team: result.row.team,
        lock: !!result.row.team_lock && !!result.row.team
      }
    });
  }
  // Disponent: PIN (+ Geräte-ID) -> Token
  if (pathname === '/api/login' && method === 'POST') {
    const body = await readBody(req, 1e4),
      did = validDeviceId(body.did),
      t = login(ip, body.pin, DISPO_PIN, '', did);
    if (t && did) sql.clearKick.run(did);
    return t
      ? sendJson(req, res, 200, { token: t })
      : sendJson(req, res, 403, { error: 'Falscher PIN (oder zu viele Versuche – 10 Minuten warten)' });
  }
  // Abgleich: nur Änderungen seit Nummer "since". team=<Name> für Monteure (nur eigene Aufträge/Ergebnisse), "-" = nur Teamliste, leer = alles (Disponent)
  if (pathname === '/api/sync' && method === 'GET') {
    const since = +params.get('since') || 0,
      team = params.get('team') || '',
      did = validDeviceId(params.get('did'));
    // Hat der Disponent das Gerät ausgeloggt, sind seine Tokens schon ungültig: ohne diese Meldung käme nur „bitte anmelden“ (401)
    // statt der Rückkehr zum Startbildschirm. Die Anmeldung auf dem Gerät hebt das Kennzeichen wieder auf (siehe Login).
    const kicked = !!(did && (sql.getKick.get(did) || {}).kick);
    if (kicked) return sendJson(req, res, 200, { seq: changeSeq, same: true, kicked: true, ver: appVersion() });
    // Monteure (team=<Name> oder „-“) brauchen die Anmeldung mit SAP-User, der Gesamtstand (kein Team) ist dem Disponenten vorbehalten
    const me = team ? userFromRequest(req) : null;
    if (team && !me) return sendJson(req, res, 401, { error: 'Bitte anmelden', login: 1 });
    if (!team && !isDispo(req)) return sendJson(req, res, 401, { error: 'Nicht angemeldet (PIN)' });
    // Gerät bekannt? Dann „zuletzt aktiv“ festhalten
    if (did) sql.touchDev.run(Date.now(), did, Date.now() - 60e3);
    // wie der Server das Gerät kennt (siehe deviceState) – steht in jeder Antwort, auch wenn sonst nichts Neues da ist
    const devState = me && did && team !== '-' ? { dev: deviceState(did, team) } : {};
    // festes Team: für ein anderes Team gibt es keine Daten, nur die Angabe des erlaubten Teams (die App wechselt dann dorthin)
    if (me && team !== '-' && !teamAllowed(me, team))
      return sendJson(req, res, 200, {
        seq: changeSeq,
        same: true,
        ver: appVersion(),
        gday: dayOf(Date.now()),
        me: meOf(me)
      });
    if (since === changeSeq)
      return sendJson(req, res, 200, {
        seq: changeSeq,
        same: true,
        ver: appVersion(),
        gday: dayOf(Date.now()),
        ...(me ? { me: meOf(me) } : {}),
        ...devState,
        ...locateField()
      });
    const full = since === 0 || since > changeSeq || since < minSeq,
      from = full ? 0 : since;
    const out = {
      seq: changeSeq,
      full,
      ver: appVersion(),
      gday: dayOf(Date.now()),
      ...(me ? { me: meOf(me) } : {}),
      ...devState,
      ...locateField(),
      teams: teamsList(),
      meta: { upload: getMeta('upload'), pruef: getMeta('pruef'), vorg: getMeta('vorg'), mel: getMeta('mel') },
      orders: [],
      ergebnis: []
    };
    if (team !== '-') {
      // erster Abgleich eines Monteurs: nur die Aufträge des Teams lesen (nicht die ganze Tabelle)
      const orderRows =
        full && team ? sql.ordersFullTeam.all(team) : (full ? sql.ordersSinceLive : sql.ordersSince).all(from);
      for (const r of orderRows) {
        // Monteur: nur, was sein Team sieht (Reparaturen/Entstörungen erst nach der Disposition); Disponent: alles
        if (!r.del && (!team || r.mteam === team)) out.orders.push(orderFields(r, !team));
        else if (!full) out.orders.push({ auftrag: r.auftrag, del: 1 }); // gelöscht, in anderes Team verschoben oder nicht (mehr) disponiert
      }
      const rows = team ? sql.ergebnisTeam.all(from, team) : sql.ergebnisAll.all(from);
      out.ergebnis = rows.map(r => ({ a: r.auftrag, doc: JSON.parse(r.doc), sq: r.seq }));
      // Meldungen (Schäden): Monteur die seines Teams und die zu seinen Aufträgen, Disponent alle; gelöschte nur bei einem Teil-Abgleich
      const meldungRows = team
        ? full
          ? sql.meldungFullTeam.all(team)
          : sql.meldungSinceTeam.all(from, team)
        : (full ? sql.meldungSinceLive : sql.meldungSince).all(from);
      out.meldungen = meldungRows.map(r => (r.del || r.mine === 0 ? { nr: r.nr, del: 1 } : meldungFields(r)));
      const lim = Date.now() - MESSAGE_HOURS * 3600e3;
      if (team)
        out.msgs = sql.msgsTeam
          .all(clipString(params.get('did'), 64), team, lim)
          .map(r => ({ id: r.id, team, text: r.text, at: r.at, ack: !!r.ack }));
      else {
        out.msgs = sql.msgsAll
          .all(Date.now() - 24 * 3600e3)
          .map(r => ({
            id: r.id,
            team: r.team,
            text: r.text,
            at: r.at,
            closed: !!r.closed || r.at <= lim,
            acks: r.acks
          }));
        out.devs = Object.fromEntries(
          sql.devsByTeam.all(Date.now() - 30 * 864e5).map(r => [r.team, [r.n, r.p]])
        );
        out.cfg = { nag: NAG_INTERVAL_MIN, hours: MESSAGE_HOURS };
        out.dteams = dispoTeamList();
        // SAP-User -> Name (für „bewertet von“): nur wenn sich die Liste geändert hat (uv = Stand des Geräts)
        if (params.get('uv') !== String(usersVer)) {
          out.users = sql.usrNames.all().map(r => [r.sap, r.name]);
          out.uv = usersVer;
        }
      }
      // Gaswarngerät-Bestätigungen der letzten 60 Tage: Monteur nur die des eigenen Teams, Disponent alle
      const gasFrom = dayOf(Date.now() - 60 * 864e5);
      out.gas = team ? sql.gasSinceTeam.all(from, gasFrom, team) : sql.gasSince.all(from, gasFrom);
      // Haken: der Disponent sieht alle, ein Monteur die Haken der Aufträge seines Teams (abgehakte Aufträge sind für ihn gesperrt)
      out.marks = (team
        ? (full ? sql.marksSinceLiveTeam : sql.marksSinceTeam).all(from, team)
        : (full ? sql.marksSinceLive : sql.marksSince).all(from)
      ).map(r => ({ a: r.auftrag, v: r.v, at: r.at, sq: r.seq }));
    }
    return sendJson(req, res, 200, out);
  }
  // Monteur: Kollegen zur Auswahl bei der Zeitrückmeldung („mit wem gearbeitet“). ?team=<Team>: here = hatte zuletzt ein Gerät in diesem Team
  if (pathname === '/api/colleagues' && method === 'GET') {
    const user = userFromRequest(req);
    if (!user) return sendJson(req, res, 401, { error: 'Bitte anmelden', login: 1 });
    const list = sql.colleagues
      .all(clipString(params.get('team'), 100), Date.now() - 7 * 864e5, user.sap)
      .map(r => ({ sap: r.sap, name: r.name, team: r.team, here: !!r.here }));
    return sendJson(req, res, 200, { list });
  }
  // Koordinaten der Auftragsadressen für die Entfernungs-Sortierung: ?since=<n> liefert nur Neueres. Antwort: n = größte Nummer
  // (beim nächsten Aufruf als since), full = Gerät muss seine Liste ersetzen (Datenbank wurde ersetzt), items = [[PLZ|Straße, lat, lon, q]],
  // open = Adressen, die noch auf ihre Koordinaten warten (die Geräte rechnen dafür vorerst mit der Bezirksmitte), err = letzter Fehler
  // des Dienstes, off = Dienst abgeschaltet (GEOCODER_URL=off); ?team=<Team> bevorzugt dessen Adressen
  if (pathname === '/api/geo' && method === 'GET') {
    if (!isDispo(req) && !userFromRequest(req)) return sendJson(req, res, 401, { error: 'Bitte anmelden', login: 1 });
    const max = sql.geoMax.get().m || 0,
      full = (+params.get('since') || 0) > max || +params.get('e') !== GEO_EPOCH,
      since = full ? 0 : +params.get('since') || 0,
      team = clipString(params.get('team'), 100);
    // Das Team dieses Geräts kommt bei den offenen Adressen zuerst dran; war der Dienst gestört, wird es gleich wieder versucht
    if (team && GEOCODER_ON) {
      geoWanted.set(team, Date.now());
      geocodeKick(0, !!geoError && Date.now() - geoTriedAt > 60e3);
    }
    return sendJson(req, res, 200, {
      n: max,
      e: GEO_EPOCH,
      ...(full ? { full: true } : {}),
      items: sql.geoSince.all(since).map(r => [r.k, r.lat, r.lon, r.q]),
      open: GEOCODER_ON ? sql.geoOpen.get(Date.now() - GEO_RETRY_MS).n : 0,
      ...(geoError ? { err: geoError } : {}),
      ...(GEOCODER_ON ? {} : { off: true })
    });
  }
  // Prüfobjekte lesen: ?a=<Auftrag> liefert eine Liste, ?team=<Team>&since=<Nr> alle geänderten Listen des Teams
  if (pathname === '/api/pruef' && method === 'GET') {
    const pruefUser = isDispo(req) ? null : userFromRequest(req);
    if (!isDispo(req) && !pruefUser) return sendJson(req, res, 401, { error: 'Bitte anmelden', login: 1 });
    if (pruefUser && params.get('team') && !teamAllowed(pruefUser, params.get('team')))
      return sendJson(req, res, 403, { error: 'Dein Team ist festgelegt.' });
    const a = params.get('a'),
      team = params.get('team'),
      since = +params.get('since') || 0;
    if (a) {
      const r = sql.pruefOne.get(a);
      return sendJson(req, res, 200, { list: r ? JSON.parse(r.items) : [] });
    }
    if (team) {
      const from = since > changeSeq ? 0 : since,
        map = {};
      for (const r of prep(
        'SELECT p.auftrag,p.items FROM pruef p JOIN orders o ON o.auftrag=p.auftrag WHERE o.mteam=? AND o.del=0 AND p.seq>?'
      ).all(team, from))
        map[r.auftrag] = JSON.parse(r.items);
      return sendJson(req, res, 200, { map, seq: changeSeq });
    }
    return sendJson(req, res, 400, { error: 'a oder team angeben' });
  }
  // Monteur: Ergebnis eines Auftrags speichern – PUT /api/ergebnis/<Auftragsnummer>
  let match;
  if ((match = pathname.match(/^\/api\/ergebnis\/(\d{1,20}(?:-\d{1,4})?(?:(?:#|%23)[a-z0-9]{4,12})?)$/)) && method === 'PUT') {
    match[1] = match[1].replace('%23', '#'); // Tageseintrag eines Dauerauftrags: „Auftrag#Kennung“ (das # kommt als %23 an)
    // _b = Stand (Änderungsnummer), auf dem die Eingabe beruht. Hat inzwischen ein anderes Gerät gespeichert, gewinnt der Server:
    // die Eingabe wird abgelehnt (409) und das Gerät bekommt den aktuellen Stand zurück. Ohne _b (alte App-Version): wie bisher.
    const user = userFromRequest(req);
    if (!user) return sendJson(req, res, 401, { error: 'Bitte anmelden', login: 1 });
    const body = await readBody(req, 1e6),
      d = cleanResultDoc(match[1], body),
      sentMit = Array.isArray(body.mit), // Kollegen mitgeschickt? (leere Liste = bewusst keine)
      base = body._b == null ? null : Number(body._b);
    if (!teamAllowed(user, d.team))
      return sendJson(req, res, 403, { error: 'Dein Team ist festgelegt – dieser Auftrag gehört zu einem anderen Team.' });
    d.u = user.sap; // wer das Ergebnis zuletzt gespeichert hat (kommt aus der Anmeldung, nicht vom Gerät)
    // Schlüssel „Auftrag#Kennung“ = ein Zeiteintrag (Dauerauftrag: ein Tageseintrag; Reparatur/Entstörung: eine von mehreren Zeiten); gesperrt wird über den Auftrag
    const orderKey = match[1].split('#')[0],
      isEntry = match[1].includes('#');
    const r = await inBatch(() => {
      if (isEntry) {
        const o = sql.getOrderKind.get(orderKey);
        if (!o || !['dau', 'rep', 'ent'].includes(o.kind)) return { bad: 'Zeiteinträge gibt es nur bei Daueraufträgen, Reparaturen und Entstörungen.' };
      }
      // Festes Team: das `team` im Body stammt vom Gerät – maßgeblich ist das Team, dessen Monteure den Auftrag wirklich sehen
      if (user.lock) {
        const o = sql.getOrderTeam.get(orderKey);
        if (!o || o.mteam !== user.team) return { forbidden: true };
      }
      const cur = sql.getErg.get(match[1]);
      // Vom Disponenten abgehakt: der Monteur kann nichts mehr ändern (erst wieder, wenn der Haken zurückgenommen wird)
      const mark = sql.getMark.get(orderKey);
      if (mark && mark.v) return { locked: mark, cur: cur || null };
      if (isEntry && !cur && sql.countEntries.get(orderKey + '#', orderKey + '$').n >= MAX_ENTRIES)
        return { bad: `Zu diesem Auftrag gibt es schon ${MAX_ENTRIES} Einträge.` };
      if (base !== null && (cur ? cur.seq : 0) !== base) return { cur: cur || null };
      // Zeitrückmeldung (tu = SAP-User, der sie gemacht hat): bleibt die Zeit unverändert, bleibt auch der bisherige Benutzer
      // (z. B. wenn ein anderer Monteur nur Prüfobjekte bewertet); neue oder geänderte Zeit gehört dem speichernden Benutzer
      if (d.min != null) {
        let prev = null;
        try {
          prev = cur && JSON.parse(cur.doc);
        } catch {}
        // Dauer nur in Viertelstunden; eine ältere, nicht gerundete Zeit darf unverändert bleiben (z. B. beim Bewerten von Prüfobjekten)
        if (d.von && +d.von.slice(3) % 15 !== 0 && !(prev && prev.von === d.von))
          return { bad: 'Die Beginn-Uhrzeit muss auf eine Viertelstunde gerundet sein (:00, :15, :30, :45).' };
        if (d.min % 15 !== 0 && !(prev && prev.min === d.min)) return { bad: 'Die Dauer muss in Viertelstunden angegeben werden (15, 30, 45 …).' };
        const unchanged = prev && prev.min === d.min && prev.tat === d.tat && prev.dat === d.dat && prev.von === d.von;
        if (unchanged) {
          if (prev.tu) d.tu = prev.tu;
          // gleiche Zeit: die Kollegen bleiben, wie sie sind – auch wenn der Speichernde selbst einer davon ist (er bewertet nur ein
          // Prüfobjekt); wurden sie nicht mitgeschickt (ältere App), gelten die bisherigen
          if (!sentMit && prev.mit) d.mit = prev.mit;
        } else {
          d.tu = user.sap;
          // neue oder geänderte Zeit: der Speichernde ist nicht „mit“ sich selbst unterwegs
          if (d.mit) {
            d.mit = d.mit.filter(x => x !== user.sap);
            if (!d.mit.length) delete d.mit;
          }
        }
      }
      changeSeq++;
      sql.upErg.run(match[1], d.team, JSON.stringify(d), changeSeq, user.sap);
      // Protokoll im selben Schreibvorgang (ein Festschreiben statt zwei)
      logAct(
        'ergebnis',
        user.sap,
        user.did,
        d.team,
        match[1],
        `${d.ok} OK, ${d.nx} Nicht OK, ${d.n - d.ok - d.nx} offen` + (d.min != null ? `, Zeit ${d.min} Min${d.fin ? ', Endrückmeldung' : ''}` : d.go ? ', gestartet' : '')
      );
      return { sq: changeSeq };
    });
    if (r.bad) return sendJson(req, res, 400, { error: r.bad });
    if (r.forbidden)
      return sendJson(req, res, 403, { error: 'Dein Team ist festgelegt – dieser Auftrag gehört zu einem anderen Team.' });
    if (r.locked)
      return sendJson(req, res, 423, {
        error: 'Der Disponent hat diesen Auftrag abgehakt – er kann nicht mehr bearbeitet werden.',
        locked: 1,
        mark: { v: 1, at: r.locked.at, sq: r.locked.seq },
        doc: r.cur ? JSON.parse(r.cur.doc) : null,
        sq: r.cur ? r.cur.seq : 0
      });
    if (r.sq == null)
      return sendJson(req, res, 409, {
        error: 'Inzwischen auf einem anderen Gerät geändert',
        doc: r.cur ? JSON.parse(r.cur.doc) : null,
        sq: r.cur ? r.cur.seq : 0
      });
    announce(r.sq, { team: d.team }, { k: 'e', a: match[1], doc: d });
    return sendJson(req, res, 200, { ok: true, sq: r.sq });
  }
  // Push: öffentlicher Schlüssel, Gerät/Team/Abo melden, Bestätigen
  if (pathname === '/api/push/key' && method === 'GET') return sendJson(req, res, 200, { key: vapid.pub });
  if (pathname === '/api/push/sub' && method === 'POST') {
    const body = await readBody(req, 1e4),
      did = validDeviceId(body.did);
    let team = body.team == null || body.team === '' ? null : clipString(body.team, 100);
    // Rolle des Geräts: 'monteur' | 'dispo' | null (abgemeldet); ältere Apps melden nur das Team -> Monteur
    const role = body.role === 'dispo' || body.role === 'monteur' ? body.role : team ? 'monteur' : null;
    if (!did) return sendJson(req, res, 400, { error: 'Ungültige Geräte-ID' });
    // Ein Gerät als Disponent zu melden, geht nur mit gültigem Token: sonst könnte jeder beliebige Geräte (samt Push-Abo und Team) anlegen –
    // und bekäme damit die Nachrichten des Disponenten an dieses Team
    if (role === 'dispo' && !isDispo(req)) return sendJson(req, res, 401, { error: 'Nicht angemeldet (PIN)' });
    // Monteur-Geräte gehören zu einem angemeldeten Benutzer (dev.usr); abgemeldete und Disponenten-Geräte zu keinem
    let userSap = null;
    if (role === 'monteur') {
      const user = userFromRequest(req);
      if (!user) return sendJson(req, res, 401, { error: 'Bitte anmelden', login: 1 });
      userSap = user.sap;
      if (!teamAllowed(user, team)) team = user.team; // festes Team gilt immer
    }
    let sub = null;
    // keep: Das Gerät konnte das Abo gerade nicht prüfen (Fehler, kein Netz, Server-Neustart) – ein bisheriges Abo bleibt dann stehen.
    // Nur ein ausdrückliches „kein Abo“ (Berechtigung weg, Abmeldung) löscht es; sonst wäre nach jedem Aussetzer beim App-Start kein Push mehr möglich.
    if (!body.sub && body.keep === true && role === 'monteur') sub = (sql.getDev.get(did) || {}).sub || null;
    if (body.sub) {
      const ep = clipString(body.sub.endpoint, 1000),
        k = body.sub.keys || {};
      if (
        !PUSH_HOSTS.test(ep) ||
        Buffer.from(clipString(k.p256dh, 200), 'base64url').length !== 65 ||
        Buffer.from(clipString(k.auth, 100), 'base64url').length !== 16
      )
        return sendJson(req, res, 400, { error: 'Ungültiges Push-Abo' });
      sub = JSON.stringify({
        endpoint: ep,
        keys: { p256dh: clipString(k.p256dh, 200), auth: clipString(k.auth, 100) }
      });
    }
    const old = sql.getDev.get(did),
      now = Date.now();
    // Push-Status laut Gerät („granted“, „default“, „denied“, „unsupported“, dahinter nach „|“ ein Fehlertext): nur bei Monteur-Geräten; ältere Apps
    // melden ihn nicht – dann bleibt der bisherige stehen. Der Disponent sieht ihn in der Geräteübersicht und weiß so, WARUM ein Gerät keinen Push hat.
    const pstat =
      role !== 'monteur' ? null : body.pstat === undefined ? (old && old.pstat) || null : clipString(body.pstat, 200).trim() || null;
    if (
      old &&
      old.role === role &&
      old.team === team &&
      old.sub === sub &&
      !old.kick &&
      (old.usr || null) === userSap &&
      (old.pstat || null) === pstat
    ) {
      sql.seenDev.run(now, did);
      return sendJson(req, res, 200, { ok: true });
    }
    // unbekanntes Gerät ohne Rolle: nichts zu merken
    if (!old && role === null && team === null) return sendJson(req, res, 200, { ok: true });
    transaction(() => {
      changeSeq++;
      if (sub) sql.dupSub.run(sub, did);
      sql.upDev.run(did, role, team, sub, now, clipString(req.headers['user-agent'], 200), now, userSap, pstat);
      if (role !== 'monteur') sql.clearLoc.run(did); // abgemeldet oder nicht (mehr) Monteur -> kein Standort
    });
    announce(changeSeq, 'dispo'); // nur der Disponent sieht Geräte und Zähler
    return sendJson(req, res, 200, { ok: true });
  }
  if (pathname === '/api/push/resub' && method === 'POST') {
    // Browser hat das Abo erneuert (aus dem Service Worker)
    const body = await readBody(req, 1e4),
      ep = clipString(body.sub && body.sub.endpoint, 1000),
      k = (body.sub && body.sub.keys) || {};
    if (!PUSH_HOSTS.test(ep) || !k.p256dh || !k.auth)
      return sendJson(req, res, 400, { error: 'Ungültiges Push-Abo' });
    sql.resub.run(
      JSON.stringify({
        endpoint: ep,
        keys: { p256dh: clipString(k.p256dh, 200), auth: clipString(k.auth, 100) }
      }),
      clipString(body.old, 1000)
    );
    return sendJson(req, res, 200, { ok: true });
  }
  // Gerät meldet seinen Standort (nur auf Abfrage: der Server nimmt ihn nur an, solange der Disponent die Geräteübersicht
  // offen hat). Body: { did, lat, lon, acc } oder { did, error: 'denied' | 'unavailable' | 'timeout' }
  if (pathname === '/api/devices/location' && method === 'POST') {
    const body = await readBody(req, 1e4),
      did = validDeviceId(body.did);
    if (!did) return sendJson(req, res, 400, { error: 'Ungültige Geräte-ID' });
    if (Date.now() >= locateUntil + 30e3) return sendJson(req, res, 200, { ok: true, ignored: true });
    const now = Date.now();
    if (['denied', 'unavailable', 'timeout'].includes(body.error)) {
      sql.setLoc.run(null, null, null, body.error, now, did);
      return sendJson(req, res, 200, { ok: true });
    }
    const lat = Number(body.lat),
      lon = Number(body.lon),
      acc = Number(body.acc);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && acc >= 0))
      return sendJson(req, res, 400, { error: 'Ungültiger Standort' });
    sql.setLoc.run(Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, Math.round(acc), null, now, did);
    return sendJson(req, res, 200, { ok: true });
  }
  // Gerät bestätigt eine Nachricht
  if (pathname === '/api/msg/ack' && method === 'POST') {
    const body = await readBody(req, 1e4),
      id = +body.id | 0,
      did = clipString(body.did, 64);
    if (!id || !/^[a-f0-9]{32}$/.test(did)) return sendJson(req, res, 400, { error: 'Ungültig' });
    const owner = sql.getDev.get(did);
    // ohne Anmeldung aufrufbar (Service Worker): nur für ein bekanntes Gerät und eine vorhandene Nachricht, sonst könnte jeder die
    // Datenbank mit Fantasie-Bestätigungen füllen und alle Geräte zum Abgleichen bringen
    if (!owner || !sql.msgState.get(did, id)) return sendJson(req, res, 200, { ok: true });
    if (sql.ack.run(id, did, Date.now(), owner.usr || null).changes) {
      transaction(() => {
        changeSeq++;
      });
      logAct('ack', owner.usr, did, owner.team, id);
      announce(changeSeq, { team: owner.team });
    }
    return sendJson(req, res, 200, { ok: true });
  }
  if (pathname === '/api/msg/state' && method === 'GET') {
    // für den Service Worker: Benachrichtigung noch nötig?
    const r = sql.msgState.get(clipString(params.get('did'), 64), +params.get('id') | 0);
    return sendJson(req, res, 200, {
      open: !!(r && !r.closed && !r.ack && r.at > Date.now() - MESSAGE_HOURS * 3600e3)
    });
  }
  // Monteur: Gaswarngerät des Teams für heute bestätigen. Body: { did, team, at }. `at` = Zeitpunkt, zu dem am Gerät
  // bestätigt wurde (relevant, wenn ohne Netz bestätigt und erst später gesendet wird); unplausible Zeiten (mehr als
  // 24 h alt oder in der Zukunft) werden durch die Serverzeit ersetzt. Je Tag und Team zählt die erste Bestätigung;
  // eine weitere (anderes Gerät, Doppel-Tipp) ändert nichts und bekommt die bestehende zurück.
  if (pathname === '/api/gas' && method === 'POST') {
    const user = userFromRequest(req);
    if (!user) return sendJson(req, res, 401, { error: 'Bitte anmelden', login: 1 });
    const body = await readBody(req, 1e4),
      did = validDeviceId(body.did),
      team = clipString(body.team, 100);
    if (!did || !team || !sql.hasTeam.get(team))
      return sendJson(req, res, 400, { error: 'Ungültiges Team oder Gerät' });
    if (!teamAllowed(user, team)) return sendJson(req, res, 403, { error: 'Dein Team ist festgelegt.' });
    const now = Date.now();
    let at = Number(body.at);
    if (!(at >= now - 24 * 3600e3 && at <= now + 5 * 60e3)) at = now;
    at = Math.min(at, now);
    const day = dayOf(at);
    let added = false;
    transaction(() => {
      if (sql.getGas.get(day, team)) return;
      changeSeq++;
      added = sql.addGas.run(day, team, at, now, did, changeSeq, user.sap).changes > 0;
    });
    if (added) {
      logAct('gas', user.sap, did, team, day);
      announce(changeSeq, { team });
    }
    const row = sql.getGas.get(day, team);
    return sendJson(req, res, 200, {
      ok: true,
      dup: !added,
      row: { d: row.day, t: row.team, at: row.at, rec: row.rec, sq: row.seq }
    });
  }
  // ab hier nur Disponent
  if (!isDispo(req)) return sendJson(req, res, 401, { error: 'Nicht angemeldet (PIN)' });
  // gesamtes Protokoll der Gaswarngerät-Bestätigungen (für den Export; die Abgleich-Antwort enthält nur die letzten 60 Tage)
  if (pathname === '/api/gas' && method === 'GET') return sendJson(req, res, 200, { rows: sql.gasAll.all() });
  if (pathname === '/api/msg' && method === 'POST') {
    // Nachricht an ein Team (ersetzt eine noch offene)
    const body = await readBody(req, 1e4),
      team = clipString(body.team, 100),
      text = clipString(body.text, 300).trim();
    if (!team || !text) return sendJson(req, res, 400, { error: 'Team und Text angeben' });
    const at = Date.now();
    let id;
    transaction(() => {
      changeSeq++;
      sql.closeTeamMsg.run(changeSeq, team);
      id = Number(sql.addMsg.run(team, text, at, changeSeq).lastInsertRowid);
    });
    announce(changeSeq, { team });
    // pushed = Geräte, bei denen der Push-Dienst die Nachricht angenommen hat; of = Geräte des Teams mit Push-Abo; known = alle Geräte des Teams
    // (angemeldet, zuletzt aktiv in 30 Tagen) – die App sagt dem Disponenten damit gleich, wie viele Monteure per Push erreichbar sind
    const sent = await sendReminders({ id, team, text, at }, true),
      known = sql.teamDevCount.get(team, Date.now() - 30 * 864e5);
    return sendJson(req, res, 200, { ok: true, id, pushed: sent.ok, of: sent.total, known: known.n });
  }
  if (pathname === '/api/msg/close' && method === 'POST') {
    const id = +(await readBody(req, 1e4)).id | 0;
    transaction(() => {
      changeSeq++;
      sql.closeMsg.run(changeSeq, id);
    });
    announce(changeSeq);
    return sendJson(req, res, 200, { ok: true });
  }
  // Geräteübersicht: alle Geräte, die in den letzten 30 Tagen aktiv waren (jüngste zuerst); `now` = Serverzeit für „vor … Min“
  // Mit ?locate=1 wird die Standortabfrage gestartet bzw. verlängert (90 s) – das macht nur die offene Geräteübersicht;
  // ?refresh=1 beginnt sofort eine neue Runde. Alle anderen Ansichten fragen nie nach Standorten.
  if (pathname === '/api/devices' && method === 'GET') {
    if (params.get('locate') === '1') {
      const wasActive = Date.now() < locateUntil;
      locateUntil = Date.now() + LOCATE_WINDOW_MS;
      if (!wasActive || params.get('refresh') === '1') {
        transaction(() => {
          locateRound++;
          changeSeq++;
        });
        announce(changeSeq); // alle Geräte gleichen sofort ab und erfahren von der Abfrage
      }
    }
    const devices = sql.listDevs.all(Date.now() - 30 * 864e5).map(r => ({
      did: r.did,
      name: r.name,
      role: r.role,
      team: r.team,
      push: !!r.push,
      pstat: r.pstat, // Push-Status laut Gerät (siehe /api/push/sub)
      seen: r.seen,
      first: r.first,
      ua: r.ua,
      kick: !!r.kick,
      usr: r.usr, // angemeldeter Benutzer (SAP-User) und sein Name
      uname: r.uname,
      lat: r.loc_lat,
      lon: r.loc_lon,
      acc: r.loc_acc,
      locAt: r.loc_at,
      locError: r.loc_err
    }));
    return sendJson(req, res, 200, { devices, now: Date.now() });
  }
  // Spitzname eines Geräts setzen (leer = Spitzname entfernen)
  if (pathname === '/api/devices/name' && method === 'POST') {
    const body = await readBody(req, 1e4),
      did = validDeviceId(body.did),
      name = clipString(body.name, 40).trim();
    if (!did) return sendJson(req, res, 400, { error: 'Ungültige Geräte-ID' });
    sql.nameDev.run(name || null, did);
    return sendJson(req, res, 200, { ok: true });
  }
  // Gerät ausloggen: das Gerät kehrt beim nächsten Abgleich zum Startbildschirm zurück (sync meldet `kicked`), und seine
  // bisher ausgestellten Disponenten-/Upload-Tokens werden sofort ungültig (siehe tokenValid)
  if (pathname === '/api/devices/logout' && method === 'POST') {
    const did = validDeviceId((await readBody(req, 1e4)).did);
    let found = false;
    if (did)
      transaction(() => {
        found = sql.kickDev.run(Date.now(), did).changes > 0;
        if (found) changeSeq++; // neue Änderungsnummer -> alle Geräte gleichen sofort ab, das betroffene erfährt es so gleich
      });
    if (!found) return sendJson(req, res, 404, { error: 'Gerät nicht gefunden' });
    announce(changeSeq);
    return sendJson(req, res, 200, { ok: true });
  }
  // ---- Benutzerverwaltung (Disponent) ----
  // Liste aller Benutzer; Anmeldung und Geräte (zuletzt gesehen, Anzahl) zeigen, wer die App wirklich nutzt
  if (pathname === '/api/users' && method === 'GET')
    return sendJson(req, res, 200, {
      users: sql.listUsr.all().map(r => ({
        sap: r.sap,
        last: r.last,
        first: r.first,
        team: r.team,
        lock: !!r.team_lock,
        active: !!r.active,
        created: r.created,
        loginAt: r.login_at,
        seen: r.seen,
        devs: r.devs
      })),
      now: Date.now()
    });
  // Benutzer anlegen: Nachname, Vorname, SAP-User, Team; das Passwort ist das Startpasswort
  if (pathname === '/api/users' && method === 'POST') {
    const body = await readBody(req, 1e4),
      sap = normalizeSap(body.sap),
      last = clipString(body.last, 60).trim(),
      first = clipString(body.first, 60).trim(),
      team = clipString(body.team, 100).trim() || null,
      lock = body.lock ? 1 : 0;
    if (!validSap(sap)) return sendJson(req, res, 400, { error: 'SAP-User: 2–20 Buchstaben/Ziffern' });
    if (!last) return sendJson(req, res, 400, { error: 'Bitte den Nachnamen angeben' });
    if (sql.getUsr.get(sap)) return sendJson(req, res, 409, { error: 'Diesen SAP-User gibt es schon' });
    const now = Date.now();
    sql.addUsr.run(sap, last, first, team, hashPassword(MONTEUR_PASSWORD), now, now, lock);
    usersVer++;
    logAct('user_new', null, null, team, sap, `${first} ${last}${lock ? ' (Team fest)' : ''}`);
    return sendJson(req, res, 200, { ok: true });
  }
  let userMatch;
  if ((userMatch = pathname.match(/^\/api\/users\/([A-Za-z0-9]{2,20})(\/reset|\/log)?$/))) {
    const sap = normalizeSap(userMatch[1]),
      row = sql.getUsr.get(sap);
    if (!row) return sendJson(req, res, 404, { error: 'Benutzer nicht gefunden' });
    // Protokoll des Benutzers (die letzten 100 Einträge)
    if (userMatch[2] === '/log' && method === 'GET')
      return sendJson(req, res, 200, { log: sql.listAct.all(sap, 100) });
    // Passwort auf das Startpasswort zurücksetzen: bisherige Anmeldungen des Benutzers werden ungültig
    if (userMatch[2] === '/reset' && method === 'POST') {
      sql.pwUsr.run(hashPassword(MONTEUR_PASSWORD), Date.now(), sap);
      logAct('user_reset', null, null, row.team, sap);
      return sendJson(req, res, 200, { ok: true });
    }
    // Name, Team, Sperre ändern (der SAP-User selbst bleibt)
    if (!userMatch[2] && method === 'PUT') {
      const body = await readBody(req, 1e4),
        last = clipString(body.last ?? row.last, 60).trim(),
        first = clipString(body.first ?? row.first, 60).trim(),
        team = (body.team === undefined ? row.team : clipString(body.team, 100).trim()) || null,
        active = body.active === undefined ? row.active : body.active ? 1 : 0,
        lock = body.lock === undefined ? row.team_lock : body.lock ? 1 : 0;
      if (!last) return sendJson(req, res, 400, { error: 'Bitte den Nachnamen angeben' });
      sql.editUsr.run(last, first, team, active, lock, sap);
      usersVer++;
      logAct(
        'user_edit',
        null,
        null,
        team,
        sap,
        `${first} ${last}${active ? '' : ' (gesperrt)'}${lock ? ' (Team fest)' : ''}`
      );
      // Geräte gleichen sofort ab und übernehmen das neue Team bzw. die Sperre des Teamwechsels
      if (team !== row.team || lock !== row.team_lock) {
        transaction(() => {
          changeSeq++;
        });
        announce(changeSeq);
      }
      return sendJson(req, res, 200, { ok: true });
    }
    // Benutzer löschen: seine Anmeldungen enden sofort, die Verknüpfung der Geräte wird gelöst (Protokoll bleibt)
    if (!userMatch[2] && method === 'DELETE') {
      transaction(() => {
        sql.unlinkDevs.run(sap);
        sql.delUsr.run(sap);
      });
      usersVer++;
      logAct('user_del', null, null, row.team, sap, fullName(row));
      return sendJson(req, res, 200, { ok: true });
    }
  }
  if (pathname === '/api/login-upload' && method === 'POST') {
    const body = await readBody(req, 1e4),
      t = login(ip, body.pin, UPLOAD_PIN, 'up:', validDeviceId(body.did));
    return t
      ? sendJson(req, res, 200, { token: t })
      : sendJson(req, res, 403, {
          error: 'Falscher Upload-PIN (oder zu viele Versuche – 10 Minuten warten)'
        });
  }
  // Upload und Löschen von Aufträgen/Prüflosen nur mit zusätzlichem Upload-PIN
  if (
    /^\/api\/(orders|vorgaenge|meldungen|pruef)$/.test(pathname) &&
    (method === 'POST' || method === 'DELETE') &&
    !isUpload(req)
  )
    return sendJson(req, res, 401, { error: 'Bitte den Upload-PIN (erneut) eingeben', up: 1 });
  if (pathname === '/api/pruef/get' && method === 'POST') {
    // Export: Prüflisten bestimmter Aufträge
    const ids = (await readBody(req)).ids,
      map = {};
    if (Array.isArray(ids))
      for (const r of prep('SELECT auftrag,items FROM pruef WHERE auftrag IN (SELECT value FROM json_each(?))').all(
        JSON.stringify(ids.map(String))
      ))
        map[r.auftrag] = JSON.parse(r.items);
    return sendJson(req, res, 200, { map });
  }
  if (pathname === '/api/mark' && method === 'POST') {
    // Aufträge abhaken / Haken entfernen
    const body = await readBody(req, 2e6),
      ids = [
        ...new Set((Array.isArray(body.ids) ? body.ids : []).map(String).filter(a => /^\d{1,20}(-\d{1,4})?$/.test(a)))
      ].slice(0, 20000);
    if (!ids.length) return sendJson(req, res, 400, { error: 'Keine Aufträge angegeben' });
    const now = Date.now(),
      sq = transaction(() => {
        changeSeq++;
        for (const a of ids) sql.upMark.run(a, body.v ? 1 : 0, now, changeSeq);
        return changeSeq;
      });
    // Haken sehen Disponenten (alle) und die Monteure der betroffenen Teams (nur Aufträge des eigenen Teams – abgehakte Aufträge
    // sind für sie gesperrt); bei sehr vielen Aufträgen gleichen die Geräte lieber ab, statt die Liste mitzuschicken
    const teamOf = new Map(sql.ordersOfIds.all(JSON.stringify(ids)).map(r => [r.auftrag, r.team])),
      v = body.v ? 1 : 0;
    announce(
      sq,
      { teams: new Set(teamOf.values()) },
      ids.length <= 500
        ? c => ({ k: 'm', ids: c.kind === 'dispo' ? ids : ids.filter(a => teamOf.get(a) === c.team), v, at: now })
        : null
    );
    return sendJson(req, res, 200, { ok: true, sq, at: now });
  }
  /**
   * Disposition: Reparaturen und Entstörungen sehen Monteure erst, wenn der Disponent ihnen ein Team und einen Zeitraum gegeben hat.
   * Body: { items: [{ a: Auftrag, team, von: "JJJJ-MM-TTTHH:MM", bis: "JJJJ-MM-TTTHH:MM" } | { a: Auftrag, off: true }] } – disponieren bzw.
   * die Disposition aufheben (Ortszeit; höchstens 1000 Aufträge je Aufruf, Zeitraum höchstens 31 Tage, Uhrzeiten nur auf Viertelstunden). Antwort { ok, sq, changed, skipped }:
   * skipped = Aufträge, die es nicht (mehr) gibt oder keine Reparatur/Entstörung sind. Die Geräte der beteiligten Teams gleichen danach ab
   * (der Auftrag erscheint beim neuen Team und verschwindet beim alten), Disponenten bekommen die geänderten Aufträge gleich mit.
   */
  if (pathname === '/api/dispo' && method === 'POST') {
    const body = await readBody(req, 2e6),
      list = Array.isArray(body.items) ? body.items.slice(0, 1000) : [],
      teams = new Set(dispoTeamList()),
      stamp = v => {
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(v || ''));
        if (!m) return null;
        const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
        return new Date(t).toISOString().slice(0, 16) === v && +m[4] < 24 ? t : null;
      },
      items = [];
    for (const x of list) {
      const a = String((x && x.a) ?? '');
      if (!/^\d{1,20}(-\d{1,4})?$/.test(a)) return sendJson(req, res, 400, { error: 'Ungültige Auftragsnummer' });
      if (x.off) {
        items.push({ a, off: true });
        continue;
      }
      const team = clipString(x.team, 100),
        von = stamp(x.von),
        bis = stamp(x.bis);
      if (!teams.has(team)) return sendJson(req, res, 400, { error: `Unbekanntes Team: ${team || '(leer)'}` });
      if (von == null || bis == null || bis <= von)
        return sendJson(req, res, 400, { error: `Ungültiger Zeitraum bei Auftrag ${a} (Beginn und Ende als JJJJ-MM-TTTHH:MM, Ende nach Beginn)` });
      if (bis - von > 31 * 864e5) return sendJson(req, res, 400, { error: `Zeitraum bei Auftrag ${a} ist länger als 31 Tage` });
      // Beginn und Ende nur auf Viertelstunden (:00, :15, :30, :45), wie die Zeitrückmeldung der Monteure; ein früher gespeicherter, nicht
      // gerundeter Wert darf unverändert bleiben (z. B. wenn nur das Team gewechselt wird)
      const was = sql.getOrderDispo.get(a);
      if ((von % 9e5 && x.von !== (was && was.dvon)) || (bis % 9e5 && x.bis !== (was && was.dbis)))
        return sendJson(req, res, 400, { error: `Beginn und Ende bei Auftrag ${a} müssen auf eine Viertelstunde gerundet sein (:00, :15, :30, :45)` });
      items.push({ a, team, von: x.von, bis: x.bis });
    }
    if (!items.length) return sendJson(req, res, 400, { error: 'Keine Aufträge angegeben' });
    const skipped = [],
      changed = [],
      now = Date.now();
    const sq = transaction(() => {
      // erst prüfen, was sich überhaupt ändert (ohne Änderung keine neue Nummer)
      const todo = [];
      for (const x of items) {
        const cur = sql.getOrderDispo.get(x.a);
        if (!cur || cur.del || (cur.kind !== 'rep' && cur.kind !== 'ent')) skipped.push(x.a);
        else if (x.off ? cur.dteam : cur.dteam !== x.team || cur.dvon !== x.von || cur.dbis !== x.bis) todo.push([x, cur]);
      }
      if (!todo.length) return null;
      changeSeq++;
      for (const [x, cur] of todo) {
        if (x.off) sql.clearDispo.run(changeSeq, x.a);
        else sql.setDispo.run(x.team, x.von, x.bis, now, changeSeq, x.a);
        changed.push({ a: x.a, from: cur.mteam, to: x.off ? null : x.team });
        // den Monteuren beider Teams später melden (erst wenn der Disponent DISPO_NOTE_MS lang nichts mehr ändert): Stand davor merken
        for (const team of new Set([cur.mteam, x.off ? null : x.team]))
          if (team) {
            const was = team === cur.mteam;
            sql.noteDispo.run(team, x.a, was ? 1 : 0, was ? cur.dvon : null, was ? cur.dbis : null, now);
          }
      }
      // Die Geräte des Teams holen den Auftrag jetzt erst: ohne neue Nummer bekämen sie seine Meldungen nicht mit (die haben eine ältere)
      sql.touchMeldungOfOrders.run(changeSeq, changeSeq);
      catalogVer++; // Teamliste (Anzahl Aufträge je Team) neu berechnen
      return changeSeq;
    });
    if (sq != null) {
      const involved = new Set(changed.flatMap(c => [c.from, c.to]).filter(Boolean));
      // Disponenten bekommen die geänderten Aufträge direkt, Monteure der beteiligten Teams gleichen ab
      const rows = changed.length <= 100 ? changed.map(c => orderFields(sql.getOrderDispo.get(c.a), true)) : null;
      announce(sq, { teams: involved }, rows && (c => (c.kind === 'dispo' ? { k: 'o', rows, teams: teamsList() } : null)));
    }
    return sendJson(req, res, 200, { ok: true, sq: sq ?? changeSeq, changed: changed.length, skipped });
  }
  // Die vier SAP-Dateien werden einzeln hochgeladen (Aufträge, Vorgänge, Meldungen, Prüflose) – in beliebiger Reihenfolge und zu
  // verschiedenen Zeiten. Aufträge und Vorgänge landen als Rohdaten in src_auftrag/src_vorgang; `orders` wird daraus neu berechnet.
  // Aufträge: ersetzt je enthaltenem Team UND je enthaltener Auftragsart alle Aufträge, die in der Datei fehlen (keep = nur ergänzen)
  if (pathname === '/api/orders' && method === 'POST') {
    const body = await readBody(req),
      hasLart = !!body.hasLart,
      rows = (Array.isArray(body.rows) ? body.rows : [])
        .filter(r => r && /^\d{1,20}$/.test(String(r.auftrag || '').replace(/\D/g, '')) && r.team)
        .map(r => ({ ...r, nr: String(r.auftrag).replace(/\D/g, ''), kind: kindOfArt(r.art, String(r.lart || ''), hasLart) })),
      used = rows.filter(r => r.kind),
      ignored = {};
    for (const r of rows) if (!r.kind) ignored[clipString(r.art, 10) || '?'] = (ignored[clipString(r.art, 10) || '?'] || 0) + 1;
    if (!rows.length) return sendJson(req, res, 400, { error: 'Keine Aufträge in der Datei' });
    const result = transaction(() => {
      changeSeq++;
      const groups = new Map();
      for (const r of used) {
        const g = clipString(r.team, 100) + '\u0000' + r.kind;
        (groups.get(g) || groups.set(g, []).get(g)).push(r.nr);
      }
      if (!body.keep)
        for (const [g, ids] of groups) {
          const [team, kind] = g.split('\u0000');
          sql.delSrcAuftragGroup.run(team, kind, JSON.stringify(ids)); // nur Aufträge entfernen, die in der neuen Datei fehlen
        }
      for (const r of used)
        sql.upSrcAuftrag.run(
          r.nr,
          clipString(r.team, 100),
          clipString(r.tp, 60),
          clipString(r.art, 30),
          clipString(r.lart, 10),
          clipString(r.plz, 10),
          clipString(r.str, 100),
          clipString(r.kurz),
          clipString(r.start, 20),
          clipString(r.ende, 20),
          clipString(String(r.mel || '').replace(/\D/g, ''), 20),
          r.kind
        );
      const built = rebuildOrders();
      setMeta('upload', {
        at: Date.now(),
        files: clipString(body.files),
        count: used.length,
        kinds: built.counts,
        planned: built.planned,
        ignored: Object.fromEntries(Object.entries(ignored).slice(0, 20))
      });
      return { ...built, ignored, count: used.length };
    });
    announce(changeSeq);
    geocodeKick(); // neue Adressen im Hintergrund in Koordinaten umwandeln
    return sendJson(req, res, 200, { ok: true, ...result });
  }
  // Vorgänge: ersetzt die Vorgänge der Aufträge, die in der Datei stehen; ohne keep außerdem die der Teams in der Datei, deren Auftrag
  // nicht mehr darin steht (abgeschlossen)
  if (pathname === '/api/vorgaenge' && method === 'POST') {
    const body = await readBody(req),
      rows = (Array.isArray(body.rows) ? body.rows : [])
        .map(r => ({ ...r, nr: String((r && r.auftrag) || '').replace(/\D/g, ''), vg: clipString(r && r.vg, 8).trim() }))
        .filter(r => r.nr && r.nr.length <= 20 && r.vg);
    if (!rows.length) return sendJson(req, res, 400, { error: 'Keine Vorgänge in der Datei' });
    const result = transaction(() => {
      changeSeq++;
      const nrs = [...new Set(rows.map(r => r.nr))];
      sql.delSrcVorgangOfOrders.run(JSON.stringify(nrs));
      if (!body.keep)
        sql.delSrcVorgangTeams.run(JSON.stringify([...new Set(rows.map(r => clipString(r.team, 100)).filter(Boolean))]), JSON.stringify(nrs));
      for (const r of rows)
        sql.upSrcVorgang.run(
          r.nr,
          r.vg,
          clipString(r.art, 30),
          clipString(r.kurz),
          clipString(r.vtxt, 200),
          clipString(r.team, 100),
          clipString(r.vteam, 100),
          clipString(r.lart, 10),
          clipString(r.start, 20),
          clipString(r.ende, 20),
          clipString(r.arb, 10),
          clipString(r.uhr, 5),
          clipString(r.uhr2, 5)
        );
      const built = rebuildOrders();
      setMeta('vorg', { at: Date.now(), files: clipString(body.files), count: rows.length, orders: nrs.length });
      return { ...built, count: rows.length, orders: nrs.length };
    });
    announce(changeSeq);
    geocodeKick();
    return sendJson(req, res, 200, { ok: true, ...result });
  }
  // Meldungen: ersetzt je enthaltenem Team die Meldungen, die in der Datei fehlen (keep = nur ergänzen)
  if (pathname === '/api/meldungen' && method === 'POST') {
    const body = await readBody(req),
      meldungen = (Array.isArray(body.rows) ? body.rows : []).filter(m => m && /^\d{1,20}$/.test(String(m.nr || '').replace(/\D/g, '')));
    if (!meldungen.length) return sendJson(req, res, 400, { error: 'Keine Meldungen in der Datei' });
    transaction(() => {
      changeSeq++;
      const now = Date.now(),
        teams = new Map();
      for (const m of meldungen) {
        const t = clipString(m.team, 100),
          nr = String(m.nr).replace(/\D/g, '');
        (teams.get(t) || teams.set(t, []).get(t)).push(nr);
      }
      if (!body.keep) for (const [t, ids] of teams) sql.tombMeldungTeam.run(now, changeSeq, t, JSON.stringify(ids));
      for (const m of meldungen)
        sql.upMeldung.run(
          String(m.nr).replace(/\D/g, ''),
          clipString(m.dat, 20),
          clipString(m.txt, 300),
          clipString(m.str, 100),
          clipString(m.plz, 10),
          clipString(String(m.auftrag || '').replace(/\D/g, ''), 20),
          clipString(m.code, 60),
          clipString(m.tp, 60),
          clipString(m.stat, 40),
          clipString(m.team, 100),
          clipString(m.grp, 60),
          changeSeq
        );
      // Geräte, die einen Auftrag neu bekommen, brauchen auch dessen Meldungen (und umgekehrt)
      sql.touchMeldungOfOrders.run(changeSeq, changeSeq);
      setMeta('mel', { at: now, files: clipString(body.files), count: meldungen.length });
    });
    announce(changeSeq);
    return sendJson(req, res, 200, { ok: true, count: meldungen.length });
  }
  // Alle Aufträge löschen (die Vorgänge bleiben, gehören dann aber zu keinem Auftrag), alle Vorgänge löschen, alle Meldungen löschen
  if (pathname === '/api/orders' && method === 'DELETE') {
    transaction(() => {
      changeSeq++;
      db.exec('DELETE FROM src_auftrag');
      rebuildOrders();
      setMeta('upload', null);
    });
    announce(changeSeq);
    return sendJson(req, res, 200, { ok: true });
  }
  if (pathname === '/api/vorgaenge' && method === 'DELETE') {
    transaction(() => {
      changeSeq++;
      db.exec('DELETE FROM src_vorgang');
      rebuildOrders(); // Reparaturen sind wieder ein Auftrag je Auftragsnummer
      setMeta('vorg', null);
    });
    announce(changeSeq);
    return sendJson(req, res, 200, { ok: true });
  }
  if (pathname === '/api/meldungen' && method === 'DELETE') {
    transaction(() => {
      changeSeq++;
      sql.tombMeldungAll.run(Date.now(), changeSeq);
      setMeta('mel', null);
    });
    announce(changeSeq);
    return sendJson(req, res, 200, { ok: true });
  }
  if (pathname === '/api/pruef' && method === 'POST') {
    const body = await readBody(req),
      by = body.by && typeof body.by === 'object' ? body.by : {};
    transaction(() => {
      changeSeq++;
      for (const [a, l] of Object.entries(by))
        if (/^\d{1,20}$/.test(a) && Array.isArray(l))
          sql.upPruef.run(a, JSON.stringify(l.slice(0, 500).map(t => clipString(t, 200))), changeSeq);
      setMeta('pruef', {
        at: Date.now(),
        files: clipString(body.files),
        count: +body.count | 0,
        orders: +body.orders | 0
      });
    });
    announce(changeSeq);
    return sendJson(req, res, 200, { ok: true });
  }
  if (pathname === '/api/pruef' && method === 'DELETE') {
    transaction(() => {
      changeSeq++;
      sql.wipePruef.run(changeSeq);
      setMeta('pruef', null);
    });
    announce(changeSeq);
    return sendJson(req, res, 200, { ok: true });
  }
  return sendJson(req, res, 404, { error: 'Unbekannt' });
}

// ---------- Version der Oberfläche: ändert sich index.html oder sw.js, laden die Geräte neu ----------
let versionCache = { k: '', v: '' };
// aktuelle Version der Oberfläche (Hash von index.html + sw.js; wird nur neu berechnet, wenn sich die Dateien ändern)
let versionCheckedAt = 0;
function appVersion() {
  // höchstens alle 2 Sekunden die Dateien prüfen (der Abgleich fragt die Version bei jedem Aufruf ab)
  if (Date.now() - versionCheckedAt < 2000 && versionCache.v) return versionCache.v;
  versionCheckedAt = Date.now();
  const files = ['index.html', 'sw.js'].map(n => path.join(PUBLIC_DIR, n)),
    stamp = files
      .map(f => {
        try {
          return fs.statSync(f).mtimeMs;
        } catch {
          return 0;
        }
      })
      .join();
  if (stamp !== versionCache.k) {
    const hash = crypto.createHash('sha1');
    for (const f of files) {
      try {
        hash.update(fs.readFileSync(f));
      } catch {}
    }
    versionCache = { k: stamp, v: hash.digest('hex').slice(0, 12) };
  }
  return versionCache.v;
}

// ---------- Statische Dateien (gzip + ETag, im Speicher gehalten) ----------
// Dateitypen der ausgelieferten Dateien
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml'
};
// Dateien im Speicher: { Zeitstempel, Inhalt, gzip, ETag, csp }
const staticCache = new Map();
/**
 * Content-Security-Policy der Oberfläche: nur eigene Dateien, Skripte nur mit Hash (die zwei Skripte in index.html werden hier aus dem
 * ausgelieferten Text berechnet – ein eingeschleuster Text könnte also nichts ausführen), keine Einbettung in fremde Seiten, keine Plugins.
 * Stile dürfen inline stehen (die Oberfläche setzt sie an Elementen).
 */
function contentSecurityPolicy(html) {
  const hashes = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
    if (!/\bsrc\s*=/i.test(m[1])) hashes.push(`'sha256-${crypto.createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
}
// Schutz-Header für jede Antwort (Seite, Dateien, API)
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), payment=(), usb=(), geolocation=(self)' // Standort braucht die Entfernungs-Sortierung
};
/**
 * Liefert eine Datei aus public/ (nur dort – kein Ausbrechen per „..“). Inhalte liegen im Speicher, mit gzip und ETag
 * (304 bei unverändert). In index.html wird __APPVER__ durch die aktuelle Version ersetzt.
 */
function serveStatic(req, res, url) {
  let relative;
  try {
    relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  } catch {
    res.writeHead(400); // z. B. „%E0%A4%A“: kein gültiger Pfad
    return res.end('Ungültige Adresse');
  }
  const file = path.normalize(path.join(PUBLIC_DIR, relative));
  let fileStat;
  try {
    fileStat = fs.statSync(file);
  } catch {
    fileStat = null;
  }
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fileStat || !fileStat.isFile()) {
    res.writeHead(404);
    return res.end('Nicht gefunden');
  }
  let entry = staticCache.get(file);
  const isHtml = path.extname(file) === '.html',
    version = isHtml ? appVersion() : '';
  if (!entry || entry.m !== fileStat.mtimeMs || entry.ver !== version) {
    // HTML trägt die Versionsnummer -> bei neuer Version neu aufbauen
    const ext = path.extname(file),
      raw = fs.readFileSync(file),
      buf = isHtml ? Buffer.from(raw.toString('utf8').replace(/__APPVER__/g, version)) : raw;
    entry = {
      m: fileStat.mtimeMs,
      ver: version,
      buf,
      type: MIME[ext] || 'application/octet-stream',
      etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"',
      gz: ext === '.png' || ext === '.woff2' ? null : zlib.gzipSync(buf), // schon komprimiert
      csp: isHtml ? contentSecurityPolicy(buf.toString('utf8')) : null
    };
    staticCache.set(file, entry);
  }
  if (entry.csp) res.setHeader('Content-Security-Policy', entry.csp);
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, { ETag: entry.etag });
    return res.end();
  }
  const useGzip = entry.gz && acceptsGzip(req);
  res.writeHead(200, {
    'Content-Type': entry.type,
    ETag: entry.etag,
    // Schriften und die Excel-Bibliothek ändern sich praktisch nie: einen Tag ohne Nachfrage; alles andere bei jedem Aufruf prüfen (ETag)
    'Cache-Control': /^\/(fonts|vendor)\//.test(url.pathname) ? 'public, max-age=86400' : 'no-cache',
    Vary: 'Accept-Encoding',
    ...(useGzip ? { 'Content-Encoding': 'gzip' } : {})
  });
  res.end(useGzip ? entry.gz : entry.buf);
}

// Einstieg jeder Anfrage: /api/… -> handleApi, sonst Datei; Fehler { code, msg } werden zu JSON-Antworten
const requestHandler = async (req, res) => {
  // Eine kaputte Adresse (z. B. „//[“) darf nie den Server beenden: new URL wirft, und eine Ausnahme außerhalb von try
  // wäre in dieser async-Funktion eine unbehandelte Ablehnung (Node beendet dann den Prozess)
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    res.writeHead(400, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
    return res.end('Ungültige Anfrage');
  }
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (TLS) res.setHeader('Strict-Transport-Security', 'max-age=15552000'); // 180 Tage: Browser nutzen dann nur noch https://
  try {
    url.pathname.startsWith('/api/') ? await handleApi(req, res, url) : serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent)
      sendJson(req, res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.msg || 'Serverfehler' });
    else res.end();
    if (!e.code) console.error(e);
  }
};

// ---------- HTTP oder HTTPS ----------
// HTTPS direkt mit Node: TLS_CERT + TLS_KEY (PEM-Dateien) oder TLS_PFX (.pfx/.p12, z. B. von der IT), Passwort in TLS_PASS
const { TLS_CERT, TLS_KEY, TLS_PFX, TLS_PASS } = process.env,
  TLS = !!(TLS_PFX || (TLS_CERT && TLS_KEY));
// Dateien des Zertifikats (für die Prüfung auf Erneuerung)
const tlsFiles = () => (TLS_PFX ? [TLS_PFX] : [TLS_CERT, TLS_KEY]);
// Zertifikat + Schlüssel (oder .pfx) von der Platte lesen
const tlsOpts = () =>
  TLS_PFX
    ? { pfx: fs.readFileSync(TLS_PFX), passphrase: TLS_PASS }
    : { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY), passphrase: TLS_PASS };
// Server starten; ohne Zertifikat läuft er als HTTP
let server;
try {
  server = TLS ? https.createServer(tlsOpts(), requestHandler) : http.createServer(requestHandler);
} catch (e) {
  console.error(`Zertifikat konnte nicht geladen werden (${tlsFiles().join(', ')}): ${e.message}`);
  process.exit(1);
}
server.on('error', e => {
  console.error(
    e.code === 'EADDRINUSE'
      ? `Port ${PORT} ist schon belegt.`
      : e.code === 'EACCES'
        ? `Keine Berechtigung für Port ${PORT}.`
        : e.message
  );
  process.exit(1);
});
server.listen(PORT, HOST, () =>
  console.log(
    `Läuft auf ${TLS ? 'https' : 'http'}://localhost:${PORT}  (Daten: ${path.join(DATA_DIR, 'data.db')}, ${JOURNAL}/synchronous=${SYNCHRONOUS}, ${db.prepare('PRAGMA synchronous').get().synchronous === 1 ? 'NORMAL aktiv' : 'FULL aktiv'})`
  )
);
geocodeKick(2000); // Adressen, für die noch Koordinaten fehlen (z. B. nach dem ersten Start oder Neustart während der Abfrage)
if (TLS) {
  // erneuertes Zertifikat (z. B. Let's Encrypt, IT) ohne Neustart übernehmen: stündlich prüfen
  const stamp = () =>
    tlsFiles()
      .map(f => {
        try {
          return fs.statSync(f).mtimeMs;
        } catch {
          return 0;
        }
      })
      .join();
  let last = stamp();
  setInterval(() => {
    const now = stamp();
    if (now === last) return;
    try {
      server.setSecureContext(tlsOpts());
      last = now;
      console.log('Neues Zertifikat übernommen.');
    } catch (e) {
      console.error('Neues Zertifikat fehlerhaft, altes bleibt aktiv:', e.message);
    }
  }, 3600e3).unref();
  // optional: Aufrufe über http:// auf https:// umleiten (HTTP_REDIRECT_PORT, z. B. 80)
  const RP = +process.env.HTTP_REDIRECT_PORT;
  if (RP)
    http
      .createServer((req, res) => {
        const host = String(req.headers.host || 'localhost').replace(/:\d+$/, '');
        res.writeHead(301, { Location: `https://${host}${PORT === 443 ? '' : ':' + PORT}${req.url}` });
        res.end();
      })
      .on('error', e => console.error(`Umleitung auf Port ${RP} nicht möglich: ${e.message}`))
      .listen(RP, HOST);
}
