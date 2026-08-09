type RetellTool = {
  name?: string;
  type?: string;
  [key: string]: unknown;
};

type RetellLlm = {
  llm_id: string;
  begin_message?: string | null;
  general_prompt?: string | null;
  general_tools?: RetellTool[] | null;
  version?: number;
};

const apply = process.argv.includes("--apply");
const apiKey = process.env.RETELL_API_KEY;
const bridgeToken = process.env.RETELL_BRIDGE_TOKEN;
const llmId = process.env.RETELL_LLM_ID;
const baseUrl = process.env.BRIDGE_BASE_URL?.replace(/\/$/, "");
const recordingsEnabled = ["1", "true", "yes", "on"].includes(
  (process.env.RECORDINGS_ENABLED ?? "false").toLowerCase(),
);

if (!apiKey || !llmId) {
  throw new Error("RETELL_API_KEY and RETELL_LLM_ID are required");
}
if (!bridgeToken || bridgeToken.length < 32) {
  throw new Error("RETELL_BRIDGE_TOKEN with at least 32 characters is required");
}
if (!baseUrl) {
  throw new Error("BRIDGE_BASE_URL is required");
}
if (!/^https:\/\//.test(baseUrl)) {
  throw new Error("BRIDGE_BASE_URL must be a public HTTPS URL");
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};
const getResponse = await fetch(
  `https://api.retellai.com/get-retell-llm/${encodeURIComponent(llmId)}`,
  {
    headers,
    signal: AbortSignal.timeout(15_000),
  },
);
if (!getResponse.ok) {
  throw new Error(`Could not read Retell LLM (${getResponse.status})`);
}
const current = (await getResponse.json()) as RetellLlm;

const availabilityTool: RetellTool = {
  type: "custom",
  name: "check_planity_availability",
  description:
    "Prüft die echten freien Termine in Planity für alle gewünschten Leistungen als zusammenhängenden Termin, ein Datum und optional einen Mitarbeiter. Jede Leistung einzeln in services übergeben. Immer vor einer Buchung aufrufen.",
  url: `${baseUrl}/retell/check-availability`,
  method: "POST",
  headers: {
    "X-Georg-Bridge-Token": bridgeToken,
  },
  parameter_type: "json",
  args_at_root: false,
  timeout_ms: 15_000,
  speak_during_execution: true,
  speak_after_execution: true,
  execution_message_type: "static_text",
  execution_message_description: "Einen Moment, ich schaue direkt im Terminkalender nach.",
  enable_typing_sound: true,
  parameters: {
    type: "object",
    required: ["services", "date"],
    properties: {
      services: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: { type: "string" },
        description:
          "Alle intern eindeutig zugeordneten Leistungsnamen einzeln. Den Kunden nie nach Systembezeichnungen oder Haarlänge fragen. Standard: Herrenhaarschnitt = Waschen & Schneiden; Damenhaarschnitt = Waschen + Schneiden + Föhnen; Ansatzfarbe ohne Längenangabe = Ansatzfarbe - Mittel. Nie eine genannte Leistung weglassen.",
      },
      date: {
        type: "string",
        description: "Gewünschtes Datum im Format JJJJ-MM-TT.",
      },
      staff: {
        type: "string",
        enum: ["Georg", "Steffi", "Daniela"],
        description: "Gewünschter Mitarbeiter, nur wenn der Kunde eine Präferenz nennt.",
      },
      preferred_time: {
        type: "string",
        description: "Gewünschte Uhrzeit im Format HH:mm, falls genannt.",
      },
    },
  },
};

