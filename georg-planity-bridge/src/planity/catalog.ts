import type {
  PlanityCatalog,
  PlanitySequenceStep,
  PlanityService,
  PlanityStaff,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

type RawService = {
  appHidden?: boolean;
  bookable?: boolean;
  deletedAt?: number;
  duration?: number;
  formula?: { xor?: { from?: string[]; qty?: number } };
  name?: string;
  prices?: { default?: number; min?: number; max?: number };
  sequence?: PlanitySequenceStep[];
  sort?: number;
  webHidden?: boolean;
};

type RawServiceGroup = {
  children?: Record<string, RawService>;
  deletedAt?: number;
  name?: string;
  sort?: number;
};

type RawCalendar = {
  name?: string;
  sort?: number;
  webHidden?: boolean;
};

type RawCalendarGroup = {
  children?: Record<string, RawCalendar>;
  name?: string;
};

type RawBusiness = {
  calendars?: Record<string, RawCalendarGroup>;
  db?: string;
  name?: string;
  openingHours?: string;
  services?: Record<string, RawServiceGroup>;
  timeZone?: string;
};

const LOCAL_STATES_START = "window._planity_localStates = ";
const LOCAL_STATES_END = "window._planity_locals";

export function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[+&]/g, " und ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toKey(value: string) {
  return normalizeText(value).replaceAll(" ", "-");
}

function serviceSearchText(value: string) {
  return normalizeText(value)
    .replace(/\bherrenhaarschnitt\b|\bherrenschnitt\b/g, "herren schneiden")
    .replace(/\bdamenhaarschnitt\b|\bdamenschnitt\b/g, "damen schneiden")
    .replace(/\bkinderhaarschnitt\b|\bkinderschnitt\b/g, "kinder schneiden")
    .replace(/\bmaschinenhaarschnitt\b/g, "maschine schneiden")
    .replace(/\bansatzfarbe\b/g, "ansatz farbe")
    .replace(/\bhaarfarbe\b/g, "haar farbe")
    .replace(/\bfaerben\b|\bfaerbung\b/g, "farbe")
    .replace(/\s+/g, " ")
    .trim();
}

