# Agent 1 – Sync Bot

Trägt neue **Cal.com**-Buchungen automatisch in **Planity** ein.

Stack: Node.js + Express + Playwright · Hosting: Render Free Tier

## Endpunkte

| Methode | Pfad           | Zweck                                                        |
|---------|----------------|-------------------------------------------------------------|
| `POST`  | `/new-booking` | Cal.com-Webhook `booking.created`. Antwortet sofort `200`, arbeitet asynchron. |
| `GET`   | `/health`      | Health-Check fürs Monitoring.                               |

## Ablauf

1. `POST /new-booking` empfängt den Webhook → **sofort 200**.
2. Payload wird geparst: Kundenname, Telefon, Leistung, Startzeit, `metadata.mitarbeiter`.
3. Playwright: Login auf `pro.planity.com`, Kalender öffnen.
4. Spalte des Mitarbeiters wählen (`egal` → **Georg**).
5. Termin eintragen → **speichern**.
6. Bei Fehler → `FALLBACK_WEBHOOK` mit allen Daten + Fehlergrund.
7. CAPTCHA/2FA → **Abbruch** (wird nicht umgangen), Fallback wird ausgelöst.

## Umgebungsvariablen

| Variable            | Beschreibung                                    |
|---------------------|-------------------------------------------------|
| `PLANITY_EMAIL`     | Planity-Login (E-Mail)                          |
| `PLANITY_PASSWORD`  | Planity-Passwort                                |
| `FALLBACK_WEBHOOK`  | URL, die bei Fehlern benachrichtigt wird        |
| `PORT`              | Optional. Render setzt das automatisch.         |

Siehe `.env.example`. **Zugangsdaten niemals committen.**

## Stand: im echten Planity-UI verifiziert

Die Selektoren wurden live im Browser (`pro.planity.com`) gegen das echte DOM
geprüft und robust umgebaut. Alle Werte kommen **dynamisch aus dem Cal.com-Payload**:

- **Formular öffnen** – über den grünen **„+"-FAB** (unabhängig von der
  Kalenderposition), nicht mehr durch Klick auf bestehende Termine.
- **Datum** – über den **In-Formular-Datepicker**: Monat via ‹/›-Pfeile navigieren,
  dann den Zieltag klicken (Nachbarmonats-Tage sind grau und werden ausgeschlossen).
- **Uhrzeit von/bis** – über die Scroll-Picker: die Zeit-Zeile wird über die
  Textanker **„von"/„bis"** gefunden (4 Zellen: von-H, von-M, bis-H, bis-M), das
  Popup (Body-Ebene) wird darüber erkannt, dass sein Vorfahr ≥6 Zahlen-Optionen
  enthält. Jede Auswahl wird **verifiziert** (Zelle zeigt danach den Wert).
  Minuten gibt es nur in **5er-Schritten** → krumme Minuten werden auf 5 gerundet.
- **Mitarbeiter** – testid-basiert: `calendars-dropdown` öffnen →
  `calendars-dropdown-{index}` (Georg=0, Steffi=1, Daniela=2, im UI bestätigt),
  `egal` → Georg.
- **Leistung** – testid-basiert: `services-dropdown` öffnen → optionale Kategorie
  (`metadata.kategorie`) → `services-dropdown-child-*` per Text.
- **Kundenname + Telefon** – Kunde per **„Erstellen"** neu angelegt, Telefon via
  `veventForm-placeholder-phoneNumber`.
- **Speichern** + **Verifizierung** (Termin im Kalender sichtbar? sonst Fallback).

### Technik: `tagAndClick`

Planity nutzt obfuskierte `css-*`/`r-*`-Klassen ohne testids an Datepicker/FAB/
Zeit-Pickern. Statt diese Klassen zu verwenden, findet ein kleines In-Page-Skript
das Zielelement über **stabile Merkmale** (Textanker, Farbe, Struktur), markiert es
mit `data-planity-pick` und Playwright klickt es dann mit einem **echten** Event.

### Im E2E-Test gefundene & behobene Bugs

Ein Testlauf gegen das echte Konto (Formular befüllt, **vor dem Speichern gestoppt**)
hat zwei echte Bugs aufgedeckt, die jetzt gefixt sind:

1. **Falscher Datepicker.** Es gibt ZWEI „Monat JJJJ"-Kalender – die persistente
   Sidebar (oben links) und den In-Formular-Datepicker. Die erste Version traf die
   Sidebar → Datum wurde nie gesetzt. **Fix:** immer den Header mit dem größten y
   (= der geöffnete In-Formular-Picker).
2. **Falsches Zeit-Popup.** Die „≥6 Zahlen"-Heuristik traf auch den Tag „10" der
   Sidebar-Mini-Kalender (höherer Score als das Stunden-Popup). **Fix:** das Popup
   wird an der **Position der geklickten Zelle** verankert (öffnet direkt darunter).

