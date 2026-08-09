import { loadConfig } from "../config.js";
import { PlanityAvailabilityClient } from "../planity/availability.js";
import { PlanityCatalogClient } from "../planity/catalog.js";

const config = loadConfig({
  ...process.env,
  DRY_RUN: "true",
  ALLOW_UNSIGNED_RETELL: "true",
});
const catalogClient = new PlanityCatalogClient({
  salonUrl: config.planity.salonUrl,
  businessId: config.planity.businessId,
  ttlMs: config.planity.catalogTtlMs,
});
const availabilityClient = new PlanityAvailabilityClient({
  baseUrl: config.planity.availabilityBaseUrl,
  businessId: config.planity.businessId,
  timezone: config.planity.timezone,
  ttlMs: config.planity.availabilityTtlMs,
});

const catalog = await catalogClient.getCatalog();
const service = catalog.services.find(
  (candidate) => candidate.name === "Waschen & Schneiden",
);
if (!service) throw new Error("Smoke-test service was not found");

const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: config.planity.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const slots = await availabilityClient.findSlots({
  catalog,
  service,
  date: today,
  searchDays: 14,
  limit: 3,
});

console.log(
  JSON.stringify(
    {
      readOnly: true,
      business: catalog.businessName,
      serviceCount: catalog.services.length,
      staff: catalog.staff.map((person) => person.name),
      checkedService: service.name,
      slots,
    },
    null,
    2,
  ),
);
