import { testDatabase } from "./helpers/postgres";
import { randomUUID } from "node:crypto";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as settle } from "node:timers/promises";
import WebSocket from "ws";
import type { CallInput } from "../lib/types";
const dir = mkdtempSync(join(tmpdir(), "tomoshimoshi-engine-"));
process.env.CALLORI_DATA_DIR = dir;
const engine = await import("../server/engine");
const store = await import("../server/store");
const userId = await store.ensureUser({
  sub: "auth0|engine",
  email: "engine@example.test",
  emailVerified: true,
});
await store.saveProfile(
  { ...store.defaultProfile, firstName: "Test", lastName: "User" },
  userId,
);
beforeEach(async () => {
  const { credit } = await import("../server/wallet");
  await store.transaction((tx) =>
    credit(tx, userId, 5000n, {
      type: "fixture",
      id: randomUUID(),
      key: randomUUID(),
    }),
  );
  await testDatabase.query("UPDATE users SET last_call_at=NULL");
});
async function storedCall(id: string) {
  await engine.flushCall(id);
  return store.getCall(id);
}
const originalFetch = globalThis.fetch;
const requests: { url: string; body: Record<string, unknown> }[] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const body = JSON.parse((init?.body as string) || "{}");
  requests.push({ url, body });
  if (url === "https://api.telnyx.com/v2/calls")
    return Response.json({ data: { call_control_id: "test-control-id" } });
  if (url.startsWith("https://api.telnyx.com/v2/calls/"))
    return Response.json({ data: { result: "ok" } });
  if (url === "https://api.openai.com/v1/responses")
    return Response.json({
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify(body.text?.format?.name === "recipient_confirmation" ? { confirmed: true } : {
                en: "Translated text",
                es: "Texto traducido",
                ja: "翻訳されたテキスト",
              }),
            },
          ],
        },
      ],
    });
  throw new Error(`Unexpected network request: ${url}`);
};
after(async () => {
  for (const id of engine.sessions.keys())
    await engine.endCall(id, "cancelled");
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Record<string, any>[] = [];
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
  event(event: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }
}
const input: CallInput = {
  phone: "+81451234567",
  objective: "Book a dental appointment",
  context: "Existing patient.",
  constraints: "Wednesday after 4 PM. Ask before confirming.",
  mode: "live",
  language: "ja",
  shareProfile: false,
  scenario: "appointment",
};
Object.assign(process.env, {
  OPENAI_API_KEY: "test-only",
  TELNYX_API_KEY: "test-only",
  TELNYX_CONNECTION_ID: "test-connection",
  TELNYX_FROM_NUMBER: "+15555550100",
  TELNYX_PUBLIC_KEY: "test-only",
  PUBLIC_BASE_URL: "https://example.test",
  ALLOWED_PHONE_NUMBERS: input.phone,
  LIVE_CALLS_ENABLED: "true",
});
test("persistent state, concurrency guard, question correlation and cancellation", async () => {
  const c = await engine.createCall(input, randomUUID(), userId);
  assert.equal(c.status, "dialing");
  assert.equal((await storedCall(c.id))?.objective, input.objective);
  await assert.rejects(
    () => engine.createCall(input, randomUUID(), userId),
    /ACTIVE_CALL/,
  );
  engine.askUser(c.id, "Are you taking any medication?", "information");
  const q = (await storedCall(c.id))!.question!;
  assert.equal((await storedCall(c.id))?.status, "waiting");
  await assert.rejects(
    () => engine.answerUser(c.id, "wrong-question", "No"),
    /STALE_QUESTION/,
  );
  engine.sessions.get(c.id)!.ai = new FakeSocket() as unknown as WebSocket;
  await engine.answerUser(c.id, q.id, "I am not taking medication.");
  assert.equal((await storedCall(c.id))?.status, "connected");
  assert.equal(
    (await storedCall(c.id))?.question?.answered,
    "I am not taking medication.",
  );
  await assert.rejects(
    () => engine.answerUser(c.id, q.id, "Duplicate"),
    /STALE_QUESTION/,
  );
  await engine.endCall(c.id, "cancelled");
  assert.equal((await storedCall(c.id))?.status, "cancelled");
  assert.equal(engine.sessions.has(c.id), false);
  await assert.rejects(
    () => engine.answerUser(c.id, q.id, "Late"),
    /CALL_ENDED/,
  );
});

test("malformed Realtime audio cannot escape the callback and crash other calls", async () => {
  const call = await engine.createCall(input, randomUUID(), userId);
  const phone = new FakeSocket(), ai = new FakeSocket();
  engine.attachMedia(call.id, phone as unknown as WebSocket, () => ai as unknown as WebSocket);
  phone.event({event:"start",start:{call_control_id:"test-control-id",media_format:{encoding:"PCMU",sample_rate:8000}}});
  assert.doesNotThrow(() => ai.event({type:"response.output_audio.delta",item_id:"bad-audio",delta:{invalid:true}}));
  await engine.endCall(call.id, "failed");
  assert.equal((await storedCall(call.id))?.error, "PROVIDER_ERROR");
  assert.equal(engine.sessions.has(call.id), false);
});

test("pre-session media buffering is bounded by bytes as well as frame count", async () => {
  const call = await engine.createCall(input, randomUUID(), userId);
  const phone = new FakeSocket(), ai = new FakeSocket();
  engine.attachMedia(call.id, phone as unknown as WebSocket, () => ai as unknown as WebSocket);
  phone.event({event:"start",start:{call_control_id:"test-control-id",media_format:{encoding:"PCMU",sample_rate:8000}}});
  for (let i=0; i<3; i++) phone.event({event:"media",media:{track:"inbound",payload:"A".repeat(512*1024)}});
  await engine.endCall(call.id, "failed");
  assert.equal((await storedCall(call.id))?.error, "AUDIO_BACKPRESSURE");
  assert.equal(engine.sessions.has(call.id), false);
});
test("live bridge relays audio, asks the user, resumes the same session and completes", async () => {
  await store.saveProfile(
    {
      ...store.defaultProfile,
      firstName: "Never share this without consent",
      lastName: "User",
      uiLanguage: "es",
    },
    userId,
  );
  const c = await engine.createCall(
    { ...input, mode: "live", language: "en" },
    randomUUID(),
    userId,
  );
  const session = engine.sessions.get(c.id)!;
  const dial = requests.find(
    (x) => x.url === "https://api.telnyx.com/v2/calls",
  )!;
  assert.equal(dial.body.stream_bidirectional_mode, "rtp");
  assert.equal(dial.body.stream_codec, "PCMU");
  assert.equal(dial.body.time_limit_secs, 600);
  assert.ok(
    String(dial.body.stream_url).startsWith("wss://example.test/media/"),
  );
  assert.equal(engine.authorizeMedia(c.id, "forged"), false);
  assert.equal(engine.authorizeMedia(c.id, session.token), true);
  const phone = new FakeSocket(),
    ai = new FakeSocket();
  engine.attachMedia(
    c.id,
    phone as unknown as WebSocket,
    () => ai as unknown as WebSocket,
  );
  assert.equal(
    engine.authorizeMedia(c.id, session.token),
    false,
    "token cannot open a second media connection",
  );
  phone.event({
    event: "start",
    start: {
      call_control_id: "test-control-id",
      media_format: { encoding: "PCMU", sample_rate: 8000 },
    },
  });
  ai.emit("open");
  assert.equal(ai.sent[0].session.audio.input.format.type, "audio/pcmu");
  assert.equal(ai.sent[0].session.audio.output.format.type, "audio/pcmu");
  assert.ok(
    !ai.sent[0].session.instructions.includes(
      "Never share this without consent",
    ),
  );
  assert.equal(
    ai.sent[0].session.audio.input.turn_detection.create_response,
    false,
  );
  assert.equal(
    ai.sent[0].session.audio.input.noise_reduction.type,
    "near_field",
  );
  assert.match(ai.sent[0].session.instructions, /Speak ONLY English/);
  assert.match(
    ai.sent[0].session.instructions,
    /Those fields are private UI text/,
  );
  ai.event({ type: "session.updated" });
  ai.event({ type: "response.done", response: { output: [] } });
  await settle();
  const responseCount = () =>
    ai.sent.filter((x) => x.type === "response.create").length;
  const initialResponses = responseCount();
  ai.event({ type: "input_audio_buffer.committed", item_id: "turn-1" });
  ai.event({ type: "input_audio_buffer.committed", item_id: "turn-1" });
  assert.equal(
    responseCount(),
    initialResponses + 1,
    "one response per committed recipient turn",
  );
  const audioCount = ai.sent.filter(
    (x) => x.type === "input_audio_buffer.append",
  ).length;
  for (const track of ["outbound", "outbound_track", undefined]) {
    phone.event({ event: "media", media: { track, payload: "own-voice" } });
  }
  assert.equal(
    ai.sent.filter((x) => x.type === "input_audio_buffer.append").length,
    audioCount,
    "only inbound media reaches OpenAI",
  );
  phone.event({ event: "media", media: { track: "inbound", payload: "abcd" } });
  assert.equal(ai.sent.at(-1)?.audio, "abcd");
  ai.event({
    type: "response.output_audio.delta",
    item_id: "audio-1",
    delta: "abcd",
  });
  assert.deepEqual(phone.sent.at(-1), {
    event: "media",
    media: { payload: "abcd" },
  });
  ai.event({ type: "input_audio_buffer.speech_started" });
  assert.equal(phone.sent.at(-1)?.event, "clear");
  assert.equal(ai.sent.at(-1)?.type, "conversation.item.truncate");
  ai.event({ type: "input_audio_buffer.speech_stopped" });
  ai.event({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "水曜日でよろしいですか？",
  });
  await settle();
  await settle();
  assert.equal(
    (await storedCall(c.id))?.transcript[0].translations.es,
    "Texto traducido",
  );
  ai.event({
    type: "response.output_audio_transcript.done",
    item_id: "audio-1",
    transcript: "確認します。",
  });
  await settle();
  await settle();
  const agentLine = (await storedCall(c.id))!.transcript.find(
    (x) => x.id === "audio-1",
  )!;
  assert.equal(
    agentLine.translations.es,
    "Texto traducido",
    "agent translations use the stable provider item ID",
  );
  assert.equal(
    agentLine.interrupted,
    true,
    "late transcripts retain interruption status",
  );
  ai.event({
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "ask_user",
          call_id: "function-1",
          arguments: JSON.stringify({
            question: "Does Wednesday at 4:30 PM work?",
            kind: "approval",
          }),
        },
      ],
    },
  });
  await settle();
  const q = (await storedCall(c.id))!.question!;
  const waitingResponses = responseCount();
  for (let i = 0; i < 5; i++) {
    ai.event({ type: "input_audio_buffer.committed", item_id: `waiting-${i}` });
  }
  assert.equal(
    responseCount(),
    waitingResponses,
    "pending question suppresses repeated automatic replies",
  );
  assert.equal((await storedCall(c.id))?.status, "waiting");
  const pendingOutput = ai.sent.find(x => x.item?.call_id === "function-1");
  assert.ok(pendingOutput?.item.output.includes("pending"));
  assert.equal(ai.sent.at(-1)?.type, "response.create", "server creates the initial hold even when the tool turn had no speech");
  assert.match(ai.sent.at(-1)?.response.instructions, /One moment/);
  assert.deepEqual(ai.sent.at(-1)?.response.input, [], "hold speech cannot see or repeat the private question");
  ai.event({ type: "response.done", response: { output: [] } });
  await settle();
  assert.equal(ai.readyState, WebSocket.OPEN);
  assert.equal(phone.readyState, WebSocket.OPEN);
  const clockNow = Date.now;
  try {
    Date.now = () => clockNow() + 16000;
    ai.event({
      type: "input_audio_buffer.committed",
      item_id: "hello-while-waiting",
    });
    assert.equal(responseCount(), waitingResponses + 1);
    assert.equal(ai.sent.at(-1)?.response.tool_choice, "none");
    assert.match(ai.sent.at(-1)?.response.instructions, /Speak ONLY English/);
    ai.event({
      type: "input_audio_buffer.committed",
      item_id: "another-hold-turn",
    });
    assert.equal(
      responseCount(),
      waitingResponses + 1,
      "hold messages cannot overlap or repeat rapidly",
    );
  } finally {
    Date.now = clockNow;
  }
  // The private answer arrives before response.created; reservation must still prevent overlap.
  const before = ai.sent.length;
  await engine.answerUser(c.id, q.id, "No. Pregunta por el jueves.");
  assert.equal(
    ai.sent.length,
    before + 1,
    "do not create a competing response while the AI speaks",
  );
  assert.ok(
    ai.sent
      .at(-1)
      ?.item.content[0].text.includes("No. Pregunta por el jueves."),
  );
  assert.match(ai.sent.at(-1)?.item.content[0].text, /Speak ONLY English/);
  ai.event({ type: "response.done", response: { output: [] } });
  await settle();
  assert.equal(ai.sent.at(-1)?.type, "response.create");
  assert.match(ai.sent.at(-1)?.response.instructions, /Your only spoken audience is the telephone recipient/,
    "private answer instructions survive a queued response during hold speech");
  assert.match(ai.sent.at(-1)?.response.instructions, /Do not acknowledge the app answer/);
  assert.equal(ai.sent.at(-1)?.response.tool_choice, undefined, "normal tools remain available");
  assert.ok(
    !ai.sent.some((x) => JSON.stringify(x).includes("Texto traducido")),
    "display translations never enter the voice session",
  );
  const translation = requests.find(
    (x) => x.url === "https://api.openai.com/v1/responses",
  )!;
  assert.equal((translation.body.text as any).format.type, "json_schema");
  assert.deepEqual((translation.body.text as any).format.schema.required, [
    "en",
    "es",
    "ja",
  ]);
  assert.equal(
    (await storedCall(c.id))?.transcript.find((line) => line.translations.ja)
      ?.translations.ja,
    "翻訳されたテキスト",
  );
  assert.equal(engine.sessions.get(c.id)?.ai, ai);
  ai.event({ type: "input_audio_buffer.committed", item_id: "recipient-cannot-book-thursday" });
  ai.event({
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "finish_call",
          call_id: "finish-1",
          arguments: JSON.stringify({
            outcome: "incomplete",
            summary: "Thursday availability was not confirmed.",
            details: [],
          }),
        },
      ],
    },
  });
  await settle();
  assert.equal((await storedCall(c.id))?.result?.outcome, "incomplete");
  await engine.endCall(c.id, "completed");
  assert.equal((await storedCall(c.id))?.status, "completed");
  assert.equal(engine.sessions.has(c.id), false);
  const hangup = requests.find((x) => x.url.includes("/actions/hangup"))!;
  assert.notEqual(
    hangup.body.command_id,
    c.id,
    "hangup does not reuse the dial command id",
  );
});
test("restart recovery terminates persisted provider calls instead of silently resuming", async () => {
  const c = await engine.createCall(
    { ...input, mode: "live", language: "en" },
    randomUUID(),
    userId,
  );
  const s = engine.sessions.get(c.id)!;
  s.timers.forEach(clearTimeout);
  engine.sessions.delete(c.id);
  await engine.recoverCalls();
  assert.equal((await storedCall(c.id))?.status, "failed");
  assert.equal((await storedCall(c.id))?.error, "SERVER_RESTART");
  assert.equal(await store.getControl(c.id), undefined);
});
test("webhook and HTTP idempotency records survive duplicate delivery", async () => {
  assert.equal(await store.seenEvent("event-1"), false);
  assert.equal(await store.seenEvent("event-1"), true);
  const c = (await store.calls(userId))[0];
  const key = randomUUID();
  await testDatabase.query(
    "INSERT INTO requests(user_id,key,call_id) VALUES($1,$2,$3)",
    [userId, key, c.id],
  );
  assert.equal((await store.requestCall(key, userId))?.id, c.id);
});

