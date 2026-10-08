/* =================================================================================================
 * Excel-Worker: liest und schreibt Excel-Dateien im Hintergrund (Web Worker), damit die Oberfläche nicht einfriert.
 * Die Oberfläche (index.html, runExcelWorker) schickt je Aufgabe eine Nachricht { type, … } und bekommt
 * { res } oder { error } zurück:
 *   type 'orders'  { bufs }         -> { rows: Aufträge, meldungen, skip, ignored, files } (Aufträge-, Vorgänge- und Meldungen-Excel
 *                                       hochladen; jede Datei wird an ihren Spalten erkannt, siehe parseOrderFiles)
 *   type 'pruef'   { buf }          -> { by: { Auftrag: [Kurztexte] } }                (Prüflos-Excel hochladen)
 *   type 'cmp'     { buf }          -> { rows, hasStatus }                             (Vergleich Excel <-> Export)
 *   sonst          { A, P, dc, tc } -> ArrayBuffer der fertigen .xlsx                  (Export)
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
const kindOf = (art, lart, hasLart) => {
  art = art.toUpperCase();
  if (art === '3NAW') return !hasLart || lart === 'FWS' ? 'war' : lart === 'FWD' ? 'dau' : '';
  return art === '3NAR' ? 'rep' : art === '3NAE' ? 'ent' : '';
};

/**
 * Aufträge aus einer oder mehreren Excel-Dateien lesen. Jede Datei wird an ihren Spalten erkannt (auch mehrere Blätter):
 *   Vorgänge   Spalten „Auftrag“ + „Vorgang“           -> je Vorgang eine Zeile (3NAR/3NAE)
 *   Meldungen  Spalten „Meldung“ + „Beschreibung“      -> Schäden, mit oder ohne Auftrag
 *   Aufträge   Spalten „Auftrag“ + „Verantw.ArbPl.“    -> ein Auftrag je Zeile
 * Zusammengeführt wird zu den Einheiten der App (rows):
 *   · Wartung, Dauerauftrag, Entstörung: ein Eintrag je Auftrag (Schlüssel = Auftragsnummer)
 *   · Reparatur: ein Eintrag je Vorgang (Schlüssel = „Auftragsnummer-Vorgang“, Team = Arbeitsplatz des Vorgangs)
 * Ohne Vorgänge-Datei bleibt ein Reparaturauftrag ein Eintrag je Auftrag. Aufträge anderer Auftragsarten werden übergangen (ignored:
 * Auftragsart -> Anzahl), Zeilen ohne Team gezählt (skip). files = was in den Dateien gefunden wurde.
 */
function parseOrderFiles(bufs) {
  const orders = new Map(),
    steps = [],
    meldungen = new Map(),
    ignored = {};
  let skip = 0;
  const files = { orders: 0, vorgaenge: 0, meldungen: 0 };
  for (const buf of bufs)
    for (const rows of readSheets(buf)) {
      let h = findHeader(rows, s => s.has('auftrag') && s.has('vorgang'));
      if (h >= 0) {
        for (const o of readRows(rows, h, VORGANG_COLUMNS, ['start', 'ende'], ['uhr', 'uhr2'])) {
          o.auftrag = normalizeOrderNo(o.auftrag);
          if (o.auftrag) steps.push(o);
        }
        files.vorgaenge++;
        continue;
      }
      h = findHeader(rows, s => s.has('meldung') && s.has('beschreibung'));
      if (h >= 0) {
        for (const o of readRows(rows, h, MELDUNG_COLUMNS, ['dat'])) {
          o.nr = normalizeOrderNo(o.nr);
          o.auftrag = normalizeOrderNo(o.auftrag);
          if (o.nr) meldungen.set(o.nr, o);
        }
        files.meldungen++;
        continue;
      }
      h = findHeader(rows, s => s.has('auftrag') && s.has('verantwarbpl'));
      if (h < 0) continue;
      for (const o of readRows(rows, h, ORDER_COLUMNS, ['start', 'ende'])) {
        o.auftrag = normalizeOrderNo(o.auftrag);
        o.mel = normalizeOrderNo(o.mel);
        if (!o.auftrag) continue;
        if (!o.team) skip++;
        else orders.set(o.auftrag, o);
      }
      files.orders++;
    }
  // Vorgänge je Auftrag (nach Vorgangsnummer)
  const stepsOf = new Map();
  for (const v of steps) (stepsOf.get(v.auftrag) || stepsOf.set(v.auftrag, []).get(v.auftrag)).push(v);
  for (const l of stepsOf.values()) l.sort((a, b) => a.vg.localeCompare(b.vg, 'de', { numeric: true }));
  // Aufträge, die nur in der Vorgänge-Datei stehen, werden aus ihr aufgebaut (ohne Adresse)
  for (const [nr, l] of stepsOf)
    if (!orders.has(nr)) {
      const v = l[0];
      if (v.team) orders.set(nr, { auftrag: nr, team: v.team, art: v.art, lart: v.lart, kurz: v.kurz, start: v.start, ende: v.ende, _present: { lart: 0 } });
    }
  const rows = [];
  for (const o of orders.values()) {
    const kind = kindOf(o.art, o.lart, o._present.lart >= 0);
    if (!kind) {
      ignored[o.art || '?'] = (ignored[o.art || '?'] || 0) + 1;
      continue;
    }
    const base = {
      kind,
      nr: o.auftrag,
      vg: '',
      vtxt: '',
      lart: o.lart || '',
      art: o.art,
      tp: o.tp || '',
      plz: o.plz || '',
      str: o.str || '',
      kurz: o.kurz,
      mel: o.mel || ''
    };
    const l = stepsOf.get(o.auftrag) || [];
    if (kind === 'rep' && l.length)
      for (const v of l)
        rows.push({
          ...base,
          auftrag: o.auftrag + '-' + v.vg,
          vg: v.vg,
          vtxt: v.vtxt,
          team: v.vteam || o.team,
          start: v.start || o.start || '',
          ende: v.ende || '',
          uhr: v.uhr,
          uhr2: v.uhr2,
          arb: v.arb
        });
    else {
      // Entstörung: Beginn laut erstem, Ende laut letztem Vorgang
      const first = l[0],
        last = l[l.length - 1];
      rows.push({
        ...base,
        auftrag: o.auftrag,
        vtxt: (first && first.vtxt) || '',
        team: o.team,
        start: (first && first.start) || o.start || '',
        ende: (last && last.ende) || o.ende || '',
        uhr: (first && first.uhr) || '',
        uhr2: (last && last.uhr2) || '',
        arb: first ? l.reduce((a, v) => a + (+v.arb || 0), 0) : ''
      });
    }
  }
  return {
    rows,
    meldungen: [...meldungen.values()].map(({ _present, ...m }) => m),
    skip,
    ignored,
    files
  };
}
/**
 * Prüfobjekte aus der Prüflos-Excel lesen: Spalten „Auftrag“ und „Kurztext des Prüfobjektes“.
 * Ergebnis: je Auftrag die Liste der Kurztexte in Dateireihenfolge.
 */
