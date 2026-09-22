import test from "node:test";
import assert from "node:assert/strict";
import {
  destinationPhone,
  isSupportedDestination,
  phoneNumberPart,
  type CallingCountry,
} from "../lib/phone";
import { buildCallInput, newPlan } from "../lib/call-plan";
import { callSchema } from "../lib/validation";

test("Japan input normalizes local, international and full-width numbers without duplicating the prefix", () => {
  for (const value of [
    "07012345678",
    "070-1234-5678",
    "70 1234 5678",
    "+81 70 1234 5678",
    "+81 (0)70-1234-5678",
    "０７０－１２３４－５６７８",
  ]) {
    assert.equal(destinationPhone(value)?.number, "+817012345678", value);
    assert.equal(destinationPhone(value)?.formatNational(), "070-1234-5678");
    assert.equal(phoneNumberPart(value), "70 1234 5678");
    assert.equal(
      destinationPhone(phoneNumberPart(value))?.number,
      "+817012345678",
    );
  }
  assert.equal(destinationPhone("03-1234-5678")?.number, "+81312345678");
  assert.equal(phoneNumberPart("03-1234-5678"), "3 1234 5678");
  assert.equal(
    destinationPhone("045-123-4567")?.formatNational(),
    "045-123-4567",
  );
  assert.equal(destinationPhone("050-1234-5678")?.number, "+815012345678");
});

test("unsupported countries, short codes, extensions and malformed numbers cannot become destinations", () => {
  for (const value of [
    "",
    "119",
    "110",
    "12345678",
    "0701234",
    "070123456789",
    "+14155550123",
    "+525512345678",
    "+442079460018",
    "tel:07012345678",
    "07012345678 ext 1",
    "07012345678;123",
    "call 07012345678",
    "+81".repeat(30),
  ]) {
    assert.equal(destinationPhone(value), undefined, value);
    assert.equal(phoneNumberPart(value), value);
  }
  assert.equal(
    destinationPhone("+14155550123", "US" as CallingCountry),
    undefined,
  );
  assert.equal(isSupportedDestination("+8107012345678"), false);
  assert.equal(isSupportedDestination("07012345678"), false);
  assert.equal(isSupportedDestination("+817012345678"), true);
});

test("wizard compiles canonical Japan numbers and the API rejects bypasses", () => {
  const plan = {
    ...newPlan("inquiry"),
    reason: "Ask about opening hours",
    phone: "070-1234-5678",
  };
  const input = buildCallInput(plan, "en");
  assert.equal(input.phone, "+817012345678");
  assert.equal(callSchema.safeParse(input).success, true);
  for (const phone of [
    "+14155550123",
    "+525512345678",
    "+8107012345678",
    "07012345678",
    "+8170123",
  ]) {
    assert.equal(
      callSchema.safeParse({ ...input, phone }).success,
      false,
      phone,
    );
  }
  assert.equal(
    buildCallInput({ ...plan, phone: "+14155550123" }, "en").phone,
    "",
  );
});