const bookingTool: RetellTool = {
  type: "custom",
  name: "book_planity_appointment",
  description:
    "Bucht alle zuvor gemeinsam geprüften und bestätigten Leistungen als einen zusammenhängenden Planity-Termin. Nur einmal aufrufen und exakt dieselbe services-Liste wie bei der Verfügbarkeitsprüfung verwenden.",
  url: `${baseUrl}/retell/book-appointment`,
  method: "POST",
  headers: {
    "X-Georg-Bridge-Token": bridgeToken,
  },
  parameter_type: "json",
  args_at_root: false,
  timeout_ms: 30_000,
  speak_during_execution: true,
  speak_after_execution: true,
  execution_message_type: "static_text",
  execution_message_description: "Einen Moment, ich trage den Termin ein.",
  enable_typing_sound: true,
  parameters: {
    type: "object",
    required: ["services", "start", "customer_name", "phone"],
    properties: {
      services: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: { type: "string" },
        description:
          "Exakt dieselben einzelnen Leistungen wie bei der Verfügbarkeitsprüfung. Keine Leistung zusammenfassen, hinzufügen oder weglassen.",
      },
      start: {
        type: "string",
        description:
          "Der bestätigte Startwert aus der Verfügbarkeitsantwort im ISO-Format.",
      },
      staff: {
        type: "string",
        enum: ["Georg", "Steffi", "Daniela"],
        description:
          "Bestätigter Mitarbeiter, nur wenn der Kunde einen Mitarbeiter gewählt hat.",
      },
      customer_name: {
        type: "string",
        description: "Vor- und Nachname des Kunden.",
      },
      phone: {
        type: "string",
        description: "Telefonnummer des Kunden.",
      },
    },
  },
};

const findAppointmentsTool: RetellTool = {
  type: "custom",
  name: "find_planity_appointments",
  description:
    "Sucht zukünftige Planity-Termine anhand der vom Kunden genannten Telefonnummer. Vor jeder Absage aufrufen.",
  url: `${baseUrl}/retell/find-appointments`,
  method: "POST",
  headers: {
    "X-Georg-Bridge-Token": bridgeToken,
  },
  parameter_type: "json",
  args_at_root: false,
  timeout_ms: 20_000,
  speak_during_execution: true,
  speak_after_execution: true,
  execution_message_type: "static_text",
  execution_message_description:
    "Einen Moment, ich suche den Termin direkt in Planity.",
  enable_typing_sound: true,
  parameters: {
    type: "object",
    required: ["phone"],
    properties: {
      phone: {
        type: "string",
        description:
          "Die vom Kunden genannte und wiederholte Telefonnummer, unter der der Termin gebucht wurde.",
      },
      date: {
        type: "string",
        description:
          "Optional das vom Kunden genannte Termindatum im Format JJJJ-MM-TT.",
      },
    },
  },
};

const cancelAppointmentTool: RetellTool = {
  type: "custom",
  name: "cancel_planity_appointment",
  description:
    "Sagt genau einen zuvor gefundenen Planity-Termin ab. Nur nach eindeutiger mündlicher Bestätigung des vollständig vorgelesenen Termins aufrufen.",
  url: `${baseUrl}/retell/cancel-appointment`,
  method: "POST",
  headers: {
    "X-Georg-Bridge-Token": bridgeToken,
  },
  parameter_type: "json",
  args_at_root: false,
  timeout_ms: 30_000,
  speak_during_execution: true,
  speak_after_execution: true,
  execution_message_type: "static_text",
  execution_message_description: "Einen Moment, ich sage den Termin ab.",
  enable_typing_sound: true,
  parameters: {
    type: "object",
    required: ["phone", "appointment_reference", "confirmed"],
    properties: {
      phone: {
        type: "string",
        description:
          "Exakt dieselbe Telefonnummer wie bei find_planity_appointments.",
      },
      appointment_reference: {
        type: "string",
        description:
          "Exakt die appointment_reference des eindeutig ausgewählten Suchergebnisses.",
      },
      confirmed: {
        type: "boolean",
        description:
          "Nur true setzen, wenn der Kunde nach dem Vorlesen von Datum, Uhrzeit, Leistung und Mitarbeiter ausdrücklich mit Ja bestätigt hat.",
      },
    },
  },
};

const recordingConsentTool: RetellTool = {
  type: "custom",
  name: "record_recording_consent",
  description:
    "Dokumentiert ausschließlich die ausdrückliche Antwort auf die Aufnahmefrage. Direkt nach einem eindeutigen Ja oder Nein aufrufen; bei unklarer Antwort zuerst nachfragen.",
  url: `${baseUrl}/retell/recording-consent`,
  method: "POST",
  headers: {
    "X-Georg-Bridge-Token": bridgeToken,
  },
  parameter_type: "json",
  args_at_root: false,
  timeout_ms: 5_000,
  speak_during_execution: false,
  speak_after_execution: false,
  enable_typing_sound: false,
  parameters: {
    type: "object",
    required: ["allowed"],
    properties: {
      allowed: {
        type: "boolean",
        description:
          "true nur nach einem ausdrücklichen Ja; false nach Nein oder einem späteren Widerruf.",
      },
    },
  },
};