test("cancellation waits for a pending dial and hangs up the late carrier response", async () => {
  const mockFetch = globalThis.fetch;
  let release!: (response: Response) => void;
  globalThis.fetch = async (url, init) =>
    String(url) === "https://api.telnyx.com/v2/calls"
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : mockFetch(url, init);
  try {
    const creating = engine.createCall(input, randomUUID(), userId);
    while (!release) await settle();
    const call = (await store.calls(userId))[0];
    const ending = engine.endCall(call.id, "cancelled");
    assert.equal(engine.sessions.get(call.id)?.stopping, true);
    assert.equal(
      engine.authorizeMedia(call.id, engine.sessions.get(call.id)!.token),
      false,
    );
    release(Response.json({ data: { call_control_id: "late-control" } }));
    await Promise.all([creating, ending]);
    assert.equal((await storedCall(call.id))?.status, "cancelled");
    assert.equal(engine.sessions.has(call.id), false);
    assert.ok(
      requests.some((x) => x.url.endsWith("/late-control/actions/hangup")),
    );
    assert.equal(await store.getControl(call.id), undefined);
  } finally {
    globalThis.fetch = mockFetch;
  }
});
test("failed recovery stays durable, blocks redial, and reuses the hangup command across retries", async () => {
  const call = await engine.createCall(input, randomUUID(), userId);
  const session = engine.sessions.get(call.id)!;
  session.timers.forEach(clearTimeout);
  engine.sessions.delete(call.id);
  const mockFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error("simulated carrier outage");
    };
    await engine.recoverCalls();
    assert.equal((await storedCall(call.id))?.status, "failed");
    assert.ok(await store.getControl(call.id));
    const command = await store.hangupCommand(call.id);
    assert.notEqual(command, call.id);
    await assert.rejects(
      () => engine.createCall(input, randomUUID(), userId),
      /RECOVERY_PENDING/,
    );
    globalThis.fetch = mockFetch;
    await engine.recoverOrphanedCalls();
    assert.equal(await store.getControl(call.id), undefined);
    assert.equal(requests.at(-1)?.body.command_id, command);
  } finally {
    globalThis.fetch = mockFetch;
  }
});
test("cancelled model responses cannot execute tools and terminal calls ignore queued tool work", async () => {
  const call = await engine.createCall(input, randomUUID(), userId);
  const phone = new FakeSocket(),
    ai = new FakeSocket();
  engine.attachMedia(
    call.id,
    phone as unknown as WebSocket,
    () => ai as unknown as WebSocket,
  );
  phone.event({
    event: "start",
    start: {
      call_control_id: "test-control-id",
      media_format: { encoding: "PCMU", sample_rate: 8000 },
    },
  });
  ai.emit("open");
  ai.event({ type: "session.updated" });
  const tool = {
    type: "function_call",
    name: "ask_user",
    call_id: "cancelled-tool",
    arguments: JSON.stringify({
      question: "Should this be ignored?",
      kind: "approval",
    }),
  };
  ai.event({
    type: "response.done",
    response: { status: "cancelled", output: [tool] },
  });
  await settle();
  assert.equal((await storedCall(call.id))?.question, undefined);
  ai.event({
    type: "response.done",
    response: {
      status: "completed",
      output: [{ ...tool, call_id: "late-tool" }],
    },
  });
  const ending = engine.endCall(call.id, "cancelled");
  await ending;
  await settle();
  assert.equal((await storedCall(call.id))?.question, undefined);
  assert.equal((await storedCall(call.id))?.status, "cancelled");
});

