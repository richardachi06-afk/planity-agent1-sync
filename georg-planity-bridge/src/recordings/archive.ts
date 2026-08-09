import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import type { AppConfig } from "../config.js";

const MAGIC = Buffer.from("GHR1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.byteLength + IV_BYTES + 1 + TAG_BYTES;
const RETENTION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

type UnknownRecord = Record<string, unknown>;

export type RecordingListItem = {
  id: string;
  recordedAt: string;
  expiresAt: string;
  encryptedBytes: number;
};

export type RecordingAudio = {
  body: Buffer;
  contentType: string;
  recordedAt: string;
};

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function parseJsonRecord(value: unknown) {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

export function extractRecordingConsent(payload: unknown): boolean | null {
  const envelope = asRecord(payload);
  const call = asRecord(envelope?.call);
  const transcript = call?.transcript_with_tool_calls;
  if (!Array.isArray(transcript)) return null;

  const invocations = new Map<string, boolean>();
  let lastDecision: boolean | null = null;
  for (const entryValue of transcript) {
    const entry = asRecord(entryValue);
    if (!entry) continue;
    if (
      entry.role === "tool_call_invocation" &&
      entry.name === "record_recording_consent" &&
      typeof entry.tool_call_id === "string"
    ) {
      const args = parseJsonRecord(entry.arguments);
      if (typeof args?.allowed === "boolean") {
        invocations.set(entry.tool_call_id, args.allowed);
      }
      continue;
    }
    if (
      entry.role === "tool_call_result" &&
      typeof entry.tool_call_id === "string" &&
      entry.successful !== false
    ) {
      const decision = invocations.get(entry.tool_call_id);
      if (typeof decision !== "boolean") continue;
      const result = parseJsonRecord(entry.content);
      if (result?.recording_allowed === decision) {
        lastDecision = decision;
      }
    }
  }
  return lastDecision;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verifyAdminAuthorization(
  authorization: string | undefined,
  expectedUser: string,
  expectedPassword: string,
) {
  if (!authorization?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return (
    safeEqual(decoded.slice(0, separator), expectedUser) &&
    safeEqual(decoded.slice(separator + 1), expectedPassword)
  );
}

function mimeCode(contentType: string, sourceUrl: string) {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase();
  if (normalized === "audio/mpeg" || /\.mp3(?:$|\?)/i.test(sourceUrl)) return 2;
  if (normalized === "audio/mp4" || /\.m4a(?:$|\?)/i.test(sourceUrl)) return 3;
  if (normalized === "audio/ogg" || /\.ogg(?:$|\?)/i.test(sourceUrl)) return 4;
  return 1;
}

function mimeFromCode(code: number) {
  if (code === 2) return "audio/mpeg";
  if (code === 3) return "audio/mp4";
  if (code === 4) return "audio/ogg";
  return "audio/wav";
}

function allowedRecordingUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      (hostname.endsWith(".amazonaws.com") ||
        hostname.endsWith(".googleapis.com") ||
        hostname === "retellai.com" ||
        hostname.endsWith(".retellai.com"))
    );
  } catch {
    return false;
  }
}

function isSafeArchiveId(value: string) {
  return /^[a-f0-9]{40}$/.test(value);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export class RecordingArchive {
  private readonly directory: string;
  private readonly encryptionKey: Buffer | null;
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.directory = resolve(config.recordings.path);
    this.encryptionKey = config.recordings.encryptionKey
      ? Buffer.from(config.recordings.encryptionKey, "base64")
      : null;
  }

  get enabled() {
    return this.config.recordings.enabled;
  }

  private key() {
    if (!this.enabled || !this.encryptionKey) {
      throw new Error("Recording archive is not enabled");
    }
    return this.encryptionKey;
  }

  async initialize() {
    if (!this.enabled) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.cleanup();
    this.cleanupTimer = setInterval(() => {
      void this.cleanup().catch(() => undefined);
    }, RETENTION_CHECK_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  stop() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private archiveId(callId: string) {
    return createHmac("sha256", this.key())
      .update(callId)
      .digest("hex")
      .slice(0, 40);
  }

  private archivePath(id: string) {
    if (!isSafeArchiveId(id)) throw new Error("Invalid recording id");
    return resolve(this.directory, `${id}.ghr`);
  }

  private encrypt(audio: Buffer, contentType: string, sourceUrl: string) {
    const iv = randomBytes(IV_BYTES);
    const type = mimeCode(contentType, sourceUrl);
    const prefix = Buffer.concat([MAGIC, iv, Buffer.from([type])]);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(prefix);
    const ciphertext = Buffer.concat([cipher.update(audio), cipher.final()]);
    return Buffer.concat([prefix, cipher.getAuthTag(), ciphertext]);
  }

  private decrypt(encrypted: Buffer): { body: Buffer; contentType: string } {
    if (
      encrypted.byteLength < HEADER_BYTES ||
      !encrypted.subarray(0, MAGIC.byteLength).equals(MAGIC)
    ) {
      throw new Error("Recording file has an invalid format");
    }
    const ivStart = MAGIC.byteLength;
    const typeOffset = ivStart + IV_BYTES;
    const tagOffset = typeOffset + 1;
    const contentOffset = tagOffset + TAG_BYTES;
    const prefix = encrypted.subarray(0, typeOffset + 1);
    const iv = encrypted.subarray(ivStart, typeOffset);
    const tag = encrypted.subarray(tagOffset, contentOffset);
    const decipher = createDecipheriv("aes-256-gcm", this.key(), iv);
    decipher.setAAD(prefix);
    decipher.setAuthTag(tag);
    return {
      body: Buffer.concat([
        decipher.update(encrypted.subarray(contentOffset)),
        decipher.final(),
      ]),
      contentType: mimeFromCode(encrypted[typeOffset] ?? 1),
    };
  }

  private async exists(path: string) {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }

  async handleWebhook(payload: unknown) {
    const envelope = asRecord(payload);
    const call = asRecord(envelope?.call);
    if (envelope?.event !== "call_ended" || !call) {
      return { status: "ignored" as const };
    }
    if (
      typeof call.agent_id !== "string" ||
      call.agent_id !== this.config.retellAgentId
    ) {
      throw new Error("Recording webhook agent id does not match");
    }
    const consent = extractRecordingConsent(payload);
    if (consent !== true) {
      return { status: "not_consented" as const };
    }
    if (!this.enabled) {
      throw new Error("Recording archive is disabled");
    }
    if (
      typeof call.call_id !== "string" ||
      !allowedRecordingUrl(call.recording_url)
    ) {
      throw new Error("Recording webhook is missing a valid recording");
    }

    const id = this.archiveId(call.call_id);
    const destination = this.archivePath(id);
    if (await this.exists(destination)) {
      return { status: "already_archived" as const, id };
    }
    const response = await this.fetchImpl(call.recording_url, {
      headers: { Accept: "audio/*, application/octet-stream" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`Retell recording download failed (${response.status})`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.config.recordings.maxBytes
    ) {
      throw new Error("Retell recording exceeds the archive size limit");
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (
      audio.byteLength === 0 ||
      audio.byteLength > this.config.recordings.maxBytes
    ) {
      throw new Error("Retell recording has an invalid size");
    }
    const encrypted = this.encrypt(
      audio,
      response.headers.get("content-type") ?? "audio/wav",
      call.recording_url,
    );
    const temporary = `${destination}.${process.pid}.${randomBytes(4).toString(
      "hex",
    )}.tmp`;
    await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
    try {
      if (await this.exists(destination)) {
        await unlink(temporary);
        return { status: "already_archived" as const, id };
      }
      await rename(temporary, destination);
      const callEndedAt =
        typeof call.end_timestamp === "number" &&
        Number.isFinite(call.end_timestamp)
          ? new Date(call.end_timestamp)
          : new Date();
      await utimes(destination, callEndedAt, callEndedAt);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await this.cleanup();
    return { status: "archived" as const, id };
  }

  async cleanup(now = Date.now()) {
    if (!this.enabled) return 0;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const cutoff =
      now - this.config.recordings.retentionDays * 24 * 60 * 60 * 1_000;
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = resolve(this.directory, entry.name);
      const details = await stat(path);
      const isExpiredRecording =
        entry.name.endsWith(".ghr") && details.mtimeMs < cutoff;
      const isStaleTemporary =
        entry.name.endsWith(".tmp") &&
        details.mtimeMs < now - 60 * 60 * 1_000;
      if (isExpiredRecording || isStaleTemporary) {
        await unlink(path);
        removed += 1;
      }
    }
    return removed;
  }

  async list(): Promise<RecordingListItem[]> {
    if (!this.enabled) return [];
    await this.cleanup();
    const entries = await readdir(this.directory, { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            /^[a-f0-9]{40}\.ghr$/.test(entry.name),
        )
        .map(async (entry) => {
          const details = await stat(resolve(this.directory, entry.name));
          return {
            id: entry.name.slice(0, -4),
            recordedAt: details.mtime.toISOString(),
            expiresAt: new Date(
              details.mtimeMs +
                this.config.recordings.retentionDays * 24 * 60 * 60 * 1_000,
            ).toISOString(),
            encryptedBytes: details.size,
          };
        }),
    );
    return items.sort((left, right) =>
      right.recordedAt.localeCompare(left.recordedAt),
    );
  }

  async read(id: string): Promise<RecordingAudio | null> {
    if (!this.enabled || !isSafeArchiveId(id)) return null;
    await this.cleanup();
    const path = this.archivePath(id);
    try {
      const [encrypted, details] = await Promise.all([
        readFile(path),
        stat(path),
      ]);
      return {
        ...this.decrypt(encrypted),
        recordedAt: details.mtime.toISOString(),
      };
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  async delete(id: string) {
    if (!this.enabled || !isSafeArchiveId(id)) return false;
    try {
      await unlink(this.archivePath(id));
      return true;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }

  renderPage(items: RecordingListItem[]) {
    const recordings =
      items.length === 0
        ? `<section class="empty">
            <div class="empty-mark" aria-hidden="true"></div>
            <h2>Noch keine Aufnahmen</h2>
            <p>Nach einem Anruf mit ausdrücklicher Zustimmung erscheint die Aufnahme hier automatisch.</p>
          </section>`
        : items
            .map((item, index) => {
              const recorded = new Intl.DateTimeFormat("de-DE", {
                timeZone: "Europe/Berlin",
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(item.recordedAt));
              const expires = new Intl.DateTimeFormat("de-DE", {
                timeZone: "Europe/Berlin",
                dateStyle: "medium",
              }).format(new Date(item.expiresAt));
              return `<article class="recording">
                <div class="recording-index">${String(index + 1).padStart(2, "0")}</div>
                <div class="recording-main">
                  <div class="recording-meta">
                    <h2>${escapeHtml(recorded)}</h2>
                    <span>Löschung am ${escapeHtml(expires)}</span>
                  </div>
                  <audio controls preload="none" src="/recordings/audio/${escapeHtml(item.id)}">
                    Ihr Browser kann diese Aufnahme nicht abspielen.
                  </audio>
                </div>
              </article>`;
            })
            .join("");

    return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>Aufnahmen · Georg Haarstudio</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #12312e;
      --ink-soft: #526864;
      --porcelain: #edf1ef;
      --paper: #f8faf9;
      --copper: #c66f47;
      --blush: #d9aaa0;
      --line: #ccd6d2;
      --focus: #2b6f68;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--porcelain);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    a { color: inherit; }
    .shell {
      width: min(960px, calc(100% - 32px));
      margin: 0 auto;
      padding: 56px 0 80px;
    }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: 32px;
      padding-bottom: 28px;
      border-bottom: 1px solid var(--ink);
    }
    .eyebrow {
      margin: 0 0 12px;
      color: var(--copper);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: .16em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      max-width: 720px;
      font-family: "Avenir Next Condensed", "Arial Narrow", sans-serif;
      font-size: clamp(42px, 8vw, 86px);
      font-stretch: condensed;
      font-weight: 700;
      letter-spacing: -.045em;
      line-height: .88;
    }
    .retention {
      width: 112px;
      padding: 16px 0 4px;
      border-top: 8px solid var(--copper);
      text-align: right;
    }
    .retention strong {
      display: block;
      font-family: "Avenir Next Condensed", "Arial Narrow", sans-serif;
      font-size: 40px;
      letter-spacing: -.04em;
      line-height: 1;
    }
    .retention span {
      color: var(--ink-soft);
      font-size: 12px;
      line-height: 1.3;
    }
    .privacy-note {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      padding: 18px 0;
      color: var(--ink-soft);
      font-size: 13px;
      border-bottom: 1px solid var(--line);
    }
    .privacy-note strong { color: var(--ink); }
    .recordings { background: var(--paper); }
    .recording {
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr);
      min-height: 132px;
      border-bottom: 1px solid var(--line);
    }
    .recording-index {
      display: grid;
      place-items: center;
      color: var(--copper);
      font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
      font-size: 13px;
      border-right: 1px solid var(--line);
    }
    .recording-main {
      display: grid;
      grid-template-columns: minmax(180px, .8fr) minmax(280px, 1.2fr);
      align-items: center;
      gap: 28px;
      padding: 24px 28px;
    }
    .recording-meta h2 {
      margin: 0 0 7px;
      font-family: "Avenir Next Condensed", "Arial Narrow", sans-serif;
      font-size: 24px;
      letter-spacing: -.02em;
    }
    .recording-meta span {
      color: var(--ink-soft);
      font-size: 12px;
    }
    audio {
      width: 100%;
      height: 42px;
      accent-color: var(--copper);
    }
    .empty {
      min-height: 300px;
      display: grid;
      place-items: center;
      align-content: center;
      padding: 48px 24px;
      text-align: center;
      background: var(--paper);
    }
    .empty-mark {
      width: 88px;
      height: 32px;
      margin-bottom: 24px;
      background: repeating-linear-gradient(90deg, var(--copper) 0 3px, transparent 3px 9px);
      border-top: 2px solid var(--ink);
    }
    .empty h2 { margin: 0 0 8px; font-size: 22px; }
    .empty p { max-width: 430px; margin: 0; color: var(--ink-soft); line-height: 1.55; }
    footer {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      padding-top: 18px;
      color: var(--ink-soft);
      font-size: 12px;
    }
    :focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
    @media (max-width: 700px) {
      .shell { width: min(100% - 20px, 960px); padding-top: 28px; }
      header { grid-template-columns: 1fr; align-items: start; }
      .retention { text-align: left; }
      .privacy-note, footer { flex-direction: column; gap: 6px; }
      .recording { grid-template-columns: 42px minmax(0, 1fr); }
      .recording-main { grid-template-columns: 1fr; gap: 18px; padding: 20px 16px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <p class="eyebrow">Georg Haarstudio · Intern</p>
        <h1>Gesprächs&shy;aufnahmen</h1>
      </div>
      <div class="retention" aria-label="Speicherfrist ${this.config.recordings.retentionDays} Tage">
        <strong>${this.config.recordings.retentionDays}</strong>
        <span>Tage Speicherfrist</span>
      </div>
    </header>
    <section class="privacy-note" aria-label="Datenschutz">
      <span><strong>Nur mit Zustimmung.</strong> Keine Transkripte, Namen oder Telefonnummern.</span>
      <span>Verschlüsselt gespeichert · automatisch gelöscht</span>
    </section>
    <section class="recordings" aria-label="Aufnahmen">${recordings}</section>
    <footer>
      <span>Der Zugriff ist passwortgeschützt.</span>
      <span>Georg Haarstudio · Friedrichstal</span>
    </footer>
  </main>
</body>
</html>`;
  }
}
