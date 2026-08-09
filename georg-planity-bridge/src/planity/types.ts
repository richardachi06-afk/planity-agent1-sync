export type Price = {
  cents: number | null;
  isFromPrice: boolean;
};

export type PlanityStaff = {
  id: string;
  key: string;
  name: string;
  sort: number;
};

export type PlanitySequenceStep = {
  serviceId: string;
  duration?: number;
  defaultDuration?: number;
  durationMinutes?: number;
  isPause?: boolean;
};

export type PlanityService = {
  id: string;
  key: string;
  name: string;
  group: string;
  durationMinutes: number;
  price: Price;
  eligibleStaff: PlanityStaff[];
  sequence: PlanitySequenceStep[];
};

export type PlanityCatalog = {
  businessId: string;
  businessName: string;
  databaseShard: string;
  timezone: string;
  openingHours: string;
  services: PlanityService[];
  staff: PlanityStaff[];
};

export type AvailabilitySlot = {
  date: string;
  time: string;
  start: string;
  staff: PlanityStaff[];
  staffAssignments: PlanityStaff[];
  mixedStaffPossible: boolean;
};
