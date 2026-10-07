#!/usr/bin/env node
/* =================================================================================================
 * UI-Stabilitätstest: die Anzeige darf nirgends springen, Animationen dürfen nichts verschieben.
 *
 * Starten:  npm run test:ui          (Dauer etwa 2 Minuten, Exit-Code 1 bei Fehlern)
 * Voraussetzung: Playwright mit Chromium (npm i -D playwright && npx playwright install chromium – oder global installiert;
 *   CHROME_PATH=/pfad/zu/chrome nimmt einen vorhandenen Browser). Der Server läuft mit einer KOPIE von data/data.db auf einem
 *   freien Port; die echten Daten bleiben unverändert.
 *
 * Jede Prüfung führt eine Bedienung aus (tippen, tippen im Suchfeld …) und misst danach Bild für Bild (requestAnimationFrame):
 *   · Das angetippte Bedienelement (bzw. sein data-k-Bereich) bleibt an derselben Bildschirmstelle (±3 px, kein Ruck > 12 px).
 *   · „Sprung“: ein Element, das still steht, springt in einem Bild um ≥ 24 px und steht danach wieder still. Echte Animationen
 *     laufen über mehrere Bilder und zählen nicht. (Bei Schrift- und Ansichtswechseln ändert sich absichtlich alles: reflow.)
 *   · Die Seite wird nie breiter als der Bildschirm (sonst lässt sie sich seitlich verschieben und wackelt).
 *   · Keine JavaScript-Fehler.
 * Dazu Einzelprüfungen (Dunkelmodus, Suche, Scroll-Stelle bleibt erhalten, Formulare erscheinen sichtbar, Live-Update).
 *
 * NEUE BEDIENUNG? Eine Prüfung dafür unten ergänzen (siehe Abschnitt „Prüfungen“) und den Test ausführen.
 * ================================================================================================= */
const { spawn, execSync } = require('child_process'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  net = require('net');

const ROOT = path.join(__dirname, '..'),
  MONTEUR = { user: process.env.TEST_USER || '33NX', password: process.env.MONTEUR_PASSWORD || 'Fernwärme1' },
  DISPO_PIN = process.env.DISPO_PIN || '2510';

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    try {
      return require(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'));
    } catch (e2) {
      console.error('Playwright fehlt: npm i -D playwright && npx playwright install chromium');
      process.exit(2);
    }
  }
}
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    for (const d of fs.readdirSync(base).sort().reverse())
      if (/^chromium-\d+$/.test(d)) {
        const p = path.join(base, d, 'chrome-linux', 'chrome');
        if (fs.existsSync(p)) return p;
      }
  } catch (e) {}
  return undefined; // Playwright-Standard
}
const freePort = () =>
  new Promise(resolve => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---------- Server mit Kopie der Daten ----------
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-test-')),
    port = await freePort();
  for (const f of ['data.db', 'data.db-wal', 'data.db-shm'])
    if (fs.existsSync(path.join(ROOT, 'data', f))) fs.copyFileSync(path.join(ROOT, 'data', f), path.join(dir, f));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, DISPO_PIN, UPLOAD_PIN: '1025', MONTEUR_PASSWORD: MONTEUR.password },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server startet nicht')), 20000);
    child.stdout.on('data', d => /Läuft auf/.test(String(d)) && (clearTimeout(t), resolve()));
    child.on('exit', c => reject(new Error('Server beendet (' + c + ')')));
  });
  return { port, dir, stop: () => (child.kill(), fs.rmSync(dir, { recursive: true, force: true })) };
}

// ---------- Messung ----------
const SEL = 'button, .card, .it, .li, h1, h2, input, select, textarea, .chip, .tabs, .msg, [data-k], th, tr, label, .row, summary, .fzg, .tag';
const failures = [];
let passed = 0;
const report = (ok, name, detail = '') => {
  if (ok) passed++;
  else failures.push(name + (detail ? ' – ' + detail : ''));
  console.log(`${ok ? '  ok  ' : 'FEHLER'} ${name}${detail ? '  → ' + detail : ''}`);
};

