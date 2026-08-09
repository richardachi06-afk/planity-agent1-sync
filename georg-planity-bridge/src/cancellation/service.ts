import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.js";
import { normalizeGermanPhone } from "../domain/format.js";
import type {
  PlanityAppointmentCandidate,
  PlanityBookingClient,
} from "../planity/booking-client.js";
import type { PlanityCatalogClient } from "../planity/catalog.js";

export type FindAppointmentsInput = {
  callId: string;
  phone: string;
  date?: string;
};

export type CancelAppointmentInput = {
  callId: string;
  phone: string;
  appointmentReference: string;
  confirmed: boolean;
};

type AppointmentClient = Pick<
  PlanityBookingClient,
  "findUpcomingAppointments" | "cancel"
>;

function dateFromStart(start: string) {
  return start.slice(0, 10);
}

function timeFromStart(start: string) {
  return start.slice(11, 16);
}

export class CancellationService {
  private readonly completedReferences = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly catalogClient: PlanityCatalogClient,
    private readonly appointmentClient: AppointmentClient,
  ) {}

  private reference(
    callId: string,
    phone: string,
    appointment: PlanityAppointmentCandidate,
  ) {
    const secret = this.config.retellBridgeToken;
    if (!secret) {
      throw new Error("The cancellation reference secret is not configured");
    }
    return createHmac("sha256", secret)
      .update(
        JSON.stringify({
          callId,
          phone,
          customerId: appointment.customerId,
          sequenceId: appointment.sequenceId,
          start: appointment.start,
        }),
      )
      .digest("base64url");
  }

  private referenceMatches(expected: string, provided: string) {
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    return (
      expectedBuffer.length === providedBuffer.length &&
      timingSafeEqual(expectedBuffer, providedBuffer)
    );
  }

  private liveTestGuard(phone: string) {
    const test = this.config.planity.test;
    if (!test.enabled) return null;
    if (
      !test.allowedPhone ||
      !test.releaseFrom ||
      !test.releaseUntil ||
      !test.sessionId
    ) {
      return {
        ok: false as const,
        code: "LIVE_TEST_NOT_ARMED",
        message: "Der kontrollierte Planity-Test ist noch nicht freigeschaltet.",
      };
    }
    let allowedPhone: string;
    try {
      allowedPhone = normalizeGermanPhone(test.allowedPhone);
    } catch {
      return {
        ok: false as const,
        code: "LIVE_TEST_NOT_ARMED",
        message: "Die freigegebene Test-Telefonnummer ist ungültig.",
      };
    }
    if (phone !== allowedPhone) {
      return {
        ok: false as const,
        code: "PHONE_NOT_ALLOWED_FOR_LIVE_TEST",
        message:
          "Diese Telefonnummer ist für den kontrollierten Echt-Test nicht freigegeben.",
      };
    }
    const now = Date.now();
    if (
      now < Date.parse(test.releaseFrom) ||
      now > Date.parse(test.releaseUntil)
    ) {
      return {
        ok: false as const,
        code: "LIVE_TEST_WINDOW_CLOSED",
        message: "Das kontrollierte Planity-Testfenster ist nicht geöffnet.",
      };
    }
    return null;
  }

  private async candidates(phone: string) {
    const catalog = await this.catalogClient.getCatalog();
    const appointments = await this.appointmentClient.findUpcomingAppointments({
      catalog,
      phone,
      limit: 10,
    });
    return { catalog, appointments };
  }

  async find(input: FindAppointmentsInput) {
    const phone = normalizeGermanPhone(input.phone);
    const { appointments } = await this.candidates(phone);
    const filtered = input.date
      ? appointments.filter(
          (appointment) => dateFromStart(appointment.start) === input.date,
        )
      : appointments;
    const matches = filtered.slice(0, 3).map((appointment) => ({
      appointment_reference: this.reference(input.callId, phone, appointment),
      customer_name: appointment.customerName,
      date: dateFromStart(appointment.start),
      time: timeFromStart(appointment.start),
      service: appointment.serviceName,
      staff:
        appointment.staffNames.length > 0
          ? [...new Set(appointment.staffNames)].join(", ")
          : null,
    }));
    return {
      ok: true,
      found: matches.length > 0,
      appointments: matches,
      message:
        matches.length === 0
          ? "Unter dieser Telefonnummer wurde kein passender zukünftiger Termin gefunden."
          : matches.length === 1
            ? "Ein passender Termin wurde gefunden. Bitte alle Termindaten vorlesen und ausdrücklich fragen, ob genau dieser Termin abgesagt werden soll."
            : "Mehrere Termine wurden gefunden. Bitte den gewünschten Termin eindeutig auswählen und vor der Absage vollständig bestätigen lassen.",
    };
  }

  async cancel(input: CancelAppointmentInput) {
    if (!input.confirmed) {
      return {
        ok: false,
        code: "EXPLICIT_CONFIRMATION_REQUIRED",
        message:
          "Die Absage wurde nicht ausgeführt. Zuerst Datum, Uhrzeit, Leistung und Mitarbeiter vorlesen und ausdrücklich bestätigen lassen.",
      };
    }
    const phone = normalizeGermanPhone(input.phone);
    if (this.completedReferences.has(input.appointmentReference)) {
      return {
        ok: true,
        status: "cancelled",
        externalActionPerformed: true,
        duplicateRequest: true,
        message: "Der Termin war bereits abgesagt.",
      };
    }
    const { catalog, appointments } = await this.candidates(phone);
    const appointment = appointments.find((candidate) =>
      this.referenceMatches(
        this.reference(input.callId, phone, candidate),
        input.appointmentReference,
      ),
    );
    if (!appointment) {
      return {
        ok: false,
        code: "APPOINTMENT_REFERENCE_INVALID_OR_STALE",
        message:
          "Der Termin konnte nicht mehr eindeutig bestätigt werden. Bitte die Terminsuche erneut ausführen.",
      };
    }
    if (appointment.containsFinancialData) {
      return {
        ok: false,
        code: "PAYMENT_REVIEW_REQUIRED",
        message:
          "Dieser Termin ist mit einer Zahlung oder einem Beleg verknüpft. Nicht absagen und an den Salon weiterleiten.",
      };
    }
    if (this.config.dryRun || !this.config.planity.cancellationEnabled) {
      return {
        ok: true,
        status: "dry_run",
        externalActionPerformed: false,
        message:
          "Dry-Run aktiv: Der Termin wurde eindeutig geprüft, aber nicht in Planity abgesagt.",
        appointment: {
          date: dateFromStart(appointment.start),
          time: timeFromStart(appointment.start),
          service: appointment.serviceName,
          staff: appointment.staffNames.join(", ") || null,
        },
      };
    }
    const guardFailure = this.liveTestGuard(phone);
    if (guardFailure) return guardFailure;

    const result = await this.appointmentClient.cancel(catalog, appointment);
    if (!result.verified) {
      throw new Error("Planity cancellation could not be verified");
    }
    this.completedReferences.add(input.appointmentReference);
    return {
      ok: true,
      status: "cancelled",
      externalActionPerformed: true,
      duplicateRequest: false,
      message: "Der Termin wurde vollständig in Planity abgesagt.",
      appointment: {
        date: dateFromStart(appointment.start),
        time: timeFromStart(appointment.start),
        service: appointment.serviceName,
        staff: appointment.staffNames.join(", ") || null,
      },
      planity: result,
    };
  }
}