test("success requires a played readback and new recipient evidence; a goodbye interruption cancels hangup", async () => {
  const call = await engine.createCall({ ...input, language: "en" }, randomUUID(), userId);
  const phone = new FakeSocket(), ai = new FakeSocket();
  engine.attachMedia(call.id, phone as unknown as WebSocket, () => ai as unknown as WebSocket);
  phone.event({ event: "start", start: { call_control_id: "test-control-id", media_format: { encoding: "PCMU", sample_rate: 8000 } } });
  ai.emit("open"); ai.event({ type: "session.updated" });
  const done = (name: string, args: unknown) => ai.event({ type: "response.done", response: { status: "completed", output: [{ type: "function_call", name, arguments: JSON.stringify(args), call_id: randomUUID() }] } });
  const success = { outcome: "success", summary: "Appointment confirmed.", details: [], confirmation_quote: "Yes, confirmed for 10 AM." };
  done("finish_call", success);
  await settle();
  assert.equal((await storedCall(call.id))?.result, undefined, "cannot close on an invented reply");
  assert.ok(ai.sent.some(e => e.item?.output?.includes("RECIPIENT_CONFIRMATION_REQUIRED")));
  done("confirm_details", { question: "Can you confirm the cleaning on September 24 at 10 AM for Test User?" });
  await settle();
  assert.equal(ai.sent.at(-1)?.response.tool_choice, "none", "the readback turn cannot finish the call");
  ai.event({ type: "response.output_audio.delta", item_id: "readback", delta: "abcd" });
  ai.event({ type: "response.output_audio.done", item_id: "readback" });
  ai.event({ type: "response.done", response: { output: [] } });
  await settle();
  phone.event({ event: "mark", mark: { name: "readback" } });
  ai.event({ type: "input_audio_buffer.speech_started", item_id: "confirmation" });
  ai.event({ type: "input_audio_buffer.speech_stopped" });
  ai.event({ type: "input_audio_buffer.committed", item_id: "confirmation" });
  ai.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "confirmation", transcript: success.confirmation_quote });
  done("finish_call", success);
  await settle(); await settle();
  assert.equal((await storedCall(call.id))?.result?.outcome, "success");
  assert.equal(ai.sent.at(-1)?.response.tool_choice, "none", "only the server's goodbye is spoken after verification");
  assert.equal(phone.readyState, WebSocket.OPEN, "generation completion is not playback completion");
  ai.event({ type: "response.output_audio.delta", item_id: "goodbye", delta: "abcd" });
  ai.event({ type: "response.output_audio.done", item_id: "goodbye" });
  ai.event({ type: "response.done", response: { output: [] } });
  await settle();
  phone.event({ event: "mark", mark: { name: "goodbye" } });
  ai.event({ type: "input_audio_buffer.speech_started", item_id: "correction" });
  assert.equal(engine.sessions.get(call.id)?.finishing, false);
  assert.equal((await storedCall(call.id))?.result, undefined, "a correction during the goodbye grace period invalidates the result");
  await engine.endCall(call.id, "cancelled");
});

