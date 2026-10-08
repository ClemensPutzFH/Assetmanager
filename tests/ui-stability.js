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
 * Dazu Einzelprüfungen (Dunkelmodus, Suche, Scroll-Stelle bleibt erhalten, Formulare erscheinen sichtbar, Live-Update,
 * Sortierung nach Entfernung mit Test-Standort und einem Mini-Geocoder statt des echten Nominatim-Dienstes,
 * Ortung durch den Disponenten und Ausloggen von Geräten).
 *
 * NEUE BEDIENUNG? Eine Prüfung dafür unten ergänzen (siehe Abschnitt „Prüfungen“) und den Test ausführen.
 * Zum Eingrenzen eines sporadischen Fehlers: TEST_ONLY=auftragsarten (nur Upload, Disposition und Ansichten der Auftragsarten), TEST_ONLY=disposition (nur Upload und das Gantt-Diagramm), TEST_ONLY=geraete (nur die Prüfung „Ortung/Ausloggen“) und TEST_DEBUG=1 (schreibt dort die
 * Abgleich- und Anmelde-Anfragen mit Zeit mit, wenn die erneute Anmeldung fehlschlägt).
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

// ---------- Mini-Geocoder (ersetzt Nominatim): Koordinaten = Bezirksmitte + fester Versatz je Straße ----------
// Der Server fragt ihn nach den Adressen der Aufträge; „Unbekannt“ und U-Bahn/Haltestellen findet er nicht (dann gilt die Bezirksmitte).
const TEST_POS = { latitude: 48.283, longitude: 16.4, accuracy: 25 }; // Standort des Test-Geräts: Mitte von Floridsdorf (1210)
const CENTERS = { 1010: [48.2082, 16.373], 1020: [48.217, 16.4], 1030: [48.198, 16.4], 1040: [48.192, 16.369], 1050: [48.188, 16.356], 1060: [48.196, 16.348], 1070: [48.203, 16.348], 1080: [48.211, 16.343], 1090: [48.226, 16.356], 1100: [48.162, 16.378], 1110: [48.169, 16.44], 1120: [48.174, 16.332], 1130: [48.185, 16.29], 1140: [48.201, 16.276], 1150: [48.196, 16.327], 1160: [48.214, 16.307], 1170: [48.233, 16.3], 1180: [48.233, 16.331], 1190: [48.253, 16.345], 1200: [48.24, 16.378], 1210: [48.28, 16.4], 1220: [48.235, 16.475], 1230: [48.138, 16.29] };
// Nachbau von Nominatim (/search) und des Wiener Adressdienstes (/daten/OGDAddressService.svc/GetAddressInfo):
// delay: Antwortzeit je Anfrage in ms (langsamer Dienst) · coarse: Straßen (RegExp), für die Nominatim nur ein PLZ-Gebiet liefert (place_rank 21) ·
// nominatimStatus: z. B. 403 (gesperrt, wie der öffentliche Dienst) · wienStreets: Map „Straße Nr“ -> PLZ-Liste (die Straße gibt es dort),
// wienAsciiOnly: kennt nur Schreibweisen ohne Sonderzeichen (ae/ss) · wienSwap: Breite/Länge statt Länge/Breite · wienBad: antwortet mit HTML
async function startGeocoder({ delay = 0, coarse = null, nominatimStatus = 200, wienStreets = null, wienAsciiOnly = false, wienSwap = false, wienBad = false } = {}) {
  const http = require('http'),
    crypto = require('crypto'),
    ascii = t => t.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'),
    counts = { nominatim: 0, wien: 0 };
  let requests = 0,
    streets = wienStreets, // kann nachträglich gesetzt werden (setStreets), sobald die Daten des Servers bekannt sind
    asciiStreets = null;
  // PLZ-Liste einer Straße; im Modus „nur ohne Sonderzeichen“ kennt der Dienst „Strasse“, aber nicht „Straße“
  const known = street => {
    if (!streets) return null;
    if (!wienAsciiOnly) return streets.get(street);
    if (/[äöüß]/.test(street)) return null;
    if (!asciiStreets) asciiStreets = new Map([...streets].map(([k, v]) => [ascii(k), v]));
    return asciiStreets.get(street);
  };
  const jitter = (street, plz) => {
    const c = CENTERS[plz] || [48.2, 16.37],
      h = crypto.createHash('md5').update(street).digest();
    return [c[0] + (h[0] / 255 - 0.5) * 0.02, c[1] + (h[1] / 255 - 0.5) * 0.03];
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'),
      send = (status, body, type = 'application/json') => {
        const answer = () => {
          res.writeHead(status, { 'Content-Type': type });
          res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };
        delay ? setTimeout(answer, delay) : answer();
      };
    requests++;
    if (u.pathname === '/daten/OGDAddressService.svc/GetAddressInfo') {
      counts.wien++;
      if (wienBad) return send(200, '<html><body>Wartungsarbeiten</body></html>', 'text/html');
      const street = u.searchParams.get('Address') || '',
        features = (known(street) || []).map(plz => {
          const [lat, lon] = jitter(street, plz);
          return { type: 'Feature', geometry: { type: 'Point', coordinates: wienSwap ? [lat, lon] : [lon, lat] }, properties: { PostalCode: plz } };
        });
      return send(200, { type: 'FeatureCollection', features });
    }
    counts.nominatim++;
    if (nominatimStatus !== 200) return send(nominatimStatus, '<html><body>Access blocked: you have violated the usage policy</body></html>', 'text/html');
    const street = u.searchParams.get('street') || '',
      plz = u.searchParams.get('postalcode') || '',
      found = !/Haltestelle|U-Bahn/.test(street),
      [lat, lon] = jitter(street, plz);
    send(200, found ? [{ lat: String(lat), lon: String(lon), place_rank: coarse && coarse.test(street) ? 21 : 30 }] : []);
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + srv.address().port;
  return { url, wienUrl: url + '/daten/OGDAddressService.svc/GetAddressInfo', counts, setStreets: m => ((streets = m), (asciiStreets = null)), requests: () => requests, stop: () => srv.close() };
}

// ---------- Server mit Kopie der Daten ----------
async function startServer(geocoderUrl, prepareData = null, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-test-')),
    port = await freePort();
  for (const f of ['data.db', 'data.db-wal', 'data.db-shm'])
    if (fs.existsSync(path.join(ROOT, 'data', f))) fs.copyFileSync(path.join(ROOT, 'data', f), path.join(dir, f));
  if (prepareData) prepareData(dir); // Daten vor dem Start verändern (nur in der Kopie)
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, DISPO_PIN, UPLOAD_PIN: '1025', MONTEUR_PASSWORD: MONTEUR.password, GEOCODER_URL: geocoderUrl, GEOCODER_DELAY_MS: '1', GEOCODER_WIEN_URL: 'off', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server startet nicht')), 20000);
    child.stdout.on('data', d => /Läuft auf/.test(String(d)) && (clearTimeout(t), resolve()));
    child.on('exit', c => reject(new Error('Server beendet (' + c + ')')));
  });
  return { port, dir, stop: () => (child.kill(), fs.rmSync(dir, { recursive: true, force: true })) };
}
// wartet, bis der Server alle Adressen der Aufträge in Koordinaten umgewandelt hat (sonst hängt die Entfernungs-Prüfung vom Zufall ab)
async function waitForCoordinates(base) {
  const login = await (await fetch(base + '/api/user/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: MONTEUR.user, password: MONTEUR.password }) })).json();
  for (let i = 0; i < 120; i++) {
    const geo = await (await fetch(base + '/api/geo?since=0', { headers: { 'X-User-Token': login.token } })).json();
    if (geo.items.length && !geo.open) return geo.items.length;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Server hat die Adressen nicht in Koordinaten umgewandelt');
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
 *  anim: die Bedienung muss ANIMIEREN – gleich nach dem Antippen läuft mindestens eine Web-Animation in der Seite (Einblendung, Gleiten;
 *    CSS-Übergänge der Knöpfe zählen nicht), am Ende ist alles fertig und nichts bleibt halb durchsichtig oder verschoben stehen
 */
async function probe(page, name, target, { ms = 750, scroll = null, at = null, act = null, reflow = false, tapTol = 3, smooth = null, anim = false } = {}) {
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
          // laufende Web-Animationen in #app (ohne CSS-Übergänge/-Animationen, die zählen nicht)
          const appAnims = () =>
              document.getAnimations().filter(a => {
                const t = a.effect && a.effect.target;
                // (data-ghost: Kopien, die außerhalb von #app ausblenden, z. B. das schließende Fenster der Disposition)
                return t && t.closest && t.closest('#app, [data-ghost]') && !a.transitionProperty && !a.animationName && a.playState === 'running';
              }).length,
            looksStuck = () =>
              [...document.querySelectorAll('#app > *')].filter(n => {
                const cs = getComputedStyle(n);
                // (gesperrte Knöpfe sind absichtlich halb durchsichtig)
                return !n.disabled && n.getBoundingClientRect().height > 0 && (+cs.opacity < 0.99 || (cs.transform !== 'none' && cs.position !== 'fixed'));
              }).length;
          let animRunning = -1;
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
            if (frames.length === 3) animRunning = appAnims();
            if (performance.now() - t0 < ms) requestAnimationFrame(loop);
            else {
              removeEventListener('error', onerr);
              resolve({ tapSig, tapTop0, before: [...before], sy0, sm0, frames, errors, animRunning, animLeft: appAnims(), stuck: looksStuck() });
            }
          };
          requestAnimationFrame(loop);
        }),
      { target, act, ms, SEL, smooth }
    );
    // Fehlersuche: TEST_TRACE=<Teil des Namens> schreibt für diese Prüfung Bild für Bild die Scroll-Stelle und die Lage der Elemente
    // (TEST_TRACE_KEYS = Muster für deren Kennung, Standard: Diagramm und Offen-Karten) – damit sieht man, WAS springt
    if (process.env.TEST_TRACE && name.includes(process.env.TEST_TRACE)) {
      const keys = new RegExp(process.env.TEST_TRACE_KEYS || '^DIV\\|(gt|dp-)'),
        pick = m => m.filter(([k]) => keys.test(k)).slice(0, 5).map(([k, v]) => `${k.slice(0, 22)}=${v}`).join('  ');
      console.log(`   [trace] ${name}\n   vor: sy=${res.sy0} ${pick(res.before)}`);
      res.frames.forEach((f, i) => console.log(`   #${i} sy=${f.sy} ${pick(f.m)}`));
    }
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
    if (anim) {
      if (res.animRunning < 1) problems.push('keine Animation gestartet (Ansicht wechselt ohne Übergang)');
      if (res.animLeft) problems.push(`${res.animLeft} Animationen laufen am Ende noch`);
      if (res.stuck) problems.push(`${res.stuck} Bereiche bleiben halb durchsichtig/verschoben stehen`);
      if (!problems.length) tapNote += ` · ${res.animRunning} Animationen`;
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
async function newPage(browser, base, viewport, errorsOut, { geolocation = true, denyLocation = false, accuracy = TEST_POS.accuracy } = {}) {
  const mobile = viewport.width < 700,
    ctx = await browser.newContext({
      viewport,
      hasTouch: mobile,
      isMobile: mobile,
      deviceScaleFactor: 2,
      ...(geolocation ? { permissions: ['geolocation'], geolocation: { ...TEST_POS, accuracy } } : {})
    }),
    page = await ctx.newPage();
  page.on('pageerror', e => errorsOut.push(e.message));
  // Ablehnung nachstellen: das Test-Chromium fragt nie, es würde endlos warten
  if (denyLocation) await page.addInitScript(() => { navigator.geolocation.getCurrentPosition = (ok, fail) => setTimeout(() => fail({ code: 1 }), 80); });
  await page.goto(base);
  await pause(page, 600);
  return page;
}
// Auftragsart wählen: Monteur auf der Startseite der große Knopf (aus einer Liste zuerst zurück), Disponent der Umschalter (Name: „Wartung“, „Reparatur“ …)
async function chooseKind(page, name) {
  // Monteur in einer Liste: erst zurück zur Startseite (dort liegt die Auswahl)
  const back = await page.evaluate(() => {
    if (document.querySelector('#app button.kind, #app .ksw button')) return false;
    const b = [...document.querySelectorAll('#app button')].find(b => /Auftragsarten/.test(b.textContent));
    if (b) b.click();
    return !!b;
  });
  if (back) await pause(page, 700);
  await page.evaluate(name => {
    const b = [...document.querySelectorAll('#app button.kind, #app .ksw button')].find(b => b.textContent.includes(name));
    if (!b) throw new Error('Auftragsart fehlt: ' + name);
    b.click();
  }, name);
  await pause(page, 600);
}
// kind: Auftragsart, die nach der Anmeldung geöffnet wird (Standard: Wartungen – die meisten Prüfungen laufen auf dieser Liste);
// null = auf der Startseite bleiben
async function loginMonteur(page, kind = 'Wartungen') {
  await page.getByText('Ich bin Monteur').click();
  // Direkt nach dem Öffnen des Formulars zeichnet die App noch ein-, zweimal neu (Rolle gemeldet, Abgleich). Kein Mensch tippt in den
  // ersten 150 ms – wartet der Test nicht, fällt das Neuzeichnen zwischen „Feld markieren“ und „Text einfügen“, und das vorbelegte
  // Feld bekommt den User doppelt („33NX33NX“, 403 Anmeldung falsch).
  await page.waitForSelector('#lgu');
  await pause(page, 400);
  await page.fill('#lgu', MONTEUR.user);
  await page.fill('#lgp', MONTEUR.password);
  await page.getByRole('button', { name: 'Anmelden' }).last().click();
  await pause(page, 1500);
  const gas = page.getByRole('button', { name: /Funktioniert ordnungsgemäß/ });
  if (await gas.count()) {
    await gas.click();
    await pause(page, 500);
  }
  if (kind) await chooseKind(page, kind);
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
// liest aus der Liste die Entfernungen („350 m“, „1,2 km“, „ca. 3 km“) in Anzeigereihenfolge
const readDistances = page =>
  page.evaluate(() =>
    [...document.querySelectorAll('#app [data-list] > [data-k]')].map(card => {
      const m = /📍 (ca\. )?([\d.,]+) (m|km)/.exec(card.textContent);
      return { k: card.dataset.k, km: m ? parseFloat(m[2].replace(/\./g, '').replace(',', '.')) / (m[3] === 'm' ? 1000 : 1) : null, rough: !!(m && m[1]) };
    })
  );
// Sortierung nach Entfernung (Standort des Test-Geräts: Floridsdorf): der Knopf bleibt stehen, nächste Aufträge zuerst, Zeile über der Liste bleibt einzeilig
async function distanceChecks(page, label) {
  const countBox = () => page.evaluate(() => { const n = document.querySelector('#app .cnt'); return n ? { h: Math.round(n.getBoundingClientRect().height), text: n.textContent } : null; });
  const nrOrder = (await readDistances(page)).map(c => c.k);
  const before = await countBox();
  await probe(page, `${label} Liste: Sortierung Entfernung`, btn('/^Entfernung$/'), { at: 300, ms: 1600 });
  const after = await countBox();
  report(!!after && /Standort von \d\d:\d\d Uhr/.test(after.text), `${label} Entfernung: Zeile über der Liste nennt den Standort`, after && after.text);
  report(!!before && !!after && before.h === after.h, `${label} Entfernung: Zeile über der Liste bleibt gleich hoch`, `${before && before.h} → ${after && after.h} px`);
  const list = await readDistances(page),
    km = list.filter(c => c.km != null && !c.rough).map(c => c.km); // „ca.“ (nur Bezirksmitte, ganze km) nicht mitzählen: gerundet kann es vor genaueren Werten stehen
  report(km.length >= 10, `${label} Entfernung: Karten zeigen die Entfernung`, `${km.length} von ${list.length} Karten`);
  report(km.every((v, i) => i === 0 || v >= km[i - 1]), `${label} Entfernung: nächste Aufträge stehen oben`, km.slice(0, 6).join(' · ') + ' … ' + km.slice(-2).join(' · ') + ' km');
  report(list.map(c => c.k).join() !== nrOrder.join(), `${label} Entfernung: Reihenfolge unterscheidet sich von der Auftragsnummer`);
  // erneut antippen = Standort neu bestimmen (Liste bleibt dabei ruhig)
  await probe(page, `${label} Liste: Entfernung erneut antippen (Standort neu)`, btn('/^Entfernung$/'), { at: 300, ms: 1200 });
  await probe(page, `${label} Liste: Sortierung Auftragsnummer (nach Entfernung)`, btn('/^Auftragsnummer$/'), { at: 300 });
  const back = await readDistances(page);
  report(back.every(c => c.km == null) && back.map(c => c.k).join() === nrOrder.join(), `${label} Entfernung: zurück zur Auftragsnummer stellt Reihenfolge und Karten wieder her`);
}
// Koordinaten der Adressen unter schwierigen Bedingungen: (1) das Team des Geräts kommt beim Umwandeln zuerst dran und zu grobe
// Treffer (nur PLZ-Gebiet) werden verworfen, (2) der Geocoder ist nicht erreichbar, (3) der Geocoder ist langsam: bis dahin „ca.“-Werte
// und der Hinweis, danach genaue Werte von selbst. Die Zeile über der Liste bleibt dabei immer gleich hoch (kein Springen).
async function geoScenarioChecks(browser, errors) {
  console.log('\n=== Koordinaten der Adressen: Reihenfolge, grobe Treffer, Störungen ===');
  const vp = { width: 390, height: 844 },
    json = async (base, url, headers) => (await fetch(base + url, { headers })).json(),
    monteurToken = async base => ({ 'X-User-Token': (await (await fetch(base + '/api/user/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: MONTEUR.user, password: MONTEUR.password }) })).json()).token }),
    dispoToken = async base => ({ Authorization: 'Bearer ' + (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: DISPO_PIN, did: 'ui-test-geo' }) })).json()).token }),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    // Zeile über der Liste und Entfernungen der Karten, wie der Monteur sie sieht
    sample = async page => ({ ...(await page.evaluate(() => { const n = document.querySelector('#app .cnt'); return n ? { h: Math.round(n.getBoundingClientRect().height), text: n.textContent } : { h: 0, text: '' }; })), cards: await readDistances(page) });

  const scenario1 = async () => {
    const geocoder = await startGeocoder({ delay: 20, coarse: /Autokaderstraße/ }),
      server = await startServer(geocoder.url),
      base = 'http://127.0.0.1:' + server.port;
    try {
      const token = await monteurToken(base),
        dispo = await dispoToken(base),
        wanted = new Set((await json(base, '/api/sync?since=0&team=', dispo)).orders.filter(o => o.team === 'FW-IH12' && o.str).map(o => (o.plz || '') + '|' + o.str));
      await json(base, '/api/geo?since=0&team=FW-IH12', token); // „dieses Team braucht Entfernungen“ – noch bevor der Server mit dem Umwandeln beginnt
      let done = 0,
        open = 0;
      for (let i = 0; i < 120 && done < wanted.size * 0.95; i++) {
        await sleep(250);
        const geo = await json(base, '/api/geo?since=0', token);
        done = geo.items.filter(i => wanted.has(i[0])).length;
        open = geo.open;
      }
      report(done >= wanted.size * 0.95 && open > 300, 'Koordinaten: Adressen des Teams kommen zuerst an die Reihe', `${done} von ${wanted.size} Adressen des Teams fertig, insgesamt noch ${open} offen`);
      let geo;
      for (let i = 0; i < 240; i++) {
        geo = await json(base, '/api/geo?since=0', token);
        if (!geo.open) break;
        await sleep(500);
      }
      const coarse = geo.items.filter(i => /Autokaderstraße/.test(i[0]));
      report(!geo.open && geo.items.length > 900, 'Koordinaten: alle Adressen werden schließlich umgewandelt', `${geo.items.length} Adressen`);
      report(coarse.length === 0, 'Koordinaten: Treffer, die nur ein PLZ-Gebiet nennen, werden verworfen', `${coarse.length} grobe Treffer übernommen`);
    } finally {
      server.stop();
      geocoder.stop();
    }
  };

  const scenario2 = async () => {
    const server = await startServer('http://127.0.0.1:1'), // dort lauscht nichts
      base = 'http://127.0.0.1:' + server.port;
    try {
      const token = await monteurToken(base);
      let geo = {};
      for (let i = 0; i < 40 && !geo.err; i++) {
        geo = await json(base, '/api/geo?since=0&team=FW-IH01', token);
        await sleep(500);
      }
      report(!!geo.err && geo.open > 0, 'Koordinaten: Störung des Geocoders wird gemeldet', geo.err || 'keine Meldung');
      const page = await newPage(browser, base, vp, errors);
      await loginMonteur(page);
      await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => b.textContent === 'Entfernung').click());
      await page.waitForTimeout(2500);
      const r = await sample(page);
      report(/Entfernung nur ungefähr/.test(r.text), 'Koordinaten: Störung zeigt „Entfernung nur ungefähr“ über der Liste', r.text);
      report(r.cards.length > 0 && r.cards.every(c => c.km == null || c.rough), 'Koordinaten: bei Störung stehen die Werte als „ca.“ da', `${r.cards.filter(c => c.rough).length} von ${r.cards.length} Karten`);
      await page.context().close();
    } finally {
      server.stop();
    }
  };

  const scenario3 = async () => {
    const geocoder = await startGeocoder({ delay: 200 }),
      server = await startServer(geocoder.url),
      base = 'http://127.0.0.1:' + server.port;
    try {
      const page = await newPage(browser, base, vp, errors);
      await loginMonteur(page);
      await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => b.textContent === 'Entfernung').click());
      await page.waitForTimeout(1500);
      const first = await sample(page);
      report(/Adressen werden ermittelt/.test(first.text) && first.cards.some(c => c.rough), 'Koordinaten: solange sie fehlen, steht „Adressen werden ermittelt“ und die Werte sind „ca.“', first.text);
      const heights = new Set([first.h]);
      let last = first;
      for (let t = 0; t < 70 && !(/Standort von/.test(last.text) && last.cards.every(c => !c.rough)); t++) {
        await page.waitForTimeout(1000);
        last = await sample(page);
        heights.add(last.h);
      }
      report(/Standort von/.test(last.text) && last.cards.length > 0 && last.cards.every(c => !c.rough), 'Koordinaten: danach werden die Entfernungen von selbst genau', last.text);
      report(heights.size === 1, 'Koordinaten: Zeile über der Liste bleibt dabei gleich hoch', [...heights].join(' / ') + ' px');
      const km = last.cards.filter(c => !c.rough && c.km != null).map(c => c.km);
      report(km.every((v, i) => i === 0 || v >= km[i - 1]), 'Koordinaten: nach dem Genauwerden stehen die nächsten Aufträge oben', km.slice(0, 5).join(' · ') + ' km');
      await page.context().close();
    } finally {
      server.stop();
      geocoder.stop();
    }
  };
  // (4) Koordinaten aus einer älteren Version (ohne Prüfung auf zu grobe Treffer) werden einmal verworfen und neu ermittelt;
  // ein Gerät mit altem Zwischenspeicher bekommt dann den kompletten neuen Stand
  const scenario4 = async () => {
    const { DatabaseSync } = require('node:sqlite'),
      OLD = '1210|Brünner Straße 52',
      geocoder = await startGeocoder(),
      server = await startServer(geocoder.url, dir => {
        const db = new DatabaseSync(path.join(dir, 'data.db'));
        db.exec('CREATE TABLE IF NOT EXISTS geo(id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL UNIQUE, lat REAL, lon REAL, q TEXT, at INTEGER NOT NULL)');
        db.prepare('INSERT OR REPLACE INTO geo(k,lat,lon,q,at) VALUES(?,?,?,?,?)').run(OLD, 48.28, 16.4, 'h', Date.now()); // „PLZ-Mitte“ als falscher Treffer
        db.exec("DELETE FROM meta WHERE k='geoq'");
        db.close();
      }),
      base = 'http://127.0.0.1:' + server.port;
    try {
      const token = await monteurToken(base);
      let geo = {};
      for (let i = 0; i < 240; i++) {
        geo = await json(base, '/api/geo?since=1&e=1&team=FW-IH01', token); // Gerät mit altem Stand (Epoche 1)
        if (geo.full && !geo.open) break;
        await sleep(250);
      }
      const hit = (geo.items || []).find(i => i[0] === OLD);
      report(geo.full === true && geo.e === 2, 'Koordinaten: Gerät mit altem Zwischenspeicher bekommt den ganzen neuen Stand', `full=${geo.full}, Epoche ${geo.e}`);
      report(!!hit && !(hit[1] === 48.28 && hit[2] === 16.4), 'Koordinaten: früher gespeicherte (evtl. zu grobe) Koordinaten wurden neu ermittelt', hit ? hit.slice(1, 3).join(', ') : 'Adresse fehlt');
    } finally {
      server.stop();
      geocoder.stop();
    }
  };
  // Wiener Adressdienst: Karte „Straße Nr“ -> PLZ, in denen es sie gibt (aus der Kopie der Daten), wie ihn der Dienst kennt
  const streetsOf = dir => {
    const { DatabaseSync } = require('node:sqlite'),
      db = new DatabaseSync(path.join(dir, 'data.db'), { readOnly: true }),
      map = new Map(),
      add = (key, plz) => (map.get(key) || map.set(key, new Set()).get(key)).add(plz);
    for (const r of db.prepare("SELECT DISTINCT plz, str FROM orders WHERE del=0 AND COALESCE(str,'')<>''").all()) {
      const first = r.str.split(',')[0].trim(),
        m = /^(.+?)\s+(\d+\s?[A-Za-z]?)(?:\s*[-–/].*)?$/.exec(first),
        name = m ? m[1] : first;
      if (m) add(`${name} ${m[2].replace(/\s/g, '')}`, r.plz);
      add(name, r.plz);
      add(name.replace(/\s+[A-ZÄÖÜ]$/, ''), r.plz);
    }
    db.close();
    return new Map([...map].map(([k, v]) => [k, [...v]]));
  };
  // (5) Der öffentliche Nominatim sperrt den Server (HTTP 403, wie bei dir): der Wiener Adressdienst liefert alle Koordinaten – auch wenn er
  // nur Schreibweisen ohne Sonderzeichen kennt und Breite/Länge vertauscht; gibt es die Straße in mehreren Bezirken, zählt der der PLZ
  const scenario5 = async () => {
    let streets;
    const geocoder = await startGeocoder({ nominatimStatus: 403, wienAsciiOnly: true, wienSwap: true }),
      server = await startServer(geocoder.url, dir => {
        streets = streetsOf(dir);
        geocoder.setStreets(streets);
      }, { GEOCODER_WIEN_URL: geocoder.wienUrl }),
      base = 'http://127.0.0.1:' + server.port;
    try {
      const token = await monteurToken(base);
      let geo = {};
      for (let i = 0; i < 480; i++) {
        geo = await json(base, '/api/geo?since=0&team=FW-IH01', token);
        if (!geo.open) break;
        await sleep(250);
      }
      const plzOf = k => k.split('|')[0],
        far = geo.items.filter(i => CENTERS[plzOf(i[0])] && Math.hypot((i[1] - CENTERS[plzOf(i[0])][0]) * 111, (i[2] - CENTERS[plzOf(i[0])][1]) * 74) > 3),
        multi = [...streets.values()].filter(plzs => plzs.length > 1).length;
      report(!geo.open && geo.items.length > 1000, 'Wiener Adressdienst: alle Adressen werden umgewandelt, obwohl Nominatim sperrt (403)', `${geo.items.length} Adressen, Nominatim ${geocoder.counts.nominatim}× angefragt, Wien ${geocoder.counts.wien}×`);
      report(!geo.err, 'Wiener Adressdienst: keine Störungsmeldung, solange eine Quelle funktioniert', geo.err || '');
      report(geocoder.counts.nominatim <= 3, 'Wiener Adressdienst: gesperrter Nominatim wird nicht ständig weiter angefragt', `${geocoder.counts.nominatim} Anfragen`);
      report(far.length === 0, 'Wiener Adressdienst: Koordinaten liegen im Bezirk der PLZ (Achsenreihenfolge und gleichnamige Straßen)', `${far.length} Adressen weiter als 3 km von der Bezirksmitte (${multi} Straßen gibt es in mehreren Bezirken)`);
    } finally {
      server.stop();
      geocoder.stop();
    }
  };
  // (6) Der Wiener Adressdienst liefert Unbrauchbares (z. B. Wartungsseite): Nominatim springt ein, der Wiener Dienst wird nicht ständig gefragt
  const scenario6 = async () => {
    const geocoder = await startGeocoder({ wienBad: true }),
      server = await startServer(geocoder.url, null, { GEOCODER_WIEN_URL: geocoder.wienUrl }),
      base = 'http://127.0.0.1:' + server.port;
    try {
      const token = await monteurToken(base);
      let geo = {};
      for (let i = 0; i < 240; i++) {
        geo = await json(base, '/api/geo?since=0&team=FW-IH01', token);
        if (!geo.open) break;
        await sleep(250);
      }
      report(!geo.open && geo.items.length > 1000, 'Wiener Adressdienst kaputt: Nominatim springt ein', `${geo.items.length} Adressen`);
      report(geocoder.counts.wien <= 3, 'Wiener Adressdienst kaputt: wird nicht ständig weiter angefragt', `${geocoder.counts.wien} Anfragen`);
    } finally {
      server.stop();
      geocoder.stop();
    }
  };
  await Promise.all([scenario1(), scenario2(), scenario3(), scenario4(), scenario5(), scenario6()]);
}
// Ortung durch den Disponenten (Tab „Geräte“): Monteur-Geräte antworten auf die Abfrage, die Karte zeigt den Standort bzw. den Grund,
// warum es keinen gibt; „Ausloggen“ bringt das Gerät zum Startbildschirm, und die erneute Anmeldung bleibt bestehen.
async function deviceChecks(browser, base, errors) {
  console.log('\n=== Ortung durch den Disponenten (Geräte) ===');
  const vp = { width: 390, height: 844 },
    didOf = page => page.evaluate(() => localStorage.getItem('did')),
    deviceCard = (page, did) => page.evaluate(did => { const c = [...document.querySelectorAll('#app .card.dv')].find(n => n.dataset.k === 'd' + did); return c ? c.innerText.replace(/\s+/g, ' ') : null; }, did),
    waitCard = async (page, did, re, ms = 14000) => {
      for (let t = 0; t < ms; t += 500) {
        const text = await deviceCard(page, did);
        if (text && re.test(text)) return text;
        await page.waitForTimeout(500);
      }
      return await deviceCard(page, did);
    };
  const monteur = await newPage(browser, base, vp, errors),
    denied = await newPage(browser, base, vp, errors, { geolocation: false, denyLocation: true }),
    dispo = await newPage(browser, base, vp, errors, { geolocation: false });
  // TEST_DEBUG=1: Anfragen des Monteur-Geräts mit Zeit mitschreiben (zum Eingrenzen sporadischer Fehler)
  const trace = [],
    t0 = Date.now();
  if (process.env.TEST_DEBUG)
    monteur.on('response', async r => {
      const u = r.url().replace(base, '');
      if (/^\/api\/(sync|user\/login|push\/sub)/.test(u)) trace.push(`${Date.now() - t0} ms ${r.request().method()} ${u.slice(0, 40)} ${/login/.test(u) ? (r.request().postData() || '').replace(/"password":"([^"]*)"/, (m, pw) => `"password":<${pw.length} Zeichen>`) : ''} -> ${r.status()} ${(await r.text().catch(() => '')).replace(/"(orders|ergebnis|teams)":\[[^\]]*\]/g, '').slice(0, 90)}`);
    });
  await loginMonteur(monteur);
  await loginMonteur(denied);
  const [didMonteur, didDenied] = [await didOf(monteur), await didOf(denied)];
  await loginDispo(dispo);
  await dispo.evaluate(() => [...document.querySelectorAll('#app .tabs button')].find(b => b.textContent.trim() === 'Geräte').click());
  const found = await waitCard(dispo, didMonteur, /Auf Karte öffnen · ±25 m/);
  report(/Auf Karte öffnen · ±25 m/.test(found || ''), 'Geräte: Monteur-Gerät antwortet auf die Standortabfrage', (found || 'Karte fehlt').slice(-80));
  report(await monteur.evaluate(() => /Standort abgefragt/.test(document.querySelector('.toast').textContent)), 'Geräte: Monteur sieht „Der Disponent hat deinen Standort abgefragt“');
  const refused = await waitCard(dispo, didDenied, /Standort nicht freigegeben/);
  report(/Standort nicht freigegeben/.test(refused || ''), 'Geräte: verweigerter Standort wird als „nicht freigegeben“ gezeigt', (refused || 'Karte fehlt').slice(-80));
  // Geräte ohne Standort, die nicht geöffnet sind, antworten nie: das steht dort so, statt „noch keine Antwort“
  const stale = await dispo.evaluate(() => [...document.querySelectorAll('#app .card.dv')].map(c => c.innerText.replace(/\s+/g, ' ')).filter(t => /Monteur/.test(t) && /Offline/.test(t) && /📍 (Standort: noch keine Antwort|Gerät ist offline)/.test(t)));
  report(stale.every(t => /Gerät ist offline/.test(t)), 'Geräte: nicht geöffnete Geräte ohne Standort sagen „offline“', `${stale.length} Geräte`);
  // „Standorte jetzt aktualisieren“: das Gerät antwortet neu (neuer Zeitstempel)
  await probe(dispo, 'Geräte: „Standorte jetzt aktualisieren“', btn('/Standorte jetzt aktualisieren/'), { at: 300, ms: 1500 });
  const again = await waitCard(dispo, didMonteur, /Auf Karte öffnen · ±25 m · (gerade eben|vor 0 Min)/);
  report(/Auf Karte öffnen/.test(again || ''), 'Geräte: nach „jetzt aktualisieren“ weiterhin Standort', (again || '').slice(-60));
  // Ausloggen: das Gerät kehrt zum Startbildschirm zurück
  const click = (page, did, re) => page.evaluate(({ did, src }) => { const c = [...document.querySelectorAll('#app .card.dv')].find(n => n.dataset.k === 'd' + did); [...c.querySelectorAll('button')].find(b => new RegExp(src).test(b.textContent.trim())).click(); }, { did, src: re });
  await click(dispo, didMonteur, '^Ausloggen$');
  await dispo.waitForTimeout(300);
  await click(dispo, didMonteur, 'Wirklich ausloggen');
  await monteur.waitForTimeout(2500);
  const afterKick = await monteur.evaluate(() => ({ start: !!([...document.querySelectorAll('#app button')].find(b => /Ich bin Monteur/.test(b.textContent))), msg: ((document.querySelector('#app .msg') || {}).textContent || '') }));
  report(afterKick.start && /abgemeldet/.test(afterKick.msg), 'Geräte: ausgeloggtes Gerät kehrt zum Startbildschirm zurück', afterKick.msg.slice(0, 60));
  // erneut anmelden: bleibt angemeldet (wird nicht sofort wieder abgemeldet)
  await loginMonteur(monteur);
  await monteur.waitForTimeout(3000);
  const afterLogin = await monteur.evaluate(() => ({ list: !![...document.querySelectorAll('#app button')].find(b => /^Entfernung$/.test(b.textContent.trim())), msg: ((document.querySelector('#app .msg') || {}).textContent || '') }));
  report(afterLogin.list && !/abgemeldet/.test(afterLogin.msg), 'Geräte: erneute Anmeldung nach dem Ausloggen bleibt bestehen', `Liste sichtbar: ${afterLogin.list} · ${afterLogin.msg.slice(0, 60)}`);
  if (process.env.TEST_DEBUG && !(afterLogin.list && !/abgemeldet/.test(afterLogin.msg))) console.log(trace.slice(-25).join('\n'));
  for (const page of [monteur, denied, dispo]) await page.context().close();
}
// Schrift (Inter aus /fonts): wird geliefert, alle vier Schnitte sind aktiv, und beim Laden der Seite verschiebt sich nichts
// (die App zeichnet erst, wenn die Schrift da ist; gemessen mit dem Browser-Maß „Layout Shift“)
async function fontChecks(browser, base, errors) {
  console.log('\n=== Schrift ===');
  for (const f of ['regular', 'medium', 'semibold', 'bold']) {
    const r = await fetch(`${base}/fonts/inter-${f}.woff2`);
    report(r.ok && /font\/woff2/.test(r.headers.get('content-type') || '') && (await r.arrayBuffer()).byteLength > 5000, `Schrift: inter-${f}.woff2 wird ausgeliefert`, `${r.status} ${r.headers.get('content-type')}`);
  }
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 }),
      page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.__cls = 0;
      try {
        new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
      } catch (e) {}
    });
    await page.goto(base);
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => ({
      weights: ['400', '500', '600', '700'].map(w => document.fonts.check(`${w} 16px Inter`)),
      family: getComputedStyle(document.body).fontFamily,
      cls: window.__cls
    }));
    report(info.weights.every(Boolean) && /^"?Inter/.test(info.family), `Schrift ${vp.width}px: Inter (400/500/600/700) ist aktiv`, `${info.weights.join('/')} · ${info.family.slice(0, 30)}`);
    report(info.cls < 0.02, `Schrift ${vp.width}px: kein Layout-Sprung beim Laden der Seite`, `Layout Shift ${info.cls.toFixed(4)}`);
    await ctx.close();
  }
}
// Ungenauer Standort (z. B. PC ohne GPS: Ortung nur auf Kilometer genau): Hinweis über der Liste und Kurzmeldung
async function poorAccuracyChecks(browser, base, errors) {
  console.log('\n=== Entfernung mit ungenauem Standort ===');
  const page = await newPage(browser, base, { width: 390, height: 844 }, errors, { accuracy: 14000 });
  await loginMonteur(page);
  const h0 = await page.evaluate(() => Math.round(document.querySelector('#app .cnt').getBoundingClientRect().height));
  await probe(page, 'Entfernung mit ungenauem Standort: Knopf bleibt stehen', btn('/^Entfernung$/'), { at: 300, ms: 1800 });
  const info = await page.evaluate(() => ({ cnt: document.querySelector('#app .cnt').textContent, h: Math.round(document.querySelector('#app .cnt').getBoundingClientRect().height), toast: document.querySelector('.toast').textContent }));
  report(/Standort ungenau \(±14 km\)/.test(info.cnt), 'Entfernung mit ungenauem Standort: Zeile nennt „Standort ungenau (±14 km)“', info.cnt);
  report(/nur auf ±14 km genau/.test(info.toast), 'Entfernung mit ungenauem Standort: Kurzmeldung erklärt es', info.toast.slice(0, 60));
  report(info.h === h0, 'Entfernung mit ungenauem Standort: Zeile über der Liste bleibt gleich hoch', `${h0} → ${info.h} px`);
  await page.context().close();
}
// Standort nicht erlaubt: Hinweis statt Absturz, Liste bleibt nach Auftragsnummer, nichts springt
async function noLocationChecks(browser, base, errors) {
  console.log('\n=== Entfernung ohne Standort-Erlaubnis ===');
  const page = await newPage(browser, base, { width: 390, height: 844 }, errors, { geolocation: false, denyLocation: true });
  await loginMonteur(page);
  const nrOrder = (await readDistances(page)).map(c => c.k);
  await probe(page, 'Entfernung ohne Erlaubnis: Knopf bleibt stehen', btn('/^Entfernung$/'), { at: 300, ms: 1800 });
  const info = await page.evaluate(() => ({ cnt: document.querySelector('#app .cnt').textContent, toast: document.querySelector('.toast').classList.contains('on') }));
  report(/kein Standort/.test(info.cnt), 'Entfernung ohne Erlaubnis: Zeile nennt „kein Standort“', info.cnt);
  report(info.toast, 'Entfernung ohne Erlaubnis: Kurzmeldung erscheint');
  const now = await readDistances(page);
  report(now.map(c => c.k).join() === nrOrder.join() && now.every(c => c.km == null), 'Entfernung ohne Erlaubnis: Liste bleibt nach Auftragsnummer');
  await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => b.textContent === 'Auftragsnummer').click());
  await page.context().close();
}

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
    await chooseKind(page, 'Wartungen'); // nach dem Neuladen beginnt der Monteur wieder auf der Startseite
  }
  // Filter, Sortierung (unterwegs auf der Liste)
  for (const f of ['Alle', 'Erledigt', 'Nicht OK', 'Offen'])
    await probe(page, `${label} Liste: Filter „${f}“`, btn(`/^${f}/`), { at: 300 });
  const sortButtons = await page.evaluate(() => [...document.querySelectorAll('#app .chips.ab button')].map(b => b.textContent.trim()));
  report(sortButtons.join(',') === 'Auftragsnummer,Entfernung', `${label} Liste: Sortierung nur nach Auftragsnummer und Entfernung (kein Termin)`, sortButtons.join(', '));
  await probe(page, `${label} Liste: Sortierung Auftragsnummer`, btn('/^Auftragsnummer$/'), { at: 300 });
  await distanceChecks(page, label);

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


