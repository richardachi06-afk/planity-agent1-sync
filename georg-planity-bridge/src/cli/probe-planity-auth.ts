import { loadConfig } from "../config.js";
import { PlanityBookingClient } from "../planity/booking-client.js";
import { PlanityCatalogClient } from "../planity/catalog.js";

const config = loadConfig({
  ...process.env,
  NODE_ENV: "development",
  DRY_RUN: "true",
  PLANITY_BOOKING_ENABLED: "false",
});
const catalogClient = new PlanityCatalogClient({
  salonUrl: config.planity.salonUrl,
  businessId: config.planity.businessId,
  ttlMs: 1,
});
const catalog = await catalogClient.getCatalog();
const client = new PlanityBookingClient(config);
const result = await client.probeAccess(catalog);

console.log(
  JSON.stringify({
    ...result,
    business: catalog.businessName,
    staffCount: catalog.staff.length,
    serviceCount: catalog.services.length,
    externalActionPerformed: false,
  }),
);