test("question timeout explains the unanswered wait before ending, and active snapshots remain owner scoped", async () => {
  const call = await engine.createCall({ ...input, language: "es" }, randomUUID(), userId);
  const phone = new FakeSocket(), ai = new FakeSocket();
  engine.attachMedia(call.id, phone as unknown as WebSocket, () => ai as unknown as WebSocket);
  phone.event({ event: "start", start: { call_control_id: "test-control-id", media_format: { encoding: "PCMU", sample_rate: 8000 } } });
  ai.emit("open"); ai.event({ type: "session.updated" });
  ai.event({ type: "response.done", response: { output: [] } });
  await settle();
  engine.askUser(call.id, "¿Te viene bien?", "approval");
  assert.equal(engine.liveCall(call.id, randomUUID()), undefined);
  const snapshot = engine.liveCall(call.id, userId)!;
  assert.equal(snapshot.status, "waiting");
  snapshot.question!.text = "mutation";
  assert.equal(engine.liveCall(call.id, userId)?.question?.text, "¿Te viene bien?");
  engine.sessions.get(call.id)!.expireQuestion!();
  assert.match(ai.sent.at(-1)?.response.instructions, /no he recibido su respuesta/);
  assert.equal(phone.readyState, WebSocket.OPEN);
  ai.event({ type: "response.output_audio.delta", item_id: "timeout-goodbye", delta: "abcd" });
  ai.event({ type: "response.output_audio.done", item_id: "timeout-goodbye" });
  ai.event({ type: "response.done", response: { output: [] } });
  await settle();
  phone.event({ event: "mark", mark: { name: "timeout-goodbye" } });
  await new Promise(resolve => setTimeout(resolve, 1400));
  assert.equal((await storedCall(call.id))?.error, "ANSWER_TIMEOUT");
  assert.equal((await storedCall(call.id))?.status, "failed");
});

