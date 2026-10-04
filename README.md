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
| `DATA_DIR` | Ordner für `data.db` und Sicherungen | `./data` |

Beispiel: `DISPO_PIN=4711 PORT=8080 node server.js`

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
- Die **Disponenten-PIN wird auf dem Server geprüft** (5 Fehlversuche pro 10 Minuten und IP). Upload, Löschen und Export gehen nur mit PIN. Die Anmeldung gilt 12 Stunden und übersteht einen Neustart.
- **Monteure und Lesezugriffe brauchen keine Anmeldung.** Wer die Adresse kennt, kann Aufträge lesen und Ergebnisse schreiben. Für den Einsatz im Internet daher den Zugang vorschalten, z. B. Basic-Auth im Reverse Proxy oder nur über VPN/Firmennetz.

## Offline
Die Oberfläche startet auch ohne Netz (nach dem ersten Öffnen mit Netz). Eingaben der Monteure werden im Gerät gesichert und automatisch gesendet, sobald der Server wieder erreichbar ist. Den letzten Stand der Aufträge und die Prüfobjekte des eigenen Teams merkt sich das Gerät in IndexedDB.

## Excel-Spalten, die gelesen werden
Aufträge: Auftrag, Verantw.ArbPl. (= Team), Techn. Platz, Auftragsart, Postleitzahl, Straße, Kurztext, Eckstarttermin, Eckendtermin.
Prüflose: Auftrag, Kurztext des Prüfobjektes.