/**
 * Führt eine Bedienung aus und prüft die Stabilität (siehe Kopf der Datei).
 *  target: JS-Quelltext einer Funktion, die das anzutippende Element liefert · act: optional, Funktion (el) => … statt el.click()
 *  at: Element vorher auf diese Bildschirmhöhe scrollen (wie ein Nutzer, der dorthin gescrollt hat) · scroll: feste Scroll-Stelle
 *  reflow: es ändert sich absichtlich alles (Schrift, Ansichtswechsel) – dann keine Sprung-Prüfung, nur das angetippte Element
 *  smooth: CSS-Selektor eines Elements, das sich durch die Bedienung verschiebt (z. B. der Inhalt unter einem Hinweis, der
 *    verschwindet): die Verschiebung muss sich über mehrere Bilder verteilen und darf nicht in einem Bild geschehen. (Die
 *    Sprung-Erkennung oben sieht nur Sprünge NACH dem ersten Bild; Sprünge direkt beim Antippen fängt erst diese Prüfung.)
 */
async function probe(page, name, target, { ms = 750, scroll = null, at = null, act = null, reflow = false, tapTol = 3, smooth = null } = {}) {
  try {
    if (scroll != null) {
      await page.evaluate(y => scrollTo(0, y), scroll);
      await page.waitForTimeout(400);
    }
    if (at != null) {
      await page.evaluate(
        ({ src, at }) => {
          const el = new Function('return (' + src + ')()')();
          scrollBy(0, el.getBoundingClientRect().top - at);
        },
        { src: target, at }
      );
      await page.waitForTimeout(400);
    }
    const res = await page.evaluate(
      ({ target, act, ms, SEL, smooth }) =>
        new Promise(resolve => {
          const vis = e => {
              const r = e.getBoundingClientRect();
              return r.height > 0 && r.width > 0 && r.bottom > 0 && r.top < innerHeight;
            },
            sigOf = e => e.tagName + '|' + ((e.dataset && e.dataset.k) || (e.closest('[data-k]') || { dataset: {} }).dataset.k || '') + '|' + (e.textContent || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 28),
            collect = () => {
              const m = new Map(),
                seen = {};
              for (const e of document.querySelectorAll(SEL)) {
                if (e.closest('#top') || e.closest('.made') || e.closest('dialog:not([open])') || !vis(e)) continue;
                const s = sigOf(e);
                seen[s] = (seen[s] || 0) + 1;
                m.set(s + '#' + seen[s], Math.round(e.getBoundingClientRect().top * 10) / 10);
              }
              return m;
            },
            errors = [],
            onerr = e => errors.push(String(e.message || e));
          addEventListener('error', onerr);
          const topOf = sel => {
              const n = sel && document.querySelector(sel);
              return n ? Math.round(n.getBoundingClientRect().top * 10) / 10 : null;
            },
            before = collect(),
            sy0 = scrollY,
            sm0 = topOf(smooth),
            t0 = performance.now();
          let tapSig = null,
            tapTop0 = null;
          try {
            const el = new Function('return (' + target + ')()')(),
              tracked = el.closest('[data-k]') || el;
            tapSig = sigOf(tracked);
            tapTop0 = Math.round(tracked.getBoundingClientRect().top * 10) / 10;
            if (act) new Function('el', 'return (' + act + ')(el)')(el);
            else el.click();
          } catch (e) {
            errors.push('Bedienung: ' + e.message);
          }
          const frames = [];
          const loop = () => {
            const f = { sy: Math.round(scrollY * 10) / 10, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sm: topOf(smooth), m: [...collect()] };
            frames.push(f);
            if (performance.now() - t0 < ms) requestAnimationFrame(loop);
            else {
              removeEventListener('error', onerr);
              resolve({ tapSig, tapTop0, before: [...before], sy0, sm0, frames, errors });
            }
          };
          requestAnimationFrame(loop);
        }),
      { target, act, ms, SEL, smooth }
    );
    const before = new Map(res.before),
      lastFrame = res.frames[res.frames.length - 1],
      last = new Map(lastFrame.m),
      problems = [];
    // Sprünge: Element steht still, springt in einem Bild um ≥ 24 px und steht danach wieder still
    let teleports = 0;
    const sample = [];
    for (const k of before.keys()) {
      if (!last.has(k)) continue;
      const series = [before.get(k), ...res.frames.map(f => new Map(f.m).get(k) ?? null)];
      for (let i = 2; i < series.length - 1; i++) {
        const [a, b, c, d] = [series[i - 2], series[i - 1], series[i], series[i + 1]];
        if ([a, b, c, d].some(v => v == null)) continue;
        if (Math.abs(b - a) <= 1 && Math.abs(c - b) >= 24 && Math.abs(d - c) <= 1) {
          teleports++;
          if (sample.length < 3) sample.push(`${k.slice(0, 36)}: ${b}→${c}`);
        }
      }
    }
    if (!reflow && teleports) problems.push(`${teleports} Sprünge (${sample.join('; ')})`);
    // angetippter Bereich bleibt stehen
    let tapNote = '';
    if (res.tapSig) {
      const nearest = (arr, ref) => arr.reduce((a, b) => (Math.abs(b - ref) < Math.abs(a - ref) ? b : a));
      const at = f => f.m.filter(([k]) => k.startsWith(res.tapSig + '#')).map(([, v]) => v);
      const ends = at(lastFrame);
      if (ends.length) {
        let maxStep = 0,
          prev = res.tapTop0;
        for (const f of res.frames) {
          const c = at(f);
          if (!c.length) continue;
          const v = nearest(c, prev);
          maxStep = Math.max(maxStep, Math.abs(v - prev));
          prev = v;
        }
        const end = nearest(ends, res.tapTop0);
        tapNote = `angetippt ${res.tapTop0}→${end}`;
        if (Math.abs(end - res.tapTop0) > tapTol) problems.push(`angetippter Bereich verschoben (${res.tapTop0}→${end})`);
        else if (maxStep > 12) problems.push(`angetippter Bereich ruckelt (Sprung ${maxStep.toFixed(0)} px)`);
      }
    }
    // weiche Verschiebung: verteilt über mehrere Bilder, kein Bild trägt mehr als 60 % der Strecke
    if (smooth) {
      const series = [res.sm0, ...res.frames.map(f => f.sm)].filter(v => v != null),
        total = Math.abs(series[series.length - 1] - series[0]);
      let maxStep = 0;
      for (let i = 1; i < series.length; i++) maxStep = Math.max(maxStep, Math.abs(series[i] - series[i - 1]));
      if (total < 20) problems.push(`„${smooth}“ bewegt sich kaum (${total.toFixed(0)} px) – Prüfung veraltet?`);
      else if (maxStep > total * 0.6) problems.push(`„${smooth}“ springt (${maxStep.toFixed(0)} von ${total.toFixed(0)} px in einem Bild)`);
      else tapNote += ` · Verschiebung ${total.toFixed(0)} px weich (größter Schritt ${maxStep.toFixed(0)})`;
    }
    const over = res.frames.filter(f => f.sw > f.cw).length;
    if (over) problems.push(`Seite breiter als der Bildschirm (${over} Bilder)`);
    if (res.errors.length) problems.push('Fehler: ' + res.errors.join(' / '));
    report(!problems.length, name, problems.join(' · ') || tapNote);
    return res;
  } catch (e) {
    report(false, name, 'Test-Fehler: ' + e.message.split('\n')[0]);
    return null;
  }
}
// Sucht einen Knopf nach Text (Regex als String)
const btn = (re, scope = '#app') =>
  `() => { const b = [...document.querySelectorAll('${scope} button')].find(b => ${re}.test(b.textContent.trim())); if (!b) throw new Error('Knopf fehlt: ${re.replace(/'/g, '')}'); return b; }`;