// ---------- Auftragsarten: Reparatur, Entstörung, Dauerauftrag, Meldungen ----------
// ---------- Disposition per API ----------
// Reparaturen und Entstörungen sehen Monteure erst, wenn der Disponent sie disponiert hat (Tab „Disposition“). dispositionChecks()
// übernimmt am Ende „Alle Vorschläge“ (SAP-Team, Beginn und Ende laut SAP; fehlt das Ende, gilt die geplante Arbeit in Stunden, sonst
// 2 Stunden): so sehen die Monteur-Prüfungen danach feste, bekannte Zeiten.
const apiJson = async (base, method, url, body, headers = {}) =>
  (await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })).json();
const dispoHeaders = async base => ({ Authorization: 'Bearer ' + (await apiJson(base, 'POST', '/api/login', { pin: DISPO_PIN })).token });
const plusMinutes = (stamp, min) => new Date(Date.parse(stamp + ':00Z') + min * 6e4).toISOString().slice(0, 16);
// Reparaturen und Entstörungen laut Server (Sicht des Disponenten) · Dispositionen aller Aufträge aufheben (nur über die API)
async function dispatchOrders(base) {
  const H = await dispoHeaders(base);
  return (await apiJson(base, 'GET', '/api/sync?since=0&team=', null, H)).orders.filter(o => o.kind === 'rep' || o.kind === 'ent');
}
async function undispatchAll(base) {
  const H = await dispoHeaders(base),
    items = (await dispatchOrders(base)).filter(o => o.dis).map(o => ({ a: o.auftrag, off: true }));
  if (items.length) await apiJson(base, 'POST', '/api/dispo', { items }, H);
}
// Aufträge, die ein Monteur des Teams (Test-Monteur) vom Server bekommt, nach Auftragsart
async function monteurKinds(base) {
  const login = await apiJson(base, 'POST', '/api/user/login', { user: MONTEUR.user, password: MONTEUR.password }),
    sync = await apiJson(base, 'GET', '/api/sync?since=0&team=FW-IH01', null, { 'X-User-Token': login.token }),
    n = {};
  for (const o of sync.orders) n[o.kind || 'war'] = (n[o.kind || 'war'] || 0) + 1;
  return n;
}

