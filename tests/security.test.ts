import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  verifyWebhook,
  safeEqual,
  readiness,
  isNumberAllowed,
} from "../server/security";
import { callSchema, profileSchema } from "../lib/validation";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const key = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64");
test("accepts authentic webhooks and rejects forgery, tampering and stale/future replay", () => {
  const raw = '{"data":{"id":"event-1"}}';
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = sign(
    null,
    Buffer.from(`${ts}|${raw}`),
    privateKey,
  ).toString("base64");
  assert.equal(verifyWebhook(raw, ts, signature, key), true);
  assert.equal(verifyWebhook(raw + " ", ts, signature, key), false);
  assert.equal(verifyWebhook(raw, ts, "forged", key), false);
  assert.equal(
    verifyWebhook(raw, ts, signature, key, Number(ts) * 1000 + 301000),
    false,
  );
  assert.equal(
    verifyWebhook(raw, ts, signature, key, Number(ts) * 1000 - 301000),
    false,
  );
  assert.equal(verifyWebhook(raw, "NaN", signature, key), false);
});
test("live calling fails closed without credentials", () => {
  assert.equal(readiness().ready, false);
  assert.ok(readiness().checks.every((c) => typeof c.configured === "boolean"));
});
test("validates numbers, bounded objectives, unknown fields and profile data", () => {
  const input = {
    phone: "+81451234567",
    objective: "Book a dental appointment",
    context: "",
    constraints: "",
    mode: "live",
    language: "ja",
    shareProfile: false,
  };
  assert.equal(callSchema.safeParse(input).success, true);
  assert.equal(callSchema.safeParse({ ...input, mode: "demo" }).success, false);
  for (const phone of [
    "119",
    "911",
    "0451234567",
    "sip:test@example.com",
    "+123",
    "+1;rm -rf /",
  ])
    assert.equal(callSchema.safeParse({ ...input, phone }).success, false);
  assert.equal(
    callSchema.safeParse({ ...input, objective: "a".repeat(1501) }).success,
    false,
  );
  assert.equal(
    callSchema.safeParse({ ...input, apiKey: "unexpected" }).success,
    false,
  );
  assert.equal(
    profileSchema.safeParse({
      firstName: "Test",
      lastName: "",
      preferredName: "",
      age: "121",
      sex: "",
      nationality: "",
      uiLanguage: "en",
    }).success,
    false,
  );
});
test("compares internal credentials without length exceptions", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "ab"), false);
  assert.equal(safeEqual("abc", "abd"), false);
});

test("destination policy restricts wildcard and exact allowlists to supported countries", () => {
  assert.equal(isNumberAllowed("+81451234567", "*"), true);
  assert.equal(isNumberAllowed("+14155550123", " * "), false);
  assert.equal(isNumberAllowed("+14155550123", "+14155550123"), false);
  assert.equal(
    isNumberAllowed("+81451234567", " +81451234567, +14155550123"),
    true,
  );
  assert.equal(isNumberAllowed("+81451234567", "+81451234568"), false);
  assert.equal(isNumberAllowed("+81451234567", ""), false);
  assert.equal(isNumberAllowed("+81451234567", "+81*"), false);
});
