# Hinweise für Änderungen an dieser App

Eine Datei Oberfläche (`public/index.html`, ohne Framework), ein Server (`server.js`). Der Eigentümer legt großen Wert darauf, dass **die Anzeige nirgends springt und alle Animationen sauber laufen** – auch nach künftigen Änderungen.

## Pflicht bei jeder Änderung an Oberfläche, Layout oder Animationen
1. `npm run test:ui` ausführen (Playwright + Chromium; `CHROME_PATH=/pfad/zu/chrome` für einen vorhandenen Browser). Der Test muss bestehen, bevor committet und gepusht wird. Schlägt er fehl: Ursache beheben, **nie** den Test lockern oder Prüfungen löschen, um grün zu werden.
2. Neue Bedienung (neuer Knopf, neues Formular, neuer Tab, neuer Hinweis, neue Animation) bekommt eine Prüfung in `tests/ui-stability.js` – dort stehen Muster für alle gängigen Fälle (`probe(...)`).
3. Immer die **echte Bedienung messen**, nicht nur den Endzustand: Position des angetippten Elements Bild für Bild (siehe `probe`).

## Regeln gegen Springen
- **Nie `font-size`, `width`, `height`, `top` … per CSS-`transition` animieren**, wenn dadurch Texte umbrechen (jeder Zwischenschritt bricht neu um, die Seite springt). Schriftgröße: sofort umstellen + View Transition (siehe `changeFontScale`). Höhen nur mit Web Animations und **sanftem Anlauf** (`AOK_EASE`), nie mit der steilen Kurve der Einblendungen (`cubic-bezier(0.2, 0.8, 0.2, 1)` springt im ersten Bild um ein Drittel).
- **Der angetippte Bereich bleibt stehen.** `render()` hält ihn über `viewportAnchors()` (Bereiche mit `data-k`, sonst das Bedienelement selbst über `controlKey`). Darum: Zeilen/Karten, die Knöpfe enthalten und sich wiederholen (Listen, Tabellen), bekommen ein **eindeutiges `data-k`** (z. B. `'u' + sap`). Ohne `data-k` und bei mehreren gleich beschrifteten Knöpfen kann nicht sicher gehalten werden.
- **Animationen dürfen ein weiteres Neuzeichnen überstehen.** `render()` läuft jederzeit erneut (Server-Antwort, Live-Update, Eingabe). Laufende Verschiebungen werden darum **nicht abgebrochen** (gemessen wird die sichtbare Position); Einblendungen merken sich ihre Startzeit und laufen weiter (`fadeIn`, `aokGhost`, `bannerGrow`). Kein `cancel()` auf laufende Verschiebungen vor dem Messen.
- **Höhe, die später dazukommt, vorher reservieren** (z. B. Zeile mit optionalem Knopf: `.uline.two`, Gaswarnzeile) oder weich einblenden (`animateBanners`).
- **Kein Layout-Messen mitten in `draw()`** ohne Folgen: Das Layout der halbfertigen, kurzen Seite kappt die Scroll-Stelle auf 0. `render()` stellt sie danach wieder her – neue Zeichenfunktionen nicht daran vorbei bauen.
- **Seitliche Einblendungen** (`translateX`) dürfen die Seite nicht breiter machen (`main { overflow-x: clip }`); nichts bauen, das über den Bildschirmrand ragt (bei 320 px Breite und 150 % Schrift prüfen).
- **Weiches Erscheinen/Verschwinden** gilt auch für Hinweise (`.msg`); Elemente der Kopfzeile ändern ihre Größe nie (Dunkelmodus-Logo: negativer Rand statt Polster).
- `prefers-reduced-motion` immer beachten (dann kein Übergang, aber trotzdem kein Springen).

## Sonstiges
- **Animationen bei Ansichtswechseln:** `animateView()` kennt die Ebenen des Monteurs (Startseite → Liste einer Auftragsart → Auftrag: hinein von rechts, zurück von links) und des Disponenten (Tab, Auftragsart: nur der Inhalt blendet ein, `.bar`, `.tabs`, `.ksw` bleiben stehen). Eine neue Ansicht braucht einen eigenen Schlüssel dort und im Test `probe(..., { anim: true })` – das prüft, dass wirklich eine Animation läuft und nichts halb sichtbar stehen bleibt.
- **Auftragsarten:** Wartung (`war`), Reparatur (`rep`, jeder Vorgang ein eigener Auftrag, Schlüssel „Nummer-Vorgang“), Entstörung (`ent`), Dauerauftrag (`dau`) und die Liste „Meldungen“ (`mel`). Alles dazu steht im README (Abschnitt „Auftragsarten“). Wer `order.auftrag` anzeigt, nimmt stattdessen `orderNr(order)`; neue Listen/Karten für eine Auftragsart prüft `TEST_ONLY=auftragsarten npm run test:ui` (schnell, nur Upload + Ansichten der Auftragsarten).
- Der Server liefert `public/` direkt von der Platte aus (kein Build-Schritt).
- Der Test startet einen eigenen Server mit **Kopie** von `data/data.db`; die echten Daten bleiben unverändert.