// Erzeugt kleine Excel-Dateien wie die aus SAP (Aufträge, Vorgänge, Meldungen) für das Team des Test-Monteurs (FW-IH01) und lädt sie
// über die Upload-Seite hoch – das prüft zugleich das Lesen der drei Dateiarten. Wartungsaufträge sind absichtlich NICHT in der Datei:
// sie müssen den Upload unversehrt überstehen.
const excelDay = offset => {
  const d = new Date();
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + offset) / 864e5) + 25569;
};
function kindFiles() {
  const X = require(path.join(ROOT, 'public', 'vendor', 'xlsx.full.min.js')),
    book = rows => {
      const wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rows), 'Tabelle1');
      return Buffer.from(X.write(wb, { type: 'array', bookType: 'xlsx' }));
    },
    T = 'FW-IH01',
    T2 = 'FW-IH02',
    xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const orders = [
    ['Auftrag', 'Kurztext', 'Postleitzahl', 'Straße', 'Verantw.ArbPl.', 'Auftragsart', 'Term. Start', 'Erfasser', 'Techn. Platz', 'IH-Leistungsart', 'Systemstatus', 'Meldung'],
    ['65900001', 'Gebrechen Testgasse', '1210', 'Testgasse 1', T, '3NAR', excelDay(2), 'X', 'TP-1', 'I42', 'FREI', ''],
    ['65900002', 'Schieber Teststraße', '1210', 'Teststraße 2', T, '3NAR', excelDay(1), 'X', 'TP-2', 'I42', 'FREI', ''],
    ['65900008', 'Alter Auftrag', '1210', 'Teststraße 8', T, '3NAR', excelDay(-3), 'X', 'TP-8', 'I42', 'FREI', ''],
    ['65900003', 'Dampf im Schacht', '1210', 'Schachtgasse 3', T, '3NAE', excelDay(0), 'X', 'TP-3', '', 'FREI', '1290000001'],
    ['65900004', 'Nächtliche Störung', '1210', 'Nachtweg 4', T, '3NAE', excelDay(-1), 'X', 'TP-4', '', 'FREI', ''],
    ['65900005', 'Allg. Tätigkeiten ohne eigenen Auftrag', '', '', T, '3NAW', excelDay(-200), 'X', 'F-N-K', 'FWD', 'FREI', ''],
    ['65900006', 'Anderer Auftrag (3NAV)', '1210', 'Nirgendwo 6', T, '3NAV', excelDay(0), 'X', 'TP-6', 'F07', 'FREI', ''],
    ['65900009', 'Nur Fremdfirma', '1210', 'Fremdgasse 9', T, '3NAR', excelDay(3), 'X', 'TP-9', 'I42', 'FREI', ''],
    ['65900010', 'Nur geplant', '1210', 'Plangasse 10', T, '3NAR', excelDay(4), 'X', 'TP-10', 'I42', 'FREI', '']
  ];
  const stepHead = ['Auftrag', 'Auftragsart', 'Eckstarttermin', 'Eckendtermin', 'Kurztext', 'Vorgang', 'Kurztext Vrg.', 'Verantw.ArbPl.', 'IH-Leistungsart', 'Anwenderstat.', 'Sortierfeld', 'VrgArbeitsplatz', 'Arbeit', 'Iststart Uzt', 'Istende Uzt', 'Istarbeit'];
  const steps = [
    stepHead,
    ['65900001', '3NAR', excelDay(2), null, 'Gebrechen Testgasse', '0010', 'Rohr tauschen', T, 'I42', '', '', T, 8, '06:00:00', '00:00:00', 0],
    ['65900001', '3NAR', excelDay(2), null, 'Gebrechen Testgasse', '0020', 'Kabel prüfen', T, 'I42', '', '', T2, 4, '06:00:00', '00:00:00', 0],
    // externe Firma (FW-IHEXT) arbeitet mit; ein Vorgang des geplanten Teams (FW-IH01P) ist noch nicht fix und erscheint nirgends
    ['65900001', '3NAR', excelDay(2), null, 'Gebrechen Testgasse', '0030', 'Fremdfirma: Kabel ziehen', T, 'I42', '', '', 'FW-IHEXT', 6, '06:00:00', '00:00:00', 0],
    ['65900001', '3NAR', excelDay(2), null, 'Gebrechen Testgasse', '0040', 'Geplante Nacharbeit', T, 'I42', '', '', 'FW-IH01P', 3, '00:00:00', '00:00:00', 0],
    ['65900009', '3NAR', excelDay(3), null, 'Nur Fremdfirma', '0010', 'Graben durch Fremdfirma', T, 'I42', '', '', 'FW-IHEXT', 12, '00:00:00', '00:00:00', 0],
    ['65900010', '3NAR', excelDay(4), null, 'Nur geplant', '0010', 'Noch nicht fix', T, 'I42', '', '', 'FW-IH01P', 8, '00:00:00', '00:00:00', 0],
    ['65900002', '3NAR', excelDay(1), null, 'Schieber Teststraße', '0010', 'Schieber tauschen', T, 'I42', '', '', T, 4, '13:30:00', '00:00:00', 0],
    ['65900008', '3NAR', excelDay(-3), null, 'Alter Auftrag', '0010', 'Alter Vorgang', T, 'I42', '', '', T, 2, '09:00:00', '00:00:00', 0],
    ['65900003', '3NAE', excelDay(0), excelDay(0), 'Dampf im Schacht', '0010', 'Störungsanalyse & Erstmaßnahmen', T, '', '', '', T, 2, '08:30:00', '10:15:00', 0],
    ['65900004', '3NAE', excelDay(-1), excelDay(0), 'Nächtliche Störung', '0010', 'Störungsanalyse & Erstmaßnahmen', T, '', '', '', T, 2, '22:00:00', '05:30:00', 0]
  ];
  const meldungen = [
    ['Angelegt am', 'Meldung', 'Beschreibung', 'Straße', 'Postleitzahl', 'Auftrag', 'Codier.Code.Txt', 'Techn. Platz', 'Anwenderstat.', 'Verantw.ArbPl.', 'Codier.Grp.Text'],
    [excelDay(0), '1290000001', 'Dampf aus dem Schacht', 'Schachtgasse    3', '1210', '65900003', 'Gebrechen stark', 'TP-3', 'prag', T, 'WN: FW Störmeldung'],
    [excelDay(-1), '1290000002', 'Rohrbruch Testgasse', 'Testgasse    1', '1210', '65900001', 'Schaden', 'TP-1', 'prag', T, 'Mängelkategorien'],
    [excelDay(-2), '1290000003', 'Deckel locker Teststraße 5', 'Teststraße    5', '1210', '', 'Gebrechen mittel', 'TP-5', 'prag', T, 'WN: FW Störmeldung'],
    [excelDay(-2), '1290000004', 'Fremdes Team Gebrechen', 'Andere Gasse 1', '1020', '', 'Gebrechen leicht', 'TP-9', 'prag', T2, 'WN: FW Störmeldung'],
    [excelDay(-9), '1290000005', 'Graffiti am Schachtdeckel', 'Teststraße    7', '1210', '', 'Schaden', 'TP-7', 'prag', T, 'Mängelkategorien']
  ];
  return {
    auftraege: { name: 'Aufträge_neu.xlsx', mimeType: xlsx, buffer: book(orders) },
    vorgaenge: { name: 'Vorgänge_neu.xlsx', mimeType: xlsx, buffer: book(steps) },
    meldungen: { name: 'Meldungen_neu.xlsx', mimeType: xlsx, buffer: book(meldungen) }
  };
}
// Disponent lädt die drei Dateien einzeln (je eine Karte auf der Upload-Seite) hoch; Wartungsaufträge bleiben unberührt
async function kindUploadChecks(browser, base, errors) {
  console.log('\n=== Auftragsarten: Upload (Aufträge, Vorgänge, Meldungen – jede Datei einzeln) ===');
  const files = kindFiles(),
    page = await newPage(browser, base, { width: 1100, height: 900 }, errors);
  await loginDispo(page);
  const kindBar = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#app .ksw button')].map(b => [b.textContent.replace(/[^A-Za-zäöüÄÖÜß]/g, ' ').trim().split(/\s+/)[0], +(/\((\d+)\)/.exec(b.textContent) || [])[1]])));
  const tab = async name => {
    await page.evaluate(n => [...document.querySelectorAll('#app .tabs button')].find(b => b.textContent.trim() === n).click(), name);
    await pause(page, 700);
  };
  const openUpload = async () => {
    await tab('Upload');
    await page.click('input[data-keep="u"]');
    await page.keyboard.type('1025');
    await pause(page, 1500);
  };
  const msgText = () => page.evaluate(() => [...document.querySelectorAll('#app .msg')].map(n => n.textContent).join(' | '));
  // Datei in das Feld `part` legen und hochladen; Ergebnis: Text der Meldung und größter Schritt, den der Knopf beim Verschieben macht.
  // Die Meldungen „Lese Datei …“ → „Speichere …“ → Ergebnis erscheinen oben und schieben den Inhalt nach unten. Das muss weich geschehen:
  // der Knopf wandert über mehrere Bilder, nie mehr als 12 px in einem Bild. (probe() verfolgt den Knopf über die Beschriftung und würde den
  // Wechsel „Hochladen“ → „Speichere …“ als Sprung sehen – darum hier die Messung von Hand.)
  const upload = async (part, file) => {
    const slot = { auftraege: 'orders', vorgaenge: 'vorg', meldungen: 'mel' }[part],
      prev = await msgText();
    await page.setInputFiles(`#app input[data-up="${slot}"]`, file);
    await page.evaluate(() => scrollTo(0, 0));
    const frames = await page.evaluate(
      slot =>
        new Promise(resolve => {
          const find = () => document.querySelector(`#app [data-k="up-${slot}"] button.pri`),
            tops = [],
            t0 = performance.now();
          find().click();
          const loop = () => {
            const b = find();
            if (b) tops.push(Math.round(b.getBoundingClientRect().top * 10) / 10);
            if (performance.now() - t0 < 2200) requestAnimationFrame(loop);
            else resolve(tops);
          };
          requestAnimationFrame(loop);
        }),
      slot
    );
    await page.waitForFunction(prev => { const t = [...document.querySelectorAll('#app .msg')].map(n => n.textContent).join(' | '); return t && t !== prev && !/Lese Datei|Speichere/.test(t); }, prev, { timeout: 20000 });
    const steps = frames.slice(1).map((v, i) => Math.abs(v - frames[i]));
    return { text: await msgText(), step: Math.max(...steps), moved: Math.abs(frames[frames.length - 1] - frames[0]) };
  };
  const before = await kindBar();
  await openUpload();
  const cards = await page.evaluate(() => [...document.querySelectorAll('#app .ugrid > .card > b')].map(n => n.textContent));
  report(cards.join() === 'Aufträge,Vorgänge,Meldungen,Prüfobjekte', 'Upload: vier Felder – Aufträge, Vorgänge, Meldungen, Prüfobjekte', cards.join(', '));
  // 1. nur die Aufträge: Reparaturen sind noch ein Auftrag je Auftragsnummer, die App weist auf die fehlenden Vorgänge hin
  let r = await upload('auftraege', files.auftraege);
  report(r.step <= 12 && r.moved > 20, 'Upload Aufträge: Hinweise schieben den Inhalt weich nach unten', `${r.moved.toFixed(0)} px, größter Schritt ${r.step.toFixed(0)} px`);
  report(/Aufträge gespeichert/.test(r.text) && /5 Reparaturen/.test(r.text) && /2 Entstörungen/.test(r.text) && /1 Dauerauftrag/.test(r.text), 'Upload Aufträge: Meldung nennt die Anzahl je Auftragsart', r.text.slice(0, 260));
  report(/1 Auftrag anderer Auftragsarten übergangen \(1× 3NAV\)/.test(r.text), 'Upload Aufträge: fremde Auftragsart (3NAV) wird übergangen und gemeldet');
  report(/Für Reparaturen fehlt noch die Vorgänge-Excel/.test(r.text), 'Upload Aufträge: Hinweis, dass die Vorgänge-Excel für Reparaturen noch fehlt');
  // 2. nur die Vorgänge: jeder Vorgang wird ein Auftrag, geplante Teams (P) entfallen
  r = await upload('vorgaenge', files.vorgaenge);
  report(/10 Vorgänge zu 7 Aufträgen gespeichert/.test(r.text) && /jetzt:.* 5 Reparaturen/.test(r.text), 'Upload Vorgänge: Meldung nennt Vorgänge und die neue Zahl der Reparaturen', r.text.slice(0, 220));
  report(/2 geplante Vorgänge \(Team mit „P“\) noch nicht angezeigt/.test(r.text), 'Upload Vorgänge: geplante Vorgänge (Team mit P) werden nicht angezeigt und gemeldet');
  // 3. nur die Meldungen
  r = await upload('meldungen', files.meldungen);
  report(/5 Meldungen gespeichert/.test(r.text), 'Upload Meldungen: Meldung nennt die Anzahl', r.text);
  await page.waitForFunction(() => !document.querySelector('#app .msg'), null, { timeout: 15000 }); // der Hinweis verschwindet nach 8 s von selbst
  await tab('Übersicht');
  await pause(page, 500);
  const after = await kindBar();
  report(before.Wartungen > 0 && after.Wartungen === before.Wartungen, 'Upload: Wartungsaufträge bleiben unversehrt', `${before.Wartungen} → ${after.Wartungen}`);
  report(after.Reparaturen === 5 && after.Entstörungen === 2 && after.Daueraufträge === 1, 'Upload: Dispo-Übersicht zählt je Auftragsart', JSON.stringify(after));
  report(after.Meldungen === 3, 'Upload: Meldungen ohne Auftrag gezählt (alle Teams)', String(after.Meldungen));
  // Dispo: Umschalter der Auftragsart – Leiste bleibt stehen
  await probe(page, 'Dispo Übersicht: Auftragsart Reparaturen (Inhalt blendet ein, Umschalter bleibt)', btn('/Reparaturen/'), { ms: 900, reflow: true, anim: true });
  report(await page.evaluate(() => ![...document.querySelectorAll('#app button')].some(b => /^(Erledigt|In Arbeit|Nicht OK)/.test(b.textContent.trim()))), 'Dispo Übersicht: Reparaturen ohne Status-Filter (Erledigt, In Arbeit, Nicht OK)');
  const cardsOf = () => page.evaluate(() => [...document.querySelectorAll('#app [data-list] > [data-k]')].map(n => n.textContent.replace(/\s+/g, ' ').slice(0, 300)));
  const reps = await cardsOf();
  report(reps.some(t => /65900001.*Vorgang 0010.*FW-IH01/.test(t)) && reps.some(t => /65900001.*Vorgang 0020.*FW-IH02/.test(t)), 'Dispo Übersicht: jeder Vorgang einer Reparatur ist ein eigener Auftrag (mit seinem Team)');
  report(await page.evaluate(() => { const c = document.querySelector('#app [data-k="o65900008-0010"]'); return !!c && /im Verzug · 3 Tage/.test(c.textContent) && /\bdue\b/.test(c.className); }), 'Dispo Übersicht: Reparatur im Verzug ist hervorgehoben');
  report(reps.some(t => /65900001.*Vorgang 0010.*Testgasse 1/.test(t)), 'Dispo Übersicht: Auftrag und Vorgang sind zusammengesetzt (Adresse aus den Aufträgen)');
  report(reps.length === 5 && reps.every(t => /nicht disponiert/.test(t)), 'Dispo Übersicht: Reparaturen tragen das Etikett „nicht disponiert“, solange nichts disponiert ist', String(reps.filter(t => /nicht disponiert/.test(t)).length));
  const teamsSeen = await page.evaluate(() => [...document.querySelectorAll('#app select option')].map(o => o.textContent.trim().split(' ')[0]));
  report(!teamsSeen.some(t => /EXT$|\dP$/.test(t)) && !reps.some(t => /Vorgang 0030|Vorgang 0040|65900010/.test(t)), 'Dispo Übersicht: weder FW-IHEXT noch Teams mit „P“ erscheinen als Team oder Auftrag', teamsSeen.join(', '));
  report(reps.some(t => /65900009.*FW-IH01/.test(t) && /Externe Firma/.test(t)) && reps.some(t => /65900001.*Vorgang 0010.*Externe Firma/.test(t)), 'Dispo Übersicht: Aufträge mit externer Firma sind gekennzeichnet (auch bei nur externen Vorgängen)');
  await probe(page, 'Dispo Übersicht: Auftragsart Meldungen', btn('/Meldungen/'), { ms: 900, reflow: true, anim: true });
  const mels = await page.evaluate(() => [...document.querySelectorAll('#app [data-list] > [data-k]')].length);
  report(mels === 3, 'Dispo Übersicht: Liste Meldungen zeigt die Meldungen ohne Auftrag', String(mels));
  await probe(page, 'Dispo Übersicht: Meldungen „Mit Auftrag“', btn('/^Mit Auftrag/'), { at: 330 });
  await probe(page, 'Dispo Übersicht: Meldungen „Alle“', btn('/^Alle \\(/'), { at: 330 });
  // Gebrechen sind hervorgehoben: Etikett mit der Schwere (leicht, mittel, stark – drei Farben) und Kante an der Karte; klein wie die übrigen Etiketten
  const gb = await page.evaluate(() => {
    const tag = n => document.querySelector(`#app [data-k="${n}"] .tag.gb`),
      look = n => { const t = tag(n); if (!t) return null; const cs = getComputedStyle(t); return { text: t.textContent, bg: cs.backgroundColor, col: cs.color, h: Math.round(t.getBoundingClientRect().height), card: getComputedStyle(t.closest('.card')).borderLeftColor, w: getComputedStyle(t.closest('.card')).borderLeftWidth }; },
      plain = document.querySelector('#app [data-k="m1290000002"] .row .tag:not(.gb)');
    return { stark: look('m1290000001'), mittel: look('m1290000003'), leicht: look('m1290000004'), plainH: plain ? Math.round(plain.getBoundingClientRect().height) : null, schaden: !tag('m1290000002') };
  });
  report(gb.stark && gb.mittel && gb.leicht && /stark/.test(gb.stark.text) && /mittel/.test(gb.mittel.text) && /leicht/.test(gb.leicht.text), 'Meldungen: Gebrechen leicht/mittel/stark tragen ein Etikett mit der Schwere', JSON.stringify([gb.leicht && gb.leicht.text, gb.mittel && gb.mittel.text, gb.stark && gb.stark.text]));
  report(!!gb.stark && new Set([gb.stark.card, gb.mittel.card, gb.leicht.card]).size === 3 && new Set([gb.stark.bg, gb.mittel.bg, gb.leicht.bg]).size === 3 && gb.stark.w === '4px', 'Meldungen: die drei Schweregrade haben eigene Farben (Etikett und Kante der Karte)', JSON.stringify([gb.leicht && gb.leicht.card, gb.mittel && gb.mittel.card, gb.stark && gb.stark.card]));
  report(gb.schaden && gb.stark.h - gb.plainH <= 2, 'Meldungen: Schaden bleibt unauffällig, das Gebrechen-Etikett ist nicht höher als ein normales', `Etikett ${gb.stark.h} px, normal ${gb.plainH} px`);
  await probe(page, 'Dispo Übersicht: Auftragsart Wartungen', btn('/Wartungen/'), { ms: 900, reflow: true, anim: true });
  report(await page.evaluate(() => [...document.querySelectorAll('#app button')].some(b => /^Erledigt/.test(b.textContent.trim())) && [...document.querySelectorAll('#app button')].some(b => /^Nicht OK/.test(b.textContent.trim()))), 'Dispo Übersicht: Wartungen mit Status-Filter (Nicht OK, Erledigt …)');
  // Die Dateien sind unabhängig: erneut NUR die Aufträge hochladen lässt die Vorgänge in Ruhe (und umgekehrt die Adressen)
  await openUpload();
  r = await upload('auftraege', files.auftraege);
  report(!/Für Reparaturen fehlt noch/.test(r.text), 'Upload Aufträge erneut: die vorhandenen Vorgänge werden weiter verwendet', r.text.slice(0, 200));
  await page.waitForFunction(() => !document.querySelector('#app .msg'), null, { timeout: 15000 });
  await tab('Übersicht');
  await chooseKind(page, 'Reparaturen');
  let again = await cardsOf();
  report(again.length === 5 && again.some(t => /65900001.*Vorgang 0020/.test(t)), 'Upload Aufträge erneut: Reparaturen bleiben je Vorgang erhalten', `${again.length} Aufträge`);
  await openUpload();
  r = await upload('vorgaenge', files.vorgaenge);
  await page.waitForFunction(() => !document.querySelector('#app .msg'), null, { timeout: 15000 });
  await tab('Übersicht');
  await chooseKind(page, 'Reparaturen');
  again = await cardsOf();
  report(again.length === 5 && again.some(t => /65900001.*Vorgang 0010.*Testgasse 1/.test(t)), 'Upload Vorgänge erneut: Adressen aus den Aufträgen bleiben erhalten', `${again.length} Aufträge`);
  // eine Datei im falschen Feld: klare Fehlermeldung statt falscher Daten
  await openUpload();
  await page.setInputFiles('#app input[data-up="mel"]', files.vorgaenge);
  await page.evaluate(() => document.querySelector('#app [data-k="up-mel"] button.pri').click());
  await page.waitForFunction(() => /Das ist keine Meldungen-Excel/.test((document.querySelector('#app .msg.er') || {}).textContent || ''), null, { timeout: 15000 });
  report(true, 'Upload: Vorgänge-Datei im Feld „Meldungen“ wird mit einem klaren Hinweis abgelehnt', await msgText());
  await page.context().close();
  // Disposition: Monteure sehen Reparaturen und Entstörungen erst, wenn der Disponent sie disponiert hat
  const undispatched = await monteurKinds(base);
  report(!undispatched.rep && !undispatched.ent && undispatched.war > 0 && undispatched.dau === 1, 'Disposition: Monteure sehen Reparaturen und Entstörungen erst nach der Disposition (Wartung und Dauerauftrag wie bisher)', JSON.stringify(undispatched));
  // (disponiert wird anschließend in dispositionChecks über den Tab „Disposition“)
}
// ---------- Disposition: Gantt-Diagramm (Tab „Disposition“) ----------
// Reparaturen und Entstörungen sind nach dem Upload noch nicht disponiert (siehe kindUploadChecks). Hier wird das Diagramm bedient:
// Vorschlag übernehmen, Fenster (Team, Beginn, Ende), Antippen in der Zeitachse, Balken ziehen (Zeit und Team), Länge ändern, Karte ziehen,
// Zoom/Navigation, Filter, Rückgängig, „Alle Vorschläge übernehmen“. Gemessen wird wie überall: nichts springt, alles läuft über mehrere Bilder.
// Am Ende ist alles mit dem Vorschlag aus SAP disponiert (die Monteur-Prüfungen danach rechnen mit diesen Zeiten).
async function dispositionChecks(browser, base, viewport, errors) {
  const label = `${viewport.width}px`,
    wide = viewport.width >= 900,
    todayIso = new Date().toLocaleDateString('sv-SE'),
    dayIso = n => new Date(Date.now() + n * 864e5).toLocaleDateString('sv-SE');
  console.log(`\n=== Disposition: Gantt-Diagramm (${label}) ===`);
  await undispatchAll(base);
  const page = await newPage(browser, base, viewport, errors);
  await loginDispo(page);
  const orderOf = async a => (await dispatchOrders(base)).find(o => o.auftrag === a);
  const view = () =>
    page.evaluate(() => ({
      pool: [...document.querySelectorAll('#app .gt-pc')].map(c => c.dataset.k.slice(3)),
      bars: [...document.querySelectorAll('#app .gt-bar:not(.draft)')].map(b => b.dataset.k.slice(3)),
      draft: [...document.querySelectorAll('#app .gt-bar.draft')].map(b => b.closest('.gt-row').dataset.team),
      tab: [...document.querySelectorAll('#app .tabs button')].find(b => /^Disposition/.test(b.textContent)).textContent.trim(),
      sheet: !!document.querySelector('#app .gt-sheet'),
      undo: [...document.querySelectorAll('#app .msg')].some(m => /Rückgängig/.test(m.textContent)),
      head: (document.querySelector('#app .gt-ph b') || {}).textContent
    }));
  const barRow = a => page.evaluate(a => { const b = document.querySelector(`#app .gt-bar[data-k="gb-${a}"]`); return b ? b.closest('.gt-row').dataset.team : null; }, a);
  const field = key => page.evaluate(key => { const n = document.querySelector(`#app .gt-sheet [data-keep="${key}"]`); return n ? n.value : null; }, key);
  const selectTeam = team => `el => { el.value = '${team}'; el.dispatchEvent(new Event('change', { bubbles: true })); }`;
  const settle = ms => pause(page, ms);
  await probe(page, `${label} Tab „Disposition“: Leiste bleibt stehen, Inhalt blendet ein`, btn('/^Disposition/', '#app .tabs'), { reflow: true, ms: 900, anim: true });
  let v = await view();
  const wanted = ['65900008-0010', '65900004', '65900003', '65900002-0010', '65900001-0010', '65900001-0020', '65900009'];
  report(v.pool.join() === wanted.join() && v.bars.length === 0 && v.tab === 'Disposition (7)', `${label} Disposition: 7 offene Aufträge, das Älteste zuerst (Datum laut SAP), Zahl am Tab`, `${v.tab} · ${v.pool.join(', ')}`);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#app .gt-name')].map(n => n.firstChild.textContent));
  report(rows.includes('FW-IH01') && rows.includes('FW-IH02') && rows.join() === [...rows].sort((a, b) => a.localeCompare(b, 'de', { numeric: true })).join(), `${label} Diagramm: eine Zeile je Team, sortiert`, `${rows.length} Teams`);
  const card = await page.evaluate(() => { const c = document.querySelector('#app [data-k="dp-65900002-0010"]'); return c && c.textContent.replace(/\s+/g, ' '); });
  report(/Reparatur/.test(card || '') && /FW-IH01/.test(card) && /SAP: .*13:30 Uhr/.test(card) && /4 Std geplant/.test(card) && /Vorschlag übernehmen/.test(card), `${label} Offen-Karte: Auftragsart, SAP-Team, SAP-Termin, geplante Stunden`, card);
  const nodate = await page.evaluate(() => { const c = document.querySelector('#app [data-k="dp-65900009"] .gt-go'); return c && !c.disabled; });
  report(nodate === true, `${label} Offen-Karte: auch ohne Uhrzeit gibt es einen Vorschlag (07:00)`);

  // ---- Vorschlag übernehmen: Karte verschwindet, Balken erscheint, Hinweis mit „Rückgängig“ ----
  await probe(page, `${label} Offen-Liste: „Vorschlag übernehmen“ (Karte geht, Balken blendet ein, Liste rückt nach)`, `() => document.querySelector('#app [data-k="dp-65900003"] .gt-go')`, { at: 330, ms: 1100, anim: true });
  v = await view();
  const o3 = await orderOf('65900003');
  report(!v.pool.includes('65900003') && v.pool.length === 6 && v.bars.includes('65900003') && v.undo && v.tab === 'Disposition (6)', `${label} Vorschlag übernehmen: Karte weg, Balken da, „Rückgängig“-Hinweis, Zahl am Tab`, `${v.tab} · ${v.bars.join()}`);
  report(o3 && o3.dis === 1 && o3.team === 'FW-IH01' && o3.start === todayIso && o3.uhr === '08:30' && o3.uhr2 === '10:15' && o3.sap && o3.sap.team === 'FW-IH01', `${label} Vorschlag übernehmen: Server hat Team FW-IH01, heute 08:30–10:15 und die SAP-Angaben`, JSON.stringify(o3 && { team: o3.team, start: o3.start, uhr: o3.uhr, uhr2: o3.uhr2 }));
  const geo = await page.evaluate(() => { const b = document.querySelector('#app .gt-bar[data-k="gb-65900003"]'); return { left: parseFloat(b.style.left), width: parseFloat(b.style.width), row: b.closest('.gt-row').dataset.team }; });
  report(Math.abs(geo.left - 8.5 * 48) < 1 && Math.abs(geo.width - 1.75 * 48) < 1 && geo.row === 'FW-IH01', `${label} Balken sitzt richtig auf der Zeitachse (Tag: 48 px je Stunde, 08:30 + 1:45 Std)`, JSON.stringify(geo));
  await probe(page, `${label} Hinweis „Rückgängig“ (Balken weg, Karte wieder da)`, btn('/^Rückgängig$/'), { scroll: 0, ms: 1100, tapTol: 400, smooth: '#app .gtb' });
  v = await view();
  report(v.pool.includes('65900003') && !v.bars.includes('65900003') && !(await orderOf('65900003')).dis, `${label} Rückgängig: Auftrag ist wieder offen (auch am Server)`, v.pool.join());
  await probe(page, `${label} Offen-Liste: „Vorschlag übernehmen“ nochmal`, `() => document.querySelector('#app [data-k="dp-65900003"] .gt-go')`, { at: 330, ms: 1100, anim: true });

  // ---- Fenster: Team, Beginn, Ende ----
  await probe(page, `${label} Offen-Karte antippen (Fenster gleitet von unten herein, Karte bleibt stehen)`, `() => document.querySelector('#app [data-k="dp-65900002-0010"]')`, { at: 300, ms: 1000, anim: true });
  v = await view();
  const sheetInfo = await page.evaluate(() => { const s = document.querySelector('#app .gt-sheet'); const r = s.getBoundingClientRect(); return { text: s.textContent.replace(/\s+/g, ' '), team: s.querySelector('select').value, bottom: Math.round(innerHeight - r.bottom), inside: r.top >= 0 && r.left >= 0 && r.right <= innerWidth + 1 }; });
  report(v.sheet && /65900002-0010/.test(sheetInfo.text) && /noch offen/.test(sheetInfo.text) && sheetInfo.team === 'FW-IH01' && sheetInfo.inside, `${label} Fenster: Auftrag, „noch offen“, Team FW-IH01 vorbelegt, liegt im Bild`, sheetInfo.text.slice(0, 120));
  report((await field('gv-d')) === dayIso(1) && (await field('gv-t')) === '13:30' && (await field('gb-t')) === '17:30', `${label} Fenster: Beginn und Ende mit dem Vorschlag aus SAP vorbelegt`, [await field('gv-d'), await field('gv-t'), await field('gb-d'), await field('gb-t')].join(' '));
  await probe(page, `${label} Fenster: Team wechseln (Entwurf wandert in die andere Zeile)`, `() => document.querySelector('#app .gt-sheet select')`, { act: selectTeam('FW-IH02'), ms: 700 });
  v = await view();
  report(v.draft.join() === 'FW-IH02', `${label} Fenster: gestrichelter Entwurfsbalken steht bei FW-IH02`, v.draft.join());
  await probe(page, `${label} Fenster: Dauer „4 Std“`, btn('/^4 Std$/', '#app .gt-sheet'), { ms: 700 });
  await probe(page, `${label} Fenster: Dauer „1 Std“ (Zeilen im Fenster bleiben stehen)`, btn('/^1 Std$/', '#app .gt-sheet'), { ms: 700 });
  report((await field('gb-t')) === '14:30' && (await field('gv-t')) === '13:30', `${label} Fenster: Dauer 1 Std setzt das Ende auf 14:30`, await field('gb-t'));
  // Beginn ändern: das Ende zieht mit (Dauer bleibt)
  await page.evaluate(() => { const n = document.querySelector('#app .gt-sheet [data-keep="gv-t"]'); n.value = '15:00'; n.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle(400);
  report((await field('gv-t')) === '15:00' && (await field('gb-t')) === '16:00', `${label} Fenster: Beginn 15:00 verschiebt das Ende mit (16:00, Dauer bleibt)`, `${await field('gv-t')}–${await field('gb-t')}`);
  // Ende vor Beginn: Speichern gesperrt
  await page.evaluate(() => { const n = document.querySelector('#app .gt-sheet [data-keep="gb-t"]'); n.value = '14:00'; n.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle(400);
  report(await page.evaluate(() => { const b = [...document.querySelectorAll('#app .gt-sheet button')].find(b => /Disponieren/.test(b.textContent)); return !!b && b.disabled && /nicht nach dem Beginn/.test(document.querySelector('#app .gt-sheet .qk').textContent); }), `${label} Fenster: Ende vor dem Beginn sperrt „Disponieren“ und sagt warum`);
  await probe(page, `${label} Fenster: Dauer „2 Std“ (Ende wieder gültig)`, btn('/^2 Std$/', '#app .gt-sheet'), { ms: 700 });
  // Tippen in eine Teamzeile setzt den Entwurf dorthin
  await probe(page, `${label} Zeitachse: Tipp in die Zeile FW-IH03 setzt den Entwurf dorthin`, `() => document.querySelector('#app .gt-row[data-team="FW-IH03"]')`, { ms: 700, act: `el => { const sc = document.querySelector('#app .gt-scroll').getBoundingClientRect(); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: sc.left + 150, clientY: r.top + 10 })); }` });
  v = await view();
  report(v.draft.join() === 'FW-IH03', `${label} Zeitachse: der Entwurf steht jetzt bei FW-IH03`, v.draft.join());
  report((await field('gv-d')) !== null && (await field('gb-t')) !== null && /FW-IH03/.test(await page.evaluate(() => document.querySelector('#app .gt-sheet select').selectedOptions[0].textContent)), `${label} Zeitachse: das Fenster zeigt das neue Team`);
  await probe(page, `${label} Fenster: „↶ Vorschlag aus SAP“ (Entwurf zurück zu FW-IH01, 13:30–17:30)`, btn('/Vorschlag aus SAP/', '#app .gt-sheet'), { ms: 700 });
  report((await field('gv-t')) === '13:30' && (await field('gb-t')) === '17:30' && (await page.evaluate(() => document.querySelector('#app .gt-sheet select').value)) === 'FW-IH01', `${label} Vorschlag aus SAP stellt Team und Zeit zurück`);
  await probe(page, `${label} Fenster: Team FW-IH02`, `() => document.querySelector('#app .gt-sheet select')`, { act: selectTeam('FW-IH02'), ms: 600 });
  await probe(page, `${label} Fenster: „✓ Disponieren“ (Fenster gleitet weg, Balken blendet ein, Karte geht)`, btn('/Disponieren$/', '#app .gt-sheet'), { ms: 1100, anim: true });
  v = await view();
  const o2 = await orderOf('65900002-0010');
  report(!v.sheet && v.bars.includes('65900002-0010') && !v.pool.includes('65900002-0010') && (await barRow('65900002-0010')) === 'FW-IH02', `${label} Disponieren: Fenster zu, Balken bei FW-IH02, Karte aus der Liste`, `${v.bars.join()} · ${await barRow('65900002-0010')}`);
  report(o2 && o2.dis === 1 && o2.team === 'FW-IH02' && o2.start === dayIso(1) && o2.uhr === '13:30' && o2.uhr2 === '17:30', `${label} Disponieren: Server hat Team FW-IH02, morgen 13:30–17:30`, JSON.stringify(o2 && { team: o2.team, start: o2.start, uhr: o2.uhr, uhr2: o2.uhr2 }));

  // ---- Balken antippen, Überschneidung, aufheben ----
  await probe(page, `${label} Balken antippen (Fenster mit „disponiert“, Balken bleibt stehen)`, `() => document.querySelector('#app .gt-bar[data-k="gb-65900002-0010"]')`, { at: 330, ms: 1000, anim: true });
  report(await page.evaluate(() => { const s = document.querySelector('#app .gt-sheet'); return !!s && /disponiert/.test(s.textContent) && [...s.querySelectorAll('button')].some(b => /Disposition aufheben/.test(b.textContent)) && /Änderung speichern|Gespeichert/.test(s.textContent) && document.querySelector('#app .gt-bar.sel'); }), `${label} Fenster zu einem Balken: „Disposition aufheben“ da, Balken hervorgehoben`);
  await probe(page, `${label} Fenster: „Disposition aufheben“ (Balken weg, Karte kommt zurück)`, btn('/^Disposition aufheben$/', '#app .gt-sheet'), { ms: 1100, anim: true });
  v = await view();
  report(!v.sheet && !v.bars.includes('65900002-0010') && v.pool.includes('65900002-0010') && !(await orderOf('65900002-0010')).dis, `${label} Aufheben: Auftrag ist wieder offen (Liste, Diagramm, Server)`, v.pool.join());
  await probe(page, `${label} Hinweis „Rückgängig“ (Disposition kommt zurück)`, btn('/^Rückgängig$/'), { scroll: 0, ms: 1100, tapTol: 400, smooth: '#app .gtb' });
  report((await orderOf('65900002-0010')).dis === 1 && (await orderOf('65900002-0010')).team === 'FW-IH02', `${label} Rückgängig stellt die Disposition (FW-IH02, 13:30–17:30) wieder her`);
  // Überschneidung: 65900001-0010 (FW-IH01, 06:00–14:00 in zwei Tagen) und Vorgang 0020 ebenfalls auf FW-IH01 legen
  await page.evaluate(() => [...document.querySelectorAll('#app [data-k="dp-65900001-0010"] .gt-go, #app [data-k="dp-65900001-0020"] .gt-go')].forEach(b => b.click()));
  await settle(900);
  await page.evaluate(() => scrollTo(0, 0));
  await page.evaluate(() => document.querySelector('#app .gt-bar[data-k="gb-65900001-0020"]').click());
  await settle(500);
  await page.evaluate(() => { const s = document.querySelector('#app .gt-sheet select'); s.value = 'FW-IH01'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle(400);
  report(await page.evaluate(() => /Überschneidet sich bei FW-IH01 mit 65900001-0010/.test(document.querySelector('#app .gt-sheet .gt-warn').textContent)), `${label} Fenster: Überschneidung im selben Team wird gemeldet`, await page.evaluate(() => document.querySelector('#app .gt-sheet .gt-warn').textContent));
  await probe(page, `${label} Überschneidung speichern (beide Balken teilen sich die Zeile)`, btn('/Änderung speichern/', '#app .gt-sheet'), { ms: 1000, anim: true });
  const cf = await page.evaluate(() => { const bars = [...document.querySelectorAll('#app .gt-row[data-team="FW-IH01"] .gt-bar.cf')]; const row = document.querySelector('#app .gt-row[data-team="FW-IH01"]'); return { n: bars.length, tops: bars.map(b => parseFloat(b.style.top)), rowH: Math.round(row.getBoundingClientRect().height), heights: bars.map(b => parseFloat(b.style.height)) }; });
  report(cf.n === 2 && cf.tops[0] !== cf.tops[1] && cf.heights.every(h => h < cf.rowH / 2) && cf.tops.every((t, i) => t + cf.heights[i] <= cf.rowH), `${label} Überschneidung: beide Balken markiert, teilen sich die Zeile, Zeile bleibt gleich hoch`, JSON.stringify(cf));
  // zurück: Vorgang 0020 gehört wieder zu FW-IH02
  await page.evaluate(() => document.querySelector('#app .gt-bar[data-k="gb-65900001-0020"]').click());
  await settle(500);
  await page.evaluate(() => { const s = document.querySelector('#app .gt-sheet select'); s.value = 'FW-IH02'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle(300);
  await page.evaluate(() => [...document.querySelectorAll('#app .gt-sheet button')].find(b => /Änderung speichern/.test(b.textContent)).click());
  await settle(900);

  // ---- Zoom, Navigation, Filter, Suche ----
  // (der Hinweis „Rückgängig“ läuft nach 10 s von selbst ab und schöbe sonst mitten in einer Prüfung den Inhalt weg)
  await page.waitForFunction(() => !document.querySelector('#app .msg'), null, { timeout: 20000 });
  await settle(500);
  await probe(page, `${label} Zoom „Woche“`, btn('/^Woche$/', '#app .gt-seg'), { at: 250, ms: 800 });
  report(await page.evaluate(() => document.querySelectorAll('#app .gt-day').length === 7 && parseFloat(getComputedStyle(document.querySelector('#app .gt-in')).width) === 7 * 24 * 14), `${label} Woche: 7 Tage, 14 px je Stunde`);
  await probe(page, `${label} Navigation „›“ (nächste Woche)`, btn('/^›$/', '#app .gt-top'), { at: 250, ms: 700 });
  await probe(page, `${label} Navigation „Heute“`, btn('/^Heute$/', '#app .gt-top'), { at: 250, ms: 700 });
  await probe(page, `${label} Zoom „Tag“`, btn('/^Tag$/', '#app .gt-seg'), { at: 250, ms: 800 });
  await probe(page, `${label} Navigation „‹“ (Vortag)`, btn('/^‹$/', '#app .gt-top'), { at: 250, ms: 700 });
  const rangeBack = await page.evaluate(() => document.querySelector('#app .gt-range').textContent);
  await probe(page, `${label} Navigation „Heute“ (zurück)`, btn('/^Heute$/', '#app .gt-top'), { at: 250, ms: 700 });
  report(rangeBack.startsWith(dayIso(-1).split('-').reverse().slice(0, 2).join('.')) && (await page.evaluate(() => document.querySelector('#app .gt-range').textContent)).startsWith(todayIso.split('-').reverse().slice(0, 2).join('.')), `${label} Navigation: ‹ zeigt ab gestern, „Heute“ ab heute`, rangeBack);
  // ---- Monatsübersicht: ein Kalendermonat, ein Tag = 36 px, Navigation von Monat zu Monat ----
  const monthNames = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
    nowD = new Date(),
    dim = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 0).getDate(),
    monthOf = n => { const d = new Date(nowD.getFullYear(), nowD.getMonth() + n, 1); return `${monthNames[d.getMonth()]} ${d.getFullYear()}`; };
  await probe(page, `${label} Zoom „Monat“`, btn('/^Monat$/', '#app .gt-seg'), { at: 250, ms: 800 });
  const mo = await page.evaluate(() => ({
    days: document.querySelectorAll('#app .gt-day').length,
    hours: document.querySelectorAll('#app .gt-hr').length,
    width: parseFloat(getComputedStyle(document.querySelector('#app .gt-in')).width),
    range: document.querySelector('#app .gt-range').textContent,
    first: document.querySelector('#app .gt-day').textContent,
    on: [...document.querySelectorAll('#app .gt-seg button.on')].map(b => b.textContent),
    weekend: document.querySelectorAll('#app .gt-wk').length,
    td: (document.querySelector('#app .gt-day.td') || {}).textContent
  }));
  report(mo.days === dim && mo.hours === 0 && mo.width === dim * 36 && mo.range === monthOf(0) && mo.first.replace(/\D/g, '') === '1' && mo.on.join() === 'Monat' && mo.weekend >= 8 && mo.td && mo.td.replace(/\D/g, '') === String(nowD.getDate()), `${label} Monat: ${dim} Tage zu je 36 px, Kopf mit Wochentag und Tag, Monatsname, Wochenenden getönt, heute markiert`, JSON.stringify(mo));
  const mbar = await page.evaluate(() => { const b = document.querySelector('#app .gt-bar[data-k="gb-65900003"]'); return b && { left: parseFloat(b.style.left), width: parseFloat(b.style.width), label: !!b.querySelector('b'), row: b.closest('.gt-row').dataset.team }; });
  report(mbar && Math.abs(mbar.left - ((nowD.getDate() - 1) * 24 + 8.5) * 1.5) < 1 && mbar.width === 14 && !mbar.label, `${label} Monat: der Balken von heute 08:30 sitzt am richtigen Tag, ist mindestens 14 px breit (antippbar) und trägt keinen abgeschnittenen Text`, JSON.stringify(mbar));
  await probe(page, `${label} Monat: Navigation „›“ (nächster Monat)`, btn('/^›$/', '#app .gt-top'), { at: 250, ms: 700 });
  const next = await page.evaluate(() => ({ range: document.querySelector('#app .gt-range').textContent, days: document.querySelectorAll('#app .gt-day').length }));
  const dimNext = new Date(nowD.getFullYear(), nowD.getMonth() + 2, 0).getDate();
  report(next.range === monthOf(1) && next.days === dimNext, `${label} Monat: „›“ zeigt ${monthOf(1)} mit ${dimNext} Tagen`, JSON.stringify(next));
  await probe(page, `${label} Monat: Navigation „‹“ (zurück, ein Monat davor)`, btn('/^‹$/', '#app .gt-top'), { at: 250, ms: 700 });
  await probe(page, `${label} Monat: Navigation „‹“ (zwei Monate zurück)`, btn('/^‹$/', '#app .gt-top'), { at: 250, ms: 700 });
  report((await page.evaluate(() => document.querySelector('#app .gt-range').textContent)) === monthOf(-1), `${label} Monat: „‹“ zeigt ${monthOf(-1)}`);
  await probe(page, `${label} Monat: „Heute“`, btn('/^Heute$/', '#app .gt-top'), { at: 250, ms: 700 });
  report((await page.evaluate(() => document.querySelector('#app .gt-range').textContent)) === monthOf(0), `${label} Monat: „Heute“ zeigt wieder ${monthOf(0)}`);
  report(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${label} Monat: Seite nicht breiter als der Bildschirm`);
  await probe(page, `${label} Zoom „Tag“ (zurück aus dem Monat)`, btn('/^Tag$/', '#app .gt-seg'), { at: 250, ms: 800 });
  report((await page.evaluate(() => document.querySelectorAll('#app .gt-day').length === 3 && document.querySelectorAll('#app .gt-hr').length === 72)), `${label} Zurück zu „Tag“: 3 Tage mit Stunden`);
  await probe(page, `${label} Filter „Reparaturen“`, btn('/^🛠️ Reparaturen/'), { at: 300, ms: 800 });
  v = await view();
  report(v.pool.every(a => !['65900003', '65900004'].includes(a)) && v.bars.every(a => !['65900003', '65900004'].includes(a)), `${label} Filter Reparaturen: Liste und Diagramm ohne Entstörungen`, v.pool.join() + ' | ' + v.bars.join());
  await probe(page, `${label} Filter „Entstörungen“`, btn('/^🚨 Entstörungen/'), { at: 300, ms: 800 });
  v = await view();
  report(v.pool.every(a => ['65900003', '65900004'].includes(a)) && v.bars.every(a => ['65900003', '65900004'].includes(a)), `${label} Filter Entstörungen: nur Entstörungen`, v.pool.join() + ' | ' + v.bars.join());
  await probe(page, `${label} Filter „Alle“`, btn('/^Alle \\(/', '#app .gtb'), { at: 300, ms: 800 });
  await page.fill('#app input[data-keep="gs"]', '65900009');
  await settle(500);
  v = await view();
  report(v.pool.join() === '65900009' && /\(1\)/.test(v.head), `${label} Suche in der Offen-Liste findet 65900009`, v.pool.join());
  await page.fill('#app input[data-keep="gs"]', '');
  await settle(400);

  if (wide) {
    // ---- Mit der Maus: Balken ziehen, Länge ändern, Karte auf eine Zeile ziehen ----
    await page.evaluate(() => scrollTo(0, 260));
    await settle(400);
    const geom = () => page.evaluate(() => {
      const sc = document.querySelector('#app .gt-scroll').getBoundingClientRect(), scr = document.querySelector('#app .gt-scroll').scrollLeft;
      const rows = Object.fromEntries([...document.querySelectorAll('#app .gt-row')].map(r => [r.dataset.team, r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2]));
      return { left: sc.left - scr, rows, tops: [...document.querySelectorAll('#app .gt-row')].map(r => Math.round(r.getBoundingClientRect().top)) };
    });
    let g = await geom();
    const b3 = await page.evaluate(() => { const r = document.querySelector('#app .gt-bar[data-k="gb-65900003"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(b3.x, b3.y);
    await page.mouse.down();
    await page.mouse.move(b3.x + 24, b3.y + 6, { steps: 4 });
    await page.mouse.move(b3.x + 48, g.rows['FW-IH03'], { steps: 10 });
    const during = await page.evaluate(() => ({ tip: (document.querySelector('.gt-tip') || {}).textContent, target: [...document.querySelectorAll('#app .gt-row.tgt')].map(r => r.dataset.team) }));
    await page.mouse.up();
    await settle(1000);
    const o3b = await orderOf('65900003');
    report(/FW-IH03/.test(during.tip || '') && during.target.join() === 'FW-IH03', `${label} Ziehen: Hinweis zeigt Team und Zeit, Zielzeile ist hervorgehoben`, `${during.tip} · ${during.target.join()}`);
    report(o3b.team === 'FW-IH03' && o3b.uhr === '09:30' && o3b.uhr2 === '11:15' && o3b.start === todayIso, `${label} Ziehen: Auftrag liegt bei FW-IH03, eine Stunde später (09:30–11:15)`, JSON.stringify({ team: o3b.team, uhr: o3b.uhr, uhr2: o3b.uhr2 }));
    const g2 = await geom();
    report(JSON.stringify(g.tops) === JSON.stringify(g2.tops), `${label} Ziehen: die Zeilen des Diagramms bleiben an derselben Bildschirmstelle (feste Zeilenhöhe, die Seite hält den Hinweis oben aus)`, `${g.tops.slice(0, 4)} → ${g2.tops.slice(0, 4)}`);
    // Länge ändern: Balken antippen, dann den rechten Rand ziehen (+2 Std)
    await page.evaluate(() => document.querySelector('#app .gt-bar[data-k="gb-65900003"]').click());
    await settle(500);
    const rz = await page.evaluate(() => { const r = document.querySelector('#app .gt-bar.sel .gt-rz').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(rz.x, rz.y);
    await page.mouse.down();
    await page.mouse.move(rz.x + 48, rz.y, { steps: 5 });
    await page.mouse.move(rz.x + 96, rz.y, { steps: 5 });
    await page.mouse.up();
    await settle(900);
    const o3c = await orderOf('65900003');
    report(o3c.uhr === '09:30' && o3c.uhr2 === '13:15' && o3c.team === 'FW-IH03', `${label} Länge ändern: rechter Rand +2 Std (Ende 13:15), Beginn bleibt`, `${o3c.uhr}–${o3c.uhr2}`);
    await page.evaluate(() => { const x = document.querySelector('#app .gt-sheet .gt-x'); if (x) x.click(); });
    await settle(500);

    // ---- Länge ändern am Rand des Balkens, ohne den Auftrag vorher zu wählen: links = Beginn, rechts = Ende ----
    const A3 = '65900003',
      edge = (side, a = A3) =>
        page.evaluate(([side, a]) => {
          const h = document.querySelector(`#app .gt-bar[data-k="gb-${a}"] .gt-${side}z`);
          if (!h) return null;
          const r = h.getBoundingClientRect(),
            x = r.left + r.width / 2,
            y = r.top + r.height / 2;
          return { x, y, w: r.width, cursor: getComputedStyle(document.elementFromPoint(x, y)).cursor, hit: document.elementFromPoint(x, y) === h };
        }, [side, a]),
      box = (a = A3) =>
        page.evaluate(a => {
          const b = document.querySelector(`#app .gt-bar[data-k="gb-${a}"]`),
            r = b.getBoundingClientRect(),
            hl = b.querySelector('.gt-lz'),
            hr = b.querySelector('.gt-rz');
          return { l: r.left, r: r.right, t: r.top, h: r.height, sel: b.classList.contains('sel'), hw: Math.max(hl ? hl.offsetWidth : 0, hr ? hr.offsetWidth : 0), tip: (document.querySelector('.gt-tip') || {}).textContent || '' };
        }, a),
      // Rand fassen und um dx Pixel ziehen; gemessen wird kurz vor dem Loslassen und danach
      dragEdge = async (side, dx, opts = {}) => {
        const e = await edge(side);
        await page.mouse.move(e.x, e.y);
        await page.mouse.down();
        await page.mouse.move(e.x + dx / 2, e.y, { steps: 4 });
        await page.mouse.move(e.x + dx, e.y, { steps: 4 });
        const mid = await box();
        if (opts.escape) await page.keyboard.press('Escape');
        await page.mouse.up();
        // (gleich nach dem Loslassen: läuft auf dem neu gezeichneten Balken eine Animation, würde er kurz verschwinden und neu einblenden)
        const anims = await page.evaluate(a => { const b = document.querySelector(`#app .gt-bar[data-k="gb-${a}"]`); return b ? b.getAnimations().length : -1; }, A3);
        await settle(900);
        return { mid, anims, after: await box() };
      };
    const e0 = { l: await edge('l'), r: await edge('r') },
      b0 = await box();
    report(!b0.sel && !!e0.l && !!e0.r && e0.l.hit && e0.r.hit, `${label} Rand ziehen: beide Ränder des Balkens haben auch ohne Auswahl einen Anfasser`, JSON.stringify({ sel: b0.sel, l: !!e0.l, r: !!e0.r }));
    report(e0.l && e0.r && e0.l.cursor === 'ew-resize' && e0.r.cursor === 'ew-resize' && e0.l.w <= 10.5 && e0.r.w <= 10.5, `${label} Rand ziehen: Zeiger wird am Rand zum Doppelpfeil (↔), schmaler Anfasser`, `${e0.l && e0.l.cursor}/${e0.r && e0.r.cursor} · ${e0.l && e0.l.w}`);
    // sichtbar nur, wenn der Zeiger über dem Balken steht (ändert nur die Deckkraft, nie Größe oder Lage)
    const rzOpacity = () => page.evaluate(a => getComputedStyle(document.querySelector(`#app .gt-bar[data-k="gb-${a}"] .gt-rz`)).opacity, A3);
    await page.mouse.move(e0.r.x, e0.r.y);
    await settle(400);
    const opHover = await rzOpacity();
    await page.mouse.move(5, 5);
    await settle(400);
    const opAway = await rzOpacity();
    report(opHover === '1' && opAway === '0', `${label} Rand ziehen: der Rand zeigt sich nur, solange der Zeiger über dem Balken steht`, `${opHover} / ${opAway}`);
    // links: Beginn +1 Std (09:30 → 10:30), Ende bleibt
    const L1 = await dragEdge('l', 48),
      o3d = await orderOf(A3);
    report(Math.abs(L1.mid.l - (b0.l + 48)) <= 1.5 && Math.abs(L1.mid.r - b0.r) <= 1.5 && Math.abs(L1.mid.t - b0.t) < 0.5 && L1.mid.h === b0.h && L1.mid.hw <= 10.5, `${label} Linker Rand: Balken schrumpft beim Ziehen am Rand (rechter Rand und Zeile stehen, Anfasser wächst nicht)`, JSON.stringify({ dl: L1.mid.l - b0.l, dr: L1.mid.r - b0.r, dt: L1.mid.t - b0.t, hw: L1.mid.hw }));
    report(/10:30–13:15/.test(L1.mid.tip) && /Std/.test(L1.mid.tip), `${label} Linker Rand: Hinweis nennt Zeitraum und Dauer`, L1.mid.tip);
    report(o3d.team === 'FW-IH03' && o3d.start === todayIso && o3d.uhr === '10:30' && o3d.uhr2 === '13:15', `${label} Linker Rand: Beginn +1 Std (10:30), Ende 13:15 und Team bleiben`, JSON.stringify({ team: o3d.team, uhr: o3d.uhr, uhr2: o3d.uhr2 }));
    report(Math.abs(L1.after.l - L1.mid.l) <= 1.5 && Math.abs(L1.after.r - L1.mid.r) <= 1.5 && !L1.after.sel && L1.anims === 0, `${label} Linker Rand: beim Loslassen springt der Balken nicht und blendet nicht neu ein`, `${L1.after.l - L1.mid.l} / ${L1.after.r - L1.mid.r} · ${L1.anims} Animationen`);
    // rechts: Ende −2 Std (13:15 → 11:15), Beginn bleibt
    const b1 = await box(),
      R1 = await dragEdge('r', -96),
      o3e = await orderOf(A3);
    report(Math.abs(R1.mid.r - (b1.r - 96)) <= 1.5 && Math.abs(R1.mid.l - b1.l) <= 1.5 && Math.abs(R1.mid.t - b1.t) < 0.5 && R1.mid.hw <= 10.5, `${label} Rechter Rand: Balken schrumpft beim Ziehen am Rand (linker Rand und Zeile stehen)`, JSON.stringify({ dl: R1.mid.l - b1.l, dr: R1.mid.r - b1.r, dt: R1.mid.t - b1.t }));
    report(o3e.uhr === '10:30' && o3e.uhr2 === '11:15' && o3e.start === todayIso && o3e.team === 'FW-IH03', `${label} Rechter Rand: Ende −2 Std (11:15), Beginn 10:30 bleibt`, `${o3e.uhr}–${o3e.uhr2}`);
    report(Math.abs(R1.after.l - R1.mid.l) <= 1.5 && Math.abs(R1.after.r - R1.mid.r) <= 1.5 && R1.anims === 0, `${label} Rechter Rand: beim Loslassen springt der Balken nicht und blendet nicht neu ein`, `${R1.after.l - R1.mid.l} / ${R1.after.r - R1.mid.r} · ${R1.anims} Animationen`);
    // über das andere Ende hinaus: mindestens 15 Min bleiben (Beginn = Ende − 15 Min), nichts dreht sich um
    const L2 = await dragEdge('l', 300),
      o3f = await orderOf(A3);
    report(o3f.uhr === '11:00' && o3f.uhr2 === '11:15' && L2.mid.r - L2.mid.l >= 6, `${label} Linker Rand über das Ende hinaus: mindestens 15 Min (11:00–11:15), Balken nie negativ`, `${o3f.uhr}–${o3f.uhr2} · ${L2.mid.r - L2.mid.l}px`);
    // schmaler Balken (15 Min = 12 px): beide Anfasser lassen sich trotzdem fassen
    const narrow = { l: await edge('l'), r: await edge('r') };
    report(narrow.l && narrow.r && narrow.l.hit && narrow.r.hit && narrow.l.cursor === 'ew-resize' && narrow.r.cursor === 'ew-resize', `${label} Schmaler Balken (15 Min): beide Ränder lassen sich fassen`, JSON.stringify({ l: narrow.l && narrow.l.w, r: narrow.r && narrow.r.w }));
    // zurück: Ende +2 Std (13:15), dann Beginn −1,5 Std (09:30)
    await dragEdge('r', 96);
    const o3g = await orderOf(A3);
    await dragEdge('l', -72);
    const o3h = await orderOf(A3);
    report(o3g.uhr === '11:00' && o3g.uhr2 === '13:15' && o3h.uhr === '09:30' && o3h.uhr2 === '13:15' && o3h.team === 'FW-IH03', `${label} Schmaler Balken: Ende +2 Std, dann Beginn −1,5 Std – wieder 09:30–13:15`, `${o3g.uhr}–${o3g.uhr2} → ${o3h.uhr}–${o3h.uhr2}`);
    // Esc beim Ziehen bricht ab: nichts wird gespeichert, der Balken springt zurück
    const b2 = await box(),
      X = await dragEdge('l', 48, { escape: true }),
      o3i = await orderOf(A3);
    report(Math.abs(X.mid.l - (b2.l + 48)) <= 1.5 && o3i.uhr === '09:30' && o3i.uhr2 === '13:15' && Math.abs(X.after.l - b2.l) <= 1.5 && Math.abs(X.after.r - b2.r) <= 1.5, `${label} Rand ziehen, dann Esc: nichts gespeichert, Balken steht wieder an seiner Stelle`, `${o3i.uhr}–${o3i.uhr2} · ${X.after.l - b2.l}`);
    // ein Tipp auf den Rand (ohne Ziehen) wählt den Auftrag wie ein Tipp auf den Balken und ändert nichts
    const eTap = await edge('r');
    await page.mouse.click(eTap.x, eTap.y);
    await settle(600);
    const o3j = await orderOf(A3);
    report((await view()).sheet && (await box()).sel && o3j.uhr === '09:30' && o3j.uhr2 === '13:15', `${label} Tipp auf den Rand (ohne Ziehen) wählt den Auftrag und ändert nichts`);
    await page.evaluate(() => { const x = document.querySelector('#app .gt-sheet .gt-x'); if (x) x.click(); });
    await settle(500);
    // Entwurf: auch der gestrichelte Entwurf lässt sich an beiden Rändern ziehen (gespeichert wird erst mit „Disponieren“).
    // Genommen wird der erste offene Auftrag; sein Entwurf wird über die Felder des Fensters auf heute 14:00 gesetzt (ganz im Bild:
    // ein abgeschnittener Rand hat keinen Anfasser).
    const draftKey = (await view()).pool[0] || '';
    if (draftKey) {
      await page.evaluate(k => document.querySelector(`#app [data-k="dp-${k}"]`).click(), draftKey);
      await settle(600);
      for (const [key, val] of [['gv-d', todayIso], ['gv-t', '14:00']]) {
        await page.evaluate(([key, val]) => { const n = document.querySelector(`#app .gt-sheet [data-keep="${key}"]`); n.value = val; n.dispatchEvent(new Event('change', { bubbles: true })); }, [key, val]);
        await settle(400);
      }
    }
    const draftOk = !!draftKey && (await page.evaluate(() => !!document.querySelector('#app .gt-bar.draft:not(.cl):not(.cr)')));
    report(draftOk, `${label} Entwurf: gewählter offener Auftrag hat einen Entwurf ganz im gezeigten Zeitraum (für die Randprüfung)`, draftKey);
    if (draftOk) {
      // (die Auswahl scrollt die Zeitachse nicht: den Entwurf selbst ins Bild holen)
      await page.evaluate(() => {
        const s = document.querySelector('#app .gt-scroll'),
          b = document.querySelector('#app .gt-bar.draft');
        s.scrollLeft = Math.max(0, parseFloat(b.style.left) - 300);
        scrollTo(0, 260);
      });
      await settle(500);
      const stamp = async k => Date.parse((await field(k + '-d')) + 'T' + (await field(k + '-t')) + ':00Z'), // (als UTC gelesen: keine Sommerzeit-Sprünge)
        dEdge = side => page.evaluate(side => { const h = document.querySelector(`#app .gt-bar.draft .gt-${side}z`), r = h.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; return { x, y, hit: document.elementFromPoint(x, y) === h, cursor: getComputedStyle(document.elementFromPoint(x, y)).cursor }; }, side),
        dBox = () => page.evaluate(() => { const b = document.querySelector('#app .gt-bar.draft'), r = b.getBoundingClientRect(); return { l: r.left, r: r.right, lz: !!b.querySelector('.gt-lz'), rz: !!b.querySelector('.gt-rz'), t: r.top }; }),
        dDrag = async (side, dx) => {
          const e = await dEdge(side);
          await page.mouse.move(e.x, e.y);
          await page.mouse.down();
          await page.mouse.move(e.x + dx / 2, e.y, { steps: 4 });
          await page.mouse.move(e.x + dx, e.y, { steps: 4 });
          await page.mouse.up();
          await settle(700);
        };
      const d0 = await dBox(),
        dl = await dEdge('l'),
        dr = await dEdge('r'),
        von0 = await stamp('gv'),
        bis0 = await stamp('gb');
      report(d0.lz && d0.rz && dl.hit && dr.hit && dl.cursor === 'ew-resize' && dr.cursor === 'ew-resize', `${label} Entwurf: gestrichelter Balken hat beide Anfasser, frei und mit Doppelpfeil`, JSON.stringify({ d0, dl: dl.hit, dr: dr.hit }));
      await dDrag('l', -48);
      const d1 = await dBox();
      report(Math.abs(d1.l - (d0.l - 48)) <= 1.5 && Math.abs(d1.r - d0.r) <= 1.5 && (await stamp('gv')) === von0 - 36e5 && (await stamp('gb')) === bis0, `${label} Entwurf: linker Rand −1 Std (Beginn eine Stunde früher, Ende bleibt)`, `${d1.l - d0.l} / ${d1.r - d0.r}`);
      await dDrag('r', 48);
      const d2 = await dBox();
      report(Math.abs(d2.r - (d1.r + 48)) <= 1.5 && Math.abs(d2.l - d1.l) <= 1.5 && (await stamp('gb')) === bis0 + 36e5 && (await stamp('gv')) === von0 - 36e5, `${label} Entwurf: rechter Rand +1 Std (Ende eine Stunde später, Beginn bleibt)`, `${d2.r - d1.r} / ${d2.l - d1.l}`);
      report(!(await orderOf(draftKey)).dis, `${label} Entwurf: Rand ziehen speichert nichts (Auftrag bleibt offen)`);
      await page.evaluate(() => document.querySelector('#app .gt-sheet .gt-x').click());
      await settle(500);
    }
    // Monat: Ziehen verschiebt um ganze Tage (36 px = 1 Tag), Uhrzeit und Team bleiben
    await probe(page, `${label} Zoom „Monat“ (zum Ziehen)`, btn('/^Monat$/', '#app .gt-seg'), { at: 250, ms: 800 });
    const dir = nowD.getDate() + 2 <= dim ? 1 : -1;
    const m3 = await page.evaluate(() => { const r = document.querySelector('#app .gt-bar[data-k="gb-65900003"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(m3.x, m3.y);
    await page.mouse.down();
    await page.mouse.move(m3.x + dir * 30, m3.y, { steps: 4 });
    await page.mouse.move(m3.x + dir * 72, m3.y, { steps: 4 });
    const monthTip = await page.evaluate(() => (document.querySelector('.gt-tip') || {}).textContent);
    await page.mouse.up();
    await settle(900);
    const o3m = await orderOf('65900003');
    report(o3m.start === dayIso(2 * dir) && o3m.uhr === '09:30' && o3m.uhr2 === '13:15' && o3m.team === 'FW-IH03', `${label} Monat: Balken 2 Tage ${dir > 0 ? 'später' : 'früher'} gezogen – Tag ${dayIso(2 * dir)}, Uhrzeit 09:30–13:15 und Team bleiben`, JSON.stringify({ team: o3m.team, start: o3m.start, uhr: o3m.uhr, uhr2: o3m.uhr2 }) + ' · ' + monthTip);
    // Monat: auch am Rand ändern sich nur ganze Tage (Uhrzeiten bleiben): rechts Ende +1 Tag, links Beginn −1 Tag
    {
      const mb = await box(),
        me = { l: await edge('l'), r: await edge('r') };
      report(me.l && me.r && me.l.hit && me.r.hit && me.l.cursor === 'ew-resize' && me.r.cursor === 'ew-resize' && me.l.w >= 3 && mb.r - mb.l >= 14, `${label} Monat: auch der 14 px breite Balken hat zwei fassbare Ränder`, JSON.stringify({ l: me.l && me.l.w, r: me.r && me.r.w, w: mb.r - mb.l }));
      const M1 = await dragEdge('r', 36),
        o3n = await orderOf(A3);
      report(o3n.start === dayIso(2 * dir) && o3n.ende === dayIso(2 * dir + 1) && o3n.uhr === '09:30' && o3n.uhr2 === '13:15' && o3n.team === 'FW-IH03', `${label} Monat: rechter Rand +1 Tag – Ende ${dayIso(2 * dir + 1)} 13:15, Beginn und Team bleiben`, JSON.stringify({ start: o3n.start, ende: o3n.ende, uhr: o3n.uhr, uhr2: o3n.uhr2 }) + ' · ' + M1.mid.tip);
      // (der Balken ist vorher auf 14 px Mindestbreite aufgeweitet: er wächst auf die echte Länge, nicht um genau 36 px; entscheidend ist, dass beim Loslassen nichts springt)
      report(M1.mid.r - mb.r > 20 && Math.abs(M1.mid.l - mb.l) <= 1.5 && Math.abs(M1.mid.t - mb.t) < 0.5 && Math.abs(M1.after.r - M1.mid.r) <= 1.5 && Math.abs(M1.after.l - M1.mid.l) <= 1.5, `${label} Monat: rechter Rand – Balken wächst beim Ziehen mit, Zeile bleibt, beim Loslassen springt nichts`, `${M1.mid.r - mb.r} · Sprung ${M1.after.r - M1.mid.r}/${M1.after.l - M1.mid.l}`);
      const M2 = await dragEdge('l', -36),
        o3o = await orderOf(A3);
      report(M2.mid.l < M1.after.l - 20 && Math.abs(M2.mid.r - M1.after.r) <= 1.5 && Math.abs(M2.after.l - M2.mid.l) <= 1.5 && Math.abs(M2.after.r - M2.mid.r) <= 1.5, `${label} Monat: linker Rand – Balken wächst nach links, rechter Rand steht, beim Loslassen springt nichts`, `${M2.mid.l - M1.after.l} · Sprung ${M2.after.l - M2.mid.l}/${M2.after.r - M2.mid.r}`);
      report(o3o.start === dayIso(2 * dir - 1) && o3o.ende === dayIso(2 * dir + 1) && o3o.uhr === '09:30' && o3o.uhr2 === '13:15', `${label} Monat: linker Rand −1 Tag – Beginn ${dayIso(2 * dir - 1)} 09:30, Ende bleibt`, JSON.stringify({ start: o3o.start, ende: o3o.ende, uhr: o3o.uhr, uhr2: o3o.uhr2 }) + ' · ' + M2.mid.tip);
    }
    // und wieder zurück auf heute (Rückgängig-Hinweis abwarten ist nicht nötig: der Server hält den Stand)
    await probe(page, `${label} Zoom „Tag“ (nach dem Ziehen im Monat)`, btn('/^Tag$/', '#app .gt-seg'), { at: 250, ms: 800 });
    await page.evaluate(() => scrollTo(0, 260));
    await settle(400);
    // Entwurf eines Offenen ziehen (Fenster offen): nur der Entwurf bewegt sich, gespeichert wird erst mit „Disponieren“
    await page.evaluate(() => { const c = document.querySelector('#app [data-k="dp-65900008-0010"]'); c.click(); });
    await settle(600);
    report((await view()).draft.length === 0, `${label} Entwurf: ein gewählter offener Auftrag, dessen SAP-Termin 3 Tage zurückliegt (außerhalb des gezeigten Zeitraums), hat keinen Balken im Bild`);
    await page.evaluate(() => document.querySelector('#app .gt-sheet .gt-x').click());
    await settle(500);
    // Karte mit der Maus auf eine Zeile ziehen (Beginn = Stelle des Zeigers, Dauer aus SAP)
    g = await geom();
    const card0 = await page.evaluate(() => { const c = document.querySelector('#app [data-k="dp-65900004"]'); const r = c.getBoundingClientRect(); return { x: r.left + 60, y: r.top + 30 }; });
    const xAt = hour => g.left + hour * 48;
    await page.mouse.move(card0.x, card0.y);
    await page.mouse.down();
    await page.mouse.move(card0.x + 40, card0.y + 10, { steps: 4 });
    await page.mouse.move(xAt(14), g.rows['FW-IH02'], { steps: 12 });
    const dragging = await page.evaluate(() => ({ ghost: (document.querySelector('.gt-ghost') || {}).textContent, target: [...document.querySelectorAll('#app .gt-row.tgt')].map(r => r.dataset.team) }));
    await page.mouse.up();
    await settle(1000);
    const o4 = await orderOf('65900004');
    report(/FW-IH02/.test(dragging.ghost || '') && dragging.target.join() === 'FW-IH02', `${label} Karte ziehen: Zeiger zeigt Ziel, Zielzeile hervorgehoben`, `${dragging.ghost} · ${dragging.target.join()}`);
    report(o4.dis === 1 && o4.team === 'FW-IH02' && o4.start === todayIso && o4.uhr === '14:00', `${label} Karte ziehen: Auftrag liegt bei FW-IH02 ab 14:00 (Stelle des Zeigers, aufs Raster gerundet)`, JSON.stringify({ team: o4.team, start: o4.start, uhr: o4.uhr, uhr2: o4.uhr2 }));
    report(!(await view()).pool.includes('65900004'), `${label} Karte ziehen: die Karte ist aus der Offen-Liste verschwunden`);
    // Loslassen außerhalb des Diagramms ändert nichts; Esc bricht ab
    const before = (await view()).pool.join();
    const c2 = await page.evaluate(() => { const c = document.querySelector('#app [data-k="dp-65900008-0010"]'); const r = c.getBoundingClientRect(); return { x: r.left + 60, y: r.top + 30 }; });
    await page.mouse.move(c2.x, c2.y);
    await page.mouse.down();
    await page.mouse.move(c2.x + 80, c2.y + 40, { steps: 5 });
    await page.mouse.up();
    await settle(500);
    report((await view()).pool.join() === before && !(await orderOf('65900008-0010')).dis, `${label} Karte ziehen: Loslassen außerhalb des Diagramms ändert nichts`);
  }

  // ---- Alle Vorschläge übernehmen (mit Rückfrage) ----
  await undispatchAll(base);
  await page.waitForFunction(() => document.querySelectorAll('#app .gt-pc').length === 7, null, { timeout: 15000 });
  await settle(500);
  report((await view()).tab === 'Disposition (7)' && (await view()).bars.length === 0, `${label} Live: nach dem Aufheben per Server sind wieder alle 7 offen (Karten, Diagramm, Tab)`);
  await probe(page, `${label} „Alle Vorschläge übernehmen“ (Rückfrage erscheint)`, btn('/^Alle Vorschläge übernehmen/'), { at: 330, ms: 700 });
  report(await page.evaluate(() => [...document.querySelectorAll('#app button')].some(b => /^Wirklich 7 Aufträge disponieren\?/.test(b.textContent.trim()))), `${label} „Alle Vorschläge“: Rückfrage nennt die Zahl (7)`);
  await probe(page, `${label} „Wirklich 7 Aufträge disponieren?“ (alle Karten gehen, Balken erscheinen)`, btn('/^Wirklich 7/'), { at: 330, ms: 1300, anim: true });
  v = await view();
  const all = await dispatchOrders(base);
  report(all.length === 7 && all.every(o => o.dis === 1) && v.pool.length === 0 && /Alles disponiert/.test(await page.evaluate(() => document.querySelector('#app .gt-empty').textContent)) && v.tab === 'Disposition', `${label} Alle Vorschläge: alle 7 disponiert, Liste leer („✓ Alles disponiert.“), keine Zahl am Tab`, `${all.filter(o => o.dis).length} disponiert`);
  const exp = { '65900008-0010': ['FW-IH01', '09:00', '11:00'], '65900004': ['FW-IH01', '22:00', '05:30'], '65900003': ['FW-IH01', '08:30', '10:15'], '65900002-0010': ['FW-IH01', '13:30', '17:30'], '65900001-0010': ['FW-IH01', '06:00', '14:00'], '65900001-0020': ['FW-IH02', '06:00', '10:00'], '65900009': ['FW-IH01', '07:00', '19:00'] }; // (nur Fremdfirma: deren 12 geplante Stunden zählen)
  const wrong = all.filter(o => exp[o.auftrag] && [o.team, o.uhr, o.uhr2].join() !== exp[o.auftrag].join()).map(o => `${o.auftrag}: ${o.team} ${o.uhr}–${o.uhr2}`);
  report(wrong.length === 0, `${label} Vorschläge: SAP-Team, SAP-Beginn und Ende (aus SAP, sonst geplante Stunden, sonst 2 Std)`, wrong.join(' | ') || 'alle wie erwartet');
  const mk = await monteurKinds(base);
  report(mk.rep === 4 && mk.ent === 2, `${label} Der Monteur (Team FW-IH01) sieht jetzt 4 Reparaturen und 2 Entstörungen`, JSON.stringify(mk));
  // Seite wird nie breiter als der Bildschirm (auch mit Fenster)
  await page.evaluate(() => document.querySelector('#app .gt-bar').click());
  await settle(600);
  report(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${label} Diagramm mit Fenster: Seite nicht breiter als der Bildschirm`);
  await page.evaluate(() => document.querySelector('#app .gt-sheet .gt-x').click());
  await settle(400);
  await page.context().close();
}
// ---------- Disposition: Liste der offenen Aufträge im Extra-Fenster (zwei Bildschirme) ----------
// Der Knopf „⧉ Extra-Fenster“ öffnet die Offen-Liste in einem zweiten Browserfenster, das Hauptfenster zeigt das Diagramm in voller Breite.
// Geprüft: Aufbau und Stabilität des Hauptfensters (Leiste gleich hoch, nichts springt), Liste im Fenster (Karten, Zahl im Titel, Suche mit
// erhaltenem Fokus, Auftragsart), „Vorschlag übernehmen“ im Fenster (Karte gleitet aus, Rest rückt weich nach, Balken im Hauptfenster),
// Antippen einer Karte (Bearbeiten-Fenster im Hauptfenster), Ziehen einer Karte auf eine Teamzeile (HTML5-Ziehen, hier mit synthetischen
// Ereignissen: echtes Ziehen über Fenstergrenzen lässt sich nicht fernsteuern), Schließen des Fensters von beiden Seiten, Abmelden.
async function poolWindowChecks(browser, base, errors) {
  const viewport = { width: 1280, height: 900 },
    label = '1280px Extra-Fenster:',
    todayIso = new Date().toLocaleDateString('sv-SE');
  console.log('\n=== Disposition: Extra-Fenster für die Offen-Liste (1280px) ===');
  await undispatchAll(base);
  const page = await newPage(browser, base, viewport, errors);
  await loginDispo(page);
  const settle = ms => pause(page, ms);
  await page.evaluate(() => [...document.querySelectorAll('#app .tabs button')].find(b => /^Disposition/.test(b.textContent.trim())).click());
  await page.waitForFunction(() => document.querySelectorAll('#app .gt-pc').length === 7, null, { timeout: 15000 });
  await settle(900);
  const orderOf = async a => (await dispatchOrders(base)).find(o => o.auftrag === a);
  const bar = () => page.evaluate(() => { const r = document.querySelector('#app .gtb').getBoundingClientRect(), g = document.querySelector('#app .gt').getBoundingClientRect(); return { top: r.top, h: Math.round(r.height * 10) / 10, gt: Math.round(g.width) }; });
  const cardsOf = p => p.evaluate(() => [...document.querySelectorAll('.gt-pool > [data-k]')].map(c => c.dataset.k.slice(3)));
  report(await page.evaluate(() => !!document.querySelector('#app .gtt-pop') && !!document.querySelector('#app .gtt input[type="search"]') && !document.querySelector('#app .gtp.solo')), `${label} Knopf „⧉ Extra-Fenster“ neben der Suche (Liste steht noch in der Seite)`);
  const b0 = await bar();

  // ---- öffnen ----
  const [popup] = await Promise.all([page.context().waitForEvent('page', { timeout: 10000 }), probe(page, `${label} „⧉ Extra-Fenster“ (Diagramm blendet in voller Breite ein, Leiste bleibt stehen)`, `() => document.querySelector('#app .gtt-pop')`, { ms: 1000, anim: true })]);
  popup.on('pageerror', e => errors.push('Extra-Fenster: ' + e.message));
  await popup.waitForSelector('.gt-pool > [data-k]', { timeout: 10000 });
  await settle(900);
  const b1 = await bar();
  report(b1.top === b0.top && b1.h === b0.h && b1.gt > b0.gt + 250, `${label} Hauptfenster: Leiste bleibt an derselben Stelle gleich hoch, das Diagramm wird breiter`, `${b0.top}/${b0.h}/${b0.gt} → ${b1.top}/${b1.h}/${b1.gt}`);
  report(await page.evaluate(() => !document.querySelector('#app .gt-pc') && !document.querySelector('#app .gt-ph') && !!document.querySelector('#app .gtp.solo') && /im Extra-Fenster/.test(document.querySelector('#app .gtt-note').textContent) && !document.querySelector('#app .gtt input')), `${label} Hauptfenster: keine Karten und keine Suche mehr, Hinweis „im Extra-Fenster“ mit Knöpfen`);
  const wanted = ['65900008-0010', '65900004', '65900003', '65900002-0010', '65900001-0010', '65900001-0020', '65900009'];
  const info = await popup.evaluate(() => ({ mode: document.compatMode, title: document.title, head: document.querySelector('.gt-ph b').textContent, chips: [...document.querySelectorAll('.chips button')].map(b => b.textContent.trim()), font: getComputedStyle(document.body).fontFamily.split(',')[0], bg: getComputedStyle(document.body).backgroundColor, wide: document.documentElement.scrollWidth <= document.documentElement.clientWidth }));
  report((await cardsOf(popup)).join() === wanted.join() && info.mode === 'CSS1Compat' && /^\(7\) Offene/.test(info.title) && /\(7\)/.test(info.head) && info.chips.join() === 'Alle (7),🛠️ Reparaturen (5),🚨 Entstörungen (2)' && /Inter/.test(info.font) && info.wide, `${label} Fenster: 7 Karten, das Älteste zuerst, Zahl im Titel, Auftragsarten, Schrift und Stile übernommen, nichts zu breit`, JSON.stringify(info));
  const gantt0 = await page.evaluate(() => document.querySelectorAll('#app .gt-row').length);
  report(gantt0 > 5, `${label} Hauptfenster: Diagramm mit ${gantt0} Teamzeilen`);

  // ---- „Vorschlag übernehmen“ im Fenster ----
  const watch = (src, ms) => popup.evaluate(({ src, ms }) => new Promise(resolve => {
    const keys = () => new Map([...document.querySelectorAll('.gt-pool > [data-k]')].map(n => [n.dataset.k, Math.round(n.getBoundingClientRect().top * 10) / 10])),
      running = () => document.getAnimations().filter(a => a.playState === 'running' && !a.transitionProperty && !a.animationName).length,
      before = keys(), t0 = performance.now(), frames = [];
    let anims = -1;
    new Function('return (' + src + ')()')().click();
    const loop = () => {
      frames.push([...keys()]);
      if (frames.length === 3) anims = running();
      if (performance.now() - t0 < ms) requestAnimationFrame(loop);
      else resolve({ before: [...before], frames, anims, left: running(), stuck: [...document.querySelectorAll('.gt-pool > [data-k]')].filter(n => +getComputedStyle(n).opacity < 0.99 || getComputedStyle(n).transform !== 'none').length, ghosts: document.querySelectorAll('body > [data-k]').length });
    };
    requestAnimationFrame(loop);
  }), { src, ms });
  // Sprünge wie in probe(): ein stillstehendes Element springt in einem Bild um ≥ 24 px
  const jumps = res => {
    const before = new Map(res.before), last = new Map(res.frames[res.frames.length - 1]);
    let n = 0;
    for (const k of before.keys()) {
      if (!last.has(k)) continue;
      const series = [before.get(k), ...res.frames.map(f => new Map(f).get(k) ?? null)];
      for (let i = 2; i < series.length - 1; i++) {
        const [a, b, c, d] = [series[i - 2], series[i - 1], series[i], series[i + 1]];
        if ([a, b, c, d].every(v => v != null) && Math.abs(b - a) <= 1 && Math.abs(c - b) >= 24 && Math.abs(d - c) <= 1) n++;
      }
    }
    return n;
  };
  const fresh0 = await page.evaluate(() => document.querySelectorAll('#app .gt-bar').length);
  let r = await watch(`() => document.querySelector('[data-k="dp-65900003"] .gt-go')`, 1100);
  await settle(300);
  let got = await cardsOf(popup);
  report(!got.includes('65900003') && got.length === 6 && jumps(r) === 0 && r.anims >= 1 && !r.left && !r.stuck && !r.ghosts, `${label} Fenster: „Vorschlag übernehmen“ – Karte gleitet aus, die übrigen rücken weich nach (kein Sprung), am Ende steht alles still`, `${got.length} Karten · ${r.anims} Animationen · ${jumps(r)} Sprünge · ${r.left} laufen noch · ${r.stuck} hängen · ${r.ghosts} Kopien`);
  const o3 = await orderOf('65900003');
  report(o3 && o3.dis === 1 && o3.team === 'FW-IH01' && o3.start === todayIso && o3.uhr === '08:30', `${label} Fenster: der Server hat 65900003 bei FW-IH01 heute 08:30 disponiert`, JSON.stringify(o3 && { team: o3.team, start: o3.start, uhr: o3.uhr }));
  report((await page.evaluate(() => document.querySelectorAll('#app .gt-bar').length)) === fresh0 + 1 && (await page.evaluate(() => !!document.querySelector('#app .gt-bar[data-k="gb-65900003"]'))) && /^\(6\) Offene/.test(await popup.title()), `${label} Hauptfenster: der Balken ist im Diagramm, der Titel des Fensters zählt 6`);
  report(await popup.evaluate(() => /Rückgängig/.test(document.querySelector('.gtw-toast').textContent) && document.querySelector('.gtw-toast').classList.contains('on')), `${label} Fenster: Hinweis mit „Rückgängig“ unten`);
  await popup.evaluate(() => [...document.querySelectorAll('.gtw-toast button')].find(b => /Rückgängig/.test(b.textContent)).click());
  await settle(900);
  report((await cardsOf(popup)).length === 7 && !(await orderOf('65900003')).dis, `${label} Fenster: „Rückgängig“ bringt die Karte zurück (auch am Server)`);

  // ---- Suche und Auftragsart im Fenster ----
  const input = popup.locator('input[type="search"]');
  await input.click();
  await input.pressSequentially('Schieb', { delay: 90 });
  await settle(500);
  const typed = await popup.evaluate(() => ({ v: document.querySelector('input[type="search"]').value, focus: document.activeElement === document.querySelector('input[type="search"]'), cards: [...document.querySelectorAll('.gt-pool > [data-k]')].map(c => c.dataset.k.slice(3)) }));
  report(typed.v === 'Schieb' && typed.focus && typed.cards.join() === '65900002-0010', `${label} Fenster: Tippen in der Suche filtert die Liste, das Feld behält Fokus und Text`, JSON.stringify(typed));
  await input.fill('');
  await settle(600);
  await popup.evaluate(() => [...document.querySelectorAll('.chips button')].find(b => /Entstörungen/.test(b.textContent)).click());
  await settle(700);
  report((await cardsOf(popup)).join() === '65900004,65900003' && (await page.evaluate(() => [...document.querySelectorAll('#app .chip.on')].map(b => b.textContent.trim()).join())).startsWith('🚨 Entstörungen'), `${label} Fenster: Auftragsart „Entstörungen“ filtert die Liste, das Hauptfenster zeigt dieselbe Wahl`, (await cardsOf(popup)).join());
  await popup.evaluate(() => [...document.querySelectorAll('.chips button')].find(b => /^Alle/.test(b.textContent.trim())).click());
  await settle(700);

  // ---- Karte antippen: Bearbeiten-Fenster im Hauptfenster ----
  await popup.evaluate(() => document.querySelector('[data-k="dp-65900002-0010"]').click());
  await settle(700);
  report(await page.evaluate(() => { const s = document.querySelector('#app .gt-sheet'); return !!s && /65900002-0010/.test(s.textContent) && /noch offen/.test(s.textContent) && !!document.querySelector('#app .gt-bar.draft'); }) && (await popup.evaluate(() => document.querySelector('[data-k="dp-65900002-0010"]').classList.contains('sel'))), `${label} Karte im Fenster antippen: das Hauptfenster zeigt Bearbeiten-Fenster und Entwurf, die Karte ist hervorgehoben`);
  await page.evaluate(() => document.querySelector('#app .gt-sheet .gt-x').click());
  await settle(600);
  report(await popup.evaluate(() => !document.querySelector('[data-k="dp-65900002-0010"]').classList.contains('sel')), `${label} Bearbeiten-Fenster schließen: die Hervorhebung im Fenster verschwindet`);

  // ---- Karte auf eine Teamzeile ziehen (HTML5-Ziehen) ----
  const geo = await page.evaluate(() => {
    const sc = document.querySelector('#app .gt-scroll').getBoundingClientRect(), row = document.querySelector('#app .gt-row[data-team="FW-IH02"]').getBoundingClientRect();
    return { left: sc.left - document.querySelector('#app .gt-scroll').scrollLeft, y: row.top + row.height / 2 };
  });
  await popup.evaluate(() => { window.__dt = new DataTransfer(); document.querySelector('[data-k="dp-65900004"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt })); });
  const x14 = geo.left + 14 * 48;
  await page.evaluate(({ x, y }) => {
    const row = document.querySelector('#app .gt-row[data-team="FW-IH02"]');
    row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: new DataTransfer() }));
  }, { x: x14, y: geo.y });
  const during = await page.evaluate(() => ({ tip: (document.querySelector('.gt-tip') || {}).textContent, target: [...document.querySelectorAll('#app .gt-row.tgt')].map(r => r.dataset.team), name: [...document.querySelectorAll('#app .gt-name.tgt')].length }));
  report(/FW-IH02/.test(during.tip || '') && /14:00/.test(during.tip) && during.target.join() === 'FW-IH02' && during.name === 1, `${label} Ziehen über das Diagramm: Hinweis zeigt Team und Zeit, Zielzeile ist hervorgehoben`, `${during.tip} · ${during.target.join()}`);
  // während des Ziehens bleibt die Liste im Fenster stehen (sonst bräche das Ziehen ab)
  report((await cardsOf(popup)).includes('65900004'), `${label} Ziehen: die Karte bleibt im Fenster, bis das Ziehen endet`);
  await page.evaluate(({ x, y }) => {
    const row = document.querySelector('#app .gt-row[data-team="FW-IH02"]');
    row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: new DataTransfer() }));
  }, { x: x14, y: geo.y });
  await popup.evaluate(() => document.querySelector('[data-k="dp-65900004"]').dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt })));
  await settle(1200);
  const o4 = await orderOf('65900004');
  report(o4 && o4.dis === 1 && o4.team === 'FW-IH02' && o4.start === todayIso && o4.uhr === '14:00' && o4.uhr2 === '21:30', `${label} Fallenlassen: Auftrag liegt bei FW-IH02 ab 14:00 (Stelle des Zeigers, Dauer aus SAP)`, JSON.stringify(o4 && { team: o4.team, start: o4.start, uhr: o4.uhr, uhr2: o4.uhr2 }));
  report(!(await cardsOf(popup)).includes('65900004') && (await page.evaluate(() => !document.querySelector('.gt-tip') && !document.querySelector('#app .gt-row.tgt') && !!document.querySelector('#app .gt-bar[data-k="gb-65900004"]'))), `${label} Fallenlassen: Karte weg, Balken im Diagramm, Hinweis und Hervorhebung sind aufgeräumt`);
  // Loslassen außerhalb einer Zeile ändert nichts
  await popup.evaluate(() => { window.__dt = new DataTransfer(); document.querySelector('[data-k="dp-65900009"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt })); });
  await popup.evaluate(() => document.querySelector('[data-k="dp-65900009"]').dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt })));
  await settle(400);
  report((await cardsOf(popup)).includes('65900009') && !(await orderOf('65900009')).dis, `${label} Ziehen ohne Ziel: nichts wird disponiert`);

  // ---- Fenster schließen: von der Seite aus und vom Fenster aus ----
  report(await page.evaluate(() => [...document.querySelectorAll('#app .gtt button')].map(b => b.textContent.trim()).join() === 'Nach vorn,Liste wieder hier'), `${label} Hauptfenster: Knöpfe „Nach vorn“ und „Liste wieder hier“`);
  await probe(page, `${label} „Liste wieder hier“ (Fenster schließt, Liste steht wieder in der Seite)`, btn('/^Liste wieder hier$/', '#app .gtt'), { ms: 1000, anim: true });
  await settle(400);
  report(popup.isClosed() && (await page.evaluate(() => document.querySelectorAll('#app .gt-pc').length)) === 6 && !(await page.evaluate(() => !!document.querySelector('#app .gtp.solo'))), `${label} „Liste wieder hier“: Extra-Fenster ist zu, die 6 offenen Karten stehen wieder links`);
  const b2 = await bar();
  // (die Oberkante liegt tiefer: oben steht noch der Hinweis „Rückgängig“ vom Fallenlassen)
  report(b2.h === b0.h && b2.gt === b0.gt, `${label} Hauptfenster: Leiste und Diagramm so hoch und breit wie vor dem Öffnen`, JSON.stringify(b2));
  // erneut öffnen und das Fenster selbst schließen
  const [popup2] = await Promise.all([page.context().waitForEvent('page', { timeout: 10000 }), page.click('#app .gtt-pop')]);
  await popup2.waitForSelector('.gt-pool > [data-k]', { timeout: 10000 });
  await settle(600);
  report((await cardsOf(popup2)).length === 6 && (await page.evaluate(() => !!document.querySelector('#app .gtp.solo'))), `${label} Erneut geöffnet: 6 offene Karten im Fenster`);
  await popup2.close();
  await page.waitForFunction(() => !document.querySelector('#app .gtp.solo') && document.querySelectorAll('#app .gt-pc').length === 6, null, { timeout: 4000 }).then(() => report(true, `${label} Fenster geschlossen (Kreuz): die Liste steht von selbst wieder im Hauptfenster`), e => report(false, `${label} Fenster geschlossen (Kreuz): die Liste steht von selbst wieder im Hauptfenster`, 'nach 4 s noch nicht'));
  // Abmelden schließt das Fenster mit
  const [popup3] = await Promise.all([page.context().waitForEvent('page', { timeout: 10000 }), page.click('#app .gtt-pop')]);
  await popup3.waitForSelector('.gt-pool > [data-k]', { timeout: 10000 });
  await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => /Start/.test(b.textContent)).click());
  await settle(900);
  report(popup3.isClosed(), `${label} Abmelden („← Start“) schließt das Extra-Fenster mit`);
  await page.context().close();
}

// Disposition auf dem schmalsten Handy (320 px): nichts ragt über den Rand, das Bearbeiten-Fenster liegt im Bild, Dunkelmodus lesbar.
// Endet wie dispositionChecks mit „Alle Vorschläge übernehmen“ (die Monteur-Prüfungen danach rechnen mit diesen Zeiten).
async function dispositionNarrowChecks(browser, base, errors) {
  console.log('\n=== Disposition: schmales Handy (320 px) und Dunkelmodus ===');
  await undispatchAll(base);
  const page = await newPage(browser, base, { width: 320, height: 640 }, errors);
  await loginDispo(page);
  await page.evaluate(() => [...document.querySelectorAll('#app .tabs button')].find(b => /^Disposition/.test(b.textContent.trim())).click());
  await page.waitForFunction(() => document.querySelectorAll('#app .gt-pc').length === 7, null, { timeout: 15000 });
  await pause(page, 800);
  const wide = () =>
    page.evaluate(() => [...document.querySelectorAll('#app *')].filter(n => n.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !n.closest('.tabs, .gt-scroll') && getComputedStyle(n).position !== 'fixed').map(n => n.tagName + '.' + n.className + '"' + n.textContent.trim().slice(0, 20) + '"').slice(0, 3));
  let w = await wide();
  report(!w.length && (await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)), '320px Disposition: Liste und Diagramm ragen nicht über den Rand', w.join(', '));
  await page.evaluate(() => document.querySelector('#app [data-k="dp-65900003"]').click());
  await pause(page, 700);
  const sheet = await page.evaluate(() => { const r = document.querySelector('#app .gt-sheet').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: innerWidth, h: innerHeight, fields: [...document.querySelectorAll('#app .gt-sheet input, #app .gt-sheet select')].map(n => Math.round(n.getBoundingClientRect().right)).every(x => x <= innerWidth) }; });
  report(sheet.l >= 0 && sheet.r <= sheet.w && sheet.b <= sheet.h && sheet.t >= 0 && sheet.fields, '320px Fenster: liegt im Bild, alle Felder innerhalb des Randes', JSON.stringify(sheet));
  w = await wide();
  report(!w.length, '320px Disposition mit Fenster: nichts ragt über den Rand', w.join(', '));
  await page.evaluate(() => [...document.querySelectorAll('#app .gt-seg button')].find(b => /^Monat$/.test(b.textContent.trim())).click());
  await pause(page, 600);
  w = await wide();
  const seg = await page.evaluate(() => { const r = document.querySelector('#app .gt-seg').getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
  report(!w.length && seg.l >= 0 && seg.r <= seg.w && (await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)), '320px Monat: Zoom-Schalter (Tag, Woche, Monat) und Diagramm ragen nicht über den Rand', JSON.stringify(seg) + ' ' + w.join(', '));
  await page.evaluate(() => [...document.querySelectorAll('#app .gt-seg button')].find(b => /^Tag$/.test(b.textContent.trim())).click());
  await pause(page, 500);
  // Dunkelmodus: Balken, Entwurf, Zeilen und Fenster bleiben lesbar (Text hebt sich vom Grund ab)
  await page.evaluate(() => [...document.querySelectorAll('#app .gt-sheet button')].find(b => /^1 Std$/.test(b.textContent.trim())).click());
  await pause(page, 400);
  await page.emulateMedia({ colorScheme: 'dark' });
  await pause(page, 400);
  const lum = c => { const m = c.match(/\d+(\.\d+)?/g).map(Number), f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  await page.evaluate(() => document.querySelector('#app .gt-sheet .gt-x').click());
  await pause(page, 400);
  await page.evaluate(() => document.querySelector('#app [data-k="dp-65900003"] .gt-go').click());
  await pause(page, 700);
  const dark = await page.evaluate(() => {
    const bar = document.querySelector('#app .gt-bar:not(.draft)'), cs = getComputedStyle(bar), card = getComputedStyle(document.querySelector('#app .gt'));
    return { fg: cs.color, bg: cs.backgroundColor, cardBg: card.backgroundColor, text: getComputedStyle(document.querySelector('#app .gt-name')).color };
  });
  report(ratio(dark.fg, dark.bg) >= 4.5 && ratio(dark.text, dark.cardBg) >= 4.5, 'Dunkelmodus: Balkenschrift und Teamnamen sind gut lesbar (Kontrast ≥ 4,5)', `Balken ${ratio(dark.fg, dark.bg).toFixed(1)}, Team ${ratio(dark.text, dark.cardBg).toFixed(1)}`);
  await page.emulateMedia({ colorScheme: 'light' });
  // alles wieder auf den Vorschlag aus SAP
  await page.waitForFunction(() => !document.querySelector('#app .msg'), null, { timeout: 20000 });
  await undispatchAll(base);
  await page.waitForFunction(() => document.querySelectorAll('#app .gt-pc').length === 7, null, { timeout: 15000 });
  await pause(page, 500);
  await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => /^Alle Vorschläge übernehmen/.test(b.textContent.trim())).click());
  await pause(page, 400);
  await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => /^Wirklich 7/.test(b.textContent.trim())).click());
  await pause(page, 1200);
  report((await dispatchOrders(base)).every(o => o.dis === 1), '320px: zuletzt sind wieder alle mit dem Vorschlag aus SAP disponiert');
  await page.context().close();
}

// Monteur: Startseite mit der Auswahl der Auftragsart, die Listen (Termin & Uhrzeit), Detail ohne Prüfobjekte, Meldungen
async function kindChecks(browser, base, viewport, errors) {
  const label = `${viewport.width}px`,
    page = await newPage(browser, base, viewport, errors);
  console.log(`\n=== Auftragsarten: Monteur (${label}) ===`);
  await loginMonteur(page, null);
  const tiles = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#app button.kind')].map(b => [b.querySelector('.kn').textContent, b.textContent.replace(b.querySelector('.kn').textContent, '').replace(/\s+/g, ' ').trim()])));
  const t0 = await tiles();
  report(Object.keys(t0).join() === 'Wartungen,Reparaturen,Entstörungen,Daueraufträge,Meldungen', `${label} Startseite: Auswahl der Auftragsart`, Object.keys(t0).join(', '));
  // „offen/gesamt“ (Status) gibt es nur bei Wartungen, die übrigen Auftragsarten zählen nur die Aufträge
  report(/⏰ 1 im Verzug/.test(t0.Reparaturen) && !/Verzug/.test(t0.Entstörungen + t0.Daueraufträge + t0.Wartungen), `${label} Startseite: Reparaturen im Verzug werden gezählt`, t0.Reparaturen);
  report(/4 Aufträge/.test(t0.Reparaturen) && /2 Aufträge/.test(t0.Entstörungen) && /📅 1 heute/.test(t0.Entstörungen) && /1 Auftrag/.test(t0.Daueraufträge) && !/offen/.test(t0.Reparaturen + t0.Entstörungen + t0.Daueraufträge) && /2 ohne Auftrag/.test(t0.Meldungen) && /offen · \d+ gesamt/.test(t0.Wartungen), `${label} Startseite: Zahlen je Auftragsart (nur das eigene Team), Status nur bei Wartungen`, JSON.stringify(t0).slice(0, 300));
  // Startseite: Hinweis schließen/öffnen lässt nichts springen
  const hasBanner = await page.evaluate(() => [...document.querySelectorAll('#app button')].some(b => b.textContent.trim() === '✕'));
  if (hasBanner) await probe(page, `${label} Startseite: Hinweis mit ✕ schließen`, btn('/^✕$/'), { scroll: 0, ms: 800, tapTol: 400, smooth: '#app .gasl' });
  // Fortschritt (Prozent, Wochenpensum) gibt es nur bei Wartungen
  await probe(page, `${label} Startseite: Wartungen öffnen (Seite gleitet von rechts herein)`, `() => document.querySelector('#app [data-k="kd-war"]')`, { reflow: true, ms: 900, anim: true });
  report(await page.evaluate(() => !!document.querySelector('#app .prg') && !!document.querySelector('#app [data-k="fc"]') && !document.querySelector('#app .ksw')), `${label} Wartungen: Fortschritt und Status-Filter werden angezeigt, kein Umschalter zwischen den Auftragsarten`);
  await probe(page, `${label} Wartungen: ← Auftragsarten (Seite gleitet von links herein)`, btn('/Auftragsarten/'), { reflow: true, ms: 900, anim: true });
  // Reparaturen: nach Termin und Uhrzeit (ab heute aufsteigend, dann das Vergangene)
  await probe(page, `${label} Startseite: Reparaturen öffnen`, `() => document.querySelector('#app [data-k="kd-rep"]')`, { reflow: true, ms: 900, anim: true });
  const order = () => page.evaluate(() => [...document.querySelectorAll('#app [data-list] > [data-k]')].map(n => n.dataset.k));
  const o1 = await order();
  report(o1.join() === 'o65900008-0010,o65900002-0010,o65900001-0010,o65900009', `${label} Reparaturen: nach Termin, das Älteste zuerst (wer im Verzug ist, steht oben), die neueren darunter`, o1.join(', '));
  // im Verzug: der Termin (−3 Tage, ohne Zeitrückmeldung) liegt in der Vergangenheit – rotes Etikett mit den Tagen und rote Kante; die anderen nicht
  const late = await page.evaluate(() => ({ tag: (document.querySelector('#app [data-k="o65900008-0010"] .tag.st-nok') || {}).textContent, cls: document.querySelector('#app [data-k="o65900008-0010"]').className, others: ['o65900002-0010', 'o65900001-0010', 'o65900009'].filter(k => /Verzug/.test(document.querySelector(`#app [data-k="${k}"]`).textContent) || /\bdue\b/.test(document.querySelector(`#app [data-k="${k}"]`).className)) }));
  report(/im Verzug · 3 Tage/.test(late.tag || '') && /\bdue\b/.test(late.cls) && !late.others.length, `${label} Reparaturen: Termin in der Vergangenheit ist als „im Verzug“ hervorgehoben (Etikett mit Tagen, Kante), kommende nicht`, JSON.stringify(late));
  // Fortschritt, Status-Filter (Offen/Erledigt), Status-Etiketten und der Umschalter zwischen den Auftragsarten gibt es hier nicht
  const noStatus = await page.evaluate(() => ({ prg: !!document.querySelector('#app .prg'), fc: !!document.querySelector('#app [data-k="fc"]'), ksw: !!document.querySelector('#app .ksw'), tags: [...document.querySelectorAll('#app [data-list] .tag')].map(t => t.textContent).filter(t => /Erledigt|offen|Nicht OK|geprüft/.test(t)) }));
  report(!noStatus.prg && !noStatus.fc && !noStatus.ksw && !noStatus.tags.length, `${label} Reparaturen: kein Fortschritt, keine Status-Filter und -Etiketten, kein Umschalter`, JSON.stringify(noStatus));
  const extTags = await page.evaluate(() => ({
    mixed: /Externe Firma/.test(document.querySelector('#app [data-k="o65900001-0010"]').textContent),
    only: /Externe Firma/.test(document.querySelector('#app [data-k="o65900009"]').textContent),
    none: !/Externe Firma/.test(document.querySelector('#app [data-k="o65900002-0010"]').textContent),
    planned: !document.querySelector('#app [data-k="o65900010"], #app [data-k="o65900001-0040"]')
  }));
  report(await page.evaluate(() => /📋 Meldung/.test(document.querySelector('#app [data-k="o65900001-0010"]').textContent) && !document.querySelector('#app [data-k="o65900001-0010"] .tag.gb')), `${label} Reparaturen: Meldung mit Schaden bleibt ein einfaches „📋 Meldung“`);
  report(extTags.mixed && extTags.only && extTags.none && extTags.planned, `${label} Reparaturen: externe Firma gekennzeichnet, Geplantes (P) fehlt`, JSON.stringify(extTags));
  // Auftrag mit externer Firma: im Detail die Vorgänge der Fremdfirma
  await probe(page, `${label} Reparatur mit externer Firma öffnen`, `() => document.querySelector('#app [data-k="o65900001-0010"]')`, { reflow: true, ms: 900, anim: true });
  const extDetail = await page.evaluate(() => (document.querySelector('#app .extbox') || {}).textContent || '');
  report(/Externe Firma arbeitet mit/.test(extDetail) && /Vorgang 0030/.test(extDetail) && /Fremdfirma: Kabel ziehen/.test(extDetail) && /6 Std geplant/.test(extDetail), `${label} Reparatur: Detail zeigt die externe Firma mit ihrem Vorgang`, extDetail);
  await probe(page, `${label} Reparatur schließen (← Zurück, Seite gleitet von links herein)`, btn('/Zurück/'), { reflow: true, ms: 900, anim: true });
  // Reparatur im Verzug öffnen: auch in der Auftragsansicht ist es hervorgehoben
  await probe(page, `${label} Reparatur im Verzug öffnen`, `() => document.querySelector('#app [data-k="o65900008-0010"]')`, { reflow: true, ms: 900, anim: true });
  report(await page.evaluate(() => /im Verzug · 3 Tage/.test((document.querySelector('#app [data-k="oc"] .tag.st-nok') || {}).textContent || '') && /\bdue\b/.test(document.querySelector('#app [data-k="oc"]').className)), `${label} Reparatur im Verzug: auch in der Auftragsansicht hervorgehoben`);
  await probe(page, `${label} Reparatur im Verzug schließen`, btn('/Zurück/'), { reflow: true, ms: 900, anim: true });
  const trm = await page.evaluate(() => (document.querySelector('#app [data-k="o65900002-0010"] .trm') || {}).textContent);
  report(/13:30–17:30 Uhr/.test(trm || ''), `${label} Reparaturen: Karte zeigt Datum und disponierte Uhrzeit von–bis`, trm);
  const sortBtns = await page.evaluate(() => [...document.querySelectorAll('#app .chips.ab button')].map(b => b.textContent.trim()).join(','));
  report(sortBtns === 'Termin & Uhrzeit,Auftragsnummer,Entfernung', `${label} Reparaturen: Sortierung`, sortBtns);
  await probe(page, `${label} Reparaturen: Sortierung Auftragsnummer`, btn('/^Auftragsnummer$/'), { at: 300 });
  const o2 = await order();
  report(o2.join() === 'o65900001-0010,o65900002-0010,o65900008-0010,o65900009', `${label} Reparaturen: nach Auftragsnummer`, o2.join(', '));
  await probe(page, `${label} Reparaturen: Sortierung Termin & Uhrzeit`, btn('/^Termin & Uhrzeit$/'), { at: 300 });
  // ist für den Auftrag im Verzug eine Zeit zurückgemeldet, gilt er als bearbeitet: keine Hervorhebung mehr (die Zeit steht auf der Karte)
  {
    const user = await (await fetch(base + '/api/user/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: MONTEUR.user, password: MONTEUR.password }) })).json();
    const st = (await fetch(base + '/api/ergebnis/65900008-0010', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-User-Token': user.token }, body: JSON.stringify({ a: '65900008-0010', team: 'FW-IH01', n: 0, s: '', nok: [], min: 60, dat: new Date().toLocaleDateString('sv-SE'), von: '08:00' }) })).status;
    await pause(page, 1500);
    const done = await page.evaluate(() => { const c = document.querySelector('#app [data-k="o65900008-0010"]'); return { verzug: /Verzug/.test(c.textContent), due: /\bdue\b/.test(c.className), zeit: /⏱ 1 Std/.test(c.textContent), pos: [...document.querySelectorAll('#app [data-list] > [data-k]')].map(n => n.dataset.k).join() }; });
    report(st === 200 && !done.verzug && !done.due && done.zeit && done.pos.startsWith('o65900008-0010'), `${label} Reparaturen: mit zurückgemeldeter Zeit ist der Verzug nicht mehr hervorgehoben (live)`, JSON.stringify(done));
  }
  // zurück zur Startseite und die nächste Auftragsart öffnen (einen Umschalter in der Liste gibt es nicht)
  await probe(page, `${label} Reparaturen: ← Auftragsarten`, btn('/Auftragsarten/'), { reflow: true, ms: 900, anim: true });
  await probe(page, `${label} Startseite: Entstörungen öffnen`, `() => document.querySelector('#app [data-k="kd-ent"]')`, { reflow: true, ms: 900, anim: true });
  const o3 = await order();
  report(o3.join() === 'o65900004,o65900003', `${label} Entstörungen: das Älteste zuerst (Nachtschicht seit gestern vor dem Termin von heute)`, o3.join(', '));
  const ent = await page.evaluate(() => ({ a: document.querySelector('#app [data-k="o65900003"]').textContent.replace(/\s+/g, ' '), b: document.querySelector('#app [data-k="o65900004"] .trm').textContent }));
  const gbCards = await page.evaluate(() => {
    const c = k => document.querySelector(`#app [data-k="${k}"]`);
    return { ent: (c('o65900003').querySelector('.tag.gb') || {}).textContent, entCard: c('o65900003').className, none: !c('o65900004').querySelector('.tag.gb') };
  });
  report(/Gebrechen · stark/.test(gbCards.ent || '') && /gb-c3/.test(gbCards.entCard) && gbCards.none, `${label} Entstörungen: Gebrechen stark ist in der Liste hervorgehoben (Etikett, Kante), ohne Meldung nicht`, JSON.stringify(gbCards));
  report(/Heute/.test(ent.a) && /08:30–10:15 Uhr/.test(ent.a) && /📋/.test(ent.a) && /bis .* 05:30 Uhr/.test(ent.b), `${label} Entstörungen: Heute-Etikett, Uhrzeit von–bis, Meldung; Nachtschicht über Mitternacht`, ent.a.slice(0, 120) + ' | ' + ent.b);
  // Entstörung öffnen: keine Prüfobjekte, dafür die Meldung; Zeit ist mit dem Termin vorbelegt
  await probe(page, `${label} Entstörung öffnen`, `() => document.querySelector('#app [data-k="o65900003"]')`, { reflow: true, ms: 900, anim: true });
  const det = await page.evaluate(() => ({ items: document.querySelectorAll('#app .it').length, text: document.querySelector('#app').textContent.replace(/\s+/g, ' ') }));
  const gbDetail = await page.evaluate(() => ({ info: !!document.querySelector('#app [data-k="oc"] .tag.gb-3'), item: !!document.querySelector('#app .it.gb-c3 .tag.gb-3') }));
  report(gbDetail.info && gbDetail.item, `${label} Entstörung: im Auftrag ist das Gebrechen oben und bei der Meldung hervorgehoben`, JSON.stringify(gbDetail));
  report(/Dampf aus dem Schacht/.test(det.text) && /1290000001/.test(det.text) && !/Prüfobjekte/.test(det.text.replace(/Prüfobjekte bewerten/, '')), `${label} Entstörung: Detail zeigt die Meldung, keine Prüfobjekte`, det.text.slice(0, 160));
  const A = 330;
  await probe(page, `${label} Entstörung: Zeit von Hand eintragen öffnen`, btn('/Zeit von Hand/'), { at: A, ms: 800 });
  const form = await page.evaluate(() => [...document.querySelectorAll('#app .d-time input')].map(i => i.type + '=' + i.value));
  const todayIso = new Date().toLocaleDateString('sv-SE');
  report(form.includes('date=' + todayIso) && form.some(f => /=08:30$/.test(f)), `${label} Entstörung: Datum und Beginn mit dem Termin vorbelegt`, form.join(' '));
  await probe(page, `${label} Entstörung: Schnellwahl 1 Std`, btn('/^1 Std$/'), { at: A });
  await probe(page, `${label} Entstörung: Zeit speichern`, btn('/Zeit speichern/'), { at: A, ms: 1200 });
  await pause(page, 800);
  // die Zeit ist gespeichert; ein Status („Erledigt“) wird nicht angezeigt – nur die Zeit selbst
  const saved = await page.evaluate(() => ({ status: /Erledigt|offen/.test(document.querySelector('#app [data-k="oc"]').textContent), time: /⏱ 1 Std/.test(document.querySelector('#app [data-k="oc"]').textContent) }));
  report(!saved.status && saved.time, `${label} Entstörung: nach dem Speichern steht die Zeit auf der Karte, kein Status`, JSON.stringify(saved));
  await probe(page, `${label} Entstörung schließen (← Zurück)`, btn('/Zurück/'), { reflow: true, ms: 900, anim: true });
  const bothLeft = await page.evaluate(() => [...document.querySelectorAll('#app [data-list] > [data-k]')].map(n => n.dataset.k).join());
  report(bothLeft === 'o65900004,o65900003', `${label} Entstörungen: alle bleiben in der Liste (kein Offen/Erledigt-Filter)`, bothLeft);
  // Dauerauftrag, Meldungen
  await probe(page, `${label} Entstörungen: ← Auftragsarten`, btn('/Auftragsarten/'), { reflow: true, ms: 900, anim: true });
  await probe(page, `${label} Startseite: Daueraufträge öffnen`, `() => document.querySelector('#app [data-k="kd-dau"]')`, { reflow: true, ms: 900, anim: true });
  const dau = await order();
  report(dau.join() === 'o65900005', `${label} Daueraufträge: Liste`, dau.join(', '));
  report(await page.evaluate(() => !document.querySelector('#app .prg')), `${label} Daueraufträge: kein Fortschritt (nur bei Wartungen)`);
  // Dauerauftrag: mehrere Tageseinträge
  await probe(page, `${label} Dauerauftrag öffnen`, `() => document.querySelector('#app [data-k="o65900005"]')`, { reflow: true, ms: 900, anim: true });
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#app .zrow')].map(n => n.textContent.replace(/\s+/g, ' ').trim()));
  const sum = () => page.evaluate(() => (document.querySelector('#app [data-k="zs0"]') || {}).textContent);
  report((await sum()) === 'Noch keine Einträge – für jeden Tag, an dem gearbeitet wurde, ein Eintrag.' && !(await page.evaluate(() => /Prüfobjekte/.test(document.querySelector('#app').textContent.replace('Prüfobjekte bewerten', '')))), `${label} Dauerauftrag: Tageseinträge statt Zeit und Prüfobjekte`, await sum());
  await probe(page, `${label} Dauerauftrag: Eintrag von Hand öffnen`, btn('/Eintrag von Hand/'), { at: A, ms: 800 });
  await page.fill('#app .d-time input[type=time]', '07:00');
  await probe(page, `${label} Dauerauftrag: Schnellwahl 1 Std`, btn('/^1 Std$/'), { at: A });
  await probe(page, `${label} Dauerauftrag: Eintrag speichern (heute) – der Eintrag blendet ein`, btn('/^Eintrag speichern$/'), { at: A, ms: 1200, anim: true });
  await pause(page, 600);
  let r1 = await rows();
  report(r1.length === 1 && /ab 07:00 Uhr · 1 Std/.test(r1[0]) && (await sum()) === 'Gesamt 1 Std in 1 Eintrag', `${label} Dauerauftrag: erster Tageseintrag steht in der Liste`, r1.join(' | ') + ' / ' + (await sum()));
  // zweiter Eintrag: gestern
  await probe(page, `${label} Dauerauftrag: zweiten Eintrag öffnen`, btn('/Eintrag von Hand/'), { at: A, ms: 800 });
  await probe(page, `${label} Dauerauftrag: Datum „Gestern“`, btn('/^Gestern$/'), { at: A });
  await page.fill('#app .d-time input[type=time]', '13:00');
  await probe(page, `${label} Dauerauftrag: Schnellwahl 2 Std`, btn('/^2 Std$/'), { at: A });
  await probe(page, `${label} Dauerauftrag: zweiten Eintrag speichern – er blendet ein, der erste rückt`, btn('/^Eintrag speichern$/'), { at: A, ms: 1200, anim: true });
  await pause(page, 600);
  const r2 = await rows();
  report(r2.length === 2 && /ab 07:00 Uhr · 1 Std/.test(r2[0]) && /ab 13:00 Uhr · 2 Std/.test(r2[1]) && (await sum()) === 'Gesamt 3 Std in 2 Einträgen', `${label} Dauerauftrag: zwei Tageseinträge, neuester zuerst, Summe`, r2.join(' | ') + ' / ' + (await sum()));
  // ersten Eintrag ändern
  await probe(page, `${label} Dauerauftrag: Eintrag ändern öffnen`, `() => document.querySelector('#app .zrow button')`, { at: A, ms: 800 });
  const formVals = await page.evaluate(() => [...document.querySelectorAll('#app .d-time input')].map(i => i.type + '=' + i.value).join(' '));
  report(/time=07:00/.test(formVals) && /Eintrag bearbeiten/.test(await page.evaluate(() => document.querySelector('#app .zne').textContent)), `${label} Dauerauftrag: Eintrag ist zum Ändern ins Formular geladen`, formVals);
  await probe(page, `${label} Dauerauftrag: Schnellwahl 30 Min`, btn('/^30 Min$/'), { at: A });
  await probe(page, `${label} Dauerauftrag: Eintrag ändern speichern`, btn('/^Eintrag ändern$/'), { at: A, ms: 1200 });
  await pause(page, 600);
  report((await sum()) === 'Gesamt 2 Std 30 Min in 2 Einträgen', `${label} Dauerauftrag: geänderter Eintrag zählt in der Summe`, await sum());
  // zweiten Eintrag löschen
  await probe(page, `${label} Dauerauftrag: Eintrag löschen öffnen`, `() => document.querySelectorAll('#app .zrow button')[1]`, { at: A, ms: 800 });
  await probe(page, `${label} Dauerauftrag: Eintrag löschen`, btn('/^Eintrag löschen$/'), { at: A, ms: 1200 });
  await pause(page, 600);
  report((await rows()).length === 1 && (await sum()) === 'Gesamt 30 Min in 1 Eintrag', `${label} Dauerauftrag: gelöschter Eintrag ist weg`, (await rows()).join(' | ') + ' / ' + (await sum()));
  await probe(page, `${label} Dauerauftrag schließen (← Zurück)`, btn('/Zurück/'), { reflow: true, ms: 900, anim: true });
  const dauCard = await page.evaluate(() => document.querySelector('#app [data-k="o65900005"]').textContent.replace(/\s+/g, ' '));
  report(/⏱ 30 Min · 1 Eintrag/.test(dauCard) && !/Erledigt/.test(dauCard), `${label} Dauerauftrag: Karte zeigt die Gesamtzeit, ist nie „erledigt“`, dauCard.slice(0, 120));
  // nach dem Neuladen (Server-Stand) sind die Einträge noch da; der Server lehnt Tageseinträge bei anderen Auftragsarten ab
  const login = await (await fetch(base + '/api/user/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: MONTEUR.user, password: MONTEUR.password }) })).json();
  const put = async key => (await fetch(base + '/api/ergebnis/' + encodeURIComponent(key), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-User-Token': login.token }, body: JSON.stringify({ a: key, team: 'FW-IH01', n: 0, s: '', nok: [], min: 60, dat: todayIso, von: '08:00' }) })).status;
  report((await put('65900003#abcdef')) === 400, `${label} Server: Tageseintrag bei einer Entstörung wird abgelehnt (nur Daueraufträge)`);
  report((await put('65900005#abcdef')) === 200, `${label} Server: Tageseintrag bei einem Dauerauftrag wird angenommen`);
  await page.reload();
  await pause(page, 1500);
  await chooseKind(page, 'Daueraufträge');
  await page.evaluate(() => document.querySelector('#app [data-k="o65900005"]').click());
  await pause(page, 900);
  report((await rows()).length === 2 && (await sum()) === 'Gesamt 1 Std 30 Min in 2 Einträgen', `${label} Dauerauftrag: Einträge nach dem Neuladen vom Server (und der eines anderen Geräts)`, (await rows()).join(' | ') + ' / ' + (await sum()));
  await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => /Zurück/.test(b.textContent)).click());
  await pause(page, 700);
  await probe(page, `${label} Daueraufträge: ← Auftragsarten`, btn('/Auftragsarten/'), { reflow: true, ms: 900, anim: true });
  await probe(page, `${label} Startseite: Meldungen öffnen`, `() => document.querySelector('#app [data-k="kd-mel"]')`, { reflow: true, ms: 900, anim: true });
  const mel = await page.evaluate(() => [...document.querySelectorAll('#app [data-list] > [data-k]')].map(n => n.dataset.k).join());
  report(mel === 'm1290000003,m1290000005', `${label} Meldungen: nur die des Teams ohne Auftrag, neueste zuerst`, mel);
  const melGb = await page.evaluate(() => ({ mittel: (document.querySelector('#app [data-k="m1290000003"] .tag.gb-2') || {}).textContent, cls: document.querySelector('#app [data-k="m1290000003"]').className, schaden: !document.querySelector('#app [data-k="m1290000005"] .tag.gb') && !/gb-c/.test(document.querySelector('#app [data-k="m1290000005"]').className) }));
  report(/Gebrechen · mittel/.test(melGb.mittel || '') && /gb-c2/.test(melGb.cls) && melGb.schaden, `${label} Meldungen: Gebrechen mittel hervorgehoben, Schaden nicht`, JSON.stringify(melGb));
  await page.click('#app input[type=search]');
  await page.keyboard.type('Graffiti');
  await pause(page, 600);
  const found = await page.evaluate(() => [...document.querySelectorAll('#app [data-list] > [data-k]')].map(n => n.dataset.k).join());
  report(found === 'm1290000005', `${label} Meldungen: Suche`, found);
  await page.fill('#app input[type=search]', '');
  await pause(page, 500);
  // zurück zur Startseite (Knopf), erneut öffnen, Zurück-Taste des Geräts
  await probe(page, `${label} Meldungen: ← Auftragsarten`, btn('/Auftragsarten/'), { reflow: true, ms: 900, anim: true });
  const t1 = await tiles();
  report(/2 Aufträge/.test(t1.Entstörungen) && /📅 1 heute/.test(t1.Entstörungen) && !/offen/.test(t1.Entstörungen), `${label} Startseite: Entstörungen zählen alle Aufträge (kein offen/erledigt), „heute“ bleibt`, t1.Entstörungen);
  await probe(page, `${label} Startseite: Entstörungen öffnen`, `() => document.querySelector('#app [data-k="kd-ent"]')`, { reflow: true, ms: 900, anim: true });
  await page.goBack();
  await pause(page, 700);
  const back = await page.evaluate(() => document.querySelectorAll('#app button.kind').length);
  report(back === 5, `${label} Zurück-Taste des Geräts: von der Liste zur Startseite`, String(back));
  await page.context().close();
}

// breiter Bildschirm: Startseite, Liste und Auftrag einer Reparatur (zweispaltig) ohne Sprünge und ohne Überlauf
async function kindChecksWide(browser, base, viewport, errors) {
  const label = `${viewport.width}px`,
    page = await newPage(browser, base, viewport, errors);
  console.log(`\n=== Auftragsarten: Monteur (${label}) ===`);
  await loginMonteur(page, null);
  for (const k of ['rep', 'ent', 'mel'])
    {
      await probe(page, `${label} Startseite: ${k} öffnen`, `() => document.querySelector('#app [data-k="kd-${k}"]')`, { reflow: true, ms: 900, anim: true });
      await probe(page, `${label} ${k}: ← Auftragsarten`, btn('/Auftragsarten/'), { reflow: true, ms: 900, anim: true });
    }
  await probe(page, `${label} Startseite: Reparaturen öffnen`, `() => document.querySelector('#app [data-k="kd-rep"]')`, { reflow: true, ms: 900, anim: true });
  await probe(page, `${label} Reparatur öffnen`, `() => document.querySelector('#app [data-list] > [data-k]')`, { reflow: true, ms: 900, anim: true });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  report(!wide, `${label} Reparatur: Seite nicht breiter als der Bildschirm`);
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
    await probe(page, `${label} Tab „${n}“: Leiste bleibt stehen, Inhalt blendet ein`, btn(`/^${n}$/`, '#app .tabs'), { reflow: true, ms: 800, anim: true });
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
  await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => b.textContent === 'Entfernung').click());
  await pause(page, 1500);
  w = await wide();
  report(!w.length, 'Liste mit Entfernung ragt nicht über den Rand', w.join(', '));
  await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => b.textContent === 'Auftragsnummer').click());
  await pause(page, 500);
  await openOrderWithItems(page);
  w = await wide();
  report(!w.length, 'Auftragsansicht ragt nicht über den Rand', w.join(', '));
  await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => /Zurück/.test(b.textContent)).click());
  await pause(page, 500);
  await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => /Auftragsarten/.test(b.textContent)).click());
  await pause(page, 600);
  w = await wide();
  report(!w.length, 'Startseite (Auftragsarten) ragt nicht über den Rand', w.join(', '));
  for (const k of ['Reparaturen', 'Entstörungen', 'Meldungen']) {
    await chooseKind(page, k);
    w = await wide();
    report(!w.length, `Liste ${k} ragt nicht über den Rand`, w.join(', '));
    if (k !== 'Meldungen') {
      await page.evaluate(() => document.querySelector('#app [data-list] > [data-k]').click());
      await pause(page, 600);
      w = await wide();
      report(!w.length, `Auftrag aus ${k} ragt nicht über den Rand`, w.join(', '));
      await page.evaluate(() => [...document.querySelectorAll('#app button')].find(b => /Zurück/.test(b.textContent)).click());
      await pause(page, 500);
    }
  }
  await page.context().close();
}

// Ergebnis ausgeben und mit Exit-Code beenden (auch bei TEST_ONLY=…: sonst bliebe der Code 0 trotz Fehlern)
function summary(t0) {
  console.log(`\n${failures.length ? 'FEHLGESCHLAGEN' : 'BESTANDEN'}: ${passed} Prüfungen ok, ${failures.length} Fehler (${Math.round((Date.now() - t0) / 1000)} s)`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(failures.length ? 1 : 0);
}
// ================================================================================================
(async () => {
  const pw = loadPlaywright(),
    geocoder = await startGeocoder(),
    server = await startServer(geocoder.url),
    base = 'http://127.0.0.1:' + server.port,
    errors = [];
  const browser = await pw.chromium.launch({ executablePath: findChrome() });
  const t0 = Date.now();
  try {
    if (process.env.TEST_ONLY === 'geraete') {
      await deviceChecks(browser, base, errors);
      return summary(t0);
    }
    if (process.env.TEST_ONLY === 'disposition') {
      // schnell: Upload, dann nur das Gantt-Diagramm (breit und am Handy)
      await kindUploadChecks(browser, base, errors);
      await dispositionChecks(browser, base, { width: 1280, height: 900 }, errors);
      await poolWindowChecks(browser, base, errors);
      await dispositionChecks(browser, base, { width: 390, height: 844 }, errors);
      await dispositionNarrowChecks(browser, base, errors);
      report(!errors.length, 'Keine JavaScript-Fehler auf den Seiten', errors.slice(0, 3).join(' / '));
      return summary(t0);
    }
    if (process.env.TEST_ONLY === 'poolfenster') {
      // schnell: Upload, dann nur das Extra-Fenster der Disposition
      await kindUploadChecks(browser, base, errors);
      await poolWindowChecks(browser, base, errors);
      report(!errors.length, 'Keine JavaScript-Fehler auf den Seiten', errors.slice(0, 3).join(' / '));
      return summary(t0);
    }
    if (process.env.TEST_ONLY === 'auftragsarten') {
      await kindUploadChecks(browser, base, errors);
      await dispositionChecks(browser, base, { width: 1280, height: 900 }, errors);
      await poolWindowChecks(browser, base, errors);
      await dispositionChecks(browser, base, { width: 390, height: 844 }, errors);
      await dispositionNarrowChecks(browser, base, errors);
      await kindChecks(browser, base, { width: 390, height: 844 }, errors);
      await kindChecksWide(browser, base, { width: 1280, height: 800 }, errors);
      report(!errors.length, 'Keine JavaScript-Fehler auf den Seiten', errors.slice(0, 3).join(' / '));
      return summary(t0);
    }
    const found = await waitForCoordinates(base);
    console.log(`Adressen mit Koordinaten: ${found} (Mini-Geocoder: ${geocoder.requests()} Anfragen)`);
    await kindUploadChecks(browser, base, errors);
    await dispositionChecks(browser, base, { width: 1280, height: 900 }, errors);
    await poolWindowChecks(browser, base, errors);
    await dispositionChecks(browser, base, { width: 390, height: 844 }, errors);
    await dispositionNarrowChecks(browser, base, errors);
    await kindChecks(browser, base, { width: 390, height: 844 }, errors);
    await monteurChecks(browser, base, { width: 390, height: 844 }, errors);
    await noLocationChecks(browser, base, errors);
    await poorAccuracyChecks(browser, base, errors);
    await fontChecks(browser, base, errors);
    await deviceChecks(browser, base, errors);
    await geoScenarioChecks(browser, errors);
    await dispoChecks(browser, base, { width: 390, height: 844 }, errors);
    await overflowChecks(browser, base, errors);
    // Desktop (breit): dieselben Grundabläufe
    await monteurChecks(browser, base, { width: 1280, height: 800 }, errors);
    await kindChecksWide(browser, base, { width: 1280, height: 800 }, errors);
    report(!errors.length, 'Keine JavaScript-Fehler auf den Seiten', errors.slice(0, 3).join(' / '));
  } finally {
    await browser.close();
    server.stop();
    geocoder.stop();
  }
  summary(t0);
})().catch(e => {
  console.error(e);
  process.exit(2);
});
