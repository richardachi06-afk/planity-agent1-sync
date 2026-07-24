import { chromium } from 'playwright';
import { zielMitarbeiter } from './parse.js';

const PLANITY_URL = 'https://pro.planity.com/';

// Mitarbeiter werden per NAME im calendars-dropdown gewählt (robuster als Index).
// Im Browser verifiziert: die Optionen tragen die Klarnamen "Georg"/"Steffi"/
// "Daniela" (und "Keine Präferenz"). Die testid-Indizes sind NICHT 0/1/2
// (real: Georg=2, Steffi=3, Daniela=4, Keine Präferenz=0) – deshalb per Text.

// Deutsche Monatsnamen (für die Datepicker-Überschrift "Juli 2026").
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

const GREY = 'rgb(172, 181, 178)'; // Farbe der Nachbarmonats-Tage im Datepicker

// Fehler dieser Klasse bedeuten: bewusst abgebrochen (CAPTCHA/2FA) – nicht umgehen.
export class AbortNeedsHuman extends Error {}

export async function createBookingInPlanity(booking) {
  const email = process.env.PLANITY_EMAIL;
  const password = process.env.PLANITY_PASSWORD;
  if (!email || !password) {
    throw new Error('PLANITY_EMAIL / PLANITY_PASSWORD nicht gesetzt');
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'], // nötig auf Render
  });

  const context = await browser.newContext({ locale: 'de-DE' });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    await login(page, email, password);
    await guardCaptchaOr2FA(page);

    const mitarbeiter = zielMitarbeiter(booking.mitarbeiter); // "egal" -> Georg
    await openNewEventForm(page);
    await setDate(page, booking);
    await setTimeRange(page, booking);
    await selectMitarbeiter(page, mitarbeiter);
    await selectLeistung(page, booking);
    await fillCustomer(page, booking);
    await saveBooking(page);
    await verifyBookingAppears(page, booking);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Generischer Helfer: Element per In-Page-JS finden, mit [data-planity-pick]
// markieren und dann per Playwright (echter Klick) anklicken. So umgehen wir
// die obfuskierten css-*/r-*-Klassen von Planity und klicken trotzdem mit
// echten Browser-Events.
// ---------------------------------------------------------------------------
async function tagAndClick(page, pageFunction, arg, errMsg) {
  const found = await page.evaluate(pageFunction, arg);
  if (!found) throw new Error(errMsg);
  await page.locator('[data-planity-pick="1"]').click();
  await clearTags(page);
}
async function clearTags(page) {
  await page.evaluate(() =>
    document.querySelectorAll('[data-planity-pick]')
      .forEach((e) => e.removeAttribute('data-planity-pick')));
}

// --- Login ------------------------------------------------------------------
async function login(page, email, password) {
  await page.goto(PLANITY_URL, { waitUntil: 'domcontentloaded' });

  const cookieBtn = page.getByRole('button', { name: 'Akzeptieren & schließen' });
  if (await cookieBtn.isVisible().catch(() => false)) {
    await cookieBtn.click();
  }

  await page.getByTestId('sign-in-email-input').fill(email);
  await page.getByTestId('sign-in-password-pressable').click();
  await page.getByTestId('sign-in-password-input').fill(password);

  await guardCaptchaOr2FA(page);

  const submit = page.getByTestId('sign-in-submit');
  if (await submit.isVisible().catch(() => false)) {
    await submit.click();
  } else {
    await page.locator('div').filter({ hasText: /^Einloggen$/ }).nth(1).click();
  }
  // Auf den Kalender warten (FAB-Button erscheint).
  await page.waitForLoadState('networkidle').catch(() => {});
}

