# Aufträge nach Team – eigener Server

Läuft mit **Node.js 22.13 oder neuer** (SQLite ist eingebaut), ohne weitere Pakete. Alle Daten liegen in **einer SQLite-Datei: `data/data.db`**.

## Starten
```
node server.js
```
Dann im Browser `http://localhost:3000` öffnen.

| Umgebungsvariable | Bedeutung | Standard |
|---|---|---|
| `PORT` | Port des Servers | `3000` |
| `HOST` | Adresse, auf der gelauscht wird (`127.0.0.1` = nur lokal, z. B. hinter Reverse Proxy) | `0.0.0.0` |
| `DISPO_PIN` | PIN der Disponenten (**bitte ändern**) | `2510` |
| `UPLOAD_PIN` | Zusätzlicher PIN für den Tab „Upload“ (Hochladen und Löschen) (**bitte ändern**) | `1025` |
| `MONTEUR_PASSWORD` | Startpasswort aller Monteur-Benutzer (beim Anlegen und bei „Passwort zurücksetzen“) (**bitte ändern**) | `Fernwärme1` |
| `DATA_DIR` | Ordner für `data.db` und Sicherungen | `./data` |
| `TIMEZONE` | Zeitzone, nach der ein Tag für die Gaswarngerät-Bestätigung beginnt und endet | `Europe/Vienna` |
| `NAG_MIN` | Push-Erinnerung alle X Minuten wiederholen, bis das Gerät bestätigt | `5` |
| `MSG_HOURS` | Nach so vielen Stunden hört eine Erinnerung von selbst auf | `12` |
| `PUSH_CONTACT` | Kontakt für die Push-Dienste (`mailto:…` oder `https://…`), am besten eine echte Adresse der IT | `mailto:admin@example.com` |
| `TLS_CERT` + `TLS_KEY` | HTTPS direkt mit Node: Zertifikat und privater Schlüssel als PEM-Dateien | – (HTTP) |
| `TLS_PFX` | HTTPS direkt mit Node: Zertifikat als `.pfx`/`.p12` (statt `TLS_CERT`/`TLS_KEY`) | – |
| `TLS_PASS` | Passwort für `TLS_PFX` bzw. einen verschlüsselten Schlüssel | – |
| `HTTP_REDIRECT_PORT` | Nur mit HTTPS: auf diesem Port `http://`-Aufrufe auf `https://` umleiten (z. B. `80`) | – |

Beispiel: `DISPO_PIN=4711 UPLOAD_PIN=8150 PORT=8080 node server.js`

## Daten
- Beim ersten Start entsteht `data/data.db` (zusammen mit `data.db-wal` und `data.db-shm`, das ist normal).
- Öffnen und auswerten kann man sie mit jedem SQLite-Programm (z. B. DB Browser for SQLite, oder `sqlite3 data/data.db`). Tabellen: `orders`, `pruef`, `ergebnis` (Ergebnis als JSON in `doc`), `dmark` (vom Disponenten abgehakte Aufträge, `v`=1 abgehakt, `at`=Zeitpunkt), `dev` (Geräte, `usr` = angemeldeter Benutzer), `gas` (Gaswarngerät-Bestätigungen: `day`, `team`, `at` = Uhrzeit der Bestätigung, `rec` = Eingang beim Server, `did` = Gerät, `usr` = Benutzer), `usr` (Benutzer der Monteure), `act` (Protokoll: wer hat wann was getan), `meta`.
- Jede Eingabe ist beim Bestätigen fest auf der Platte (`synchronous=FULL`), auch bei Stromausfall.
- Pro Tag entsteht eine Sicherung in `data/backups/` (`data-JJJJ-MM-TT.db`, die letzten 30 bleiben). Sie ist eine vollständige, direkt nutzbare Datenbankdatei.
- Umzug/Sicherung von Hand: Server stoppen und `data.db` kopieren (oder Sicherung aus `backups/` verwenden). Die Sicherungen enthalten auch den Schlüssel für die Anmeldung, bitte nicht öffentlich ablegen.

## Code-Überblick
Jede Datei beginnt mit einem Kopfkommentar, der sie erklärt; Funktionen und Zustandsvariablen sind kommentiert.
- `server.js` – Server: API unter `/api/`, SQLite, Push, statische Dateien. Der Kopfkommentar listet Tabellen, Zugriffsstufen und Umgebungsvariablen.
- `public/index.html` – die gesamte Oberfläche (Stile + Skript in einer Datei, ohne Framework/Build). Das Skript ist in Abschnitte gegliedert (Zustand, Upload, Ergebnisse/Status, Zeitrückmeldung, Outbox, Abgleich, Vergleich, Fortschritt, Nachrichten, Zeichnen …). `render()` zeichnet alles aus dem Zustand neu; `draw()` wählt dafür eine der Ansichten `drawOrderDetail`, `drawMonteurList`, `drawDispo` usw.
- `public/worker.js` – Excel lesen/schreiben im Hintergrund (Aufträge, Prüflose, Vergleich, Export).
- `public/sw.js` – Service Worker: Offline-Start und Push-Benachrichtigungen.