const nthBtn = (re, n) => `() => { const b = [...document.querySelectorAll('#app button')].filter(b => ${re}.test(b.textContent.trim()))[${n}]; if (!b) throw new Error('Knopf fehlt: ${re}'); return b; }`;
const pause = (page, ms = 500) => page.waitForTimeout(ms);

// ---------- Anmeldung ----------
async function newPage(browser, base, viewport, errorsOut) {
  const mobile = viewport.width < 700,
    ctx = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2 }),
    page = await ctx.newPage();
  page.on('pageerror', e => errorsOut.push(e.message));
  await page.goto(base);
  await pause(page, 600);
  return page;
}
async function loginMonteur(page) {
  await page.getByText('Ich bin Monteur').click();
  await page.fill('#lgu', MONTEUR.user);
  await page.fill('#lgp', MONTEUR.password);
  await page.getByRole('button', { name: 'Anmelden' }).last().click();
  await pause(page, 1500);
  const gas = page.getByRole('button', { name: /Funktioniert ordnungsgemäß/ });
  if (await gas.count()) {
    await gas.click();
    await pause(page, 500);
  }
}
async function loginDispo(page) {
  await page.getByText('Ich bin Disponent').click();
  await pause(page, 300);
  await page.locator('input').first().click();
  await page.keyboard.type(DISPO_PIN);
  await pause(page, 1800);
}
// öffnet den ersten Auftrag der Liste mit mindestens 3 Prüfobjekten, von denen noch welche offen sind („Alles OK“ da)
async function openOrderWithItems(page) {
  for (let i = 0; i < 12; i++) {
    const opened = await page.evaluate(i => {
      const card = document.querySelectorAll('#app [data-list] > [data-k]')[i];
      if (card) card.click();
      return !!card;
    }, i);
    if (!opened) return false;
    await pause(page, 800);
    const ok = await page.evaluate(() => document.querySelectorAll('#app .it').length >= 3 && !!document.querySelector('#app [data-k="aok"]'));
    if (ok) return true;
    await page.evaluate(() => closeOrder()); // direkt schließen (ohne Verlassen-Warnung)
    await pause(page, 500);
  }
  return false;
}

