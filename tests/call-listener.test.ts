import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { CallListener, listenProtocol, listenTicket } from "../server/call-listener";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: (string | Buffer)[] = [];
  fail = false;
  send(data: string | Buffer, callback?: (error?: Error) => void) {
    if (this.fail) throw new Error("offline");
    this.sent.push(data);
    callback?.();
  }
  ping() {}
  terminate() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
}
const channels: CallListener[] = [];
afterEach(() => channels.splice(0).forEach(channel => channel.close()));
function channel() { const result = new CallListener(); channels.push(result); return result; }
function attach(target: CallListener) { const socket = new Socket(); target.attach(socket as unknown as WebSocket); return socket; }

test("listen grants are random, short-lived, replaced and single-use", () => {
  const target = channel();
  const first = target.issue(1000), next = target.issue(1000);
  assert.notEqual(first.ticket, next.ticket);
  assert.equal(next.expiresAt, 31_000);
  assert.equal(target.consume(first.ticket, 1001), false);
  assert.equal(target.consume("x".repeat(43), 1001), false);
  assert.equal(target.consume(next.ticket, 1001), true);
  assert.equal(target.consume(next.ticket, 1001), false);
  const expired = target.issue(1000);
  assert.equal(target.consume(expired.ticket, 31_000), false);
  target.close();
  assert.equal(target.consume(expired.ticket, 1001), false);
  assert.throws(() => target.issue(), /CALL_ENDED/);
});

test("handshake requires the canonical origin and exactly the listen and ticket protocols", () => {
  process.env.APP_BASE_URL = "https://www.tomoshimoshi.com";
  const token = "a".repeat(43), protocols = `${listenProtocol}, ticket.${token}`;
  assert.equal(listenTicket(protocols, process.env.APP_BASE_URL), token);
  for (const origin of [undefined, "null", "https://attacker.test", "https://www.tomoshimoshi.com.attacker.test"])
    assert.equal(listenTicket(protocols, origin), undefined);
  for (const header of [undefined, "ticket." + token, protocols + ", extra", `${listenProtocol}, ticket.short`])
    assert.equal(listenTicket(header, process.env.APP_BASE_URL), undefined);
});

test("binary PCMU preserves both tracks; clear removes only pending agent audio", () => {
  const target = channel(), socket = attach(target);
  target.audio("recipient", Buffer.from([0xff, 0x7f]).toString("base64"));
  target.audio("agent", Buffer.from([0, 128]));
  target.clearAgent();
  assert.deepEqual(socket.sent, [Buffer.from([0, 255, 127]), Buffer.from([1, 0, 128]), "clear"]);
});

test("only one listener is retained and a disconnected listener receives no history", () => {
  const target = channel(), old = attach(target), next = attach(target);
  assert.equal(old.readyState, WebSocket.CLOSED);
  target.audio("recipient", "abcd");
  assert.equal(old.sent.length, 0);
  assert.equal(next.sent.length, 1);
  next.emit("close");
  target.audio("recipient", "abcd");
  const later = attach(target);
  assert.equal(later.sent.length, 0);
});

test("slow, failed and writing listeners are isolated without throwing into the call", () => {
  const target = channel(), slow = attach(target);
  slow.bufferedAmount = 128 * 1024 + 1;
  assert.doesNotThrow(() => target.audio("recipient", "abcd"));
  assert.equal(slow.readyState, WebSocket.CLOSED);
  assert.equal(slow.sent.length, 0);
  const failed = attach(target); failed.fail = true;
  assert.doesNotThrow(() => target.audio("agent", "abcd"));
  assert.equal(failed.readyState, WebSocket.CLOSED);
  const writer = attach(target); writer.emit("message", "microphone");
  assert.equal(writer.readyState, WebSocket.CLOSED);
  assert.doesNotThrow(() => target.audio("recipient", "abcd"));
});