Ebenfalls im Test korrigiert/verifiziert:
- **Mitarbeiter-Mapping:** real ist `calendars-dropdown-0`=„Keine Präferenz",
  `-2`=Georg, `-3`=Steffi, `-4`=Daniela (NICHT 0/1/2). Deshalb Auswahl **per Name**.
- Ganze Kette live bestätigt: 28. Juli · 10:00–10:30 · Steffi · Waschen & Schneiden.

### ⚠️ Ehrlich: Was trotzdem brüchig bleibt

1. **Zeit-Picker & Datepicker haben keine testids.** Die Heuristik (Textanker
   „von"/„bis", Position des Popups unter der Zelle, größtes-y-Datepicker,
   Grau-Farbe für Nachbartage) ist im echten UI verifiziert, aber kein
   Vertragsversprechen: Ändert Planity das Layout grundlegend, muss sie nachgezogen
   werden. Die Verifizierung nach dem Speichern ist der Sicherheitsgurt.
2. **Minuten nur in 5er-Schritten.** Salon-Slots (:00/:15/:30/:45) sind abgedeckt;
   krumme Zeiten werden gerundet (mit Warnung im Log).
3. **Grüner FAB** wird über Farbe + Position erkannt (kein testid).
4. **Save-Button** ist weiter ein reiner CSS-Klassenselektor (`.css-175oi2r…`).
5. **Endzeit („bis")** ist tolerant: schlägt sie fehl, läuft es weiter (Planity
   leitet die Dauer aus der Leistung ab – im Test bestätigt: „bis" wird nach
   Leistungswahl automatisch gesetzt). Start („von") ist verpflichtend.
6. **Leistungsname muss exakt passen:** die Cal.com-`leistung` muss als Teilstring
   im Planity-Service vorkommen (z.B. „Waschen & Schneiden"). Bei Abweichung greift
   der Fallback.

Die Verifizierung nach dem Speichern fängt fehlerhafte/ausbleibende Buchungen ab
und meldet sie an den `FALLBACK_WEBHOOK`, sodass nichts still verloren geht.

## Lokal starten

```bash
cd agent1-sync
cp .env.example .env      # Werte eintragen
npm install               # installiert auch Chromium (postinstall)
npm start
```

Test:
```bash
curl localhost:3000/health
```

---

## Render-Deployment (Schritt für Schritt)

1. **Code in ein Git-Repo bringen**
   - Ordner `agent1-sync/` nach GitHub pushen (eigenes Repo oder Unterordner).
   - Sicherstellen, dass `.env` **nicht** mitgepusht wird (steht in `.gitignore`).

2. **Render-Account**
   - Auf <https://render.com> mit GitHub anmelden.

3. **Neuen Web Service anlegen**
   - Dashboard → **New +** → **Web Service**.
   - GitHub-Repo verbinden und auswählen.

4. **Service konfigurieren**
   - **Root Directory:** `agent1-sync` (falls im Monorepo/Unterordner).
   - **Environment:** `Node`.
   - **Build Command:** `npm install`
     (installiert per `postinstall` automatisch Chromium für Playwright).
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`.

5. **Umgebungsvariablen setzen**
   - Reiter **Environment** → **Add Environment Variable**:
     - `PLANITY_EMAIL`
     - `PLANITY_PASSWORD`
     - `FALLBACK_WEBHOOK`
   - `PORT` **nicht** setzen – Render liefert das selbst; der Code nutzt `process.env.PORT`.

6. **Playwright-Browser auf Render**
   - Der `postinstall`-Schritt lädt Chromium beim Build.
   - Läuft das nicht durch, als **Build Command** stattdessen:
     `npm install && npx playwright install --with-deps chromium`

7. **Deploy starten**
   - **Create Web Service** klicken. Render baut und startet.
   - In den **Logs** muss stehen: `Agent 1 – Sync Bot läuft auf Port ...`.

8. **Health prüfen**
   - Render gibt eine URL wie `https://agent1-sync.onrender.com`.
   - Aufruf: `https://agent1-sync.onrender.com/health` → `{"status":"ok"}`.

9. **Cal.com-Webhook eintragen**
   - Cal.com → **Settings → Developer → Webhooks** → neuer Webhook.
   - **Subscriber URL:** `https://agent1-sync.onrender.com/new-booking`
   - **Event:** `Booking Created`.

10. **Free-Tier-Hinweis (wichtig)**
    - Render Free schläft nach ~15 Min Inaktivität ein; der erste Request danach
      dauert ~30–60 s (Cold Start). Cal.com bekommt trotzdem schnell `200`, weil
      die eigentliche Buchung asynchron läuft – der Cold Start kann die erste
      Buchung aber verzögern.
    - Bei Bedarf mit einem externen Ping-Dienst (z. B. UptimeRobot) alle 10 Min
      `/health` aufrufen, um den Service wach zu halten.
