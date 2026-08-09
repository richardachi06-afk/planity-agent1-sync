import { createApp } from "./app.js";
import { BookingService } from "./booking/service.js";
import { CancellationService } from "./cancellation/service.js";
import { loadConfig } from "./config.js";
import { PlanityAvailabilityClient } from "./planity/availability.js";
import { PlanityBookingClient } from "./planity/booking-client.js";
import { PlanityCatalogClient } from "./planity/catalog.js";
import { RecordingArchive } from "./recordings/archive.js";

const config = loadConfig();
const recordingArchive = new RecordingArchive(config);
await recordingArchive.initialize();
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
const planityBookingClient = new PlanityBookingClient(config);
const bookingService = new BookingService(
  config,
  catalogClient,
  availabilityClient,
  planityBookingClient,
);
const cancellationService = new CancellationService(
  config,
  catalogClient,
  planityBookingClient,
);
const app = createApp({
  config,
  catalogClient,
  availabilityClient,
  bookingService,
  cancellationService,
  recordingArchive,
});

app.listen(config.port, () => {
  console.log(
    JSON.stringify({
      event: "server_started",
      port: config.port,
      dryRun: config.dryRun,
      planityWritesEnabled: config.planity.bookingEnabled,
      planityCancellationEnabled: config.planity.cancellationEnabled,
      recordingArchiveEnabled: recordingArchive.enabled,
    }),
  );
});