## Wie die Geräte abgleichen
- Der Server vergibt bei jeder Änderung eine fortlaufende Nummer. Geräte holen nur Änderungen seit ihrer letzten Nummer, nach einer Eingabe also wenige hundert Byte.
- Monteure bekommen nur Aufträge und Ergebnisse ihres Teams, Disponenten alles. Die Haken des Disponenten (abgehakte Aufträge) gehen nur an die Disponentenansicht.
- Änderungen kommen **live** per Server-Sent Events (`/api/events`) bei allen offenen Geräten an, ohne ständiges Nachfragen. Zusätzlich fragt jedes Gerät alle 30 Sekunden nach.
- Antworten und Dateien werden vom Server selbst per gzip komprimiert.
- Excel-Dateien werden im Browser in einem Hintergrund-Thread gelesen und geschrieben, die Oberfläche bleibt bedienbar.

## Betrieb
- **HTTPS ist nötig**, damit Offline-Start (Service Worker), „Zum Startbildschirm hinzufügen“ und Push-Benachrichtigungen außerhalb von `localhost` funktionieren.
- **Das Zertifikat muss auf den Handys als vertrauenswürdig gelten.** Ein selbst ausgestelltes Zertifikat reicht nicht: Browser verweigern dann Service Worker und Push, auch wenn man die Warnung wegklickt. Möglich sind ein Zertifikat der firmeneigenen Zertifizierungsstelle (wenn deren Stammzertifikat per Geräteverwaltung auf den Diensthandys verteilt ist) oder ein öffentliches Zertifikat (z. B. Let's Encrypt) für einen echten Domainnamen.
- **Variante A – HTTPS direkt mit Node:**
  ```
  TLS_PFX=C:\zert\auftraege.pfx TLS_PASS=… PORT=443 HTTP_REDIRECT_PORT=80 node server.js
  ```
  oder mit PEM-Dateien `TLS_CERT=cert.pem TLS_KEY=key.pem`. Bei `TLS_CERT` die Datei mit der **vollständigen Kette** (Zertifikat + Zwischenzertifikate) verwenden, sonst lehnen manche Handys die Verbindung ab. Ein erneuertes Zertifikat (gleicher Dateiname) wird innerhalb einer Stunde ohne Neustart übernommen; ist die neue Datei fehlerhaft, bleibt das alte aktiv.
- **Variante B – Reverse Proxy** (holt und erneuert Let's-Encrypt-Zertifikate selbst), z. B. Caddy:
  ```
  auftraege.example.com {
      reverse_proxy localhost:3000
  }
  ```
  Bei nginx für den Live-Kanal `proxy_buffering off;` setzen (der Server sendet bereits `X-Accel-Buffering: no`).
- Dauerbetrieb z. B. mit systemd oder `pm2`.
- **Nur einen Serverprozess** pro Datenbank starten.

## Sicherheit
- Die **Disponenten-PIN wird auf dem Server geprüft** (5 Fehlversuche pro 10 Minuten und IP). Export und Abhaken gehen nur mit PIN. Die Anmeldung gilt 12 Stunden und übersteht einen Neustart.
- **Upload und Löschen** brauchen zusätzlich den **Upload-PIN**. Er wird bei jedem Öffnen des Tabs „Upload“ abgefragt, ebenfalls auf dem Server geprüft (5 Fehlversuche pro 10 Minuten) und gilt höchstens 30 Minuten.
- **Monteure und Lesezugriffe brauchen keine Anmeldung.** Wer die Adresse kennt, kann Aufträge lesen und Ergebnisse schreiben. Für den Einsatz im Internet daher den Zugang vorschalten, z. B. Basic-Auth im Reverse Proxy oder nur über VPN/Firmennetz.

## Nachrichten an Teams (Push-Benachrichtigungen)
- Im Tab **Fortschritt** hat jedes Team einen 📣-Button. Der Disponent schickt damit eine Nachricht (Text vorbelegt, änderbar) an alle Geräte des Teams.
- Auf den Handys erscheint eine **echte Benachrichtigung**, auch bei geschlossener App: bleibt stehen, vibriert, kommt nach dem Wegwischen sofort wieder und wird alle `NAG_MIN` Minuten erneut zugestellt – bis auf dem Gerät **„Bestätigen“** getippt wird (direkt in der Benachrichtigung oder im Fenster in der App). Bei offener App erscheint zusätzlich ein Fenster, das sich nur mit „Bestätigen“ schließen lässt.
- Bestätigt wird **je Gerät**. Der Disponent sieht „x von y Geräten bestätigt“ und kann eine Erinnerung vorzeitig beenden. Eine neue Nachricht an dasselbe Team ersetzt die offene.
- Monteure müssen Benachrichtigungen einmal erlauben (Hinweis mit Button „Aktivieren“ in der Teamansicht).
- **Voraussetzungen:**
  - **HTTPS** (siehe Betrieb) – ohne sichere Verbindung gibt es keine Benachrichtigungen.
  - Der **Server braucht Internetzugang** zu den Push-Diensten (`fcm.googleapis.com` für Android/Chrome/Edge, `web.push.apple.com` für iPhone/Mac, `updates.push.services.mozilla.com` für Firefox, `*.notify.windows.com`). Andere Adressen ruft der Server nicht auf.
  - **iPhone/iPad:** nur ab iOS 16.4 und nur, wenn die App über „Teilen → Zum Home-Bildschirm“ installiert und von dort geöffnet wird.
  - Energiesparfunktionen mancher Android-Handys können Benachrichtigungen verzögern; ggf. Akku-Optimierung für den Browser ausschalten.
- Die Schlüssel für die Push-Dienste (VAPID) entstehen beim ersten Start und liegen in `data.db`. Geht die Datei verloren, melden sich die Geräte beim nächsten Öffnen der App automatisch neu an.

## Geräte (wer ist wo angemeldet)
- Jedes Gerät hat eine zufällige Kennung (im Browser gespeichert). Der Server merkt sich dazu: Rolle (Monteur mit Team / Disponent / abgemeldet), Spitzname, zuletzt aktiv, Browser/System und ob Benachrichtigungen an sind (Tabelle `dev`). Ein Disponent zählt erst nach der PIN-Eingabe als angemeldet, nach dem Neuladen der Seite wieder als abgemeldet.
- Im Dispo-Tab **Geräte** sieht man alle Geräte der letzten 30 Tage, kann ihnen einen **Spitznamen** geben (z. B. „Handy Max“) und sie **ausloggen**.
- Ausloggen: Der Server meldet das Gerät **sofort ab** (Rolle und Team weg, Standort gelöscht, keine Benachrichtigungen mehr). Bei geöffneter App kehrt das Gerät gleich zum Startbildschirm zurück, sonst beim nächsten Öffnen (bis dahin steht „⏳ Gerät noch nicht informiert“ an der Karte). Bei Disponenten wird die Anmeldung zusätzlich auf dem Server ungültig – ein weiterer Zugriff mit dem alten Token ist nicht mehr möglich. Bei Monteur-Geräten endet damit auch die Anmeldung des Benutzers (sie müssen sich neu anmelden), und die Zuordnung zum Benutzer wird gelöst.
- **Standort der Monteur-Geräte:** Er wird nur abgefragt, solange der Tab „Geräte“ offen ist (sonst nie). Dann melden Monteur-Geräte, die gerade geöffnet sind, ihren Standort (höchstens einmal pro Minute; „Standorte jetzt aktualisieren“ löst sofort eine neue Runde aus). Der Browser fragt den Monteur beim ersten Mal um Erlaubnis, und löst der Disponent die Abfrage aus, während die App auf dem Gerät läuft, erscheint kurz der Hinweis „Der Disponent hat deinen Standort abgefragt.“ (beim Start der App nicht). Gespeichert wird nur der jeweils letzte Standort (kein Verlauf); beim Abmelden wird er gelöscht. In der Gerätekarte erscheint er als Link zu OpenStreetMap. Standort per Browser funktioniert nur über HTTPS (oder localhost). Hinweis: Standortabfragen bei Mitarbeitenden sind datenschutz- und mitbestimmungsrelevant (DSGVO, ggf. Betriebsrat) – bitte vorab klären.
- Ältere Datenbanken werden beim Start automatisch um die neuen Spalten ergänzt.

## Gaswarngerät (tägliche Bestätigung)
- Bevor ein Team arbeitet, muss es **jeden Tag** bestätigen, dass das Gaswarngerät ordnungsgemäß funktioniert. Solange das Team heute noch nicht bestätigt hat, liegt auf allen seinen Geräten ein Fenster über der App, das sich nur mit **„✓ Funktioniert ordnungsgemäß“** schließen lässt (einziger Ausweg: „Team wechseln“). Das Fenster erscheint auch nach Mitternacht wieder.
- Bestätigt wird **je Team**: Bestätigt ein Gerät des Teams, ist es für alle Geräte des Teams erledigt (die erste Bestätigung des Tages zählt). Die Teamliste zeigt „✓ Gaswarngerät heute um HH:MM Uhr bestätigt“.
- **Dokumentation:** Der Server speichert Tag, Team, Uhrzeit, das bestätigende Gerät (Tabelle `gas`) und den Zeitpunkt, zu dem die Bestätigung beim Server ankam. Es wird nur angefügt, nie geändert oder gelöscht. Ohne Netz gilt die Bestätigung sofort und wird später mit der **echten Uhrzeit** nachgesendet (Zeiten, die mehr als 24 Stunden zurückliegen oder in der Zukunft liegen, ersetzt der Server durch die eigene Uhrzeit).
- **Disponent:** Im Tab **Fortschritt** zeigt die Karte „Gaswarngerät“ je Team die Uhrzeit der Bestätigung oder „nicht bestätigt“ (nicht bestätigte zuerst); mit ‹ › oder dem Datumsfeld lassen sich frühere Tage ansehen (letzte 60 Tage). **„Gesamtes Protokoll (CSV)“** lädt alle Bestätigungen seit Beginn (Semikolon-getrennt, öffnet sich in Excel).
- Was „ein Tag“ ist, bestimmt `TIMEZONE` (Standard `Europe/Vienna`): Um Mitternacht in dieser Zeitzone beginnt der neue Tag.
- Das Protokoll hält nur fest, **dass** bestätigt wurde, nicht **wer** (die App kennt keine Personen, nur Team und Gerät – der Spitzname des Geräts steht mit im Protokoll). Wenn das für eine Nachweispflicht nicht reicht, braucht es eine namentliche Anmeldung der Monteure.

## Offline
Die Oberfläche startet auch ohne Netz (nach dem ersten Öffnen mit Netz). Eingaben der Monteure werden im Gerät gesichert und automatisch gesendet, sobald der Server wieder erreichbar ist. Den letzten Stand der Aufträge und die Prüfobjekte des eigenen Teams merkt sich das Gerät in IndexedDB.

## Excel-Spalten, die gelesen werden
Aufträge: Auftrag, Verantw.ArbPl. (= Team), Techn. Platz, Auftragsart, Postleitzahl, Straße, Kurztext, Eckstarttermin, Eckendtermin.
Prüflose: Auftrag, Kurztext des Prüfobjektes.

## Benutzer (Monteur-Anmeldung)

- **Alle Monteure melden sich mit ihrem SAP-User und einem Passwort an** (Startseite → „Ich bin Monteur“). Der SAP-User wird ohne Beachtung der Groß-/Kleinschreibung geprüft. Die Anmeldung gilt 60 Tage und bleibt beim Schließen der App erhalten; „Abmelden“ steht in der Monteur-Ansicht unter der Überschrift und auf der Startseite.
- Die Benutzer (Team, Name, SAP-User) stehen in **`users.json`** und werden **beim ersten Start** in die Datenbank (Tabelle `usr`) übernommen – alle mit dem Startpasswort `MONTEUR_PASSWORD` (Standard `Fernwärme1`, bitte ändern). Danach pflegt der Disponent sie im Tab **Benutzer**; `users.json` wird nicht noch einmal eingelesen. Passwörter werden nur als scrypt-Hash gespeichert.
- Das **Team** wird beim Anmelden automatisch gewählt. Der Monteur kann es wie bisher über „Team wechseln“ ändern und landet beim nächsten Einstieg wieder im zuletzt gewählten Team. Ändert der Disponent das Team eines Benutzers, gilt das sofort. Gibt es für das Team keine Aufträge (z. B. „Springer“), erscheint die Teamauswahl.
- **Tab „Benutzer“** (Disponent): Liste mit Suche und Teamfilter, letzte Anmeldung und Geräte; Anlegen, Bearbeiten (Name, Team, sperren), **Passwort zurücksetzen** (alle bisherigen Anmeldungen des Benutzers enden), Löschen und das **Protokoll** des Benutzers (Anmeldungen, gespeicherte Ergebnisse, Gaswarngerät, Bestätigungen).
- **Was mit dem Benutzer protokolliert wird:** jedes gespeicherte Ergebnis (Feld `u` im Ergebnis, im Excel-Export „Zuletzt gespeichert von“), die Gaswarngerät-Bestätigung (Karte und CSV), Nachrichten-Bestätigungen, Anmeldungen und die Benutzerverwaltung (Tabelle `act`, 400 Tage). In der Geräteübersicht steht an jedem Monteur-Gerät der angemeldete Benutzer.
- **Ohne Anmeldung** liefert der Server Monteuren nichts: Abgleich, Prüfobjekte, Ergebnis speichern und Gaswarngerät bestätigen brauchen den Benutzer-Token. Den Gesamtstand (alle Teams) liefert der Server nur noch dem Disponenten (mit PIN-Token).
- 5 Fehlversuche pro Benutzer und IP (und 40 pro IP) sperren die Anmeldung 10 Minuten.