function genericCutCandidates(catalog: PlanityCatalog, input: string) {
  const query = serviceSearchText(input);
  const hasGenericCutTerm = /\b(schneiden|haarschnitt|schnitt)\b/.test(query);
  const hasSpecificVariant =
    /\b(maschine|waschen|foehnen|trocknen|pony|spitzen|[0-9]+)\b/.test(query);
  if (!hasGenericCutTerm || hasSpecificVariant) return [];

  const requestedGroup = ["herren", "damen", "kinder"].find((group) =>
    query.includes(group),
  );
  return catalog.services.filter((service) => {
    const group = serviceSearchText(service.group);
    const name = serviceSearchText(service.name);
    return (
      (!requestedGroup || group.includes(requestedGroup)) &&
      /\b(schneiden|haarschnitt|schnitt)\b/.test(name) &&
      !name.includes("pony")
    );
  });
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function extractLocalStates(html: string): UnknownRecord {
  const start = html.indexOf(LOCAL_STATES_START);
  const endMarker = html.indexOf(LOCAL_STATES_END, start + LOCAL_STATES_START.length);

  if (start < 0 || endMarker < 0) {
    throw new Error("Planity local state was not found in the salon page");
  }

  const jsonStart = start + LOCAL_STATES_START.length;
  const jsonEnd = html.lastIndexOf(";", endMarker);
  if (jsonEnd <= jsonStart) {
    throw new Error("Planity local state is malformed");
  }

  return JSON.parse(html.slice(jsonStart, jsonEnd).trim()) as UnknownRecord;
}

function findBusiness(states: UnknownRecord): RawBusiness {
  for (const state of Object.values(states)) {
    const stateRecord = asRecord(state);
    const data = stateRecord ? asRecord(stateRecord.data) : null;
    if (data?.services && data.calendars && typeof data.name === "string") {
      return data as RawBusiness;
    }
  }
  throw new Error("Salon business data was not found in Planity local state");
}

function intersect(sets: Set<string>[]) {
  if (sets.length === 0) return new Set<string>();
  const [first, ...rest] = sets;
  if (!first) return new Set<string>();
  return new Set([...first].filter((value) => rest.every((set) => set.has(value))));
}

function eligibleCalendarIds(
  service: RawService,
  allServices: Map<string, RawService>,
  allCalendarIds: string[],
) {
  const direct = service.formula?.xor?.from;
  if (direct?.length) return new Set(direct);

  const sequenceSets = (service.sequence ?? [])
    .filter((step) => step.serviceId !== "PAUSE")
    .map((step) => allServices.get(step.serviceId)?.formula?.xor?.from)
    .filter((ids): ids is string[] => Boolean(ids?.length))
    .map((ids) => new Set(ids));

  return sequenceSets.length > 0
    ? intersect(sequenceSets)
    : new Set(allCalendarIds);
}

export function parseCatalog(
  html: string,
  businessId: string,
): PlanityCatalog {
  const business = findBusiness(extractLocalStates(html));
  const calendarGroups = Object.values(business.calendars ?? {});
  const calendars = calendarGroups.flatMap((group) =>
    Object.entries(group.children ?? {}),
  );
  const staff = calendars
    .map(
      ([id, value]): PlanityStaff => ({
        id,
        key: toKey(value.name ?? id),
        name: value.name ?? id,
        sort: value.sort ?? 999,
      }),
    )
    .sort((a, b) => a.sort - b.sort);
  const staffById = new Map(staff.map((person) => [person.id, person]));

  const activeGroups = Object.entries(business.services ?? {}).filter(
    ([id, group]) => id !== "hiddenServices" && !group.deletedAt,
  );
  const allServices = new Map<string, RawService>();
  for (const [, group] of activeGroups) {
    for (const [serviceId, service] of Object.entries(group.children ?? {})) {
      if (!service.deletedAt) allServices.set(serviceId, service);
    }
  }

  const services: PlanityService[] = [];
  for (const [, group] of activeGroups) {
    for (const [id, service] of Object.entries(group.children ?? {})) {
      if (!service.bookable || service.deletedAt || !service.name) continue;
      const eligibleIds = eligibleCalendarIds(
        service,
        allServices,
        staff.map((person) => person.id),
      );
      const defaultPrice = service.prices?.default;
      const minimumPrice = service.prices?.min;
      services.push({
        id,
        key: toKey(`${group.name ?? ""} ${service.name}`),
        name: service.name.trim(),
        group: group.name ?? "",
        durationMinutes: service.duration ?? 0,
        price: {
          cents: defaultPrice ?? minimumPrice ?? null,
          isFromPrice: defaultPrice === undefined && minimumPrice !== undefined,
        },
        eligibleStaff: [...eligibleIds]
          .map((calendarId) => staffById.get(calendarId))
          .filter((person): person is PlanityStaff => Boolean(person))
          .sort((a, b) => a.sort - b.sort),
        sequence: (service.sequence ?? []).map((step) => ({
          ...step,
          durationMinutes:
            step.duration ??
            step.defaultDuration ??
            allServices.get(step.serviceId)?.duration ??
            0,
          isPause: step.serviceId === "PAUSE",
        })),
      });
    }
  }

  services.sort(
    (a, b) =>
      a.group.localeCompare(b.group, "de") || a.name.localeCompare(b.name, "de"),
  );

  return {
    businessId,
    businessName: business.name ?? "Georg Hairstudio",
    databaseShard: business.db ?? "de-4",
    timezone: business.timeZone ?? "Europe/Berlin",
    openingHours: business.openingHours ?? "",
    services,
    staff,
  };
}

type CatalogClientOptions = {
  salonUrl: string;
  businessId: string;
  ttlMs: number;
  fetchImpl?: typeof fetch;
};

export class PlanityCatalogClient {
  private readonly fetchImpl: typeof fetch;
  private cache: { expiresAt: number; catalog: PlanityCatalog } | null = null;

  constructor(private readonly options: CatalogClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getCatalog(): Promise<PlanityCatalog> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.catalog;
    }

    const response = await this.fetchImpl(this.options.salonUrl, {
      headers: {
        Accept: "text/html",
        "User-Agent": "GeorgHairstudio-Retell-Bridge/0.1",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Planity catalog request failed with ${response.status}`);
    }

    const catalog = parseCatalog(await response.text(), this.options.businessId);
    this.cache = {
      catalog,
      expiresAt: Date.now() + this.options.ttlMs,
    };
    return catalog;
  }

  async resolveService(input: string) {
    const catalog = await this.getCatalog();
    const genericCandidates = genericCutCandidates(catalog, input);
    if (genericCandidates.length > 1) {
      const query = serviceSearchText(input);
      const defaultName = query.includes("herren")
        ? "waschen und schneiden"
        : query.includes("damen")
          ? "waschen und schneiden und foehnen"
          : null;
      const defaultService = defaultName
        ? genericCandidates.find(
            (service) => serviceSearchText(service.name) === defaultName,
          )
        : undefined;
      if (defaultService) {
        return {
          service: defaultService,
          candidates: [defaultService],
        };
      }
      return {
        service: null,
        candidates: genericCandidates.slice(0, 6),
      };
    }
    if (genericCandidates.length === 1 && genericCandidates[0]) {
      return {
        service: genericCandidates[0],
        candidates: genericCandidates,
      };
    }

    const query = serviceSearchText(input);
    if (!/\b(kurz|mittel|lang)\b/.test(query)) {
      const defaultVariantName = /\bansatz farbe\b/.test(query)
        ? "Ansatzfarbe - Mittel"
        : /\bblondierung\b/.test(query)
          ? "Blondierung - Mittel"
          : /\bstraehnen oberkopf\b/.test(query)
            ? "Strähnen Oberkopf - Mittel"
            : /\bdauerwelle\b/.test(query)
              ? "Dauerwelle - Lang"
              : null;
      const defaultVariant = defaultVariantName
        ? catalog.services.find(
            (service) => normalizeText(service.name) === normalizeText(defaultVariantName),
          )
        : undefined;
      if (defaultVariant) {
        return { service: defaultVariant, candidates: [defaultVariant] };
      }
    }
    const scored = catalog.services
      .map((service) => {
        const name = serviceSearchText(service.name);
        const fullName = serviceSearchText(`${service.group} ${service.name}`);
        let score = 0;
        if (query === name || query === fullName || query === serviceSearchText(service.key)) score = 100;
        else if (fullName.includes(query) || query.includes(fullName)) score = 70;
        else {
          const queryTokens = new Set(query.split(" "));
          const candidateTokens = new Set(fullName.split(" "));
          const intersection = [...queryTokens].filter((token) =>
            candidateTokens.has(token),
          ).length;
          const union = new Set([...queryTokens, ...candidateTokens]).size;
          score = union ? (intersection / union) * 50 : 0;
        }
        return { service, score };
      })
      .filter(({ score }) => score >= 20)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const second = scored[1];
    if (!best) return { service: null, candidates: [] };
    if (
      second &&
      (best.score === second.score ||
        (best.score < 100 && best.score - second.score < 8))
    ) {
      return {
        service: null,
        candidates: scored.slice(0, 4).map(({ service }) => service),
      };
    }
    return {
      service: best.service,
      candidates: scored.slice(0, 4).map(({ service }) => service),
    };
  }
}
