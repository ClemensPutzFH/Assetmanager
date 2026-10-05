/* =================================================================================================
 * Excel-Worker: liest und schreibt Excel-Dateien im Hintergrund (Web Worker), damit die Oberfläche nicht einfriert.
 * Die Oberfläche (index.html, runExcelWorker) schickt je Aufgabe eine Nachricht { type, … } und bekommt
 * { res } oder { error } zurück:
 *   type 'orders'  { buf }          -> { rows: Aufträge, skip: Zeilen ohne Team }      (Aufträge-Excel hochladen)
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
  plz: ['postleitzahl'],
  str: ['straße', 'strasse'],
  kurz: ['kurztext'],
  start: ['eckstarttermin'],
  ende: ['eckendtermin']
};
// Excel-Datumszahl -> „TT.MM.JJJJ“ (UTC); alles andere bleibt Text
const formatExcelDate = v =>
  typeof v === 'number' && v > 20000
    ? new Date(Math.round((v - 25569) * 864e5)).toLocaleDateString('de-AT', { timeZone: 'UTC' })
    : String(v || '').trim();
// liest alle Blätter einer Excel-Datei als Zeilen (Arrays), leere Zellen = ''
const readSheets = buf => {
  const wb = XLSX.read(buf, { type: 'array' });
  return wb.SheetNames.map(n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }));
};

/**
 * Aufträge aus der Excel lesen. Die Kopfzeile (innerhalb der ersten 10 Zeilen) braucht „Auftrag“ und „Verantw.ArbPl.“.
 * Zeilen ohne Team werden gezählt (skip) und nicht übernommen.
 */
function parseOrders(buf) {
  const out = [];
  let skip = 0;
  for (const rows of readSheets(buf)) {
    const headerRow = rows
      .slice(0, 10)
      .findIndex(
        r =>
          r.some(c => normalizeHeader(c) === 'auftrag') && r.some(c => normalizeHeader(c) === 'verantwarbpl')
      );
    if (headerRow < 0) continue;
    const columnIndex = {};
    for (const k in ORDER_COLUMNS)
      columnIndex[k] = rows[headerRow].findIndex(c => ORDER_COLUMNS[k].includes(normalizeHeader(c)));
    for (const r of rows.slice(headerRow + 1)) {
      const g = k => (columnIndex[k] < 0 ? '' : r[columnIndex[k]]),
        s = k => String(g(k)).replace(/\s+/g, ' ').trim();
      const o = {
        auftrag: normalizeOrderNo(g('auftrag')),
        team: s('team'),
        tp: s('tp'),
        art: s('art'),
        plz: s('plz'),
        str: s('str'),
        kurz: s('kurz'),
        start: formatExcelDate(g('start')),
        ende: formatExcelDate(g('ende'))
      };
      if (!o.auftrag) continue;
      if (!o.team) skip++;
      else out.push(o);
    }
  }
  return { rows: out, skip };
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
  const { type, buf, A, P, dc, tc } = e.data;
  try {
    const res =
      type === 'orders'
        ? parseOrders(buf)
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
