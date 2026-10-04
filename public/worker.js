// Excel lesen und schreiben im Hintergrund (Web Worker), damit die Oberfläche nicht einfriert
importScripts('/vendor/xlsx.full.min.js');
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
const an = v => String(v ?? '').trim().replace(/^0+/, '');
const COLS = { auftrag: ['auftrag'], team: ['verantwarbpl'], tp: ['technplatz'], art: ['auftragsart'], plz: ['postleitzahl'], str: ['straße', 'strasse'], kurz: ['kurztext'], start: ['eckstarttermin'], ende: ['eckendtermin'] };
const dt = v => typeof v === 'number' && v > 20000 ? new Date(Math.round((v - 25569) * 864e5)).toLocaleDateString('de-AT', { timeZone: 'UTC' }) : String(v || '').trim();
const sheets = buf => { const wb = XLSX.read(buf, { type: 'array' }); return wb.SheetNames.map(n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' })); };

function orders(buf) {
  const out = []; let skip = 0;
  for (const rows of sheets(buf)) {
    const hi = rows.slice(0, 10).findIndex(r => r.some(c => norm(c) === 'auftrag') && r.some(c => norm(c) === 'verantwarbpl'));
    if (hi < 0) continue;
    const ix = {}; for (const k in COLS) ix[k] = rows[hi].findIndex(c => COLS[k].includes(norm(c)));
    for (const r of rows.slice(hi + 1)) {
      const g = k => ix[k] < 0 ? '' : r[ix[k]], s = k => String(g(k)).replace(/\s+/g, ' ').trim();
      const o = { auftrag: an(g('auftrag')), team: s('team'), tp: s('tp'), art: s('art'), plz: s('plz'), str: s('str'), kurz: s('kurz'), start: dt(g('start')), ende: dt(g('ende')) };
      if (!o.auftrag) continue;
      if (!o.team) skip++; else out.push(o);
    }
  }
  return { rows: out, skip };
}
function pruef(buf) {
  const by = {};
  for (const rows of sheets(buf)) {
    const hi = rows.slice(0, 10).findIndex(r => r.some(c => norm(c) === 'auftrag') && r.some(c => norm(c).startsWith('kurztext')));
    if (hi < 0) continue;
    const ia = rows[hi].findIndex(c => norm(c) === 'auftrag'), ik = rows[hi].findIndex(c => norm(c).startsWith('kurztext'));
    for (const r of rows.slice(hi + 1)) {
      const a = an(r[ia]), t = String(r[ik] ?? '').replace(/\s+/g, ' ').trim();
      if (a && t) (by[a] = by[a] || []).push(t);
    }
  }
  return { by };
}
function xlsx(A, P, dc, tc) {
  const mk = (aoa, dc = -1, tc = -1) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (dc >= 0) for (let i = 1; i < aoa.length; i++) { const a = XLSX.utils.encode_cell({ r: i, c: dc }); if (ws[a] && ws[a].t === 'n') ws[a].z = 'dd.mm.yyyy'; }
    if (tc >= 0) for (let i = 1; i < aoa.length; i++) { const a = XLSX.utils.encode_cell({ r: i, c: tc }); if (ws[a] && ws[a].t === 'n') ws[a].z = 'hh:mm'; }
    ws['!cols'] = aoa[0].map((h, c) => { let m = String(h).length; for (let i = 1; i < Math.min(aoa.length, 500); i++) m = Math.max(m, String(aoa[i][c] ?? '').length); return { wch: Math.min(60, m + 2) }; });
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) };
    return ws;
  };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, mk(A, dc, tc), 'Aufträge');
  XLSX.utils.book_append_sheet(wb, mk(P), 'Prüfobjekte');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}
onmessage = e => {
  const { type, buf, A, P, dc, tc } = e.data;
  try {
    const res = type === 'orders' ? orders(buf) : type === 'pruef' ? pruef(buf) : xlsx(A, P, dc, tc);
    const tr = res instanceof ArrayBuffer ? [res] : res && res.buffer instanceof ArrayBuffer ? [res.buffer] : [];
    postMessage({ res }, tr);
  } catch (err) { postMessage({ error: 'Excel-Datei konnte nicht verarbeitet werden: ' + (err.message || err) }); }
};
