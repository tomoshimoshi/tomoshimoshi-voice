import { createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { isSupportedDestination } from "../lib/phone";
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function verifyWebhook(
  raw: string,
  timestamp: string,
  signature: string,
  key: string,
  now = Date.now(),
) {
  try {
    if (
      !/^\d+$/.test(timestamp) ||
      Math.abs(now / 1000 - Number(timestamp)) > 300
    )
      return false;
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(key, "base64"),
      ]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(`${timestamp}|${raw}`),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}
export function readiness() {
  const keys = [
    "OPENAI_API_KEY",
    "TELNYX_API_KEY",
    "TELNYX_CONNECTION_ID",
    "TELNYX_FROM_NUMBER",
    "TELNYX_PUBLIC_KEY",
    "PUBLIC_BASE_URL",
    "ALLOWED_PHONE_NUMBERS",
  ];
  const checks = keys.map((name) => ({
    name,
    configured: !!process.env[name]?.trim(),
  }));
  checks.push({
    name: "LIVE_CALLS_ENABLED",
    configured: process.env.LIVE_CALLS_ENABLED === "true",
  });
  checks.push({
    name: "HTTPS_CALLBACK",
    configured: !!process.env.PUBLIC_BASE_URL?.match(/^https:\/\/[^/]+\/?$/),
  });
  return { ready: checks.every((x) => x.configured), checks };
}

export function isNumberAllowed(
  phone: string,
  allowed = process.env.ALLOWED_PHONE_NUMBERS || "",
) {
  if (!isSupportedDestination(phone)) return false;
  const destinations = allowed.split(",").map((value) => value.trim());
  return destinations.includes("*") || destinations.includes(phone);
}