function parseChecklists(buf) {
  const by = {};
  for (const rows of readSheets(buf)) {
    const headerRow = rows
      .slice(0, 10)
      .findIndex(
        r =>
          r.some(c => normalizeHeader(c) === 'auftrag') &&
          r.some(c => normalizeHeader(c).startsWith('kurztext'))
      );
    if (headerRow < 0) continue;
    const orderCol = rows[headerRow].findIndex(c => normalizeHeader(c) === 'auftrag'),
      textCol = rows[headerRow].findIndex(c => normalizeHeader(c).startsWith('kurztext'));
    for (const r of rows.slice(headerRow + 1)) {
      const a = normalizeOrderNo(r[orderCol]),
        t = String(r[textCol] ?? '')
          .replace(/\s+/g, ' ')
          .trim();
      if (a && t) (by[a] = by[a] || []).push(t);
    }
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
/**
 * Erzeugt die Export-Datei: Blatt „Aufträge“ (A) und Blatt „Prüfobjekte“ (P) als Tabellen mit Kopfzeile in Zeile 1.
 * dc / tc = Spaltenindex der Datums- bzw. Uhrzeit-Spalte in A (bekommen echte Excel-Formate dd.mm.yyyy / hh:mm).
 */
function buildExport(A, P, dc, tc) {
  // Tabelle aus Zeilen: Datums-/Uhrzeitformat, Spaltenbreite nach Inhalt (höchstens 60), Autofilter über alle Spalten
  const makeSheet = (aoa, dc = -1, tc = -1) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (dc >= 0)
      for (let i = 1; i < aoa.length; i++) {
        const a = XLSX.utils.encode_cell({ r: i, c: dc });
        if (ws[a] && ws[a].t === 'n') ws[a].z = 'dd.mm.yyyy';
      }
    if (tc >= 0)
      for (let i = 1; i < aoa.length; i++) {
        const a = XLSX.utils.encode_cell({ r: i, c: tc });
        if (ws[a] && ws[a].t === 'n') ws[a].z = 'hh:mm';
      }
    ws['!cols'] = aoa[0].map((h, c) => {
      let m = String(h).length;
      for (let i = 1; i < Math.min(aoa.length, 500); i++) m = Math.max(m, String(aoa[i][c] ?? '').length);
      return { wch: Math.min(60, m + 2) };
    });
    ws['!autofilter'] = {
      ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } })
    };
    return ws;
  };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, makeSheet(A, dc, tc), 'Aufträge');
  XLSX.utils.book_append_sheet(workbook, makeSheet(P), 'Prüfobjekte');
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
}
// Nachricht der Oberfläche verarbeiten; große Ergebnisse (ArrayBuffer) werden ohne Kopie übergeben
onmessage = e => {
  const { type, buf, bufs, A, P, dc, tc } = e.data;
  try {
    const res =
      type === 'orders'
        ? parseOrderFiles(bufs || [buf])
        : type === 'pruef'
          ? parseChecklists(buf)
          : type === 'cmp'
            ? parseForComparison(buf)
            : buildExport(A, P, dc, tc);
    const tr =
      res instanceof ArrayBuffer ? [res] : res && res.buffer instanceof ArrayBuffer ? [res.buffer] : [];
    postMessage({ res }, tr);
  } catch (err) {
    postMessage({ error: 'Excel-Datei konnte nicht verarbeitet werden: ' + (err.message || err) });
  }
};