// --- CAPTCHA / 2FA: erkennen und ABBRECHEN (nicht umgehen) ------------------
async function guardCaptchaOr2FA(page) {
  const signals = [
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
    'iframe[title*="captcha" i]', '[data-testid*="captcha" i]',
    'text=/best.?tigungscode/i', 'text=/verification code/i',
    'text=/zwei.?faktor/i', 'text=/two.?factor/i',
  ];
  for (const sel of signals) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) {
      throw new AbortNeedsHuman(
        `CAPTCHA/2FA erkannt (${sel}) – automatische Buchung abgebrochen.`);
    }
  }
}

// --- Formular öffnen: grüner "+"-FAB (unabhängig von der Kalenderposition) ---
async function openNewEventForm(page) {
  await tagAndClick(page, () => {
    const cands = [...document.querySelectorAll('#planity button, #planity [role="button"]')]
      .filter((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const m = (s.backgroundColor.match(/\d+/g) || []).map(Number);
        const green = m.length >= 3 && m[1] > 120 && m[0] < 120 && m[2] < 140;
        return green && r.width >= 36 && r.width <= 90 && r.height >= 36 && r.height <= 90
          && r.bottom > innerHeight - 160 && r.right > innerWidth - 200;
      });
    if (!cands[0]) return false;
    cands[0].setAttribute('data-planity-pick', '1');
    return true;
  }, null, 'Neu-Termin-Button (grüner FAB) nicht gefunden.');

  await page.getByTestId('vevent-form')
    .waitFor({ state: 'visible', timeout: 8000 })
    .catch(() => { throw new Error('Termin-Formular (vevent-form) ist nicht erschienen.'); });
}

// --- Datum: In-Formular-Kalender, Monat navigieren, richtigen Tag klicken ----
async function setDate(page, booking) {
  const d = new Date(booking.rawStart);
  const tz = { timeZone: 'Europe/Berlin' };
  const tag = Number(d.toLocaleString('en-US', { day: 'numeric', ...tz }));
  const monat = Number(d.toLocaleString('en-US', { month: 'numeric', ...tz })) - 1; // 0-basiert
  const jahr = Number(d.toLocaleString('en-US', { year: 'numeric', ...tz }));
  const zielHeader = `${MONATE[monat]} ${jahr}`;
  console.log(`[planity] Zieldatum: ${tag}. ${zielHeader}`);

  // Datepicker öffnen (Feld mit Text wie "Freitag 24. Juli").
  await tagAndClick(page, () => {
    const form = document.querySelector('[data-testid="vevent-form"]');
    const el = [...form.querySelectorAll('div,span')].find((e) =>
      !e.children.length && /^[A-Za-zäöüÄÖÜ]+ \d{1,2}\. [A-Za-zäöüÄÖÜ]+$/.test(e.textContent.trim()));
    if (!el) return false;
    el.setAttribute('data-planity-pick', '1');
    return true;
  }, null, 'Datumsfeld nicht gefunden.');

  // Zum richtigen Monat navigieren (max. 24 Schritte als Sicherung).
  for (let i = 0; i < 24; i++) {
    const header = await page.evaluate(() => {
      // WICHTIG: Es gibt ZWEI "Monat JJJJ"-Header – die persistente Sidebar
      // (oben links) und den In-Formular-Datepicker (öffnet darunter, größeres y).
      // Wir nehmen immer den mit dem größten y = der geöffnete In-Formular-Picker.
      const hs = [...document.querySelectorAll('div,span')].filter((e) =>
        !e.children.length && /^[A-Za-zäöüÄÖÜ]+ \d{4}$/.test(e.textContent.trim())
        && e.getBoundingClientRect().width > 0);
      const el = hs.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
      return el ? el.textContent.trim() : null;
    });
    if (!header) throw new Error('Datepicker-Überschrift nicht gefunden.');
    if (header === zielHeader) break;

    const zielIndex = MONATE.indexOf(zielHeader.split(' ')[0]) + Number(zielHeader.split(' ')[1]) * 12;
    const curIndex = MONATE.indexOf(header.split(' ')[0]) + Number(header.split(' ')[1]) * 12;
    const dir = zielIndex > curIndex ? 'next' : 'prev';

    await tagAndClick(page, (dir) => {
      const hs = [...document.querySelectorAll('div,span')].filter((e) =>
        !e.children.length && /^[A-Za-zäöüÄÖÜ]+ \d{4}$/.test(e.textContent.trim())
        && e.getBoundingClientRect().width > 0);
      const header = hs.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
      let dp = header;
      for (let j = 0; j < 8 && dp; j++) {
        dp = dp.parentElement;
        const t = [...dp.querySelectorAll('*')].filter((e) => !e.children.length).map((e) => e.textContent.trim());
        if (t.includes('15') && t.includes('31')) break;
      }
      const hy = header.getBoundingClientRect().y;
      const arrows = [...dp.querySelectorAll('svg')]
        .map((s) => ({ s, x: s.getBoundingClientRect().x, y: s.getBoundingClientRect().y }))
        .filter((o) => Math.abs(o.y - hy) < 30).sort((a, b) => a.x - b.x);
      const pick = dir === 'prev' ? arrows[0] : arrows[arrows.length - 1];
      if (!pick) return false;
      pick.s.setAttribute('data-planity-pick', '1');
      return true;
    }, dir, 'Monats-Navigationspfeil nicht gefunden.');
    await page.waitForTimeout(150);
  }

  // Zieltag im aktuellen Monat klicken (Nachbarmonats-Tage sind grau).
  await tagAndClick(page, ({ tag, grey }) => {
    const hs = [...document.querySelectorAll('div,span')].filter((e) =>
      !e.children.length && /^[A-Za-zäöüÄÖÜ]+ \d{4}$/.test(e.textContent.trim())
      && e.getBoundingClientRect().width > 0);
    const header = hs.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
    let dp = header;
    for (let j = 0; j < 8 && dp; j++) {
      dp = dp.parentElement;
      const t = [...dp.querySelectorAll('*')].filter((e) => !e.children.length).map((e) => e.textContent.trim());
      if (t.includes('15') && t.includes('31')) break;
    }
    const cells = [...dp.querySelectorAll('*')].filter((e) =>
      !e.children.length && e.textContent.trim() === String(tag));
    const target = cells.find((c) => getComputedStyle(c).color !== grey) || cells[0];
    if (!target) return false;
    target.setAttribute('data-planity-pick', '1');
    return true;
  }, { tag, grey: GREY }, `Tag ${tag} im Datepicker nicht gefunden.`);
}

