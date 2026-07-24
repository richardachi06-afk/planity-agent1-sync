// Ruft den FALLBACK_WEBHOOK mit allen Daten + Fehlergrund auf.
// Wird genutzt, wenn die automatische Planity-Buchung scheitert
// (inkl. CAPTCHA/2FA-Abbruch), damit ein Mensch manuell nachbuchen kann.

export async function sendFallback({ reason, booking, payload }) {
  const url = process.env.FALLBACK_WEBHOOK;
  if (!url) {
    console.error('[fallback] FALLBACK_WEBHOOK ist nicht gesetzt – kann nicht benachrichtigen!');
    console.error('[fallback] Grund war:', reason);
    return;
  }

  const body = {
    source: 'agent1-sync',
    reason,
    booking: booking || null,
    rawPayload: payload || null,
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[fallback] Webhook antwortete mit ${res.status}`);
    } else {
      console.log('[fallback] Fehler an FALLBACK_WEBHOOK gemeldet.');
    }
  } catch (err) {
    console.error('[fallback] Konnte FALLBACK_WEBHOOK nicht erreichen:', err.message);
  }
}