for (const scenario of ["quoted differently", "no model quote", "late transcription", "negative reply", "cancelled while verifying", "correction while verifying"] as const) {
  test(`final confirmation uses recipient ASR: ${scenario}`, async () => {
    const call = await engine.createCall({ ...input, language: "es" }, randomUUID(), userId);
    const phone = new FakeSocket(), ai = new FakeSocket();
    engine.attachMedia(call.id, phone as unknown as WebSocket, () => ai as unknown as WebSocket);
    phone.event({ event: "start", start: { call_control_id: "test-control-id", media_format: { encoding: "PCMU", sample_rate: 8000 } } });
    ai.emit("open"); ai.event({ type: "session.updated" });
    const done = (name: string, args: unknown) => ai.event({ type: "response.done", response: { status: "completed", output: [{ type: "function_call", name, arguments: JSON.stringify(args), call_id: randomUUID() }] } });
    const question = "¿Queda reservada la limpieza dental para Test User el 24 de septiembre a las 14:00?";
    done("confirm_details", { question });
    await settle();
    ai.event({ type: "response.output_audio.delta", item_id: "readback", delta: "abcd" });
    ai.event({ type: "response.output_audio.done", item_id: "readback" });
    ai.event({ type: "response.done", response: { output: [] } });
    await settle();
    phone.event({ event: "mark", mark: { name: "readback" } });
    ai.event({ type: "input_audio_buffer.speech_started", item_id: "reply" });
    ai.event({ type: "input_audio_buffer.speech_stopped" });
    ai.event({ type: "input_audio_buffer.committed", item_id: "reply" });
    const reply = scenario === "negative reply" ? "Sí, pero no queda reservada hasta que pague." : "Sí.";
    const fetchBefore = globalThis.fetch;
    let release: (() => void) | undefined;
    let verificationCount = 0;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.text?.format?.name === "recipient_confirmation") {
        verificationCount++;
        assert.deepEqual(JSON.parse(body.input), { question, reply }, "verify the complete original, never the model's quote or UI translation");
        if (scenario.endsWith("while verifying")) await new Promise<void>(resolve => { release = resolve; });
        return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ confirmed: scenario !== "negative reply" }) }] }] });
      }
      return fetchBefore(url, init);
    };
    try {
      const transcribe = () => ai.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "reply", transcript: reply });
      if (scenario !== "late transcription") transcribe();
      const result = { outcome: "success", summary: "Reserva confirmada.", details: [] as string[],
        ...(scenario === "no model quote" ? {} : { confirmation_quote: "Yes" }) };
      done("finish_call", result);
      await settle();
      if (scenario === "late transcription") {
        assert.equal((await storedCall(call.id))?.result, undefined);
        assert.ok(!ai.sent.some(e => e.item?.output?.includes("RECIPIENT_CONFIRMATION_REQUIRED")), "wait silently for ASR instead of restarting readback");
        transcribe();
      }
      if (scenario === "cancelled while verifying") await engine.endCall(call.id, "cancelled");
      if (scenario === "correction while verifying") ai.event({ type: "input_audio_buffer.speech_started", item_id: "correction" });
      release?.();
      await settle(); await settle();
      const stored = await storedCall(call.id);
      if (scenario === "negative reply" || scenario.endsWith("while verifying")) {
        if (scenario === "cancelled while verifying") {
          assert.equal(stored?.status, "cancelled", "a user hangup is not agent success");
          assert.equal(stored?.result?.outcome, "cancelled");
        } else assert.equal(stored?.result, undefined);
      } else {
        assert.equal(stored?.result?.outcome, "success");
        assert.match(ai.sent.at(-1)?.response.instructions, /Gracias por su ayuda/);
        assert.ok(!ai.sent.some(e => e.item?.output?.includes("RECIPIENT_CONFIRMATION_REQUIRED")));
        assert.equal(phone.readyState, WebSocket.OPEN, "still wait for goodbye playback before hangup");
      }
      assert.equal(verificationCount, 1, "reuse ASR verification rather than checking a differently quoted reply twice");
    } finally {
      release?.();
      globalThis.fetch = fetchBefore;
      await engine.endCall(call.id, "cancelled");
    }
  });
}

test("a recipient rejection webhook wins over a media close and is idempotent", async () => {
  const c = await engine.createCall(input, randomUUID(), userId);
  const phone = new FakeSocket();
  engine.attachMedia(c.id, phone as unknown as WebSocket);
  phone.close();
  assert.equal(engine.sessions.get(c.id)?.stopping, undefined);
  const details = { cause: "call_rejected", source: "callee", sipCause: "603" };
  await engine.remoteHangup(c.id, details);
  await engine.remoteHangup(c.id, details);
  const result = await storedCall(c.id);
  assert.equal(result?.error, "RECIPIENT_REJECTED");
  assert.equal(result?.status, "failed");
  assert.equal(engine.sessions.has(c.id), false);
  assert.equal(await store.getControl(c.id), undefined);
});

