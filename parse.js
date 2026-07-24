// Liest die für Planity nötigen Felder aus dem Cal.com-Webhook-Payload.
// Cal.com verschachtelt die Daten unter payload.payload (v2-Webhooks).
// Wir sind hier bewusst tolerant und prüfen mehrere mögliche Pfade.

const MITARBEITER_ERLAUBT = ['Georg', 'Steffi', 'Daniela', 'egal'];

export function parseCalcomPayload(raw) {
  const p = raw?.payload || raw || {};

  // --- Startzeit ---
  const startzeit = p.startTime || p.start || p.when?.start;
  if (!startzeit) throw new Error('Startzeit fehlt im Payload');

  // --- Endzeit (für das "bis"-Feld im Formular) ---
  const endzeit = p.endTime || p.end || p.when?.end || null;

  // --- Kunde (erster Attendee) ---
  const attendee = Array.isArray(p.attendees) ? p.attendees[0] : p.attendee;
  const kundenname = attendee?.name || p.responses?.name?.value || p.name;
  if (!kundenname) throw new Error('Kundenname fehlt im Payload');

  // --- Telefon ---
  const telefon =
    attendee?.phoneNumber ||
    p.responses?.phone?.value ||
    p.responses?.attendeePhoneNumber?.value ||
    p.responses?.location?.value?.optionValue ||
    '';

  // --- Leistung ---
  const leistung =
    p.eventTitle ||
    p.title ||
    p.eventType?.title ||
    p.type ||
    'Termin';

  // --- Mitarbeiter aus metadata ---
  let mitarbeiter = p.metadata?.mitarbeiter || raw?.metadata?.mitarbeiter || 'egal';
  mitarbeiter = normalisiereMitarbeiter(mitarbeiter);

  // Optional: Planity-Kategorie, falls die Leistung darunter verschachtelt ist
  // (z.B. "Damen | Farbe & Strähnen"). Kommt aus metadata, ist nicht Pflicht.
  const kategorie = p.metadata?.kategorie || raw?.metadata?.kategorie || null;

  return {
    kundenname, telefon, leistung, kategorie, mitarbeiter,
    startzeit, rawStart: startzeit,
    endzeit, rawEnd: endzeit,
  };
}

function normalisiereMitarbeiter(value) {
  if (!value) return 'egal';
  const clean = String(value).trim().toLowerCase();
  const match = MITARBEITER_ERLAUBT.find((m) => m.toLowerCase() === clean);
  if (!match) {
    console.warn(`[parse] Unbekannter Mitarbeiter "${value}" -> fallback auf "egal"`);
    return 'egal';
  }
  return match;
}

// "egal" wird immer auf Georg gebucht.
export function zielMitarbeiter(mitarbeiter) {
  return mitarbeiter === 'egal' ? 'Georg' : mitarbeiter;
}
