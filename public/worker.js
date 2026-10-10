/* =================================================================================================
 * Excel-Worker: liest und schreibt Excel-Dateien im Hintergrund (Web Worker), damit die Oberfläche nicht einfriert.
 * Die Oberfläche (index.html, runExcelWorker) schickt je Aufgabe eine Nachricht { type, … } und bekommt
 * { res } oder { error } zurück:
 *   type 'orders'  { bufs, wanted } -> { rows, skip, hasLart }                          (Aufträge-, Vorgänge- oder Meldungen-Excel
 *                                       hochladen; wanted = 'auftraege' | 'vorgaenge' | 'meldungen', siehe parseSource)
 *   type 'pruef'   { buf }          -> { by: { Auftrag: [Kurztexte] } }                (Prüflos-Excel hochladen)
 *   type 'cmp'     { buf }          -> { rows, hasStatus }                             (Vergleich Excel <-> Export)
 *   type 'sheets'  { sheets: [{ name, rows, dt }] } -> ArrayBuffer der fertigen .xlsx (beliebige Tabellen; dt = Spalten mit Datum und Uhrzeit,
 *                                       z. B. Bestätigungen der Chat-Nachrichten)
 *   sonst          { A, P, dc, tc, E } -> ArrayBuffer der fertigen .xlsx                (Export; E = Tageseinträge der Daueraufträge)
 * ================================================================================================= */
importScripts('/vendor/xlsx.full.min.js');
// Spaltenüberschrift vereinheitlichen: Kleinbuchstaben, nur a–z, 0–9 und äöüß („Verantw.ArbPl.“ -> „verantwarbpl“)
const normalizeHeader = s =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]/g, '');
// Auftragsnummer vereinheitlichen: Leerzeichen und führende Nullen entfernen
const normalizeOrderNo = v =>
  String(v ?? '')
    .trim()
    .replace(/^0+/, '');
// gesuchte Spalten der Aufträge-Excel (normalisierte Überschriften); „Verantw.ArbPl.“ ist das Team
const ORDER_COLUMNS = {
  auftrag: ['auftrag'],
  team: ['verantwarbpl'],
  tp: ['technplatz'],
  art: ['auftragsart'],
  lart: ['ihleistungsart'],
  plz: ['postleitzahl'],
  str: ['straße', 'strasse'],
  kurz: ['kurztext'],
  start: ['eckstarttermin', 'termstart'],
  ende: ['eckendtermin', 'termende'],
  mel: ['meldung']
};
// Spalten der Vorgänge-Excel: je Zeile ein Vorgang eines Auftrags (Reparatur 3NAR, Entstörung 3NAE)
const VORGANG_COLUMNS = {
  auftrag: ['auftrag'],
  art: ['auftragsart'],
  start: ['eckstarttermin'],
  ende: ['eckendtermin'],
  kurz: ['kurztext'],
  vg: ['vorgang'],
  vtxt: ['kurztextvrg'],
  team: ['verantwarbpl'],
  lart: ['ihleistungsart'],
  vteam: ['vrgarbeitsplatz'],
  arb: ['arbeit'],
  uhr: ['iststartuzt'],
  uhr2: ['istendeuzt']
};
// Spalten der Meldungen-Excel: Schäden, die gemeldet wurden – mit oder ohne Auftrag
const MELDUNG_COLUMNS = {
  nr: ['meldung'],
  dat: ['angelegtam'],
  txt: ['beschreibung'],
  str: ['straße', 'strasse'],
  plz: ['postleitzahl'],
  auftrag: ['auftrag'],
  code: ['codiercodetxt'],
  tp: ['technplatz'],
  stat: ['anwenderstat'],
  team: ['verantwarbpl'],
  grp: ['codiergrptext']
};
// Excel-Datumszahl -> „TT.MM.JJJJ“ (UTC); alles andere bleibt Text
const formatExcelDate = v =>
  typeof v === 'number' && v > 20000
    ? new Date(Math.round((v - 25569) * 864e5)).toLocaleDateString('de-AT', { timeZone: 'UTC' })
    : String(v || '').trim();
// Uhrzeit -> „HH:MM“. Kommt als Text („13:17:40“) oder als Excel-Zeit (Bruchteil eines Tages). Leer und 00:00 = nicht gesetzt
// (SAP liefert für fehlende Zeiten 00:00:00).
const formatExcelTime = v => {
  let minutes = -1;
  if (typeof v === 'number' && v >= 0) minutes = Math.round((v % 1) * 1440);
  else {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? '').trim());
    if (m) minutes = +m[1] * 60 + +m[2];
  }
  if (minutes <= 0 || minutes >= 1440) return '';
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
};
// liest alle Blätter einer Excel-Datei als Zeilen (Arrays), leere Zellen = ''
const readSheets = buf => {
  const wb = XLSX.read(buf, { type: 'array' });
  return wb.SheetNames.map(n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }));
};
// Kopfzeile eines Blattes suchen (innerhalb der ersten 10 Zeilen): ok(Menge der normalisierten Überschriften) muss stimmen
const findHeader = (rows, ok) =>
  rows.slice(0, 10).findIndex(r => ok(new Set(r.map(normalizeHeader))));
