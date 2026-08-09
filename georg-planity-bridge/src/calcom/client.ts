import { normalizeText } from "../planity/catalog.js";

type CalEventType = {
  id: number;
  title: string;
  slug: string;
  lengthInMinutes?: number;
};

type CalComClientOptions = {
  apiKey?: string;
  eventTypesVersion: string;
  bookingsVersion: string;
  fetchImpl?: typeof fetch;
};

export class CalComClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CalComClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listEventTypes(): Promise<CalEventType[]> {
    if (!this.options.apiKey) return [];
    const response = await this.fetchImpl(
      "https://api.cal.com/v2/event-types?take=100",
      {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "cal-api-version": this.options.eventTypesVersion,
        },
        signal: AbortSignal.timeout(12_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Cal.com event type request failed with ${response.status}`);
    }
    const payload = (await response.json()) as {
      status: string;
      data?: CalEventType[];
    };
    return payload.status === "success" && Array.isArray(payload.data)
      ? payload.data
      : [];
  }

  async findEventTypeId(serviceName: string) {
    const expected = normalizeText(serviceName);
    const events = await this.listEventTypes();
    return events.find((event) => normalizeText(event.title) === expected)?.id ?? null;
  }

  async createMirrorBooking(input: {
    eventTypeId: number;
    startUtc: string;
    name: string;
    email: string;
    phone: string;
    metadata: Record<string, string>;
  }) {
    if (!this.options.apiKey) throw new Error("CAL_API_KEY is not configured");
    const response = await this.fetchImpl("https://api.cal.com/v2/bookings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        "cal-api-version": this.options.bookingsVersion,
      },
      body: JSON.stringify({
        start: input.startUtc,
        eventTypeId: input.eventTypeId,
        attendee: {
          name: input.name,
          email: input.email,
          phoneNumber: input.phone,
          timeZone: "Europe/Berlin",
          language: "de",
        },
        metadata: input.metadata,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Cal.com mirror booking failed with ${response.status}`);
    }
    return response.json() as Promise<unknown>;
  }
}
