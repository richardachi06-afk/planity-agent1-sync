import type { PlanityAvailabilityClient } from "../planity/availability.js";
import type {
  AvailabilitySlot,
  PlanityCatalog,
  PlanityService,
  PlanityStaff,
} from "../planity/types.js";

export type ServiceChainSlot = AvailabilitySlot & {
  services: PlanityService[];
  durationMinutes: number;
};

/**
 * If the exact requested time is free, Retell only needs that one answer.
 * Nearby times are alternatives and must only be offered when the requested
 * time itself is unavailable.
 */
export function selectSlotsForResponse(
  slots: ServiceChainSlot[],
  preferredTime?: string,
) {
  const exactSlot = preferredTime
    ? slots.find((slot) => slot.time === preferredTime)
    : undefined;
  return {
    exactRequestedTimeAvailable: Boolean(exactSlot),
    slots: exactSlot ? [exactSlot] : slots,
  };
}

function addDays(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function timeToMinutes(time: string) {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function minutesToTime(totalMinutes: number) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function serviceDurationMinutes(service: PlanityService) {
  if (service.sequence.length === 0) return service.durationMinutes;
  return service.sequence.reduce(
    (total, step) => total + (step.durationMinutes ?? 0),
    0,
  );
}

export function serviceWorkingSteps(service: PlanityService) {
  return service.sequence.filter((step) => !step.isPause).length || 1;
}

function isColorOrChemicalService(service: PlanityService) {
  const value = `${service.group} ${service.name}`.toLocaleLowerCase("de-DE");
  return /farbe|färb|strähn|blond|balayage|tön|dauerwelle/.test(value);
}

/**
 * Planity receives the canonical salon workflow, regardless of the order in
 * which the caller happened to mention the services. The sort is stable for
 * services in the same workflow group.
 */
export function orderAndDedupeServices(services: PlanityService[]) {
  const unique = [
    ...new Map(services.map((service) => [service.id, service])).values(),
  ];
  return unique
    .map((service, index) => ({ service, index }))
    .sort((left, right) => {
      const rankDifference =
        Number(!isColorOrChemicalService(left.service)) -
        Number(!isColorOrChemicalService(right.service));
      return rankDifference || left.index - right.index;
    })
    .map(({ service }) => service);
}

export async function findServiceChainSlots(input: {
  availabilityClient: Pick<PlanityAvailabilityClient, "findSlots">;
  catalog: PlanityCatalog;
  services: PlanityService[];
  date: string;
  staff?: PlanityStaff;
  preferredTime?: string;
  searchDays: number;
  limit?: number;
  forceRefresh?: boolean;
}): Promise<ServiceChainSlot[]> {
  const services = orderAndDedupeServices(input.services);
  if (services.length === 0) return [];

  const totalDuration = services.reduce(
    (total, service) => total + serviceDurationMinutes(service),
    0,
  );
  const resultLimit = input.limit ?? 3;
  const onlyService = services[0];
  if (services.length === 1 && onlyService) {
    const slots = await input.availabilityClient.findSlots({
      catalog: input.catalog,
      service: onlyService,
      date: input.date,
      ...(input.staff ? { staff: input.staff } : {}),
      ...(input.preferredTime ? { preferredTime: input.preferredTime } : {}),
      searchDays: input.searchDays,
      limit: resultLimit,
      ...(input.forceRefresh ? { forceRefresh: true } : {}),
    });
    return slots.map((slot) => ({
      ...slot,
      services,
      durationMinutes: totalDuration,
    }));
  }

  for (let offset = 0; offset < input.searchDays; offset += 1) {
    const date = addDays(input.date, offset);
    const slotsByService = await Promise.all(
      services.map((service) =>
        input.availabilityClient.findSlots({
          catalog: input.catalog,
          service,
          date,
          ...(input.staff ? { staff: input.staff } : {}),
          searchDays: 1,
          limit: 1_000,
          ...(input.forceRefresh ? { forceRefresh: true } : {}),
        }),
      ),
    );
    const firstSlots = slotsByService[0] ?? [];
    const chainSlots: ServiceChainSlot[] = [];

    for (const firstSlot of firstSlots) {
      const possibleStaff = input.staff ? [input.staff] : firstSlot.staff;
      for (const staff of possibleStaff) {
        let currentMinutes = timeToMinutes(firstSlot.time);
        const assignments: PlanityStaff[] = [];
        let valid = true;

        for (let index = 0; index < services.length; index += 1) {
          const service = services[index];
          if (!service || currentMinutes >= 24 * 60) {
            valid = false;
            break;
          }
          const targetTime = minutesToTime(currentMinutes);
          const serviceSlot = (slotsByService[index] ?? []).find(
            (slot) =>
              slot.time === targetTime &&
              !slot.mixedStaffPossible &&
              slot.staff.some((person) => person.id === staff.id),
          );
          if (!serviceSlot) {
            valid = false;
            break;
          }
          assignments.push(
            ...Array.from({ length: serviceWorkingSteps(service) }, () => staff),
          );
          currentMinutes += serviceDurationMinutes(service);
        }

        if (!valid) continue;
        chainSlots.push({
          date,
          time: firstSlot.time,
          start: firstSlot.start,
          staff: [staff],
          staffAssignments: assignments,
          mixedStaffPossible: false,
          services,
          durationMinutes: totalDuration,
        });
      }
    }

    if (chainSlots.length > 0) {
      const preferredMinutes = input.preferredTime
        ? timeToMinutes(input.preferredTime)
        : null;
      chainSlots.sort((left, right) => {
        if (preferredMinutes === null) return left.time.localeCompare(right.time);
        return (
          Math.abs(timeToMinutes(left.time) - preferredMinutes) -
            Math.abs(timeToMinutes(right.time) - preferredMinutes) ||
          left.time.localeCompare(right.time)
        );
      });
      return chainSlots.slice(0, resultLimit);
    }
  }

  return [];
}