// --- Uhrzeit von/bis über die Scroll-Picker (robust) ------------------------
async function setTimeRange(page, booking) {
  const start = new Date(booking.rawStart);
  const end = booking.rawEnd ? new Date(booking.rawEnd) : null;

  await pickTimeField(page, 0, pad2(hourIn(start)));       // von-Stunde
  await pickTimeField(page, 1, snap5(minIn(start)));       // von-Minute
  if (end) {
    await pickTimeField(page, 2, pad2(hourIn(end))).catch((e) =>
      console.warn(`[planity] bis-Stunde: ${e.message}`));
    await pickTimeField(page, 3, snap5(minIn(end))).catch((e) =>
      console.warn(`[planity] bis-Minute: ${e.message}`));
  }
}

// Öffnet die col-te Zeit-Zelle [0..3] und wählt im Popup den Wert; verifiziert.
async function pickTimeField(page, col, value) {
  // 1) Zeit-Zelle öffnen (Zeile mit "von"+"bis"; 4 Zahlen-Zellen in Reihenfolge).
  await tagAndClick(page, (col) => {
    const form = document.querySelector('[data-testid="vevent-form"]');
    const leaves = [...form.querySelectorAll('div,span')].filter((e) => !e.children.length);
    const von = leaves.find((e) => e.textContent.trim() === 'von');
    const bis = leaves.find((e) => e.textContent.trim() === 'bis');
    if (!von || !bis) return false;
    let row = von;
    while (row && !row.contains(bis)) row = row.parentElement;
    const cells = [...row.querySelectorAll('*')].filter((e) =>
      !e.children.length && /^\d{2}$/.test(e.textContent.trim()));
    if (!cells[col]) return false;
    cells[col].setAttribute('data-planity-pick', '1');
    return true;
  }, col, `Zeit-Zelle ${col} nicht gefunden.`);

  await page.waitForTimeout(150);

  // 2) Wert im Popup wählen. WICHTIG: Das Popup wird direkt UNTER der geklickten
  //    Zelle geöffnet. Wir ankern deshalb an der Position der Zelle, sonst würde
  //    z.B. der Tag "10" der Sidebar-Mini-Kalender fälschlich getroffen (im Test
  //    verifiziert: reine "viele Zahlen"-Heuristik reicht NICHT).
  await tagAndClick(page, ([value, col]) => {
    const form = document.querySelector('[data-testid="vevent-form"]');
    const leaves = [...form.querySelectorAll('div,span')].filter((e) => !e.children.length);
    const von = leaves.find((e) => e.textContent.trim() === 'von');
    const bis = leaves.find((e) => e.textContent.trim() === 'bis');
    let row = von;
    while (row && !row.contains(bis)) row = row.parentElement;
    const cells = [...row.querySelectorAll('*')].filter((e) =>
      !e.children.length && /^\d{2}$/.test(e.textContent.trim()));
    const cr = cells[col].getBoundingClientRect();
    const cands = [...document.querySelectorAll('div,span')].filter((el) => {
      if (el.children.length || el.textContent.trim() !== value) return false;
      if (row && row.contains(el)) return false;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      // direkt unterhalb der Zelle und horizontal in Zellennähe (Picker-Grid)
      return r.top > cr.bottom - 4 && r.top < cr.bottom + 340
        && r.left > cr.left - 240 && r.left < cr.left + 280;
    });
    // Falls mehrere Treffer: der mit den meisten Zahlen-Nachbarn (= Picker-Grid).
    const score = (el) => {
      let a = el;
      for (let i = 0; i < 5 && a; i++) {
        a = a.parentElement;
        if (!a) break;
        const n = [...a.querySelectorAll('*')]
          .filter((x) => !x.children.length && /^\d{2}$/.test(x.textContent.trim())).length;
        if (n >= 6) return n;
      }
      return 0;
    };
    const target = cands.map((el) => ({ el, s: score(el) })).sort((a, b) => b.s - a.s)[0];
    if (!target) return false;
    target.el.setAttribute('data-planity-pick', '1');
    return true;
  }, [value, col], `Zeit-Option "${value}" nicht im Picker gefunden (nur 5-Minuten-Schritte verfügbar?).`);

  // 3) Verifizieren, dass die Zelle jetzt den Wert zeigt.
  const shown = await page.evaluate((col) => {
    const form = document.querySelector('[data-testid="vevent-form"]');
    const leaves = [...form.querySelectorAll('div,span')].filter((e) => !e.children.length);
    const von = leaves.find((e) => e.textContent.trim() === 'von');
    const bis = leaves.find((e) => e.textContent.trim() === 'bis');
    let row = von;
    while (row && !row.contains(bis)) row = row.parentElement;
    const cells = [...row.querySelectorAll('*')].filter((e) =>
      !e.children.length && /^\d{2}$/.test(e.textContent.trim()));
    return cells[col] ? cells[col].textContent.trim() : null;
  }, col);
  if (shown !== value) {
    throw new Error(`Zeit-Zelle ${col} zeigt "${shown}" statt "${value}".`);
  }
}

