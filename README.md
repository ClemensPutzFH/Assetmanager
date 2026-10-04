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
| `DATA_DIR` | Ordner für `data.db` und Sicherungen | `./data` |
| `NAG_MIN` | Push-Erinnerung alle X Minuten wiederholen, bis das Gerät bestätigt | `5` |
| `MSG_HOURS` | Nach so vielen Stunden hört eine Erinnerung von selbst auf | `12` |
| `PUSH_CONTACT` | Kontakt für die Push-Dienste (`mailto:…` oder `https://…`), am besten eine echte Adresse der IT | `mailto:admin@example.com` |

Beispiel: `DISPO_PIN=4711 UPLOAD_PIN=8150 PORT=8080 node server.js`

## Daten
- Beim ersten Start entsteht `data/data.db` (zusammen mit `data.db-wal` und `data.db-shm`, das ist normal).
- Öffnen und auswerten kann man sie mit jedem SQLite-Programm (z. B. DB Browser for SQLite, oder `sqlite3 data/data.db`). Tabellen: `orders`, `pruef`, `ergebnis` (Ergebnis als JSON in `doc`), `dmark` (vom Disponenten abgehakte Aufträge, `v`=1 abgehakt, `at`=Zeitpunkt), `meta`.
- Jede Eingabe ist beim Bestätigen fest auf der Platte (`synchronous=FULL`), auch bei Stromausfall.
- Pro Tag entsteht eine Sicherung in `data/backups/` (`data-JJJJ-MM-TT.db`, die letzten 30 bleiben). Sie ist eine vollständige, direkt nutzbare Datenbankdatei.
- Umzug/Sicherung von Hand: Server stoppen und `data.db` kopieren (oder Sicherung aus `backups/` verwenden). Die Sicherungen enthalten auch den Schlüssel für die Anmeldung, bitte nicht öffentlich ablegen.

## Wie die Geräte abgleichen
- Der Server vergibt bei jeder Änderung eine fortlaufende Nummer. Geräte holen nur Änderungen seit ihrer letzten Nummer, nach einer Eingabe also wenige hundert Byte.
- Monteure bekommen nur Aufträge und Ergebnisse ihres Teams, Disponenten alles. Die Haken des Disponenten (abgehakte Aufträge) gehen nur an die Disponentenansicht.
- Änderungen kommen **live** per Server-Sent Events (`/api/events`) bei allen offenen Geräten an, ohne ständiges Nachfragen. Zusätzlich fragt jedes Gerät alle 30 Sekunden nach.
- Antworten und Dateien werden vom Server selbst per gzip komprimiert.
- Excel-Dateien werden im Browser in einem Hintergrund-Thread gelesen und geschrieben, die Oberfläche bleibt bedienbar.

## Betrieb
- **HTTPS ist nötig**, damit Offline-Start (Service Worker) und „Zum Startbildschirm hinzufügen" außerhalb von `localhost` funktionieren. Am einfachsten mit einem Reverse Proxy, z. B. Caddy:
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

## Offline
Die Oberfläche startet auch ohne Netz (nach dem ersten Öffnen mit Netz). Eingaben der Monteure werden im Gerät gesichert und automatisch gesendet, sobald der Server wieder erreichbar ist. Den letzten Stand der Aufträge und die Prüfobjekte des eigenen Teams merkt sich das Gerät in IndexedDB.

## Excel-Spalten, die gelesen werden
Aufträge: Auftrag, Verantw.ArbPl. (= Team), Techn. Platz, Auftragsart, Postleitzahl, Straße, Kurztext, Eckstarttermin, Eckendtermin.
Prüflose: Auftrag, Kurztext des Prüfobjektes.