const toolNamesToReplace = new Set([
  "check_availability",
  "check_planity_availability",
  "book_appointment",
  "book_planity_appointment",
  "find_appointments",
  "find_planity_appointments",
  "cancel_appointment",
  "cancel_planity_appointment",
  "record_recording_consent",
]);
const preservedTools = (current.general_tools ?? []).filter(
  (tool) => !tool.name || !toolNamesToReplace.has(tool.name),
);
const nextTools = [
  ...preservedTools,
  availabilityTool,
  bookingTool,
  findAppointmentsTool,
  cancelAppointmentTool,
  ...(recordingsEnabled ? [recordingConsentTool] : []),
];
let nextPrompt = [
  "# Rolle",
  'Du bist die freundliche Telefonrezeption von "Georg Hair Studio" in Friedrichstal. Sprich lockeres Hochdeutsch, immer mit „Sie“, in kurzen natürlichen Sätzen.',
  "",
  "# Aktuelle Zeit",
  "Aktuelle Salonzeit: {{current_time_Europe/Berlin}}.",
  "Kalender: {{current_calendar_Europe/Berlin}}.",
  "Löse heute, morgen, übermorgen und Wochentage nur damit auf. Erfinde kein Datum.",
  "",
  "# Termin buchen – fester Ablauf",
  "1. Frage nur Informationen, die noch fehlen. Wiederhole niemals eine bereits beantwortete Frage.",
  "2. Falls unklar: „Geht es um Damen, Herren oder Kinder?“ Danach: „Was möchten Sie machen lassen?“ Frage nie nach Haarlänge oder Haartyp und nie: „Wie soll ich den Termin eintragen?“",
  "3. Frage nach Tag und ungefährer Uhrzeit. Nach einem Mitarbeiter nur fragen, wenn der Kunde selbst einen wünscht.",
  "4. Sobald Leistung, Tag und Uhrzeit bekannt sind, rufe check_planity_availability sofort auf. Frage vorher nicht erneut, ob die Uhrzeit noch passt.",
  "5. Ist die gewünschte Uhrzeit frei, nenne nur diese Uhrzeit und frage direkt: „Wie ist Ihr Vor- und Nachname?“ Nenne keine benachbarten Zeiten. Ist sie nicht frei, nenne höchstens drei zurückgegebene Alternativen.",
  "6. Frage danach einmal nach der Telefonnummer.",
  "7. Lies Leistung(en), Tag, Uhrzeit, Mitarbeiter falls gewählt, Name und Telefonnummer genau einmal kurz vor. Frage: „Soll ich den Termin so buchen?“",
  "8. Nur nach einem eindeutigen Ja rufe book_planity_appointment genau einmal auf.",
  "9. Sage nur dann „Der Termin ist gebucht“, wenn das Tool status=booked zurückgibt. Bei Fehler oder zwischenzeitlich belegtem Termin nicht weiterbehaupten, dass gebucht wird, sondern eine neue freie Zeit anbieten.",
  "",
  "# Interne Leistungszuordnung – nicht vorlesen",
  "Normaler Herrenhaarschnitt = Waschen & Schneiden. Nur wenn der Kunde selbst Maschine sagt = Maschinenhaarschnitt.",
  "Normaler Damenhaarschnitt = Waschen + Schneiden + Föhnen. Nur wenn der Kunde selbst Trocknen sagt = Waschen + Schneiden + Trocknen.",
  "Ansatzfarbe ohne Längenangabe = Ansatzfarbe - Mittel; Blondierung = Blondierung - Mittel; Strähnen Oberkopf = Strähnen Oberkopf - Mittel; Dauerwelle = Dauerwelle - Lang.",
  "Wenn der Kunde mehrere Leistungen nennt, übergib alle gemeinsam in services. Chemische Leistungen kommen vor Schneiden und Styling. Niemals getrennte Termine daraus machen.",
  "",
  "# Weiterleitung",
  "Bei Bewerbungen, Jobs, Anstellung, Ausbildung, Praktikum, Lieferanten, Werbung, Presse, Kooperationen, Rechnungen, persönlichen Anrufen für Georg oder anderen Nicht-Kundenanliegen sofort sagen: „Ich verbinde Sie direkt.“ Dann transfer_call aufrufen. Keine Bewerbung oder Kontaktdaten vorab aufnehmen.",
  "",
  "# Absage",
  "Für eine Absage Telefonnummer erfragen und find_planity_appointments aufrufen. Den eindeutigen Termin vollständig vorlesen und ausdrücklich fragen, ob genau dieser Termin abgesagt werden soll. cancel_planity_appointment nur nach Ja mit confirmed=true aufrufen. Erfolg nur bei status=cancelled behaupten.",
  "",
  "# Salon und Grenzen",
  "Hindenburgstraße 52, 76297 Friedrichstal. Parken direkt davor. Mo, Mi, Fr 9–19 Uhr; Di, Do 9–18 Uhr; Sa 8–14 Uhr; So geschlossen. Mitarbeiter: Georg, Steffi, Daniela.",
  "Nenne nie Planity, System, Datenbank, interne Leistungsnamen oder Buchungslogik. Beim Nachschlagen nur: „Einen Moment, ich schaue kurz nach.“ Nutze niemals Kasse, Zahlung, Erstattung oder Belege.",
].join("\n");