test("a late signed reason corrects the media fallback without changing billing", async () => {
  const c = await engine.createCall(input, randomUUID(), userId);
  await engine.endCall(c.id, "failed", "CONNECTION_LOST");
  const before = await storedCall(c.id);
  await engine.remoteHangup(c.id, { cause: "user_busy", sipCause: "486" });
  const after = await storedCall(c.id);
  assert.equal(after?.error, "RECIPIENT_BUSY");
  assert.deepEqual(after?.billing, before?.billing);
  assert.equal(after?.endedAt, before?.endedAt);
});

test("a connected recipient hangup is incomplete, not a technical failure", async () => {
  const c = await engine.createCall(input, randomUUID(), userId);
  engine.update(c.id, call => { call.status = "connected"; });
  await engine.remoteHangup(c.id, { cause: "normal_clearing", source: "callee" });
  const result = await storedCall(c.id);
  assert.equal(result?.status, "completed");
  assert.equal(result?.result?.outcome, "incomplete");
  assert.equal(result?.error, "RECIPIENT_HUNG_UP");
});

for (const scenario of ["cancelled", "technical", "success"] as const) {
  test(`carrier reasons preserve ${scenario} outcomes`, async () => {
    await testDatabase.query("UPDATE users SET last_call_at=NULL");
    const c = await engine.createCall(input, randomUUID(), userId);
    if (scenario === "success") engine.update(c.id, call => {
      call.result = { outcome: "success", summary: "Booking confirmed", details: [] };
    });
    await engine.endCall(c.id, scenario === "cancelled" ? "cancelled" : scenario === "technical" ? "failed" : "completed", scenario === "technical" ? "PROVIDER_ERROR" : undefined);
    const before = await storedCall(c.id);
    await engine.remoteHangup(c.id, { cause: "normal_clearing", source: "callee" });
    assert.deepEqual(await storedCall(c.id), before);
  });
}

test("media stop without a carrier webhook still terminates and cleans up", async () => {
  const c = await engine.createCall(input, randomUUID(), userId);
  const phone = new FakeSocket();
  engine.attachMedia(c.id, phone as unknown as WebSocket);
  phone.event({ event: "stop" });
  await new Promise(resolve => setTimeout(resolve, 2200));
  const result = await storedCall(c.id);
  assert.equal(result?.error, "CONNECTION_LOST");
  assert.equal(result?.status, "failed");
  assert.equal(engine.sessions.has(c.id), false);
});

async function receptionCall() {
  const call = await engine.createCall({ ...input, language: "en" }, randomUUID(), userId);
  const phone = new FakeSocket(), ai = new FakeSocket();
  engine.attachMedia(call.id, phone as unknown as WebSocket, () => ai as unknown as WebSocket);
  phone.event({ event: "start", start: { call_control_id: "test-control-id", media_format: { encoding: "PCMU", sample_rate: 8000 } } });
  ai.emit("open");
  ai.event({ type: "session.updated" });
  const done = async (name?: string, args?: unknown) => {
    ai.event({ type: "response.done", response: { status: "completed", output: name
      ? [{ type: "function_call", name, arguments: JSON.stringify(args), call_id: randomUUID() }] : [] } });
    await settle();
    await settle();
  };
  const turn = (transcript: string) => {
    const item_id = randomUUID();
    ai.event({ type: "input_audio_buffer.speech_started", item_id });
    ai.event({ type: "input_audio_buffer.speech_stopped" });
    ai.event({ type: "input_audio_buffer.committed", item_id });
    ai.event({ type: "conversation.item.input_audio_transcription.completed", item_id, transcript });
  };
  const state = (state: string, message = "", details: string[] = []) =>
    done("handle_phone_system", { state, message, details });
  const responses = () => ai.sent.filter(event => event.type === "response.create");
  await done();
  return { call, phone, ai, done, turn, state, responses };
}

test("iPhone screening speaks the reason once, stays silent through announcements and reintroduces to the human", async () => {
  const { call, phone, ai, done, turn, state, responses } = await receptionCall();
  try {
    turn("Hi, if you record your name and reason for calling, I'll see if this person is available.");
    const reason = "I am ToMoshiMoshi, an AI assistant calling to ask about a dental cleaning appointment.";
    await state("screening", reason);
    assert.deepEqual(responses().at(-1)?.response.input, [], "screening audio cannot expose the full task or profile");
    assert.match(responses().at(-1)?.response.instructions, /calling to ask about a dental cleaning appointment/);
    assert.equal(responses().at(-1)?.response.tool_choice, "none");
    await done();
    const beforeSilence = responses().length;
    engine.sessions.get(call.id)!.requestResponse!("hold");
    assert.equal(responses().length, beforeSilence, "reminders cannot fill the screening silence");
    for (const announcement of ["Thanks.", "Please stay on the line.", "Please."]) {
      turn(announcement);
      assert.deepEqual(responses().at(-1)?.response.output_modalities, ["text"]);
      assert.deepEqual(responses().at(-1)?.response.tools.map((tool: { name: string }) => tool.name), ["handle_phone_system"]);
      const phoneEvents = phone.sent.length;
      ai.event({ type: "response.output_audio.delta", item_id: randomUUID(), delta: "abcd" });
      assert.equal(phone.sent.length, phoneEvents, "unexpected audio during classification is never played");
      const count = responses().length;
      await state("wait");
      assert.equal(responses().length, count, "the tool result must not trigger another spoken turn");
    }
    turn("Record your name and reason for calling.");
    const count = responses().length;
    await state("screening", reason);
    assert.equal(responses().length, count, "a repeated screening decision does not replay the reason");
    turn("Huh?");
    await state("human");
    assert.match(responses().at(-1)?.response.instructions, /They may not have heard the earlier introduction/);
    assert.match(responses().at(-1)?.response.instructions, /ask permission to continue/);
    assert.equal(responses().at(-1)?.response.output_modalities, undefined, "human conversation uses the session audio modality");
    await done();
    turn("Yes, how can I help?");
    assert.deepEqual(responses().at(-1), { type: "response.create" }, "normal conversation resumes after the new introduction");
    assert.equal((await storedCall(call.id))?.result, undefined);
  } finally {
    await engine.endCall(call.id, "cancelled");
  }
});

