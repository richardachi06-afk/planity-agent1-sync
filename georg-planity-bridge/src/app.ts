import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
} from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import {
  availabilityArgsSchema,
  bookingArgsSchema,
  cancelAppointmentArgsSchema,
  findAppointmentsArgsSchema,
  recordingConsentArgsSchema,
} from "./domain/schemas.js";
import { formatPrice } from "./domain/format.js";
import { BookingService } from "./booking/service.js";
import {
  findServiceChainSlots,
  orderAndDedupeServices,
  selectSlotsForResponse,
} from "./booking/service-chain.js";
import type { CancellationService } from "./cancellation/service.js";
import type { PlanityAvailabilityClient } from "./planity/availability.js";
import { normalizeText, type PlanityCatalogClient } from "./planity/catalog.js";
import {
  type RecordingArchive,
  verifyAdminAuthorization,
} from "./recordings/archive.js";
import {
  getAgentId,
  getCallId,
  parseRawJson,
  unwrapRetellArgs,
  verifyRetellRequest,
} from "./security/retell.js";

type AppDependencies = {
  config: AppConfig;
  catalogClient: PlanityCatalogClient;
  availabilityClient: PlanityAvailabilityClient;
  bookingService: BookingService;
  cancellationService: CancellationService;
  recordingArchive: RecordingArchive;
};

function rawBody(request: Request) {
  if (!Buffer.isBuffer(request.body)) {
    throw new Error("Expected raw JSON request body");
  }
  return request.body;
}

function retellPayload(request: Request, config: AppConfig) {
  const body = rawBody(request);
  const signature = request.header("x-retell-signature");
  const providedBridgeToken = request.header("x-georg-bridge-token");
  const payload = parseRawJson(body);
  const requestAgentId = getAgentId(payload);
  if (
    !verifyRetellRequest(body, signature, {
      ...(config.retellApiKey ? { apiKey: config.retellApiKey } : {}),
      allowUnsigned: config.allowUnsignedRetell,
      ...(config.retellBridgeToken
        ? { bridgeToken: config.retellBridgeToken }
        : {}),
      ...(providedBridgeToken ? { providedBridgeToken } : {}),
      ...(config.retellAgentId
        ? { expectedAgentId: config.retellAgentId }
        : {}),
      ...(requestAgentId ? { requestAgentId } : {}),
    })
  ) {
    const error = new Error("Unauthorized Retell request");
    Object.assign(error, { status: 401 });
    throw error;
  }
  return payload;
}

function retellWebhookPayload(request: Request, config: AppConfig) {
  const body = rawBody(request);
  const signature = request.header("x-retell-signature");
  const payload = parseRawJson(body);
  const requestAgentId = getAgentId(payload);
  if (
    !config.retellApiKey ||
    !signature ||
    !verifyRetellRequest(body, signature, {
      apiKey: config.retellApiKey,
      allowUnsigned: false,
    }) ||
    !config.retellAgentId ||
    requestAgentId !== config.retellAgentId
  ) {
    const error = new Error("Unauthorized Retell webhook");
    Object.assign(error, { status: 401 });
    throw error;
  }
  return payload;
}