// --- Mitarbeiter über calendars-dropdown wählen (per Name, robust) ----------
async function selectMitarbeiter(page, mitarbeiter) {
  console.log(`[planity] Mitarbeiter=${mitarbeiter}`);
  await page.getByTestId('calendars-dropdown').click();

  // Option wählen, deren Text exakt der Mitarbeitername ist.
  const opt = page.locator('[data-testid^="calendars-dropdown-"]')
    .filter({ hasText: new RegExp(`^${escapeRegExp(mitarbeiter)}$`) }).first();
  if (!(await opt.isVisible().catch(() => false))) {
    throw new Error(`Mitarbeiter "${mitarbeiter}" im calendars-dropdown nicht gefunden.`);
  }
  await opt.click();
}

// --- Dienstleistung über services-dropdown wählen (testid-basiert) ----------
async function selectLeistung(page, booking) {
  await page.getByTestId('services-dropdown').click();

  // Optionale Kategorie zuerst (z.B. "Herren | Schnitt & Styling").
  if (booking.kategorie) {
    await page.locator('div')
      .filter({ hasText: new RegExp(`^${escapeRegExp(booking.kategorie)}$`) })
      .nth(1).click().catch(() => {});
  }

  // Leistung per Text in irgendeinem services-dropdown-child.
  const service = page.locator('[data-testid^="services-dropdown-child-"]')
    .filter({ hasText: booking.leistung }).first();
  if (await service.isVisible().catch(() => false)) {
    await service.click();
  } else {
    await page.getByText(booking.leistung, { exact: false }).first().click();
  }
}