// Spaltenindizes: Schlüssel -> Index der ersten passenden Überschrift (-1 = Spalte fehlt)
const columnsOf = (header, spec) => {
  const index = {};
  for (const k in spec) index[k] = header.findIndex(c => spec[k].includes(normalizeHeader(c)));
  return index;
};
// Zeilen eines Blattes als Objekte (Text bereinigt); Datum -> „TT.MM.JJJJ“, Uhrzeit -> „HH:MM“
const readRows = (rows, headerRow, spec, dates = [], times = []) => {
  const index = columnsOf(rows[headerRow], spec);
  return rows.slice(headerRow + 1).map(r => {
    const o = { _present: index };
    for (const k in spec) {
      const v = index[k] < 0 ? '' : r[index[k]];
      o[k] = dates.includes(k)
        ? formatExcelDate(v)
        : times.includes(k)
          ? formatExcelTime(v)
          : String(v ?? '')
              .replace(/\s+/g, ' ')
              .trim();
    }
    return o;
  });
};

/**
 * Kategorie („Auftragsart“ in der App) eines Auftrags nach SAP-Auftragsart und Leistungsart:
 *   war  Wartung     3NAW mit Leistungsart FWS (fehlt die Spalte „IH-Leistungsart“ ganz, gilt jeder 3NAW als Wartung – ältere Dateien)
 *   dau  Dauerauftrag 3NAW mit Leistungsart FWD
 *   rep  Reparatur   3NAR (jeder Vorgang ist in der App ein eigener Auftrag)
 *   ent  Entstörung  3NAE
 * Alle anderen (z. B. 3NAV, 3NIN, 3NBT, 3NAW mit anderer Leistungsart) gehören nicht dazu: '' .
 */
const SOURCE_NAMES = { auftraege: 'Aufträge', vorgaenge: 'Vorgänge', meldungen: 'Meldungen', pruef: 'Prüfobjekte' };
// Spalte „Kurztext des Prüfobjektes“ der Prüflos-Excel (auch „Kurztext Prüfobjekt …“). „Kurztext“ allein gibt es in jeder SAP-Datei
// (Aufträge, Vorgänge …) und genügt nicht: sonst würde eine Aufträge-Excel im Feld „Prüfobjekte“ als Prüflos gelesen
const isCheckText = h => /^kurztext(des)?prüf/.test(normalizeHeader(h));
// Fehler mit fertigem Text für die Anwenderin/den Anwender (z. B. „falsche Datei im Feld“): kommt ohne den Zusatz „Excel-Datei konnte nicht
// verarbeitet werden“ bei der Oberfläche an
const userError = message => Object.assign(new Error(message), { user: true });
/**
 * Art eines Blattes an seinen Spalten erkennen:
 *   vorgaenge   Spalten „Auftrag“ + „Vorgang“
 *   meldungen   Spalten „Meldung“ + „Beschreibung“
 *   auftraege   Spalten „Auftrag“ + „Verantw.ArbPl.“
 *   pruef       Spalten „Auftrag“ + „Kurztext des Prüfobjektes“ (zuletzt geprüft)
 * Ergebnis { type, header (Zeile der Kopfzeile) } oder null (keines davon).
 */
function detectSheet(rows) {
  for (const [type, ok] of [
    ['vorgaenge', s => s.has('auftrag') && s.has('vorgang')],
    ['meldungen', s => s.has('meldung') && s.has('beschreibung')],
    ['auftraege', s => s.has('auftrag') && s.has('verantwarbpl')],
    ['pruef', s => s.has('auftrag') && [...s].some(isCheckText)]
  ]) {
    const header = findHeader(rows, ok);
    if (header >= 0) return { type, header };
  }
  return null;
}
/**
 * Eine SAP-Excel lesen: wanted = welche Dateiart erwartet wird (Upload-Feld „Aufträge“, „Vorgänge“ oder „Meldungen“). Jede Datei steht für
 * sich; zusammengeführt wird erst auf dem Server (die Dateien kommen zu verschiedenen Zeiten und in beliebiger Reihenfolge).
 *   auftraege  -> rows [{ auftrag, team, tp, art, lart, plz, str, kurz, start, ende, mel }], hasLart (Spalte „IH-Leistungsart“ vorhanden),
 *                 skip (Zeilen ohne Team)
 *   vorgaenge  -> rows [{ auftrag, art, kurz, vg, vtxt, team (des Auftrags), vteam (Arbeitsplatz des Vorgangs), lart, start, ende, arb, uhr, uhr2 }]
 *   meldungen  -> rows [{ nr, dat, txt, str, plz, auftrag, code, tp, stat, team, grp }]
 * Passt kein Blatt, kommt ein Fehler, der sagt, was die Datei stattdessen ist (z. B. „das ist die Vorgänge-Excel“).
 */
