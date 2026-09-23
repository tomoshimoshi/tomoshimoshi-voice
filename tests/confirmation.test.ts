import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfirmationGate } from "../server/confirmation";
const line = (id: string, role = "recipient", original = "Yes, confirmed for 10 AM.") => ({ id, role, original });
function readback(gate: ConfirmationGate) { gate.begin(); gate.audio("readback"); gate.played("readback"); }
function reply(gate: ConfirmationGate, id: string) { gate.speechStarted(id); gate.commit(id); }
test("the reported failure: earlier availability and a private answer cannot confirm a booking", () => {
  const gate = new ConfirmationGate();
  reply(gate, "offered-time");
  gate.reset(); // private answer
  const transcript = [line("offered-time"), line("answer", "user")];
  assert.equal(!!gate.latestEvidence(transcript), false);
  readback(gate);
  assert.equal(!!gate.latestEvidence(transcript), false, "silence after the readback is not consent");
});
test("success needs a full matching utterance that STARTED after playback", () => {
  const gate = new ConfirmationGate();
  gate.begin(); gate.audio("readback"); gate.speechStarted("early");
  gate.played("readback"); gate.commit("early");
  assert.equal(!!gate.latestEvidence([line("early")]), false);
  reply(gate, "new");
  assert.equal(!!gate.latestEvidence([]), false, "late ASR has not supplied evidence yet");
  assert.equal(gate.latestEvidence([line("new", "recipient", "Yes, but at 3 PM.")])?.original, "Yes, but at 3 PM.", "the verifier receives the ENTIRE reply, including qualifications");
  assert.equal(!!gate.latestEvidence([line("new", "agent")]), false);
  assert.equal(!!gate.latestEvidence([line("new")]), true);
  reply(gate, "correction");
  assert.equal(gate.latestEvidence([line("new"), line("correction", "recipient", "Actually, no.")])?.original, "Actually, no.");
});
test("an interrupted readback or new user answer invalidates confirmation", () => {
  for (const reset of [(g: ConfirmationGate) => g.interrupt("readback"), (g: ConfirmationGate) => g.reset()]) {
    const gate = new ConfirmationGate(); readback(gate); reset(gate);
    gate.played("readback"); // clear flushes queued marks too
    reply(gate, "reply");
    assert.equal(!!gate.latestEvidence([line("reply")]), false);
  }
});

test("multiple audio parts require playback of the final part", () => {
  const gate = new ConfirmationGate();
  gate.begin(); gate.audio("first"); gate.played("first");
  gate.speechStarted("between-parts");
  gate.audio("second"); gate.played("first"); gate.played("second");
  gate.commit("between-parts");
  assert.equal(!!gate.latestEvidence([line("between-parts")]), false);
  reply(gate, "after-all-parts");
  assert.equal(!!gate.latestEvidence([line("after-all-parts")]), true);
});
