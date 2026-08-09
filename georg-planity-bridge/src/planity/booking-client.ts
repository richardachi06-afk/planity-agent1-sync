import type { AppConfig } from "../config.js";
import { normalizeGermanPhone } from "../domain/format.js";
import type {
  PlanityCatalog,
  PlanitySequenceStep,
  PlanityService,
  PlanityStaff,
} from "./types.js";

const FIREBASE_PUSH_CHARS =
  "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
const SERVER_TIMESTAMP = { ".sv": "timestamp" } as const;
const BUSINESS_WRITE_PREFIXES = [
  "calendar_vevents/",
  "business_customers/",
] as const;
const MASTER_WRITE_PREFIXES = ["user_vevents/", "sms_queue/"] as const;
const USERS_WRITE_PREFIXES = ["user_vevents/"] as const;
const FORBIDDEN_WRITE_TERMS = [
  "receipt",
  "pos_",
  "payment",
  "stripe",
  "cash",
  "checkout",
  "encaisse",
  "kass",
] as const;

type FirebaseAuthResponse = {
  expiresIn?: string;
  idToken?: string;
  localId?: string;
};

type UnknownRecord = Record<string, unknown>;

export type PlanityBookingRequest = {
  idempotencyKey: string;
  catalog: PlanityCatalog;
  services: PlanityService[];
  start: string;
  staffAssignments: PlanityStaff[];
  customerName: string;
  phone: string;
};

export type PlanityBookingResult = {
  appointmentIds: string[];
  customerId: string;
  customerReused: boolean;
  supportWritesComplete: boolean;
  verified: boolean;
};

export type PlanityWritePlan = {
  businessWrites: Record<string, unknown>;
  masterWrites: Record<string, unknown>;
  usersWrites: Record<string, unknown>;
  appointmentIds: string[];
  sequenceId: string;
};

export type PlanityAppointmentEvent = {
  id: string;
  calendarIds: string[];
  removedFromCalendarIds: string[];
};

export type PlanityAppointmentCandidate = {
  customerId: string;
  customerName: string;
  phone: string;
  sequenceId: string;
  appointmentIds: string[];
  start: string;
  serviceName: string;
  staffNames: string[];
  events: PlanityAppointmentEvent[];
  containsFinancialData: boolean;
};

export type PlanityCancellationPlan = {
  businessWrites: Record<string, unknown>;
  masterWrites: Record<string, unknown>;
  usersWrites: Record<string, unknown>;
};

export type PlanityCancellationResult = {
  supportWritesComplete: boolean;
  verified: boolean;
};

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function hasDeepValue(value: unknown, expected: string, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === expected) return true;
  if (Array.isArray(value)) {
    return value.some((entry) => hasDeepValue(entry, expected, depth + 1));
  }
  const record = asRecord(value);
  return record
    ? Object.entries(record).some(
        ([key, entry]) =>
          key === expected || hasDeepValue(entry, expected, depth + 1),
      )
    : false;
}

function findDisplayName(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["shortName", "firstName", "name"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length >= 2) {
      return candidate.trim();
    }
  }
  for (const child of Object.values(record)) {
    const found = findDisplayName(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function pathUrl(baseUrl: string, path: string, token: string) {
  const encodedPath = path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${encodedPath}.json`);
  url.searchParams.set("auth", token);
  return url;
}

function databaseRootUrl(baseUrl: string, token: string) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/.json`);
  url.searchParams.set("auth", token);
  return url;
}

function firebasePushId(now = Date.now(), random = Math.random) {
  const timeChars = new Array<string>(8);
  let timestamp = now;
  for (let index = 7; index >= 0; index -= 1) {
    timeChars[index] = FIREBASE_PUSH_CHARS.charAt(timestamp % 64);
    timestamp = Math.floor(timestamp / 64);
  }
  const randomChars = Array.from({ length: 12 }, () =>
    FIREBASE_PUSH_CHARS.charAt(Math.floor(random() * 64)),
  );
  return `${timeChars.join("")}${randomChars.join("")}`;
}

function usersShard(customerId: string) {
  const total = [...customerId].reduce(
    (sum, character) => sum + (character.codePointAt(0) ?? 0),
    0,
  );
  return (total % 10) + 1;
}

function parseStart(start: string) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(start);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error("Planity booking start must use an ISO local date and time");
  }
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return {
    date: match[1],
    time: `${match[2]}:${match[3]}`,
    planityStart: `${match[1]} ${match[2]}:${match[3]}`,
    startMinutes: hours * 60 + minutes,
  };
}

