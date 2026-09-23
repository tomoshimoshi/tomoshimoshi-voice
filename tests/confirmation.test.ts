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
  assert.equal(gate.evidence(transcript, transcript[0].original), false);
  readback(gate);
  assert.equal(gate.evidence(transcript, transcript[0].original), false, "silence after the readback is not consent");
});
test("success needs a full matching utterance that STARTED after playback", () => {
  const gate = new ConfirmationGate();
  gate.begin(); gate.audio("readback"); gate.speechStarted("early");
  gate.played("readback"); gate.commit("early");
  assert.equal(gate.evidence([line("early")], line("early").original), false);
  reply(gate, "new");
  assert.equal(gate.evidence([], line("new").original), false, "late ASR has not supplied evidence yet");
  assert.equal(gate.evidence([line("new")], "Yes"), false, "a fragment can hide a later qualification");
  assert.equal(gate.evidence([line("new", "agent")], line("new").original), false);
  assert.equal(gate.evidence([line("new")], line("new").original), true);
  reply(gate, "correction");
  assert.equal(gate.evidence([line("new"), line("correction", "recipient", "Actually, no.")], line("new").original), false);
});
test("an interrupted readback or new user answer invalidates confirmation", () => {
  for (const reset of [(g: ConfirmationGate) => g.interrupt("readback"), (g: ConfirmationGate) => g.reset()]) {
    const gate = new ConfirmationGate(); readback(gate); reset(gate);
    gate.played("readback"); // clear flushes queued marks too
    reply(gate, "reply");
    assert.equal(gate.evidence([line("reply")], line("reply").original), false);
  }
});

test("multiple audio parts require playback of the final part", () => {
  const gate = new ConfirmationGate();
  gate.begin(); gate.audio("first"); gate.played("first");
  gate.speechStarted("between-parts");
  gate.audio("second"); gate.played("first"); gate.played("second");
  gate.commit("between-parts");
  assert.equal(gate.evidence([line("between-parts")], line("between-parts").original), false);
  reply(gate, "after-all-parts");
  assert.equal(gate.evidence([line("after-all-parts")], line("after-all-parts").original), true);
});
