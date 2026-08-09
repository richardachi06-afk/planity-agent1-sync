import { gunzipSync, inflateSync } from "node:zlib";
import type {
  AvailabilitySlot,
  PlanityCatalog,
  PlanityService,
  PlanityStaff,
} from "./types.js";

type AvailabilityTree = Record<string, Record<string, unknown>>;

type AvailabilityClientOptions = {
  baseUrl: string;
  businessId: string;
  timezone: string;
  ttlMs: number;
  fetchImpl?: typeof fetch;
};

function decodeCompressedJson(raw: string): AvailabilityTree {
  const compressed = Buffer.from(raw, "latin1");
  let json: string;
  try {
    json = gunzipSync(compressed).toString("utf8");
  } catch {
    json = inflateSync(compressed).toString("utf8");
  }
  return JSON.parse(json) as AvailabilityTree;
}

function staffIdsFromObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Set<string>();
  }
  return new Set(
    Object.keys(value as Record<string, unknown>).filter(
      (key) => key !== "PAUSE_PLACEHOLDER" && key !== "limitRemain",
    ),
  );
}

function intersection(sets: Set<string>[]) {
  const [first, ...rest] = sets;
  if (!first) return new Set<string>();
  return new Set([...first].filter((id) => rest.every((set) => set.has(id))));
}

export function candidateStaff(value: unknown) {
  if (!Array.isArray(value)) {
    const staff = staffIdsFromObject(value);
    return {
      commonStaff: staff,
      allStaff: staff,
      stepStaff: staff.size > 0 ? [staff] : [],
      hasCandidates: staff.size > 0,
    };
  }

  const stepSets = value
    .filter((step) => {
      if (!step || typeof step !== "object" || Array.isArray(step)) return false;
      return !Object.hasOwn(step, "PAUSE_PLACEHOLDER");
    })
    .map(staffIdsFromObject)
    .filter((set) => set.size > 0);

  const allStaff = new Set(stepSets.flatMap((set) => [...set]));
  return {
    commonStaff: intersection(stepSets),
    allStaff,
    stepStaff: stepSets,
    hasCandidates: stepSets.length > 0 && stepSets.every((set) => set.size > 0),
  };
}

function addDays(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export class PlanityAvailabilityClient {
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<
    string,
    { expiresAt: number; data: AvailabilityTree }
  >();

  constructor(private readonly options: AvailabilityClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async getTree(serviceId: string, forceRefresh = false) {
    const cached = this.cache.get(serviceId);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const url = `${this.options.baseUrl}/${encodeURIComponent(
      this.options.businessId,
    )}/${encodeURIComponent(serviceId)}-str.json`;
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "GeorgHairstudio-Retell-Bridge/0.1",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      throw new Error(`Planity availability request failed with ${response.status}`);
    }
    const raw = (await response.json()) as unknown;
    if (typeof raw !== "string") {
      throw new Error("Planity availability response had an unexpected format");
    }
    const data = decodeCompressedJson(raw);
    this.cache.set(serviceId, {
      data,
      expiresAt: Date.now() + this.options.ttlMs,
    });
    return data;
  }

  async findSlots(input: {
    catalog: PlanityCatalog;
    service: PlanityService;
    date: string;
    staff?: PlanityStaff;
    preferredTime?: string;
    searchDays: number;
    limit?: number;
    forceRefresh?: boolean;
  }): Promise<AvailabilitySlot[]> {
    const tree = await this.getTree(
      input.service.id,
      input.forceRefresh ?? false,
    );
    const staffById = new Map(input.catalog.staff.map((person) => [person.id, person]));
    const slots: AvailabilitySlot[] = [];

    for (let offset = 0; offset < input.searchDays; offset += 1) {
      const date = addDays(input.date, offset);
      const day = tree[date] ?? {};
      for (const [time, rawCandidates] of Object.entries(day)) {
        if (time === "limitRemain" || !/^\d{2}:\d{2}$/.test(time)) continue;
        const candidates = candidateStaff(rawCandidates);
        if (!candidates.hasCandidates) continue;
        if (input.staff && !candidates.commonStaff.has(input.staff.id)) continue;

        const displayStaffIds =
          candidates.commonStaff.size > 0
            ? candidates.commonStaff
            : candidates.allStaff;
        const staff = [...displayStaffIds]
          .map((id) => staffById.get(id))
          .filter((person): person is PlanityStaff => Boolean(person))
          .sort((a, b) => a.sort - b.sort);
        const selectedStaffId = input.staff?.id ?? [...candidates.commonStaff][0];
        const staffAssignmentIds = selectedStaffId
          ? candidates.stepStaff.map(() => selectedStaffId)
          : candidates.stepStaff
              .map((ids) => [...ids][0])
              .filter((id): id is string => Boolean(id));
        const staffAssignments = staffAssignmentIds
          .map((id) => staffById.get(id))
          .filter((person): person is PlanityStaff => Boolean(person));

        slots.push({
          date,
          time,
          start: `${date}T${time}:00`,
          staff,
          staffAssignments,
          mixedStaffPossible:
            candidates.commonStaff.size === 0 && candidates.allStaff.size > 0,
        });
      }
      if (slots.length > 0) break;
    }

    slots.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (!input.preferredTime) return a.time.localeCompare(b.time);
      const toMinutes = (time: string) => {
        const [hours = "0", minutes = "0"] = time.split(":");
        return Number(hours) * 60 + Number(minutes);
      };
      return (
        Math.abs(toMinutes(a.time) - toMinutes(input.preferredTime)) -
        Math.abs(toMinutes(b.time) - toMinutes(input.preferredTime))
      );
    });

    return slots.slice(0, input.limit ?? 3);
  }
}