if (recordingsEnabled && !nextPrompt.includes("# Aufnahme-Zustimmung")) {
  nextPrompt = [
    "# Aufnahme-Zustimmung",
    "- Deine erste Nachricht fragt bereits, ob das Gespräch zur Qualitätssicherung sieben Tage aufgezeichnet werden darf.",
    "- Warte auf die Antwort, bevor du nach dem Anliegen fragst oder Kundendaten erhebst.",
    '- Bei einem eindeutigen Ja sofort "record_recording_consent" mit allowed=true aufrufen. Danach kurz danken und normal helfen.',
    '- Bei einem eindeutigen Nein sofort "record_recording_consent" mit allowed=false aufrufen. Sage, dass keine Aufnahme gespeichert wird, und hilf normal weiter.',
    "- Bei einer unklaren Antwort stelle dieselbe Ja-oder-Nein-Frage noch einmal. Zustimmung niemals vermuten.",
    '- Widerruft der Kunde später die Zustimmung, rufe "record_recording_consent" erneut mit allowed=false auf. Dann wird der Anruf nicht archiviert.',
    "",
    nextPrompt,
  ].join("\n");
}

const nextBeginMessage = recordingsEnabled
  ? "Hallo, Georg Haarstudio Friedrichstal. Bevor wir starten: Dürfen wir dieses Gespräch zur Qualitätssicherung für sieben Tage aufgezeichnet werden? Bitte sagen Sie Ja oder Nein."
  : (current.begin_message ??
    "Hallo, Georg Haarstudio Friedrichstal. Wie kann ich Ihnen weiterhelfen?");

const update = {
  begin_message: nextBeginMessage,
  general_prompt: nextPrompt,
  general_tools: nextTools,
};

if (!apply) {
  console.log(
    JSON.stringify(
      {
        applied: false,
        llmId: current.llm_id,
        currentVersion: current.version,
        beginMessageChanged: nextBeginMessage !== current.begin_message,
        promptChanged: nextPrompt !== current.general_prompt,
        preservedToolNames: preservedTools.map((tool) => tool.name ?? tool.type),
        replacementToolNames: [
          availabilityTool.name,
          bookingTool.name,
          findAppointmentsTool.name,
          cancelAppointmentTool.name,
          ...(recordingsEnabled ? [recordingConsentTool.name] : []),
        ],
        recordingsEnabled,
        bridgeBaseUrl: baseUrl,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const patchResponse = await fetch(
  `https://api.retellai.com/update-retell-llm/${encodeURIComponent(llmId)}`,
  {
    method: "PATCH",
    headers,
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(20_000),
  },
);
if (!patchResponse.ok) {
  throw new Error(
    `Could not update Retell LLM (${patchResponse.status}): ${await patchResponse.text()}`,
  );
}
const updated = (await patchResponse.json()) as RetellLlm;
console.log(
  JSON.stringify({
    applied: true,
    llmId: updated.llm_id,
    version: updated.version,
    toolNames: nextTools.map((tool) => tool.name ?? tool.type),
  }),
);
