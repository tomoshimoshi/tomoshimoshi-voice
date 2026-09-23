import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCallInput, fullName, newPlan } from "../lib/call-plan";
import { callSchema, profileSchema } from "../lib/validation";
import { instructions } from "../server/providers";
import type { Call, Profile } from "../lib/types";

test("appointment wizard preserves reason, patient status, date alternatives, local times and consent", () => {
  const plan = {
    ...newPlan("appointment"),
    category: "dentist",
    reason: "Limpieza dental",
    phone: "+817012345678",
    patient: "yes",
    dates: [
      { date: "2026-10-01", from: "16:00", to: "18:00" },
      { date: "2026-10-03", from: "", to: "" },
    ],
  };
  const call = buildCallInput(plan, "es");
  assert.ok(callSchema.safeParse(call).success);
  assert.equal(
    call.objective,
    "Pedir una cita con el dentista: Limpieza dental",
  );
  assert.match(call.context, /Existing patient\/customer: yes/);
  assert.match(call.constraints, /2026-10-01: from 16:00 until 18:00/);
  assert.match(call.constraints, /2026-10-03: any time/);
  assert.match(call.constraints, /Asia\/Tokyo/);
  assert.match(call.constraints, /alternatives, not multiple bookings/);
  assert.match(call.constraints, /Ask the app user before confirming/);
  assert.equal(call.mode, "live");
  assert.match(
    buildCallInput({ ...plan, confirmFirst: false }, "es").constraints,
    /may confirm one booking/,
  );
});
test("skipping dates never grants open-ended booking permission", () => {
  const call = buildCallInput(
    { ...newPlan("appointment"), confirmFirst: false },
    "en",
  );
  assert.match(call.constraints, /Do not invent availability/);
  assert.match(call.constraints, /Ask the app user before confirming/);
});
test("inquiry and follow-up briefs avoid appointment questions and retain reference data", () => {
  for (const purpose of ["inquiry", "followup"] as const) {
    const call = buildCallInput(
      {
        ...newPlan(purpose),
        phone: "+817012345678",
        reason: "Check the refund status",
        reference: "ORDER-42",
        dates: [{ date: "2026-10-01", from: "", to: "" }],
      },
      "en",
    );
    assert.ok(callSchema.safeParse(call).success);
    assert.doesNotMatch(call.constraints, /availability|2026-10-01/);
    assert.equal(call.scenario, purpose);
    if (purpose === "followup") assert.match(call.context, /ORDER-42/);
  }
});
test("full identity preserves every given name and surname and never substitutes a nickname", () => {
  const profile: Profile = {
    firstName: "Leonel David",
    lastName: "Castañeda Mendoza",
    preferredName: "Leo",
    age: "",
    sex: "",
    nationality: "",
    uiLanguage: "es",
  };
  assert.equal(fullName(profile), "Leonel David Castañeda Mendoza");
  const call = {
    ...buildCallInput(newPlan(), "es"),
    id: "test",
    status: "connected",
    createdAt: "",
    transcript: [],
    uiLanguage: "es",
    shareProfile: true,
  } as Call;
  const prompt = instructions(call, profile);
  assert.match(prompt, /"fullName":"Leonel David Castañeda Mendoza"/);
  assert.match(prompt, /NEVER substitute it for the given names/);
  assert.doesNotMatch(
    instructions({ ...call, shareProfile: false }, profile),
    /Leonel David|Castañeda Mendoza|"preferredName":"Leo"/,
  );
});

test("Japanese interface preferences are accepted and private prompts stay separate from spoken language", () => {
  const profile = profileSchema.parse({
    firstName: "太郎",
    lastName: "山田",
    preferredName: "",
    age: "",
    sex: "",
    nationality: "",
    uiLanguage: "ja",
  });
  const call: Call = {
    ...buildCallInput({ ...newPlan(), language: "en" }, "ja"),
    id: "test",
    status: "connected",
    createdAt: "",
    transcript: [],
    uiLanguage: profile.uiLanguage,
  };
  const prompt = instructions(call, profile);
  assert.match(prompt, /Speak ONLY English on the telephone/);
  assert.match(prompt, /ask_user question and finish_call summary\/details use Japanese/);
});
