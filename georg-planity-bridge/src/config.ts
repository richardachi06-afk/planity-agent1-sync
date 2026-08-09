import { z } from "zod";

const booleanFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value, context) => {
      if (value === undefined || value === "") return defaultValue;
      if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
      if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
      context.addIssue({
        code: "custom",
        message: `Expected boolean value, received "${value}"`,
      });
      return z.NEVER;
    });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DRY_RUN: booleanFromEnv(true),
  ALLOW_UNSIGNED_RETELL: booleanFromEnv(false),
  RETELL_API_KEY: z.string().optional(),
  RETELL_BRIDGE_TOKEN: z.string().min(32).optional(),
  RETELL_AGENT_ID: z.string().optional(),
  RECORDINGS_ENABLED: booleanFromEnv(false),
  RECORDINGS_PATH: z.string().default("./data/recordings"),
  RECORDING_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  RECORDING_ENCRYPTION_KEY: z.string().optional(),
  RECORDINGS_ADMIN_USER: z.string().min(3).max(64).default("georg"),
  RECORDINGS_ADMIN_PASSWORD: z.string().min(16).optional(),
  RECORDING_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_000_000)
    .max(256_000_000)
    .default(64_000_000),
  PLANITY_SALON_URL: z
    .url()
    .default("https://www.planity.com/de-DE/georg-hairstudio-76297-stutensee"),
  PLANITY_BUSINESS_ID: z.string().default("-OL4rfal5p-581U2OHLQ"),
  PLANITY_AVAILABILITY_BASE_URL: z
    .url()
    .default(
      "https://planity-production-availabilities-1.europe-west1.firebasedatabase.app",
    ),
  PLANITY_TIMEZONE: z.string().default("Europe/Berlin"),
  PLANITY_CATALOG_TTL_MS: z.coerce.number().int().positive().default(900_000),
  PLANITY_AVAILABILITY_TTL_MS: z.coerce.number().int().positive().default(30_000),
  MAX_AVAILABILITY_SEARCH_DAYS: z.coerce.number().int().min(1).max(60).default(14),
  PLANITY_BOOKING_ENABLED: booleanFromEnv(false),
  PLANITY_CANCELLATION_ENABLED: booleanFromEnv(false),
  PLANITY_PRO_EMAIL: z.string().optional(),
  PLANITY_PRO_PASSWORD: z.string().optional(),
  PLANITY_ACCESS_PIN: z.string().optional(),
  PLANITY_FIREBASE_API_KEY: z
    .string()
    .default("AIzaSyDrSE1PzMwLKyhEvh2x8eV7s1NYwKGRC5Q"),
  PLANITY_FIREBASE_MASTER_URL: z
    .url()
    .default("https://planity-production.firebaseio.com"),
  PLANITY_FIREBASE_BUSINESS_URL_TEMPLATE: z
    .string()
    .default(
      "https://planity-production-%SHARD%.europe-west1.firebasedatabase.app",
    ),
  PLANITY_FIREBASE_USERS_URL_TEMPLATE: z
    .string()
    .default(
      "https://planity-production-users-%SHARD%.europe-west1.firebasedatabase.app",
    ),
  PLANITY_API_BASE_URL: z
    .url()
    .default("https://product.api.euwest1.prod.planityapp.com"),
  PLANITY_TEST_MODE: booleanFromEnv(true),
  PLANITY_TEST_ALLOWED_PHONE: z.string().optional(),
  PLANITY_TEST_ALLOWED_NAME: z.string().min(2).max(100).optional(),
  PLANITY_TEST_SESSION_ID: z.string().min(8).optional(),
  PLANITY_TEST_RELEASE_FROM: z.iso.datetime().optional(),
  PLANITY_TEST_RELEASE_UNTIL: z.iso.datetime().optional(),
  PLANITY_TEST_MAX_BOOKINGS: z.coerce.number().int().min(1).max(3).default(1),
  PLANITY_TEST_STATE_PATH: z
    .string()
    .default("./data/planity-test-state.json"),
  PLANITY_CREATED_BY: z.string().min(2).max(64).default("Retell Voice-Agent"),
  CAL_API_KEY: z.string().optional(),
  CAL_MIRROR_ENABLED: booleanFromEnv(false),
  CAL_API_VERSION_EVENT_TYPES: z.string().default("2024-06-14"),
  CAL_API_VERSION_BOOKINGS: z.string().default("2026-02-25"),
  SQLITE_PATH: z.string().default("./data/bridge.sqlite"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);

  if (env.NODE_ENV === "production" && !env.RETELL_API_KEY) {
    throw new Error("RETELL_API_KEY is required in production");
  }
  if (env.NODE_ENV === "production" && env.ALLOW_UNSIGNED_RETELL) {
    throw new Error("ALLOW_UNSIGNED_RETELL must be false in production");
  }
  if (env.RECORDINGS_ENABLED) {
    if (
      !env.RECORDING_ENCRYPTION_KEY ||
      !env.RECORDINGS_ADMIN_PASSWORD ||
      !env.RETELL_AGENT_ID
    ) {
      throw new Error(
        "Recording archive requires encryption key, admin password and Retell agent id",
      );
    }
    let encryptionKey: Buffer;
    try {
      encryptionKey = Buffer.from(env.RECORDING_ENCRYPTION_KEY, "base64");
    } catch {
      encryptionKey = Buffer.alloc(0);
    }
    if (encryptionKey.byteLength !== 32) {
      throw new Error(
        "RECORDING_ENCRYPTION_KEY must be a base64 encoded 32-byte key",
      );
    }
  }
  const planityWritesEnabled =
    env.PLANITY_BOOKING_ENABLED || env.PLANITY_CANCELLATION_ENABLED;
  if (!env.DRY_RUN && !planityWritesEnabled) {
    throw new Error(
      "Refusing to start with DRY_RUN=false while all Planity writes are disabled",
    );
  }
  if (env.PLANITY_CANCELLATION_ENABLED && !env.RETELL_BRIDGE_TOKEN) {
    throw new Error(
      "RETELL_BRIDGE_TOKEN is required when Planity cancellation is enabled",
    );
  }
  if (!env.DRY_RUN && planityWritesEnabled) {
    if (!env.PLANITY_PRO_EMAIL || !env.PLANITY_PRO_PASSWORD) {
      throw new Error(
        "PLANITY_PRO_EMAIL and PLANITY_PRO_PASSWORD are required for Planity writes",
      );
    }
    if (env.PLANITY_TEST_MODE) {
      if (
        !env.PLANITY_TEST_ALLOWED_PHONE ||
        !env.PLANITY_TEST_ALLOWED_NAME ||
        !env.PLANITY_TEST_SESSION_ID ||
        !env.PLANITY_TEST_RELEASE_FROM ||
        !env.PLANITY_TEST_RELEASE_UNTIL
      ) {
        throw new Error(
          "The live Planity test requires an allowed phone, session id and release window",
        );
      }
      if (
        Date.parse(env.PLANITY_TEST_RELEASE_UNTIL) <=
        Date.parse(env.PLANITY_TEST_RELEASE_FROM)
      ) {
        throw new Error("PLANITY_TEST_RELEASE_UNTIL must be after its start");
      }
    }
  }
  if (env.CAL_MIRROR_ENABLED && !env.CAL_API_KEY) {
    throw new Error("CAL_API_KEY is required when CAL_MIRROR_ENABLED=true");
  }

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    dryRun: env.DRY_RUN,
    allowUnsignedRetell: env.ALLOW_UNSIGNED_RETELL,
    retellApiKey: env.RETELL_API_KEY,
    retellBridgeToken: env.RETELL_BRIDGE_TOKEN,
    retellAgentId: env.RETELL_AGENT_ID,
    recordings: {
      enabled: env.RECORDINGS_ENABLED,
      path: env.RECORDINGS_PATH,
      retentionDays: env.RECORDING_RETENTION_DAYS,
      encryptionKey: env.RECORDING_ENCRYPTION_KEY,
      adminUser: env.RECORDINGS_ADMIN_USER,
      adminPassword: env.RECORDINGS_ADMIN_PASSWORD,
      maxBytes: env.RECORDING_MAX_BYTES,
    },
    planity: {
      salonUrl: env.PLANITY_SALON_URL,
      businessId: env.PLANITY_BUSINESS_ID,
      availabilityBaseUrl: env.PLANITY_AVAILABILITY_BASE_URL.replace(/\/$/, ""),
      timezone: env.PLANITY_TIMEZONE,
      catalogTtlMs: env.PLANITY_CATALOG_TTL_MS,
      availabilityTtlMs: env.PLANITY_AVAILABILITY_TTL_MS,
      maxSearchDays: env.MAX_AVAILABILITY_SEARCH_DAYS,
      bookingEnabled: env.PLANITY_BOOKING_ENABLED,
      cancellationEnabled: env.PLANITY_CANCELLATION_ENABLED,
      proEmail: env.PLANITY_PRO_EMAIL,
      proPassword: env.PLANITY_PRO_PASSWORD,
      accessPin: env.PLANITY_ACCESS_PIN,
      firebaseApiKey: env.PLANITY_FIREBASE_API_KEY,
      firebaseMasterUrl: env.PLANITY_FIREBASE_MASTER_URL.replace(/\/$/, ""),
      firebaseBusinessUrlTemplate: env.PLANITY_FIREBASE_BUSINESS_URL_TEMPLATE,
      firebaseUsersUrlTemplate: env.PLANITY_FIREBASE_USERS_URL_TEMPLATE,
      apiBaseUrl: env.PLANITY_API_BASE_URL.replace(/\/$/, ""),
      createdBy: env.PLANITY_CREATED_BY,
      test: {
        enabled: env.PLANITY_TEST_MODE,
        allowedPhone: env.PLANITY_TEST_ALLOWED_PHONE,
        allowedName: env.PLANITY_TEST_ALLOWED_NAME,
        sessionId: env.PLANITY_TEST_SESSION_ID,
        releaseFrom: env.PLANITY_TEST_RELEASE_FROM,
        releaseUntil: env.PLANITY_TEST_RELEASE_UNTIL,
        maxBookings: env.PLANITY_TEST_MAX_BOOKINGS,
        statePath: env.PLANITY_TEST_STATE_PATH,
      },
    },
    cal: {
      apiKey: env.CAL_API_KEY,
      mirrorEnabled: env.CAL_MIRROR_ENABLED,
      eventTypesVersion: env.CAL_API_VERSION_EVENT_TYPES,
      bookingsVersion: env.CAL_API_VERSION_BOOKINGS,
    },
    sqlitePath: env.SQLITE_PATH,
  };
}