test("a business hold defers private answers and resumes without repeating the screening introduction", async () => {
  const { call, ai, done, turn, state, responses } = await receptionCall();
  try {
    turn("Good morning, dental clinic. How can I help?");
    assert.deepEqual(responses().at(-1), { type: "response.create" }, "ordinary business greeting keeps the normal audio flow");
    await done();
    const questionId = engine.askUser(call.id, "Would Friday work?", "approval")!;
    turn("Please hold while I check with my colleague.");
    await state("wait");
    const count = responses().length;
    await engine.answerUser(call.id, questionId, "Yes, Friday works.");
    assert.equal(responses().length, count, "a private answer does not speak over a business hold");
    assert.equal(engine.sessions.get(call.id)?.privateAnswerPending, true);
    turn("Thank you for holding. Would Friday work?");
    await state("human");
    assert.match(responses().at(-1)?.response.instructions, /returned from a hold\/transfer/);
    assert.match(responses().at(-1)?.response.instructions, /A private app answer arrived during the hold/);
    assert.equal(engine.sessions.get(call.id)?.privateAnswerPending, false, "the deferred answer is consumed in the first resumed turn");
    assert.doesNotMatch(responses().at(-1)?.response.instructions.split("NEXT TURN:")[1], /ask permission to continue/);
    await done();
    turn("Can you confirm Friday works?");
    assert.deepEqual(responses().at(-1), { type: "response.create" }, "the private answer is not delivered twice");
    assert.ok(ai.sent.some(event => event.item?.content?.some((part: { text?: string }) => part.text?.includes("Friday works"))));
  } finally {
    await engine.endCall(call.id, "cancelled");
  }
});

for (const recording of [
  { speech: "We are unavailable right now. Please call back after 5 PM.", summary: "No están disponibles. La grabación pide llamar después de las 17:00.", details: ["Llamar después de las 17:00."] },
  { speech: "Our office is closed today. Please call tomorrow.", summary: "El negocio está cerrado hoy y pide llamar mañana.", details: ["Llamar mañana."] },
  { speech: "Please leave your message after the tone.", summary: "Contestó un buzón de voz; no se dejó mensaje.", details: [] },
]) {
  test(`a terminal recording reports incomplete without voicemail, goodbye or redial: ${recording.speech}`, async () => {
    const { call, phone, turn, state, responses } = await receptionCall();
    turn(recording.speech);
    const count = responses().length;
    const dials = requests.filter(request => request.url === "https://api.telnyx.com/v2/calls").length;
    await state("unavailable", recording.summary, recording.details);
    assert.equal(responses().length, count, "no task details or goodbye are spoken into the recording");
    assert.equal(phone.readyState, WebSocket.CLOSED);
    const result = await storedCall(call.id);
    assert.equal(result?.status, "completed");
    assert.deepEqual(result?.result, { outcome: "incomplete", summary: recording.summary, details: recording.details });
    assert.equal(requests.filter(request => request.url === "https://api.telnyx.com/v2/calls").length, dials);
  });
}

test("screening cannot ask the user for decisions or treat an announcement as success", async () => {
  const { call, turn, state, done, ai } = await receptionCall();
  try {
    turn("Record your name and reason for calling.");
    await state("screening", "ToMoshiMoshi, an AI assistant calling about an appointment.");
    await done();
    turn("Thanks. Please stay on the line.");
    await done("ask_user", { question: "May I book it?", kind: "approval" });
    assert.equal((await storedCall(call.id))?.question, undefined);
    await done("finish_call", { outcome: "success", summary: "Booked", details: [] });
    assert.equal((await storedCall(call.id))?.result, undefined);
    assert.ok(ai.sent.some(event => event.item?.output?.includes("RECIPIENT_NOT_CONNECTED")));
  } finally {
    await engine.endCall(call.id, "cancelled");
  }
});

test("new human audio prevents a stale unavailable decision from ending the call", async () => {
  const { call, turn, state, done, ai } = await receptionCall();
  try {
    turn("Record your name and reason for calling.");
    await state("screening", "ToMoshiMoshi, an AI assistant calling about an appointment.");
    await done();
    turn("This person is not available.");
    turn("Hello, who is this?");
    await state("unavailable", "No disponible.");
    assert.equal(engine.sessions.has(call.id), true);
    assert.equal((await storedCall(call.id))?.result, undefined);
    assert.ok(ai.sent.some(event => event.item?.output?.includes("new_recipient_audio")));
    await state("human");
    assert.equal(engine.sessions.get(call.id)?.stopping, undefined);
  } finally {
    await engine.endCall(call.id, "cancelled");
  }
});

test("screening wait is bounded and repeated announcements cannot extend it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call, turn, state, done } = await receptionCall();
  try {
    turn("Record your name and reason for calling.");
    await state("screening", "ToMoshiMoshi, an AI assistant calling about an appointment.");
    await done();
    t.mock.timers.tick(60000);
    turn("Please stay on the line.");
    await state("wait");
    t.mock.timers.tick(60000);
    await settle();
    await settle();
    const result = await storedCall(call.id);
    assert.equal(result?.result?.outcome, "incomplete");
    assert.match(result?.result?.summary || "", /agotara la espera/);
    assert.equal(result?.status, "completed");
  } finally {
    await engine.endCall(call.id, "cancelled");
  }
});

test("a human joining cancels the screening deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call, turn, state, done } = await receptionCall();
  try {
    turn("Record your name and reason for calling.");
    await state("screening", "ToMoshiMoshi, an AI assistant calling about an appointment.");
    await done();
    t.mock.timers.tick(60000);
    turn("Hello?");
    await state("human");
    await done();
    t.mock.timers.tick(60000);
    await settle();
    assert.equal(engine.sessions.has(call.id), true, "the old screening timer cannot close a human conversation");
    assert.equal((await storedCall(call.id))?.result, undefined);
  } finally {
    await engine.endCall(call.id, "cancelled");
  }
});

