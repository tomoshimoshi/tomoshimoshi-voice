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

test("confirmation verification uses a bounded structured decision and fails closed", async () => {
  const { confirmationIsExplicit } = await import("../server/providers");
  for (const value of [{ confirmed: true }, { confirmed: false }, {}, { confirmed: "true" }]) {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.text.format.name, "recipient_confirmation");
      assert.equal(body.store, false);
      assert.ok(init?.signal);
      assert.equal(JSON.parse(body.input).reply, "Hello.");
      return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
    };
    assert.equal(await confirmationIsExplicit("Is it booked?", "Hello."), value.confirmed === true);
  }
  globalThis.fetch = async () => Response.json({}, { status: 503 });
  await assert.rejects(() => confirmationIsExplicit("Is it booked?", "Yes."), /CONFIRMATION_CHECK_UNAVAILABLE/);
});