// ================================================================================================
// Prüfungen
// ================================================================================================
async function monteurChecks(browser, base, viewport, errors) {
  const label = `${viewport.width}px`,
    page = await newPage(browser, base, viewport, errors);
  console.log(`\n=== Monteur (${label}) ===`);
  await loginMonteur(page);

  // Hinweis oben (Benachrichtigungen): schließen und wieder öffnen – ganz oben auf der Seite
  const hasBanner = await page.evaluate(() => [...document.querySelectorAll('#app button')].some(b => b.textContent.trim() === '✕'));
  if (hasBanner) {
    await probe(page, `${label} Liste: Hinweis mit ✕ schließen (ganz oben, Inhalt rückt weich nach)`, btn('/^✕$/'), { scroll: 0, ms: 800, tapTol: 400, smooth: '#app .gasl' });
    await probe(page, `${label} Liste: Glocke wieder öffnen (ganz oben, Inhalt rückt weich nach)`, btn('/Benachrichtigungen/'), { scroll: 0, ms: 800, tapTol: 400, smooth: '#app .gasl' });
    await page.reload();
    await pause(page, 1200);
  }
  // Filter, Sortierung (unterwegs auf der Liste)
  for (const f of ['Alle', 'Erledigt', 'Nicht OK', 'Offen'])
    await probe(page, `${label} Liste: Filter „${f}“`, btn(`/^${f}/`), { at: 300 });
  await probe(page, `${label} Liste: Sortierung Termin`, btn('/^Termin$/'), { at: 300 });
  await probe(page, `${label} Liste: Sortierung Auftragsnummer`, btn('/^Auftragsnummer$/'), { at: 300 });

  // Schriftgröße: der angetippte Knopf bleibt unter dem Finger – ganz oben und weiter unten, rauf und runter
  await probe(page, `${label} Schrift: A+ ganz oben`, btn('/^A\\+$/'), { scroll: 0, reflow: true });
  await probe(page, `${label} Schrift: A+ nochmal`, btn('/^A\\+$/'), { reflow: true });
  await probe(page, `${label} Schrift: A+ nochmal (150 %)`, btn('/^A\\+$/'), { reflow: true });
  await probe(page, `${label} Schrift: A− `, btn('/^A−$/'), { reflow: true });
  await probe(page, `${label} Schrift: A− weiter unten`, btn('/^A−$/'), { at: 250, reflow: true });
  await probe(page, `${label} Schrift: A− `, btn('/^A−$/'), { reflow: true });

  // Dunkelmodus: nichts darf sich verschieben (Kopfzeile bleibt gleich hoch)
  const topH = async () => page.evaluate(() => document.querySelector('#top').getBoundingClientRect().height);
  const h1 = await topH();
  await page.evaluate(() => document.querySelector('#top .thm').click());
  await pause(page, 400);
  const h2 = await topH();
  report(h1 === h2, `${label} Dunkelmodus: Kopfzeile gleich hoch`, `${h1} → ${h2} px`);
  await probe(page, `${label} Liste: Dunkelmodus aus`, `() => document.querySelector('#top .thm')`, { scroll: 300 });

  // Suche: Suchfeld bleibt stehen, auch wenn die Seite durch wenige Treffer kürzer wird
  await page.evaluate(() => scrollTo(0, 450));
  await pause(page, 400);
  await page.click('#app input[type=search]');
  let searchOk = true,
    detail = '';
  for (const ch of ['S', 'E', 'N', '9']) {
    const r = await page.evaluate(
      ch =>
        new Promise(resolve => {
          const i = document.querySelector('#app input[type=search]'),
            t0 = i.getBoundingClientRect().top;
          i.value += ch;
          i.dispatchEvent(new Event('input', { bubbles: true }));
          let worst = 0;
          const t1 = performance.now(),
            loop = () => {
              worst = Math.max(worst, Math.abs(i.getBoundingClientRect().top - t0));
              if (performance.now() - t1 < 400) requestAnimationFrame(loop);
              else resolve(worst);
            };
          requestAnimationFrame(loop);
        }),
      ch
    );
    if (r > 2) {
      searchOk = false;
      detail += ` „${ch}“: ${r.toFixed(0)} px`;
    }
  }
  report(searchOk, `${label} Suche tippen: Suchfeld bleibt stehen`, detail);
  await page.evaluate(() => {
    const i = document.querySelector('#app input[type=search]');
    i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pause(page, 500);

  // Live-Update: der Disponent hakt einen sichtbaren Auftrag ab -> darunter gleitet es, springt nicht
  await page.evaluate(() => scrollTo(0, 900));
  await pause(page, 500);
  const key = await page.evaluate(() => {
    const c = [...document.querySelectorAll('#app [data-list] > [data-k]')].filter(n => { const r = n.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 50; });
    return c.length > 1 ? c[0].dataset.k : null;
  });
  if (key) {
    const login = await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: DISPO_PIN, did: 'ui-test-dispo' }) })).json();
    await probe(page, `${label} Live-Update: Auftrag wird abgehakt (Karten darunter gleiten)`, `() => document.querySelector('#app [data-k="${key}"]')`, {
      ms: 1600,
      act: `async el => { await new Promise(r => setTimeout(r, 200)); await fetch('/api/mark', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ${login.token}' }, body: JSON.stringify({ ids: ['${key.slice(1)}'], v: 1 }) }); }`
    });
  }

  // Auftrag öffnen / schließen: Scroll-Stelle bleibt, kein seitliches Wackeln
  await page.evaluate(() => scrollTo(0, 0));
  await pause(page, 300);
  if (!(await openOrderWithItems(page))) {
    report(false, `${label} Auftrag mit Prüfobjekten gefunden`, 'keiner in den ersten 12 Aufträgen');
    await page.context().close();
    return;
  }
  await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => /Zurück/.test(b.textContent)).click());
  await pause(page, 600);
  await page.evaluate(() => scrollTo(0, 1500));
  await pause(page, 400);
  const sy = await page.evaluate(() => scrollY);
  await probe(page, `${label} Auftrag öffnen (seitliches Wackeln)`, `() => [...document.querySelectorAll('#app [data-list] > [data-k]')].find(n => n.getBoundingClientRect().top > 100)`, { reflow: true, tapTol: 5000 });
  await pause(page, 500);
  await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => /Zurück/.test(b.textContent)).click());
  await pause(page, 700);
  const sy2 = await page.evaluate(() => scrollY);
  report(Math.abs(sy - sy2) <= 2, `${label} Auftrag schließen: Scroll-Stelle der Liste bleibt`, `${sy} → ${sy2}`);

  // Auftragsansicht
  await page.evaluate(() => scrollTo(0, 0));
  await openOrderWithItems(page);
  const A = 330;
  if (await page.evaluate(() => !!document.querySelector('#app [data-k="zw"] button')))
    await probe(page, `${label} Detail: „Mit wem“ Kollege antippen`, `() => document.querySelector('#app [data-k="zw"] button')`, { at: A });
  await probe(page, `${label} Detail: Zeit von Hand eintragen öffnen`, btn('/Zeit von Hand/'), { at: A, ms: 800 });
  const formVisible = await page.evaluate(() => { const i = document.querySelector('#app .d-time input'); if (!i) return false; const r = i.getBoundingClientRect(); return r.top > 0 && r.top < innerHeight; });
  report(formVisible, `${label} Detail: Zeitformular erscheint im sichtbaren Bereich (nicht darüber)`);
  await probe(page, `${label} Detail: Schnellwahl 1 Std`, btn('/^1 Std$/'), { at: A });
  await probe(page, `${label} Detail: Zeit speichern`, btn('/Zeit speichern/'), { at: A, ms: 1200 });
  await pause(page, 600);
  await probe(page, `${label} Detail: Nicht OK (Editor öffnet)`, `() => document.querySelectorAll('#app .it')[0].querySelector('button.nk')`, { at: A });
  await probe(page, `${label} Detail: Nicht OK (Editor wechselt)`, `() => document.querySelectorAll('#app .it')[1].querySelector('button.nk')`, { at: A });
  await probe(page, `${label} Detail: Editor Abbrechen`, btn('/^Abbrechen$/'), { at: A });
  await probe(page, `${label} Detail: OK antippen`, `() => document.querySelectorAll('#app .it')[1].querySelector('button.ok')`, { at: A });
  await probe(page, `${label} Detail: OK zurücknehmen`, `() => document.querySelectorAll('#app .it')[1].querySelector('button.ok')`, { at: A });
  await probe(page, `${label} Detail: Alles OK (Rückfrage wächst weich auf)`, btn('/Alle|Alles OK/'), { at: A, smooth: '#app .it' });
  await probe(page, `${label} Detail: Rückfrage abbrechen (schließt weich)`, btn('/^Abbrechen$/'), { at: A, smooth: '#app .it' });
  await probe(page, `${label} Detail: Alles OK (Rückfrage)`, btn('/Alle|Alles OK/'), { at: A });
  await pause(page, 400);
  await probe(page, `${label} Detail: „Ja, alle OK“ (schließt weich)`, btn('/Ja, alle OK/'), { at: A, ms: 1300, smooth: '#app .it' });
  await page.context().close();
}

