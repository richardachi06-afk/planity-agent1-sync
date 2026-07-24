import express from 'express';
import { createBookingInPlanity } from './planity.js';
import { sendFallback } from './fallback.js';
import { parseCalcomPayload } from './parse.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

// --- Monitoring -------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// --- Cal.com Webhook --------------------------------------------------------
// Empfängt "booking.created", antwortet SOFORT mit 200 und arbeitet dann
// asynchron weiter (Playwright-Buchung kann 30-60s dauern -> nie blockieren).
app.post('/new-booking', (req, res) => {
  const payload = req.body;

  // Nur auf booking.created reagieren, alles andere still bestätigen.
  const triggerEvent = payload?.triggerEvent || payload?.event;
  if (triggerEvent && triggerEvent !== 'BOOKING_CREATED' && triggerEvent !== 'booking.created') {
    return res.status(200).json({ ignored: triggerEvent });
  }

  // SOFORT antworten – Cal.com erwartet schnelle 2xx-Antwort.
  res.status(200).json({ received: true });

  // Danach asynchron weiterarbeiten (Fehler dürfen den Prozess nicht killen).
  handleBooking(payload).catch((err) => {
    console.error('[new-booking] Unerwarteter Fehler im Async-Handler:', err);
  });
});

async function handleBooking(payload) {
  let booking;
  try {
    booking = parseCalcomPayload(payload);
  } catch (err) {
    console.error('[handleBooking] Payload konnte nicht geparst werden:', err.message);
    await sendFallback({ reason: `Payload-Parsing fehlgeschlagen: ${err.message}`, payload });
    return;
  }

  console.log(`[handleBooking] Neue Buchung: ${booking.kundenname} / ${booking.leistung} / ` +
              `${booking.startzeit} / Mitarbeiter=${booking.mitarbeiter}`);

  try {
    await createBookingInPlanity(booking);
    console.log(`[handleBooking] ✅ Termin in Planity eingetragen für ${booking.kundenname}`);
  } catch (err) {
    console.error(`[handleBooking] ❌ Buchung fehlgeschlagen: ${err.message}`);
    await sendFallback({ reason: err.message, booking, payload });
  }
}

app.listen(PORT, () => {
  console.log(`Agent 1 – Sync Bot läuft auf Port ${PORT}`);
});