test("successive transfers keep the same call and progress while orienting each new operator", async () => {
  const { call, phone, ai, turn, state, done, responses } = await receptionCall();
  const dials = requests.filter(request => request.url === "https://api.telnyx.com/v2/calls").length;
  try {
    for (const [announcement, greeting] of [
      ["I'll transfer you to appointments.", "Appointments, Maria speaking. What is the call about?"],
      ["I'll connect you with the dentist.", "Doctor Lee here. What date was offered?"],
    ]) {
      turn(announcement);
      const count = responses().length;
      await state("transfer");
      assert.equal(responses().length, count, "transfer does not start a goodbye or repeat the request");
      assert.equal(engine.sessions.get(call.id)?.socket, phone);
      assert.equal(engine.sessions.get(call.id)?.ai, ai);
      turn("Please stay on the line.");
      assert.deepEqual(responses().at(-1)?.response.output_modalities, ["text"]);
      await state("wait");
      turn(greeting);
      await state("human");
      const nextTurn = responses().at(-1)?.response.instructions.split("NEXT TURN:")[1];
      assert.match(nextTurn, /new operator/);
      assert.match(nextTurn, /only the needed context/);
      assert.match(nextTurn, /Preserve earlier progress and user approvals/);
      assert.match(nextTurn, /check the status of any potentially completed action/);
      await done();
      assert.equal((await storedCall(call.id))?.result, undefined);
    }
    const transcript = (await storedCall(call.id))!.transcript;
    assert.ok(transcript.some(line => line.original.includes("Maria speaking")), "previous operator context remains available");
    assert.ok(transcript.some(line => line.original.includes("Doctor Lee")));
    assert.equal(requests.filter(request => request.url === "https://api.telnyx.com/v2/calls").length, dials);
  } finally {
    await engine.endCall(call.id, "cancelled");
  }
});

for (const transition of ["transfer", "new_operator"] as const) {
  test(`${transition} invalidates a prior operator's readback before completion`, async () => {
    const { call, phone, ai, turn, state, done } = await receptionCall();
    try {
      await done("confirm_details", { question: "Is the dental cleaning booked for Friday at 4 PM?" });
      ai.event({ type: "response.output_audio.delta", item_id: "old-operator-readback", delta: "abcd" });
      ai.event({ type: "response.output_audio.done", item_id: "old-operator-readback" });
      await done();
      phone.event({ event: "mark", mark: { name: "old-operator-readback" } });
      const gate = engine.sessions.get(call.id)!.confirmation!;
      turn(transition === "transfer" ? "Let me transfer you to scheduling." : "This is Maria, I am taking over for my colleague.");
      assert.ok(gate.eligibleItemId, "the prior readback has a reply before the operator transition");
      const revision = gate.revision;
      await state(transition);
      assert.ok(gate.revision > revision);
      assert.equal(gate.eligibleItemId, undefined, "the old readback cannot confirm a new operator's result");
      if (transition === "transfer") {
        turn("Scheduling, can I help?");
        await state("human");
      }
      await done();
      turn("Yes.");
      await done("finish_call", { outcome: "success", summary: "Booked", details: [] });
      assert.equal((await storedCall(call.id))?.result, undefined, "requires a new final readback rather than a bare yes after handoff");
      assert.ok(ai.sent.some(event => event.item?.output?.includes("RECIPIENT_CONFIRMATION_REQUIRED")));
    } finally {
      await engine.endCall(call.id, "cancelled");
    }
  });
}

test("non-addressed audio yields silently without turning the conversation into a timed hold", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call, turn, state, responses } = await receptionCall();
  try {
    turn("Maria, could you check the appointment book for me?");
    const count = responses().length;
    await state("listen");
    assert.equal(responses().length, count, "listening does not trigger a follow-up response");
    t.mock.timers.tick(180000);
    await settle();
    assert.equal(engine.sessions.has(call.id), true, "background speech does not arm a recipient-hold deadline");
    turn("Sorry about that, what day would you like?");
    assert.deepEqual(responses().at(-1), { type: "response.create" }, "direct speech resumes the ongoing conversation without an introduction");
  } finally {
    await engine.endCall(call.id, "cancelled");
  }
});

test("a request to repeat interrupts playback and cancelled speech cannot perform an action", async () => {
  const { call, phone, ai, turn, done, responses } = await receptionCall();
  try {
    turn("What day would you like?");
    ai.event({ type: "response.output_audio.delta", item_id: "interrupted-preference", delta: "abcd" });
    turn("Sorry, I couldn't hear the date. Could you repeat just the day?");
    assert.ok(phone.sent.some(event => event.event === "clear"));
    assert.ok(ai.sent.some(event => event.type === "conversation.item.truncate" && event.item_id === "interrupted-preference"));
    const count = phone.sent.filter(event => event.event === "media").length;
    ai.event({ type: "response.output_audio.delta", item_id: "interrupted-preference", delta: "abcd" });
    assert.equal(phone.sent.filter(event => event.event === "media").length, count, "late audio cannot continue the interrupted speech");
    ai.event({ type: "response.done", response: { status: "cancelled", output: [{
      type: "function_call", name: "finish_call", call_id: randomUUID(),
      arguments: JSON.stringify({ outcome: "incomplete", summary: "Couldn't hear", details: [] }),
    }] } });
    await settle();
    assert.equal((await storedCall(call.id))?.result, undefined, "a hearing repair does not imply refusal or a disconnected call");
    assert.deepEqual(responses().at(-1), { type: "response.create" }, "the latest request to repeat receives the next turn");
    await done();
    assert.equal(engine.sessions.get(call.id)?.socket, phone);
  } finally {
    await engine.endCall(call.id, "cancelled");
  }
});