function timeFromMinutes(date: string, totalMinutes: number) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${date} ${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0",
  )}`;
}

type ConcreteServiceStep = PlanitySequenceStep & {
  originService: PlanityService;
  originSequenceIndex: number | null;
};

function concreteSteps(services: PlanityService[]): ConcreteServiceStep[] {
  const steps: ConcreteServiceStep[] = [];
  for (const service of services) {
    if (service.sequence.length === 0) {
      steps.push({
        serviceId: service.id,
        durationMinutes: service.durationMinutes,
        isPause: false,
        originService: service,
        originSequenceIndex: null,
      });
      continue;
    }
    steps.push(
      ...service.sequence.map((step, index) => ({
        ...step,
        originService: service,
        originSequenceIndex: index + 1,
      })),
    );
  }
  return steps;
}

function cleanObject<T extends UnknownRecord>(record: T): T {
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) {
      delete record[key];
    } else if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      !Object.hasOwn(value, ".sv")
    ) {
      cleanObject(value as UnknownRecord);
    }
  }
  return record;
}

function assertSafeWritePaths(
  writes: Record<string, unknown>,
  allowedPrefixes: readonly string[],
) {
  for (const path of Object.keys(writes)) {
    const normalized = path.replace(/^\/+/, "").toLowerCase();
    if (!allowedPrefixes.some((prefix) => normalized.startsWith(prefix))) {
      throw new Error(`Refusing non-appointment Planity write path: ${path}`);
    }
    if (FORBIDDEN_WRITE_TERMS.some((term) => normalized.includes(term))) {
      throw new Error(`Refusing forbidden Planity write path: ${path}`);
    }
  }
}

export function buildPlanityWritePlan(input: {
  businessId: string;
  services: PlanityService[];
  start: string;
  staffAssignments: PlanityStaff[];
  customerId: string;
  customerName: string;
  phone: string;
  customerExists: boolean;
  createdBy: string;
  appointmentIds?: string[];
  now?: number;
}): PlanityWritePlan {
  const parsedStart = parseStart(input.start);
  const steps = concreteSteps(input.services);
  const workingSteps = steps.filter((step) => !step.isPause);
  if (workingSteps.length !== input.staffAssignments.length) {
    throw new Error(
      "Planity staff assignments do not match the appointment sequence",
    );
  }
  if (
    steps.some(
      (step) =>
        !Number.isInteger(step.durationMinutes) ||
        (step.durationMinutes ?? 0) <= 0,
    )
  ) {
    throw new Error("Planity appointment sequence contains an invalid duration");
  }

  const appointmentIds =
    input.appointmentIds ??
    workingSteps.map((_, index) => firebasePushId(Date.now() + index));
  if (appointmentIds.length !== workingSteps.length) {
    throw new Error("Planity appointment ids do not match the sequence");
  }
  const sequenceId = appointmentIds.join(",");
  const businessWrites: Record<string, unknown> = {};
  const userSequence: UnknownRecord[] = [];
  let currentMinutes = parsedStart.startMinutes;
  let workingIndex = 0;

  for (let sequenceIndex = 0; sequenceIndex < steps.length; sequenceIndex += 1) {
    const step = steps[sequenceIndex];
    if (!step) continue;
    const duration = step.durationMinutes ?? 0;
    if (step.isPause) {
      currentMinutes += duration;
      continue;
    }
    const appointmentId = appointmentIds[workingIndex];
    const staff = input.staffAssignments[workingIndex];
    if (!appointmentId || !staff) {
      throw new Error("Planity appointment sequence could not be constructed");
    }
    const isComplex = step.originService.sequence.length > 0;
    const event = cleanObject({
      s: timeFromMinutes(parsedStart.date, currentMinutes),
      st: currentMinutes,
      d: duration,
      se: step.serviceId,
      seo: isComplex ? step.originService.id : null,
      seoi: isComplex ? step.originSequenceIndex : null,
      seop: isComplex ? step.originService.price.cents : null,
      ca: staff.id,
      p: isComplex ? null : step.originService.price.cents,
      cu: {
        d: false,
        id: input.customerId,
        name: input.customerName,
      },
      cby: input.createdBy,
      cat: SERVER_TIMESTAMP,
      uat: SERVER_TIMESTAMP,
      sq: sequenceId,
    });
    businessWrites[`calendar_vevents/${staff.id}/${appointmentId}`] = event;
    businessWrites[
      `business_customers/${input.businessId}/${input.customerId}/vevents/${appointmentId}`
    ] = staff.id;
    userSequence.push(
      cleanObject({
        serviceId: step.serviceId,
        serviceOrigin: isComplex ? step.originService.id : null,
        serviceOriginIndex: isComplex ? step.originSequenceIndex : null,
        serviceOriginPrice: isComplex ? step.originService.price.cents : null,
        calendars: staff.id,
        duration,
        sort: workingIndex,
        price: isComplex ? null : step.originService.price.cents,
      }),
    );
    currentMinutes += duration;
    workingIndex += 1;
  }

  if (!input.customerExists) {
    const customerPath = `business_customers/${input.businessId}/${input.customerId}`;
    businessWrites[`${customerPath}/name`] = input.customerName;
    businessWrites[`${customerPath}/phone`] = input.phone;
    businessWrites[`${customerPath}/comment`] = "";
    businessWrites[`${customerPath}/email`] = "";
    businessWrites[`${customerPath}/createdAt`] = input.now ?? Date.now();
  }

  const firstAppointmentId = appointmentIds[0];
  const firstStaff = input.staffAssignments[0];
  if (!firstAppointmentId || !firstStaff) {
    throw new Error("Planity appointment must contain at least one working step");
  }
  const userAppointment = {
    businessId: input.businessId,
    start: parsedStart.planityStart,
    sequence: userSequence,
  };
  const userPath = `user_vevents/${input.customerId}/${sequenceId}`;
  const masterWrites: Record<string, unknown> = {
    [userPath]: userAppointment,
    [`sms_queue/${firstAppointmentId}`]: {
      customerId: input.customerId,
      businessId: input.businessId,
      start: parsedStart.planityStart,
      calendarId: firstStaff.id,
    },
  };
  const usersWrites: Record<string, unknown> = {
    [userPath]: userAppointment,
  };

  assertSafeWritePaths(businessWrites, BUSINESS_WRITE_PREFIXES);
  assertSafeWritePaths(masterWrites, MASTER_WRITE_PREFIXES);
  assertSafeWritePaths(usersWrites, USERS_WRITE_PREFIXES);

  return {
    businessWrites,
    masterWrites,
    usersWrites,
    appointmentIds,
    sequenceId,
  };
}

function normalizedPhoneOrNull(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    return normalizeGermanPhone(value);
  } catch {
    return null;
  }
}

function safeFirebaseIds(value: unknown) {
  if (typeof value !== "string") return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(
          (entry) =>
            entry.length > 5 &&
            entry.length < 160 &&
            !/[.#$[\]/]/.test(entry),
        ),
    ),
  ];
}

function localDateTime(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part(
    "minute",
  )}`;
}