function parseSource(bufs, wanted) {
  const rows = [],
    found = {};
  let skip = 0,
    hasLart = false;
  for (const buf of bufs)
    for (const sheet of readSheets(buf)) {
      const d = detectSheet(sheet);
      if (!d) continue;
      found[d.type] = (found[d.type] || 0) + 1;
      if (d.type !== wanted) continue;
      if (wanted === 'vorgaenge')
        for (const o of readRows(sheet, d.header, VORGANG_COLUMNS, ['start', 'ende'], ['uhr', 'uhr2'])) {
          o.auftrag = normalizeOrderNo(o.auftrag);
          if (o.auftrag) rows.push(o);
        }
      else if (wanted === 'meldungen')
        for (const o of readRows(sheet, d.header, MELDUNG_COLUMNS, ['dat'])) {
          o.nr = normalizeOrderNo(o.nr);
          o.auftrag = normalizeOrderNo(o.auftrag);
          if (o.nr) rows.push(o);
        }
      else {
        for (const o of readRows(sheet, d.header, ORDER_COLUMNS, ['start', 'ende'])) {
          o.auftrag = normalizeOrderNo(o.auftrag);
          o.mel = normalizeOrderNo(o.mel);
          if (!o.auftrag) continue;
          if (!o.team) skip++;
          else rows.push(o);
          hasLart = o._present.lart >= 0;
        }
      }
    }
  if (!found[wanted]) {
    const other = Object.keys(found).find(k => k !== wanted);
    throw userError(
      other
        ? `Das ist keine ${SOURCE_NAMES[wanted]}-Excel, sondern die ${SOURCE_NAMES[other]}-Excel – bitte im Feld „${SOURCE_NAMES[other]}“ hochladen.`
        : `Keine ${SOURCE_NAMES[wanted]} gefunden (nötige Spalten: ${{ auftraege: 'Auftrag + Verantw.ArbPl.', vorgaenge: 'Auftrag + Vorgang', meldungen: 'Meldung + Beschreibung' }[wanted]}).`
    );
  }
  return { rows: rows.map(({ _present, ...o }) => o), skip, hasLart };
}
/**
 * Prüfobjekte aus der Prüflos-Excel lesen: Spalten „Auftrag“ und „Kurztext des Prüfobjektes“.
 * Ergebnis: je Auftrag die Liste der Kurztexte in Dateireihenfolge.
 */
function parseChecklists(buf) {
  const by = {},
    found = {};
  let matched = false;
  for (const rows of readSheets(buf)) {
    const headerRow = rows.slice(0, 10).findIndex(r => r.some(c => normalizeHeader(c) === 'auftrag') && r.some(isCheckText));
    if (headerRow < 0) {
      const d = detectSheet(rows); // eine andere SAP-Datei? (für die Fehlermeldung unten)
      if (d) found[d.type] = true;
      continue;
    }
    matched = true;
    const orderCol = rows[headerRow].findIndex(c => normalizeHeader(c) === 'auftrag'),
      textCol = rows[headerRow].findIndex(isCheckText);
    for (const r of rows.slice(headerRow + 1)) {
      const a = normalizeOrderNo(r[orderCol]),
        t = String(r[textCol] ?? '')
          .replace(/\s+/g, ' ')
          .trim();
      if (a && t) (by[a] = by[a] || []).push(t);
    }
  }
  if (!matched) {
    const other = Object.keys(found)[0];
    throw userError(
      other
        ? `Das ist keine Prüfobjekte-Excel, sondern die ${SOURCE_NAMES[other]}-Excel – bitte im Feld „${SOURCE_NAMES[other]}“ hochladen.`
        : 'Keine Prüfobjekte gefunden (Spalten „Auftrag“ und „Kurztext des Prüfobjektes“ nötig).'
    );
  }
  return { by };
}
/**
 * Für den Vergleich (Disponent): liest Auftragsnummern samt Team, Kurztext und – falls vorhanden – „Abgehakt am“.
 * Die Aufträge-Excel hat diese Spalte nicht, der Export dieser App schon (hasStatus). Beim Export zählt nur das
 * Blatt mit dieser Spalte (das Blatt „Prüfobjekte“ wiederholt die Aufträge und würde sonst mitzählen).
 */
