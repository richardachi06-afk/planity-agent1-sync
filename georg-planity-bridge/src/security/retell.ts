import { createHmac, timingSafeEqual } from "node:crypto";

type RetellSecurityOptions = {
  apiKey?: string;
  allowUnsigned: boolean;
  bridgeToken?: string;
  providedBridgeToken?: string;
  expectedAgentId?: string;
  requestAgentId?: string;
};

function constantTimeStringEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verifyRetellRequest(
  rawBody: Buffer,
  signature: string | undefined,
  options: RetellSecurityOptions,
) {
  if (options.apiKey && signature) {
    const match = /^v=(\d+),d=([a-f0-9]+)$/i.exec(signature);
    if (match?.[1] && match[2]) {
      const timestamp = Number(match[1]);
      if (
        Number.isFinite(timestamp) &&
        Math.abs(Date.now() - timestamp) <= 300_000
      ) {
        const expected = createHmac("sha256", options.apiKey)
          .update(`${rawBody.toString("utf8")}${timestamp}`)
          .digest();
        const supplied = Buffer.from(match[2], "hex");
        if (
          supplied.byteLength === expected.byteLength &&
          timingSafeEqual(supplied, expected)
        ) {
          return true;
        }
      }
    }
  }

  if (
    options.bridgeToken &&
    options.providedBridgeToken &&
    options.expectedAgentId &&
    options.requestAgentId &&
    constantTimeStringEqual(options.bridgeToken, options.providedBridgeToken) &&
    constantTimeStringEqual(options.expectedAgentId, options.requestAgentId)
  ) {
    return true;
  }

  return options.allowUnsigned && !signature && !options.providedBridgeToken;
}

export function parseRawJson(rawBody: Buffer): unknown {
  if (rawBody.byteLength === 0) throw new Error("Request body is empty");
  return JSON.parse(rawBody.toString("utf8")) as unknown;
}

export function unwrapRetellArgs(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  return record.args && typeof record.args === "object" ? record.args : record;
}

export function getCallId(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const call = (payload as Record<string, unknown>).call;
  if (!call || typeof call !== "object" || Array.isArray(call)) return undefined;
  const callId = (call as Record<string, unknown>).call_id;
  return typeof callId === "string" ? callId : undefined;
}

export function getAgentId(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const call = (payload as Record<string, unknown>).call;
  if (!call || typeof call !== "object" || Array.isArray(call)) return undefined;
  const agentId = (call as Record<string, unknown>).agent_id;
  return typeof agentId === "string" ? agentId : undefined;
}