// --- Kunde NEU anlegen (Name aus Payload) + Telefon -------------------------
async function fillCustomer(page, booking) {
  await page.getByText('Einen Kunden auswählen').click();
  await page.getByTestId('undefined-input').first().fill(booking.kundenname);
  await page.getByText('Erstellen').click();

  if (booking.telefon) {
    const phone = page.getByTestId('veventForm-placeholder-phoneNumber');
    await phone.getByTestId('undefined-pressable').click().catch(() => {});
    await phone.getByTestId('undefined-input').fill(booking.telefon);
  }
}

// --- Termin speichern -------------------------------------------------------
const SAVE_BUTTON =
  '.css-175oi2r.r-18u37iz.r-tzz3ar.r-17s6mgv > div:nth-child(2) > .css-175oi2r > svg';
async function saveBooking(page) {
  await page.locator(SAVE_BUTTON).click();
  await page.waitForLoadState('networkidle').catch(() => {});
}

// --- Verifizierung: erscheint der Termin wirklich im Kalender? --------------
async function verifyBookingAppears(page, booking) {
  await page.waitForTimeout(1500);
  const kandidaten = [booking.kundenname, booking.leistung].filter(Boolean);
  for (const text of kandidaten) {
    const sichtbar = await page.getByText(text, { exact: false }).first()
      .isVisible({ timeout: 5000 }).catch(() => false);
    if (sichtbar) {
      console.log(`[planity] ✅ Verifiziert: "${text}" im Kalender gefunden.`);
      return;
    }
  }
  throw new Error(
    `Verifizierung fehlgeschlagen: Termin für "${booking.kundenname}" ` +
    `nach dem Speichern nicht im Kalender gefunden.`);
}

// --- Helpers ----------------------------------------------------------------
function pad2(n) { return String(n).padStart(2, '0'); }

// Minute auf nächste 5er-Stufe runden (Picker bietet nur 00,05,...,55).
function snap5(m) {
  let v = Math.round(m / 5) * 5;
  if (v >= 60) v = 55;
  if (v !== m) console.warn(`[planity] Minute ${m} auf ${v} (5er-Schritt) gerundet.`);
  return pad2(v);
}

function hourIn(date) {
  return Number(date.toLocaleString('en-GB',
    { hour: '2-digit', hour12: false, timeZone: 'Europe/Berlin' }).slice(0, 2));
}
function minIn(date) {
  return Number(date.toLocaleString('en-GB',
    { minute: '2-digit', timeZone: 'Europe/Berlin' }).match(/\d+/)[0]);
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
