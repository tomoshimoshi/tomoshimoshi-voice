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