export function buildPlanityCancellationPlan(input: {
  businessId: string;
  appointment: PlanityAppointmentCandidate;
  deletedBy: string;
  timestamp?: unknown;
}): PlanityCancellationPlan {
  const timestamp = input.timestamp ?? SERVER_TIMESTAMP;
  const businessWrites: Record<string, unknown> = {};
  for (const event of input.appointment.events) {
    const calendars = [
      ...new Set([...event.calendarIds, ...event.removedFromCalendarIds]),
    ];
    if (calendars.length === 0) {
      throw new Error("Planity cancellation has no calendar assignment");
    }
    for (const calendarId of calendars) {
      businessWrites[`calendar_vevents/${calendarId}/${event.id}/dat`] =
        timestamp;
      businessWrites[`calendar_vevents/${calendarId}/${event.id}/uat`] =
        timestamp;
      businessWrites[`calendar_vevents/${calendarId}/${event.id}/dby`] =
        input.deletedBy;
    }
    businessWrites[
      `business_customers/${input.businessId}/${input.appointment.customerId}/vevents/${event.id}`
    ] = null;
  }

  const userPath = `user_vevents/${input.appointment.customerId}/${input.appointment.sequenceId}`;
  const firstAppointmentId = input.appointment.appointmentIds[0];
  if (!firstAppointmentId) {
    throw new Error("Planity cancellation has no appointment id");
  }
  const masterWrites: Record<string, unknown> = {
    [userPath]: null,
    [`sms_queue/${firstAppointmentId}`]: null,
  };
  const usersWrites: Record<string, unknown> = {
    [userPath]: null,
  };

  assertSafeWritePaths(businessWrites, BUSINESS_WRITE_PREFIXES);
  assertSafeWritePaths(masterWrites, MASTER_WRITE_PREFIXES);
  assertSafeWritePaths(usersWrites, USERS_WRITE_PREFIXES);
  return { businessWrites, masterWrites, usersWrites };
}

