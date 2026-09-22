import { test, after } from "node:test";
import assert from "node:assert/strict";
import { hangup } from "../server/providers";
const original = globalThis.fetch;
after(() => {
  globalThis.fetch = original;
});
test("a failed hangup succeeds only when carrier status explicitly says inactive", async () => {
  const urls: string[] = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    return init?.method === "POST"
      ? Response.json({ errors: [] }, { status: 422 })
      : Response.json({ data: { is_alive: false } });
  };
  await hangup("fixture/control", "unique-command");
  assert.ok(urls[0].endsWith("/fixture%2Fcontrol/actions/hangup"));
  assert.ok(urls[1].endsWith("/fixture%2Fcontrol"));
});
test("active or unknown carrier state is never treated as successful hangup", async () => {
  for (const data of [{ is_alive: true }, {}]) {
    globalThis.fetch = async (_url, init) =>
      init?.method === "POST"
        ? Response.json({}, { status: 503 })
        : Response.json({ data });
    await assert.rejects(() => hangup("fixture", "unique-command"));
  }
});
