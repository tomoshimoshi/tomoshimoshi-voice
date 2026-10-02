import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import WebSocket from "ws";

export const listenProtocol = "tomoshimoshi-listen";
const ticketLifetime = 30_000;
const maxBufferedBytes = 128 * 1024;

/** One optional, read-only subscriber per call. No audio history is retained. */
export class CallListener {
  private grant?: { digest: Buffer; expires: number };
  private socket?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private closed = false;

  issue(now = Date.now()) {
    if (this.closed) throw new Error("CALL_ENDED");
    const ticket = randomBytes(32).toString("base64url");
    this.grant = { digest: this.digest(ticket), expires: now + ticketLifetime };
    return { ticket, expiresAt: now + ticketLifetime };
  }

  consume(ticket: string, now = Date.now()) {
    const grant = this.grant;
    if (this.closed || !grant || grant.expires <= now || !/^[\w-]{43}$/.test(ticket)) return false;
    if (!timingSafeEqual(grant.digest, this.digest(ticket))) return false;
    this.grant = undefined;
    return true;
  }

  attach(socket: WebSocket) {
    if (this.closed) { socket.terminate(); return; }
    this.detach();
    this.socket = socket;
    let alive = true;
    socket.on("pong", () => { alive = true; });
    // The listening channel never accepts microphone audio or call controls.
    socket.on("message", () => this.detach(socket));
    socket.on("error", () => this.detach(socket));
    socket.on("close", () => this.detach(socket));
    this.heartbeat = setInterval(() => {
      if (!alive) { this.detach(socket); return; }
      alive = false;
      try { socket.ping(); } catch { this.detach(socket); }
    }, 30_000);
    this.heartbeat.unref();
  }

  audio(track: "recipient" | "agent", payload: string | Buffer) {
    // Skip decoding, allocations and sends entirely when nobody is listening.
    if (!this.available()) return;
    const bytes = typeof payload === "string" ? Buffer.from(payload, "base64") : payload;
    if (!bytes.length) return;
    if (bytes.length > maxBufferedBytes) { this.detach(); return; }
    const packet = Buffer.allocUnsafe(bytes.length + 1);
    packet[0] = track === "recipient" ? 0 : 1;
    bytes.copy(packet, 1);
    this.send(packet);
  }

  clearAgent() { this.send("clear"); }

  close() {
    this.closed = true;
    this.grant = undefined;
    this.detach();
  }

  private digest(ticket: string) { return createHash("sha256").update(ticket).digest(); }

  private available() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > maxBufferedBytes) { this.detach(socket); return false; }
    return true;
  }

  private send(data: string | Buffer) {
    if (!this.available()) return;
    const socket = this.socket!;
    try { socket.send(data, error => { if (error) this.detach(socket); }); }
    catch { this.detach(socket); }
  }

  private detach(socket = this.socket) {
    if (!socket || socket !== this.socket) return;
    this.socket = undefined;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    socket.terminate();
  }
}

/** Tickets travel in a subprotocol header, never in logged URL query strings. */
export function listenTicket(protocols: string | undefined, origin: string | undefined) {
  if (!origin || origin !== process.env.APP_BASE_URL) return;
  const values = protocols?.split(",").map(value => value.trim());
  if (values?.length !== 2 || values[0] !== listenProtocol || !/^ticket\.[\w-]{43}$/.test(values[1])) return;
  return values[1].slice(7);
}
