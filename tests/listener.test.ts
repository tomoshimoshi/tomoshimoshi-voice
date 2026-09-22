import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceListener } from "../server/listener";

test("voice listener keeps local defaults and accepts the platform port and container interface", () => {
  assert.deepEqual(voiceListener({}), { host: "127.0.0.1", port: 3001 });
  assert.deepEqual(voiceListener({ VOICE_PORT: "4001" }), {
    host: "127.0.0.1",
    port: 4001,
  });
  assert.deepEqual(
    voiceListener({ PORT: "8080", VOICE_PORT: "3001", VOICE_HOST: "0.0.0.0" }),
    { host: "0.0.0.0", port: 8080 },
  );
});

test("an invalid hosting port fails instead of silently listening on an unreachable fallback", () => {
  for (const port of ["0", "-1", "65536", "3001.5", "NaN", "0xBB9"]) {
    assert.throws(() => voiceListener({ PORT: port, VOICE_PORT: "3001" }), /PORT/);
    assert.throws(() => voiceListener({ VOICE_PORT: port }), /PORT/);
  }
});