async function dispoChecks(browser, base, viewport, errors) {
  const label = `${viewport.width}px`,
    page = await newPage(browser, base, viewport, errors);
  console.log(`\n=== Disponent (${label}) ===`);
  await loginDispo(page);
  const gotoTab = async n => {
    await page.evaluate(n => [...document.querySelectorAll('#app .tabs button')].find(b => b.textContent.trim() === n).click(), n);
    await pause(page, 1100);
  };
  // Tabs: Kopfzeile und Tab-Leiste bleiben stehen, nur der Inhalt wechselt
  for (const n of ['Fortschritt', 'Upload', 'Vergleich', 'Geräte', 'Benutzer', 'Übersicht'])
    await probe(page, `${label} Tab „${n}“: Leiste bleibt stehen`, btn(`/^${n}$/`, '#app .tabs'), { reflow: true, ms: 800 });
  // Übersicht: Filter
  await probe(page, `${label} Übersicht: Filter öffnen`, btn('/⚙ Filter/'), { at: 250, reflow: true });
  for (const f of ['Nicht OK', 'Erledigt', 'Alle \\('])
    await probe(page, `${label} Übersicht: Filter „${f.replace(' \\(', '')}“`, btn(`/^${f}/`), { at: 330 });
  await probe(page, `${label} Übersicht: Abgehakte ausblenden`, btn('/^Ausblenden/'), { at: 330 });
  await probe(page, `${label} Übersicht: Abgehakte anzeigen`, btn('/^Anzeigen$/'), { at: 330 });
  await probe(page, `${label} Übersicht: Sortierung Rückmeldung`, btn('/^Rückmeldung/'), { at: 330 });
  await probe(page, `${label} Übersicht: Sortierung Auftragsnummer`, btn('/^Auftragsnummer$/'), { at: 330 });
  await probe(page, `${label} Übersicht: Filter schließen`, btn('/⚙ Filter/'), { at: 250, reflow: true });
  // Fortschritt
  await gotoTab('Fortschritt');
  await probe(page, `${label} Fortschritt: Tabelle`, btn('/^Tabelle$/'), { at: 330 });
  await probe(page, `${label} Fortschritt: Diagramm`, btn('/^Diagramm$/'), { at: 330 });
  // Geräte
  await gotoTab('Geräte');
  await probe(page, `${label} Geräte: Spitzname geben`, nthBtn('/Spitzname geben/', 1), { at: 400 });
  await probe(page, `${label} Geräte: Ausloggen (Rückfrage)`, nthBtn('/^Ausloggen$/', 2), { at: 400 });
  await probe(page, `${label} Geräte: Rückfrage abbrechen`, btn('/^Abbrechen$/'), { at: 400 });
  // Benutzer: Zeilen klappen auf und zu, die Seite bleibt an Ort und Stelle (früher sprang sie nach ganz oben)
  await gotoTab('Benutzer');
  await probe(page, `${label} Benutzer: Neuer Benutzer`, btn('/Neuer Benutzer/'), { at: 250 });
  await probe(page, `${label} Benutzer: Neuer Benutzer abbrechen`, btn('/^Abbrechen$/'), { at: 350 });
  await probe(page, `${label} Benutzer: Bearbeiten`, nthBtn('/^Bearbeiten$/', 2), { at: 400 });
  await probe(page, `${label} Benutzer: Bearbeiten abbrechen`, btn('/^Abbrechen$/'), { at: 400 });
  await probe(page, `${label} Benutzer: Passwort zurücksetzen (Rückfrage)`, nthBtn('/Passwort zurücksetzen/', 2), { at: 400 });
  await probe(page, `${label} Benutzer: Rückfrage abbrechen`, btn('/^Abbrechen$/'), { at: 400 });
  await probe(page, `${label} Benutzer: Protokoll öffnen`, nthBtn('/^Protokoll$/', 2), { at: 400, ms: 1300 });
  await probe(page, `${label} Benutzer: Löschen (Rückfrage)`, nthBtn('/^Löschen$/', 2), { at: 400 });
  await probe(page, `${label} Benutzer: Rückfrage abbrechen`, btn('/^Abbrechen$/'), { at: 400 });
  await probe(page, `${label} Benutzer: Löschen bestätigen (Zeilen darunter gleiten)`, nthBtn('/^Löschen$/', 4), { at: 400, act: `el => { el.click(); setTimeout(() => [...document.querySelectorAll('#app button')].find(b => /Wirklich löschen/.test(b.textContent)).click(), 300); }`, ms: 1800 });
  await page.context().close();
}