export function createApp(dependencies: AppDependencies) {
  const {
    config,
    catalogClient,
    availabilityClient,
    bookingService,
    cancellationService,
    recordingArchive,
  } = dependencies;
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  app.post(
    "/retell/webhook",
    express.raw({ type: "application/json", limit: "2mb" }),
    async (request, response) => {
      const payload = retellWebhookPayload(request, config);
      await recordingArchive.handleWebhook(payload);
      response.status(204).end();
    },
  );
  app.use("/retell", express.raw({ type: "application/json", limit: "64kb" }));
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      service: "georg-planity-voice-bridge",
      dryRun: config.dryRun,
      planityWritesEnabled: config.planity.bookingEnabled,
      planityCancellationEnabled: config.planity.cancellationEnabled,
      controlledTestMode: config.planity.test.enabled,
      calMirrorEnabled: config.cal.mirrorEnabled,
      recordingArchiveEnabled: recordingArchive.enabled,
      recordingRetentionDays: config.recordings.retentionDays,
    });
  });

  app.get("/catalog", async (_request, response) => {
    const catalog = await catalogClient.getCatalog();
    response.json({
      business: catalog.businessName,
      timezone: catalog.timezone,
      openingHours: catalog.openingHours,
      staff: catalog.staff.map(({ key, name }) => ({ key, name })),
      services: catalog.services.map((service) => ({
        key: service.key,
        name: service.name,
        group: service.group,
        durationMinutes: service.durationMinutes,
        price: formatPrice(service.price.cents, service.price.isFromPrice),
        staff: service.eligibleStaff.map((person) => person.name),
      })),
    });
  });

  app.post("/retell/check-availability", async (request, response) => {
    const payload = retellPayload(request, config);
    const args = availabilityArgsSchema.parse(unwrapRetellArgs(payload));
    const requestedServices = [];
    for (const requestedName of args.services) {
      const resolved = await catalogClient.resolveService(requestedName);
      if (!resolved.service) {
        return response.json({
          ok: false,
          status: "needs_clarification",
          code: "SERVICE_AMBIGUOUS_OR_UNKNOWN",
          requestedService: requestedName,
          candidates: resolved.candidates.map((service) => ({
            name: service.name,
            group: service.group,
          })),
          message:
            resolved.candidates.length > 0
              ? `Bitte den Kunden zuerst fragen, welche genaue Leistung mit „${requestedName}“ gemeint ist: ${resolved.candidates
                  .map((service) => `${service.name} (${service.group})`)
                  .join(", ")}?`
              : `Die Leistung „${requestedName}“ wurde in Planity nicht gefunden.`,
        });
      }
      requestedServices.push(resolved.service);
    }
    const services = orderAndDedupeServices(requestedServices);

    const catalog = await catalogClient.getCatalog();
    const staff = args.staff
      ? catalog.staff.find(
          (person) => normalizeText(person.name) === normalizeText(args.staff ?? ""),
        )
      : undefined;
    if (args.staff && !staff) {
      return response.json({
        ok: false,
        status: "needs_clarification",
        code: "STAFF_UNKNOWN",
        message: "Dieser Mitarbeiter wurde in Planity nicht gefunden.",
      });
    }
    if (
      staff &&
      services.some(
        (service) =>
          !service.eligibleStaff.some((person) => person.id === staff.id),
      )
    ) {
      const unavailableServices = services
        .filter(
          (service) =>
            !service.eligibleStaff.some((person) => person.id === staff.id),
        )
        .map((service) => service.name);
      return response.json({
        ok: false,
        status: "needs_clarification",
        code: "STAFF_NOT_ELIGIBLE",
        message: `${staff.name} ist folgenden Leistungen nicht zugeordnet: ${unavailableServices.join(", ")}.`,
      });
    }

    const slots = await findServiceChainSlots({
      availabilityClient,
      catalog,
      services,
      date: args.date,
      ...(staff ? { staff } : {}),
      ...(args.preferredTime ? { preferredTime: args.preferredTime } : {}),
      searchDays: config.planity.maxSearchDays,
      limit: 3,
    });
    const selection = selectSlotsForResponse(slots, args.preferredTime);
    const responseSlots = selection.slots;
    const exactRequestedTimeAvailable =
      selection.exactRequestedTimeAvailable;

    return response.json({
      ok: true,
      services: services.map((service) => service.name),
      bookingOrder: services.map((service) => service.name),
      requestedDate: args.date,
      requestedStaff: staff?.name ?? null,
      timezone: config.planity.timezone,
      available: responseSlots.length > 0,
      exactRequestedTimeAvailable,
      slots: responseSlots.map((slot) => ({
        start: slot.start,
        staff: slot.staff.map((person) => person.name),
        mixedStaffPossible: slot.mixedStaffPossible,
      })),
      message:
        exactRequestedTimeAvailable && responseSlots[0]
          ? `Der gewünschte Termin am ${responseSlots[0].date} um ${responseSlots[0].time} ist frei.`
          : responseSlots.length > 0
            ? `${args.preferredTime ? `Der gewünschte Termin um ${args.preferredTime} ist nicht frei. ` : ""}Freie Alternativen: ${responseSlots
              .map(
                (slot) =>
                  `${slot.date} um ${slot.time}${
                    slot.staff.length ? ` (${slot.staff.map((p) => p.name).join(", ")})` : ""
                  }`,
              )
              .join("; ")}.`
            : "Im geprüften Zeitraum wurde kein freier Termin gefunden.",
    });
  });

  app.post("/retell/book-appointment", async (request, response) => {
    const payload = retellPayload(request, config);
    const args = bookingArgsSchema.parse(unwrapRetellArgs(payload));
    const callId = getCallId(payload);
    const result = await bookingService.prepare({
      ...(callId ? { callId } : {}),
      services: args.services,
      start: args.start,
      ...(args.staff ? { staff: args.staff } : {}),
      customerName: args.customerName,
      phone: args.phone,
    });
    return response.status(result.ok ? 200 : 409).json(result);
  });

  app.post("/retell/find-appointments", async (request, response) => {
    const payload = retellPayload(request, config);
    const args = findAppointmentsArgsSchema.parse(unwrapRetellArgs(payload));
    const callId = getCallId(payload);
    if (!callId) {
      return response.status(422).json({
        ok: false,
        code: "CALL_ID_REQUIRED",
        message:
          "Die sichere Terminsuche benötigt eine gültige Retell-Anruf-ID.",
      });
    }
    const result = await cancellationService.find({
      callId,
      phone: args.phone,
      ...(args.date ? { date: args.date } : {}),
    });
    return response.json(result);
  });

  app.post("/retell/cancel-appointment", async (request, response) => {
    const payload = retellPayload(request, config);
    const args = cancelAppointmentArgsSchema.parse(unwrapRetellArgs(payload));
    const callId = getCallId(payload);
    if (!callId) {
      return response.status(422).json({
        ok: false,
        code: "CALL_ID_REQUIRED",
        message:
          "Die sichere Terminabsage benötigt eine gültige Retell-Anruf-ID.",
      });
    }
    const result = await cancellationService.cancel({
      callId,
      phone: args.phone,
      appointmentReference: args.appointmentReference,
      confirmed: args.confirmed,
    });
    return response.status(result.ok ? 200 : 409).json(result);
  });

  app.post("/retell/recording-consent", (request, response) => {
    const payload = retellPayload(request, config);
    const args = recordingConsentArgsSchema.parse(unwrapRetellArgs(payload));
    return response.json({
      ok: true,
      recording_allowed: args.allowed,
      message: args.allowed
        ? `Die Zustimmung wurde bestätigt. Die Aufnahme darf nach dem Gespräch ${config.recordings.retentionDays} Tage verschlüsselt gespeichert werden.`
        : "Es liegt keine Zustimmung vor. Die Aufnahme wird nicht archiviert; das Gespräch kann ohne gespeicherte Aufnahme weitergehen.",
    });
  });

  const recordingsAuth = (
    request: Request,
    response: Response,
    next: () => void,
  ) => {
    const password = config.recordings.adminPassword;
    if (
      !recordingArchive.enabled ||
      !password ||
      !verifyAdminAuthorization(
        request.header("authorization"),
        config.recordings.adminUser,
        password,
      )
    ) {
      response.setHeader(
        "WWW-Authenticate",
        'Basic realm="Georg Haarstudio Aufnahmen", charset="UTF-8"',
      );
      response.status(recordingArchive.enabled ? 401 : 503).send(
        recordingArchive.enabled
          ? "Zugangsdaten erforderlich."
          : "Das Aufnahme-Archiv ist noch nicht aktiviert.",
      );
      return;
    }
    response.setHeader("Cache-Control", "no-store, private");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    next();
  };

  app.get(
    "/recordings",
    recordingsAuth,
    async (_request, response) => {
      const items = await recordingArchive.list();
      response.type("html").send(recordingArchive.renderPage(items));
    },
  );

  app.get(
    "/recordings/audio/:id",
    recordingsAuth,
    async (request, response) => {
      const id = request.params.id;
      if (typeof id !== "string") {
        return response.status(404).send("Aufnahme nicht gefunden.");
      }
      const audio = await recordingArchive.read(id);
      if (!audio) return response.status(404).send("Aufnahme nicht gefunden.");
      const range = request.header("range");
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Content-Type", audio.contentType);
      response.setHeader(
        "Content-Disposition",
        `inline; filename="aufnahme-${audio.recordedAt.slice(0, 10)}.wav"`,
      );
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match?.[1]) {
          response.setHeader("Content-Range", `bytes */${audio.body.length}`);
          return response.status(416).end();
        }
        const start = Number(match[1]);
        const requestedEnd = match[2] ? Number(match[2]) : audio.body.length - 1;
        const end = Math.min(requestedEnd, audio.body.length - 1);
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 0 ||
          start > end ||
          start >= audio.body.length
        ) {
          response.setHeader("Content-Range", `bytes */${audio.body.length}`);
          return response.status(416).end();
        }
        response.status(206);
        response.setHeader(
          "Content-Range",
          `bytes ${start}-${end}/${audio.body.length}`,
        );
        response.setHeader("Content-Length", String(end - start + 1));
        return response.end(audio.body.subarray(start, end + 1));
      }
      response.setHeader("Content-Length", String(audio.body.length));
      return response.end(audio.body);
    },
  );

  app.delete(
    "/recordings/audio/:id",
    recordingsAuth,
    async (request, response) => {
      const id = request.params.id;
      if (typeof id !== "string") {
        return response.status(404).json({ ok: false });
      }
      const removed = await recordingArchive.delete(id);
      return response.status(removed ? 200 : 404).json({ ok: removed });
    },
  );

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof z.ZodError) {
      response.status(422).json({
        ok: false,
        code: "INVALID_ARGUMENTS",
        message: error.issues.map((issue) => issue.message).join("; "),
      });
      return;
    }
    const status =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500;
    response.status(status).json({
      ok: false,
      code: status === 401 ? "UNAUTHORIZED" : "INTERNAL_ERROR",
      message:
        status === 500
          ? "Die Terminabfrage ist gerade nicht erreichbar. Bitte Rückruf anbieten."
          : error instanceof Error
            ? error.message
            : "Unbekannter Fehler",
    });
  };
  app.use(errorHandler);

  return app;
}