export class PlanityBookingClient {
  private tokenCache:
    | { token: string; uid: string; expiresAt: number; displayName: string }
    | undefined;
  private accessCheckedForToken: string | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async readResponseJson(response: Response) {
    const value = (await response.json().catch(() => null)) as unknown;
    return value;
  }

  private async authenticate() {
    if (
      this.tokenCache &&
      this.tokenCache.expiresAt > Date.now() + 120_000
    ) {
      return this.tokenCache;
    }
    const email = this.config.planity.proEmail;
    const password = this.config.planity.proPassword;
    if (!email || !password) {
      throw new Error("Planity Pro credentials are not configured");
    }
    const url = new URL(
      "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
    );
    url.searchParams.set("key", this.config.planity.firebaseApiKey);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await this.readResponseJson(
      response,
    )) as FirebaseAuthResponse | null;
    if (!response.ok || !payload?.idToken || !payload.localId) {
      throw new Error(`Planity Pro authentication failed (${response.status})`);
    }
    this.tokenCache = {
      token: payload.idToken,
      uid: payload.localId,
      expiresAt:
        Date.now() + Math.max(300, Number(payload.expiresIn ?? 3600)) * 1_000,
      displayName: this.config.planity.createdBy,
    };
    this.accessCheckedForToken = undefined;
    return this.tokenCache;
  }

  private async databaseGet(
    baseUrl: string,
    path: string,
    token: string,
    query?: Record<string, string>,
  ) {
    const url = pathUrl(baseUrl, path, token);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    return {
      ok: response.ok,
      status: response.status,
      value: await this.readResponseJson(response),
    };
  }

  private async assertBusinessAccess(auth: {
    token: string;
    uid: string;
    displayName: string;
  }) {
    if (this.accessCheckedForToken === auth.token) return;
    const [profileResult, adminResult, accessResult] = await Promise.all([
      this.databaseGet(
        this.config.planity.firebaseMasterUrl,
        `pros/${auth.uid}`,
        auth.token,
      ),
      this.databaseGet(
        this.config.planity.firebaseMasterUrl,
        `admins/${auth.uid}`,
        auth.token,
      ),
      this.databaseGet(
        this.config.planity.firebaseMasterUrl,
        `pros_acls/${auth.uid}/businesses`,
        auth.token,
      ),
    ]);
    const businesses = asRecord(accessResult.value);
    const hasBusinessAccess =
      Boolean(adminResult.ok && adminResult.value) ||
      Boolean(
        accessResult.ok &&
          businesses &&
          businesses[this.config.planity.businessId],
      );
    if (
      !profileResult.ok ||
      !profileResult.value ||
      !hasBusinessAccess
    ) {
      throw new Error(
        "The configured Planity Pro account is not linked to this salon",
      );
    }
    auth.displayName =
      findDisplayName(profileResult.value) ?? this.config.planity.createdBy;
    this.accessCheckedForToken = auth.token;
  }

  private businessDatabaseUrl(shard: string) {
    if (!/^[a-z0-9-]+$/i.test(shard)) {
      throw new Error("Planity returned an invalid business database shard");
    }
    return this.config.planity.firebaseBusinessUrlTemplate.replace(
      "%SHARD%",
      shard,
    );
  }

  private usersDatabaseUrl(shard: number) {
    return this.config.planity.firebaseUsersUrlTemplate.replace(
      "%SHARD%",
      String(shard),
    );
  }

  private customerIdCandidates(hit: UnknownRecord, businessId: string) {
    const candidates = new Set<string>();
    for (const key of ["id", "customerId"]) {
      if (typeof hit[key] === "string") candidates.add(hit[key] as string);
    }
    const objectId = hit.objectID;
    if (typeof objectId === "string") {
      candidates.add(objectId);
      if (objectId.startsWith(businessId)) {
        const suffix = objectId
          .slice(businessId.length)
          .replace(/^[@:_|/.-]+/, "");
        if (suffix) candidates.add(suffix);
      }
    }
    return [...candidates].filter(
      (candidate) => candidate.length > 5 && !candidate.includes("/"),
    );
  }

  private async customerFromCandidates(input: {
    hits: UnknownRecord[];
    phone: string;
    businessBaseUrl: string;
    token: string;
  }) {
    for (const hit of input.hits.slice(0, 10)) {
      if (
        typeof hit.businessId === "string" &&
        hit.businessId !== this.config.planity.businessId
      ) {
        continue;
      }
      for (const candidate of this.customerIdCandidates(
        hit,
        this.config.planity.businessId,
      )) {
        const customer = await this.databaseGet(
          input.businessBaseUrl,
          `business_customers/${this.config.planity.businessId}/${candidate}`,
          input.token,
        );
        const record = asRecord(customer.value);
        if (
          customer.ok &&
          record &&
          !record.deletedAt &&
          normalizedPhoneOrNull(record.phone) === input.phone
        ) {
          return { id: candidate, record };
        }
      }
    }
    return null;
  }

  private async findCustomer(input: {
    phone: string;
    businessBaseUrl: string;
    token: string;
  }) {
    const firebaseResult = await this.databaseGet(
      input.businessBaseUrl,
      `business_customers/${this.config.planity.businessId}`,
      input.token,
      {
        orderBy: JSON.stringify("phone"),
        equalTo: JSON.stringify(input.phone),
        limitToFirst: "3",
      },
    );
    if (firebaseResult.ok) {
      const customers = asRecord(firebaseResult.value) ?? {};
      for (const [id, value] of Object.entries(customers)) {
        const record = asRecord(value);
        if (
          record &&
          !record.deletedAt &&
          normalizedPhoneOrNull(record.phone) === input.phone
        ) {
          return { id, record };
        }
      }
    }

    const credentialsResponse = await this.fetchImpl(
      `${this.config.planity.apiBaseUrl}/getCustomerSearchCredentials`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: input.token,
          businessId: this.config.planity.businessId,
          businessCountryCode: "DE",
          withMainAppCredentials: false,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const credentialsEnvelope = asRecord(
      await this.readResponseJson(credentialsResponse),
    );
    const credentials =
      asRecord(credentialsEnvelope?.body) ?? credentialsEnvelope;
    const appId = credentials?.appId;
    const apiKey = credentials?.apiKey;
    if (
      !credentialsResponse.ok ||
      typeof appId !== "string" ||
      typeof apiKey !== "string"
    ) {
      throw new Error(
        "Planity customer lookup is unavailable; refusing to create a duplicate",
      );
    }
    const algoliaResponse = await this.fetchImpl(
      `https://${encodeURIComponent(
        appId,
      )}-dsn.algolia.net/1/indexes/business_customers/query`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Algolia-Application-Id": appId,
          "X-Algolia-API-Key": apiKey,
        },
        body: JSON.stringify({
          query: input.phone,
          hitsPerPage: 10,
          filters: "deletedAt=0",
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const algoliaPayload = asRecord(
      await this.readResponseJson(algoliaResponse),
    );
    if (!algoliaResponse.ok || !Array.isArray(algoliaPayload?.hits)) {
      throw new Error(
        "Planity customer lookup is unavailable; refusing to create a duplicate",
      );
    }
    return this.customerFromCandidates({
      hits: algoliaPayload.hits
        .map(asRecord)
        .filter((hit): hit is UnknownRecord => Boolean(hit)),
      phone: input.phone,
      businessBaseUrl: input.businessBaseUrl,
      token: input.token,
    });
  }

  async findUpcomingAppointments(input: {
    catalog: PlanityCatalog;
    phone: string;
    limit?: number;
    now?: Date;
  }): Promise<PlanityAppointmentCandidate[]> {
    const auth = await this.authenticate();
    await this.assertBusinessAccess(auth);
    const businessBaseUrl = this.businessDatabaseUrl(
      input.catalog.databaseShard,
    );
    const customer = await this.findCustomer({
      phone: input.phone,
      businessBaseUrl,
      token: auth.token,
    });
    if (!customer) return [];

    const customerVevents = asRecord(customer.record.vevents) ?? {};
    const references = Object.entries(customerVevents)
      .filter(([appointmentId]) => safeFirebaseIds(appointmentId).length === 1)
      .slice(-250);
    const loaded = await Promise.all(
      references.map(async ([appointmentId, rawCalendarId]) => {
        const calendarIds = safeFirebaseIds(rawCalendarId);
        for (const calendarId of calendarIds) {
          const result = await this.databaseGet(
            businessBaseUrl,
            `calendar_vevents/${calendarId}/${appointmentId}`,
            auth.token,
          );
          const record = asRecord(result.value);
          if (result.ok && record) {
            return { appointmentId, pathCalendarId: calendarId, record };
          }
        }
        return null;
      }),
    );

    const active = loaded.filter(
      (
        entry,
      ): entry is {
        appointmentId: string;
        pathCalendarId: string;
        record: UnknownRecord;
      } =>
        Boolean(
          entry &&
            !entry.record.dat &&
            typeof entry.record.s === "string" &&
            asRecord(entry.record.cu)?.id === customer.id,
        ),
    );
    const groups = new Map<
      string,
      Array<{
        appointmentId: string;
        pathCalendarId: string;
        record: UnknownRecord;
      }>
    >();
    for (const entry of active) {
      const sequenceIds = safeFirebaseIds(entry.record.sq);
      const sequenceId =
        sequenceIds.length > 0 ? sequenceIds.join(",") : entry.appointmentId;
      const group = groups.get(sequenceId) ?? [];
      group.push(entry);
      groups.set(sequenceId, group);
    }

    const staffById = new Map(
      input.catalog.staff.map((person) => [person.id, person.name]),
    );
    const serviceById = new Map(
      input.catalog.services.map((service) => [service.id, service.name]),
    );
    const threshold = localDateTime(
      input.catalog.timezone,
      input.now ?? new Date(),
    );
    const candidates: PlanityAppointmentCandidate[] = [];
    for (const [sequenceId, entries] of groups) {
      const appointmentIds = safeFirebaseIds(sequenceId);
      if (
        appointmentIds.length === 0 ||
        entries.length !== appointmentIds.length
      ) {
        continue;
      }
      const ordered = [...entries].sort((left, right) =>
        String(left.record.s).localeCompare(String(right.record.s)),
      );
      const start = String(ordered[0]?.record.s ?? "");
      if (!start || start < threshold) continue;
      const rootServiceIds = [...new Set(ordered
        .map(({ record }) =>
          typeof record.seo === "string"
            ? record.seo
            : typeof record.se === "string"
              ? record.se
              : null,
        )
        .filter((value): value is string => Boolean(value)))];
      const calendarIds = [
        ...new Set(
          ordered.flatMap(({ pathCalendarId, record }) => [
            pathCalendarId,
            ...safeFirebaseIds(record.ca),
          ]),
        ),
      ];
      const financialKeys = [
        "r",
        "opcid",
        "optpecid",
        "oppm",
        "oppp",
        "opd",
      ];
      candidates.push({
        customerId: customer.id,
        customerName:
          typeof customer.record.name === "string"
            ? customer.record.name
            : "Kunde",
        phone: input.phone,
        sequenceId,
        appointmentIds,
        start,
        serviceName:
          rootServiceIds
            .map((serviceId) => serviceById.get(serviceId))
            .filter((name): name is string => Boolean(name))
            .join(" + ") || "Friseurtermin",
        staffNames: calendarIds
          .map((calendarId) => staffById.get(calendarId))
          .filter((name): name is string => Boolean(name)),
        events: ordered.map(({ appointmentId, pathCalendarId, record }) => ({
          id: appointmentId,
          calendarIds: [
            ...new Set([pathCalendarId, ...safeFirebaseIds(record.ca)]),
          ],
          removedFromCalendarIds: safeFirebaseIds(record.rf),
        })),
        containsFinancialData: ordered.some(({ record }) =>
          financialKeys.some((key) => Boolean(record[key])),
        ),
      });
    }

    return candidates
      .sort((left, right) => left.start.localeCompare(right.start))
      .slice(0, input.limit ?? 5);
  }

  async cancel(
    catalog: PlanityCatalog,
    appointment: PlanityAppointmentCandidate,
  ): Promise<PlanityCancellationResult> {
    const auth = await this.authenticate();
    await this.assertBusinessAccess(auth);
    const businessBaseUrl = this.businessDatabaseUrl(catalog.databaseShard);
    const plan = buildPlanityCancellationPlan({
      businessId: catalog.businessId,
      appointment,
      deletedBy: auth.uid,
    });
    await this.patchDatabase(businessBaseUrl, plan.businessWrites, auth.token);
    const supportResults = await Promise.allSettled([
      this.patchDatabase(
        this.config.planity.firebaseMasterUrl,
        plan.masterWrites,
        auth.token,
      ),
      this.patchDatabase(
        this.usersDatabaseUrl(usersShard(appointment.customerId)),
        plan.usersWrites,
        auth.token,
      ),
    ]);
    const firstEvent = appointment.events[0];
    const firstCalendar = firstEvent?.calendarIds[0];
    let verified = false;
    if (firstEvent && firstCalendar) {
      const verification = await this.databaseGet(
        businessBaseUrl,
        `calendar_vevents/${firstCalendar}/${firstEvent.id}`,
        auth.token,
      );
      verified =
        verification.ok && Boolean(asRecord(verification.value)?.dat);
    }
    return {
      supportWritesComplete: supportResults.every(
        (result) => result.status === "fulfilled",
      ),
      verified,
    };
  }

  private async patchDatabase(
    baseUrl: string,
    writes: Record<string, unknown>,
    token: string,
  ) {
    const response = await this.fetchImpl(databaseRootUrl(baseUrl, token), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(writes),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`Planity calendar write failed (${response.status})`);
    }
  }

  async probeAccess(catalog: PlanityCatalog) {
    const auth = await this.authenticate();
    await this.assertBusinessAccess(auth);
    const businessBaseUrl = this.businessDatabaseUrl(catalog.databaseShard);
    const customerLookup = await this.databaseGet(
      businessBaseUrl,
      `business_customers/${this.config.planity.businessId}`,
      auth.token,
      {
        orderBy: JSON.stringify("phone"),
        equalTo: JSON.stringify("+499999999999"),
        limitToFirst: "1",
      },
    );
    return {
      authenticated: true,
      businessAccess: true,
      databaseShard: catalog.databaseShard,
      indexedCustomerLookup: customerLookup.ok,
      checkoutCapability: false,
    };
  }

  async book(request: PlanityBookingRequest): Promise<PlanityBookingResult> {
    const auth = await this.authenticate();
    await this.assertBusinessAccess(auth);
    const businessBaseUrl = this.businessDatabaseUrl(
      request.catalog.databaseShard,
    );
    const existingCustomer = await this.findCustomer({
      phone: request.phone,
      businessBaseUrl,
      token: auth.token,
    });
    const customerId = existingCustomer?.id ?? firebasePushId();
    const plan = buildPlanityWritePlan({
      businessId: request.catalog.businessId,
      services: request.services,
      start: request.start,
      staffAssignments: request.staffAssignments,
      customerId,
      customerName: request.customerName,
      phone: request.phone,
      customerExists: Boolean(existingCustomer),
      createdBy: this.config.planity.createdBy,
    });

    await this.patchDatabase(
      businessBaseUrl,
      plan.businessWrites,
      auth.token,
    );

    const supportResults = await Promise.allSettled([
      this.patchDatabase(
        this.config.planity.firebaseMasterUrl,
        plan.masterWrites,
        auth.token,
      ),
      this.patchDatabase(
        this.usersDatabaseUrl(usersShard(customerId)),
        plan.usersWrites,
        auth.token,
      ),
    ]);
    const supportWritesComplete = supportResults.every(
      (result) => result.status === "fulfilled",
    );

    const firstAppointmentId = plan.appointmentIds[0];
    const firstStaff = request.staffAssignments[0];
    let verified = false;
    if (firstAppointmentId && firstStaff) {
      const verification = await this.databaseGet(
        businessBaseUrl,
        `calendar_vevents/${firstStaff.id}/${firstAppointmentId}`,
        auth.token,
      );
      const record = asRecord(verification.value);
      verified =
        verification.ok &&
        record?.sq === plan.sequenceId &&
        asRecord(record?.cu)?.id === customerId;
    }

    return {
      appointmentIds: plan.appointmentIds,
      customerId,
      customerReused: Boolean(existingCustomer),
      supportWritesComplete,
      verified,
    };
  }
}