// Zusätzlich: bei größter Schrift und schmalem Bildschirm läuft nichts über den Rand
async function overflowChecks(browser, base, errors) {
  console.log('\n=== Überlauf bei 150 % Schrift, 320 px breit ===');
  const page = await newPage(browser, base, { width: 320, height: 640 }, errors);
  await loginMonteur(page);
  for (let i = 0; i < 3; i++) await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => b.textContent === 'A+').click());
  await pause(page, 500);
  const wide = () =>
    page.evaluate(() => [...document.querySelectorAll('#app *')].filter(n => n.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !n.closest('.tabs') && getComputedStyle(n).position !== 'fixed').map(n => n.tagName + '.' + n.className + '"' + n.textContent.trim().slice(0, 20) + '"').slice(0, 3));
  let w = await wide();
  report(!w.length, 'Liste ragt nicht über den Rand', w.join(', '));
  await openOrderWithItems(page);
  w = await wide();
  report(!w.length, 'Auftragsansicht ragt nicht über den Rand', w.join(', '));
  await page.context().close();
}

// ================================================================================================
(async () => {
  const pw = loadPlaywright(),
    server = await startServer(),
    base = 'http://127.0.0.1:' + server.port,
    errors = [];
  const browser = await pw.chromium.launch({ executablePath: findChrome() });
  const t0 = Date.now();
  try {
    await monteurChecks(browser, base, { width: 390, height: 844 }, errors);
    await dispoChecks(browser, base, { width: 390, height: 844 }, errors);
    await overflowChecks(browser, base, errors);
    // Desktop (breit): dieselben Grundabläufe
    await monteurChecks(browser, base, { width: 1280, height: 800 }, errors);
    report(!errors.length, 'Keine JavaScript-Fehler auf den Seiten', errors.slice(0, 3).join(' / '));
  } finally {
    await browser.close();
    server.stop();
  }
  console.log(`\n${failures.length ? 'FEHLGESCHLAGEN' : 'BESTANDEN'}: ${passed} Prüfungen ok, ${failures.length} Fehler (${Math.round((Date.now() - t0) / 1000)} s)`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(failures.length ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(2);
});
