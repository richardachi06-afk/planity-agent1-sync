import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "../config.js";
import { normalizeGermanPhone } from "../domain/format.js";
import { normalizeText } from "../planity/catalog.js";
import type { PlanityAvailabilityClient } from "../planity/availability.js";
import type {
  PlanityBookingClient,
  PlanityBookingResult,
} from "../planity/booking-client.js";
import type { PlanityCatalogClient } from "../planity/catalog.js";
import {
  findServiceChainSlots,
  orderAndDedupeServices,
  serviceWorkingSteps,
} from "./service-chain.js";

export type BookingInput = {
  callId?: string;
  services: string[];
  start: string;
  staff?: string;
  customerName: string;
  phone: string;
};

type TestReservation = {
  status: "reserved" | "booked" | "failed";
  createdAt: string;
  result?: PlanityBookingResult;
};

type TestState = {
  sessionId: string;
  count: number;
  reservations: Record<string, TestReservation>;
};

export class BookingService {
  private bookingLock: Promise<void> = Promise.resolve();
  private testStateCache: TestState | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly catalogClient: PlanityCatalogClient,
    private readonly availabilityClient: PlanityAvailabilityClient,
    private readonly bookingClient: PlanityBookingClient,
  ) {}

  private async withBookingLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.bookingLock;
    let release: (() => void) | undefined;
    this.bookingLock = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private testStatePath() {
    return resolve(this.config.planity.test.statePath);
  }

  private async loadTestState() {
    const sessionId = this.config.planity.test.sessionId;
    if (!sessionId) {
      throw new Error("Planity live test session is not configured");
    }
    if (this.testStateCache?.sessionId === sessionId) {
      return this.testStateCache;
    }
    try {
      const parsed = JSON.parse(
        await readFile(this.testStatePath(), "utf8"),
      ) as TestState;
      if (
        parsed.sessionId === sessionId &&
        Number.isInteger(parsed.count) &&
        parsed.count >= 0 &&
        parsed.reservations &&
        typeof parsed.reservations === "object"
      ) {
        this.testStateCache = parsed;
        return parsed;
      }
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
    this.testStateCache = {
      sessionId,
      count: 0,
      reservations: {},
    };
    return this.testStateCache;
  }

  private async persistTestState(state: TestState) {
    const statePath = this.testStatePath();
    await mkdir(dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, statePath);
    this.testStateCache = state;
  }

  private liveTestGuard(phone: string, customerName: string) {
    const test = this.config.planity.test;
    if (!test.enabled) return null;
    if (
      !test.allowedPhone ||
      !test.allowedName ||
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
    if (normalizeText(customerName) !== normalizeText(test.allowedName)) {
      return {
        ok: false as const,
        code: "NAME_NOT_ALLOWED_FOR_LIVE_TEST",
        message:
          "Dieser Kundenname ist für den kontrollierten Echt-Test nicht freigegeben.",
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

  async prepare(input: BookingInput) {
    return this.withBookingLock(async () => this.prepareLocked(input));
  }

  private async prepareLocked(input: BookingInput) {
    const requestedServices = [];
    for (const requestedName of input.services) {
      const resolved = await this.catalogClient.resolveService(requestedName);
      if (!resolved.service) {
        return {
          ok: false,
          code: "SERVICE_AMBIGUOUS_OR_UNKNOWN",
          requestedService: requestedName,
          message:
            resolved.candidates.length > 0
              ? `Bitte „${requestedName}“ präzisieren: ${resolved.candidates
                  .map((service) => service.name)
                  .join(", ")}.`
              : `Die Leistung „${requestedName}“ wurde in Planity nicht gefunden.`,
        };
      }
      requestedServices.push(resolved.service);
    }
    const services = orderAndDedupeServices(requestedServices);

    const catalog = await this.catalogClient.getCatalog();
    const requestedStaff = input.staff
      ? catalog.staff.find(
          (person) => normalizeText(person.name) === normalizeText(input.staff ?? ""),
        )
      : undefined;
    if (input.staff && !requestedStaff) {
      return {
        ok: false,
        code: "STAFF_UNKNOWN",
        message: "Dieser Mitarbeiter wurde in Planity nicht gefunden.",
      };
    }
    if (
      requestedStaff &&
      services.some(
        (service) =>
          !service.eligibleStaff.some((person) => person.id === requestedStaff.id),
      )
    ) {
      const unavailableServices = services
        .filter(
          (service) =>
            !service.eligibleStaff.some(
              (person) => person.id === requestedStaff.id,
            ),
        )
        .map((service) => service.name);
      return {
        ok: false,
        code: "STAFF_NOT_ELIGIBLE",
        message: `${requestedStaff.name} ist folgenden Leistungen nicht zugeordnet: ${unavailableServices.join(", ")}.`,
      };
    }

    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(input.start);
    if (!match?.[1] || !match[2]) {
      return {
        ok: false,
        code: "INVALID_START",
        message: "Der Terminstart muss im ISO-Format übergeben werden.",
      };
    }

    const slots = await findServiceChainSlots({
      availabilityClient: this.availabilityClient,
      catalog,
      services,
      date: match[1],
      preferredTime: match[2],
      ...(requestedStaff ? { staff: requestedStaff } : {}),
      searchDays: 1,
      limit: 10,
      forceRefresh: true,
    });
    const exactSlot = slots.find(
      (slot) => slot.date === match[1] && slot.time === match[2],
    );
    if (!exactSlot) {
      return {
        ok: false,
        code: "SLOT_NO_LONGER_AVAILABLE",
        message:
          "Dieser Termin ist in Planity nicht mehr frei. Bitte erneut Verfügbarkeiten prüfen.",
      };
    }

    const phone = normalizeGermanPhone(input.phone);
    const idempotencyKey = createHash("sha256")
      .update(
        JSON.stringify({
          callId: input.callId ?? "",
          serviceIds: services.map((service) => service.id),
          start: input.start,
          staffId: requestedStaff?.id ?? "",
          phone,
        }),
      )
      .digest("hex");

    const plan = {
      idempotencyKey,
      services: services.map((service) => ({
        id: service.id,
        name: service.name,
      })),
      bookingOrder: services.map((service) => service.name),
      start: exactSlot.start,
      staff: requestedStaff?.name ?? null,
      customer: {
        name: input.customerName,
        phone,
      },
    };

    if (this.config.dryRun || !this.config.planity.bookingEnabled) {
      return {
        ok: true,
        status: "dry_run",
        externalActionPerformed: false,
        message:
          "Dry-Run aktiv: Der Termin wurde geprüft, aber nicht in Planity gebucht.",
        plan,
      };
    }

    const guardFailure = this.liveTestGuard(phone, input.customerName);
    if (guardFailure) return guardFailure;

    if (exactSlot.staffAssignments.length === 0) {
      return {
        ok: false,
        code: "STAFF_ASSIGNMENT_UNAVAILABLE",
        message:
          "Planity konnte dem Termin keine Mitarbeiter zuordnen. Bitte Rückruf anbieten.",
      };
    }
    const expectedWorkingSteps = services.reduce(
      (total, service) => total + serviceWorkingSteps(service),
      0,
    );
    if (exactSlot.staffAssignments.length !== expectedWorkingSteps) {
      return {
        ok: false,
        code: "STAFF_ASSIGNMENT_UNAVAILABLE",
        message:
          "Die Mitarbeiter-Zuordnung für diese Leistung ist nicht eindeutig. Bitte Rückruf anbieten.",
      };
    }

    if (!this.config.planity.test.enabled) {
      const result = await this.bookingClient.book({
        idempotencyKey,
        catalog,
        services,
        start: exactSlot.start,
        staffAssignments: exactSlot.staffAssignments,
        customerName: input.customerName,
        phone,
      });
      return {
        ok: true,
        status: "booked",
        externalActionPerformed: true,
        duplicateRequest: false,
        message: result.verified
          ? "Der Termin wurde in Planity gespeichert und direkt verifiziert."
          : "Der Termin wurde in Planity gespeichert.",
        plan: {
          ...plan,
          staff: [
            ...new Set(exactSlot.staffAssignments.map((person) => person.name)),
          ].join(", "),
        },
        planity: result,
      };
    }

    const state = await this.loadTestState();
    const existingReservation = state.reservations[idempotencyKey];
    if (existingReservation?.status === "booked" && existingReservation.result) {
      return {
        ok: true,
        status: "booked",
        externalActionPerformed: true,
        duplicateRequest: true,
        message: "Der Termin war bereits in Planity gespeichert.",
        plan: {
          ...plan,
          staff: [
            ...new Set(exactSlot.staffAssignments.map((person) => person.name)),
          ].join(", "),
        },
        planity: existingReservation.result,
      };
    }
    if (existingReservation) {
      return {
        ok: false,
        code: "LIVE_TEST_ALREADY_ATTEMPTED",
        message:
          "Für diesen Test wurde bereits ein Buchungsversuch gestartet. Bitte nicht erneut buchen.",
      };
    }
    if (state.count >= this.config.planity.test.maxBookings) {
      return {
        ok: false,
        code: "LIVE_TEST_LIMIT_REACHED",
        message:
          "Die erlaubte Anzahl echter Planity-Testbuchungen ist bereits erreicht.",
      };
    }

    state.count += 1;
    state.reservations[idempotencyKey] = {
      status: "reserved",
      createdAt: new Date().toISOString(),
    };
    await this.persistTestState(state);

    try {
      const result = await this.bookingClient.book({
        idempotencyKey,
        catalog,
        services,
        start: exactSlot.start,
        staffAssignments: exactSlot.staffAssignments,
        customerName: input.customerName,
        phone,
      });
      state.reservations[idempotencyKey] = {
        ...state.reservations[idempotencyKey],
        status: "booked",
        result,
      } as TestReservation;
      try {
        await this.persistTestState(state);
      } catch {
        this.testStateCache = state;
      }
      return {
        ok: true,
        status: "booked",
        externalActionPerformed: true,
        duplicateRequest: false,
        message: result.verified
          ? "Der Termin wurde in Planity gespeichert und direkt verifiziert."
          : "Der Termin wurde in Planity gespeichert.",
        plan: {
          ...plan,
          staff: [
            ...new Set(exactSlot.staffAssignments.map((person) => person.name)),
          ].join(", "),
        },
        planity: result,
      };
    } catch (error) {
      state.reservations[idempotencyKey] = {
        ...state.reservations[idempotencyKey],
        status: "failed",
      } as TestReservation;
      try {
        await this.persistTestState(state);
      } catch {
        this.testStateCache = state;
      }
      throw error;
    }
  }
}