function parseForComparison(buf) {
  const sheetsData = [];
  let hasStatus = false;
  for (const rows of readSheets(buf)) {
    const headerRow = rows.slice(0, 10).findIndex(r => r.some(c => normalizeHeader(c) === 'auftrag'));
    if (headerRow < 0) continue;
    const header = rows[headerRow],
      ix = n => header.findIndex(c => normalizeHeader(c) === n);
    const orderCol = ix('auftrag'),
      markCol = ix('abgehaktam'),
      teamCol = header.findIndex(c => normalizeHeader(c).endsWith('verantwarbpl')),
      textCol = ix('kurztext');
    if (markCol >= 0) hasStatus = true;
    const s = k =>
      String(k ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    sheetsData.push({
      st: markCol >= 0,
      rows: rows
        .slice(headerRow + 1)
        .map(r => ({
          auftrag: normalizeOrderNo(r[orderCol]),
          team: teamCol < 0 ? '' : s(r[teamCol]),
          kurz: textCol < 0 ? '' : s(r[textCol]),
          hak: markCol < 0 ? '' : s(r[markCol])
        }))
        .filter(o => o.auftrag)
    });
  }
  const out = new Map();
  for (const x of sheetsData) if (x.st === hasStatus) for (const o of x.rows) out.set(o.auftrag, o);
  return { rows: [...out.values()], hasStatus };
}
// Tabelle aus Zeilen (Kopfzeile in Zeile 1): dc / tc = Spalte mit Datum bzw. Uhrzeit, dt = Spalten mit Datum und Uhrzeit (echte Excel-Formate
// dd.mm.yyyy / hh:mm / dd.mm.yyyy hh:mm:ss), Spaltenbreite nach Inhalt (höchstens 60; Datum mit Uhrzeit 21), Autofilter über alle Spalten
function makeSheet(aoa, dc = -1, tc = -1, dt = []) {
  const ws = XLSX.utils.aoa_to_sheet(aoa),
    format = (c, z) => {
      for (let i = 1; i < aoa.length; i++) {
        const a = XLSX.utils.encode_cell({ r: i, c });
        if (ws[a] && ws[a].t === 'n') ws[a].z = z;
      }
    };
  if (dc >= 0) format(dc, 'dd.mm.yyyy');
  if (tc >= 0) format(tc, 'hh:mm');
  for (const c of dt) format(c, 'dd.mm.yyyy hh:mm:ss');
  ws['!cols'] = aoa[0].map((h, c) => {
    let m = String(h).length;
    if (dt.includes(c)) m = Math.max(m, 19);
    else for (let i = 1; i < Math.min(aoa.length, 500); i++) m = Math.max(m, String(aoa[i][c] ?? '').length);
    return { wch: Math.min(60, m + 2) };
  });
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } })
  };
  return ws;
}
// Datei aus beliebigen Blättern: [{ name, rows, dt }] (siehe makeSheet)
function buildSheets(sheets) {
  const workbook = XLSX.utils.book_new();
  for (const sh of sheets) XLSX.utils.book_append_sheet(workbook, makeSheet(sh.rows, -1, -1, sh.dt || []), sh.name);
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
}
/**
 * Erzeugt die Export-Datei: Blatt „Aufträge“ (A) und Blatt „Prüfobjekte“ (P) als Tabellen mit Kopfzeile in Zeile 1.
 * dc / tc = Spaltenindex der Datums- bzw. Uhrzeit-Spalte in A (bekommen echte Excel-Formate dd.mm.yyyy / hh:mm).
 */
function buildExport(A, P, dc, tc, E) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, makeSheet(A, dc, tc), 'Aufträge');
  XLSX.utils.book_append_sheet(workbook, makeSheet(P), 'Prüfobjekte');
  // Tageseinträge der Daueraufträge (Datum Spalte 3, Uhrzeit Spalte 4)
  if (E) XLSX.utils.book_append_sheet(workbook, makeSheet(E, 3, 4), 'Zeiteinträge');
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
}
// Nachricht der Oberfläche verarbeiten; große Ergebnisse (ArrayBuffer) werden ohne Kopie übergeben
onmessage = e => {
  const { type, buf, bufs, A, P, dc, tc, E } = e.data;
  try {
    const res =
      type === 'orders'
        ? parseSource(bufs || [buf], e.data.wanted)
        : type === 'pruef'
          ? parseChecklists(buf)
          : type === 'cmp'
            ? parseForComparison(buf)
            : type === 'sheets'
              ? buildSheets(e.data.sheets)
              : buildExport(A, P, dc, tc, E);
    const tr =
      res instanceof ArrayBuffer ? [res] : res && res.buffer instanceof ArrayBuffer ? [res.buffer] : [];
    postMessage({ res }, tr);
  } catch (err) {
    postMessage({ error: err.user ? err.message : 'Excel-Datei konnte nicht verarbeitet werden: ' + (err.message || err) });
  }
};
