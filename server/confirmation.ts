// Temporal evidence, independent of model instructions. Transcription arrival order
// is not speech order: only committed recipient item IDs can satisfy this gate.
export class ConfirmationGate {
  question = "";
  revision = 0;
  get latestItemId() {
    return this.turns.at(-1);
  }
  get eligibleItemId() {
    const latest = this.latestItemId;
    return latest && this.eligible.has(latest) ? latest : undefined;
  }
  private turns: string[] = [];
  private checkpoint?: { item?: string; played: boolean };
  private eligible = new Set<string>();
  private startedAfterPlayback = new Set<string>();
  speechStarted(itemId: string) {
    if (this.checkpoint?.played) this.startedAfterPlayback.add(itemId);
  }
  commit(itemId: string) {
    if (this.turns.includes(itemId)) return;
    this.turns.push(itemId);
    if (this.checkpoint?.played && this.startedAfterPlayback.has(itemId)) this.eligible.add(itemId);
  }
  reset() {
    this.revision++;
    this.checkpoint = undefined;
    this.eligible.clear();
    this.startedAfterPlayback.clear();
  }
  begin(question = "") {
    this.reset();
    this.question = question;
    this.checkpoint = { played: false };
  }
  audio(itemId: string) {
    if (this.checkpoint && this.checkpoint.item !== itemId) {
      // A response can contain several audio messages. Wait for the LAST one,
      // and invalidate speech that started between two parts of the readback.
      this.checkpoint.item = itemId;
      this.checkpoint.played = false;
      this.eligible.clear();
      this.startedAfterPlayback.clear();
    }
  }
  played(itemId: string) {
    if (this.checkpoint?.item === itemId) this.checkpoint.played = true;
  }
  interrupt(itemId: string) {
    if (this.checkpoint?.item === itemId) this.reset();
  }
  latestEvidence(transcript: { id: string; role: string; original: string }[]) {
    const latest = this.eligibleItemId;
    // The ASR item is authoritative. Requiring the voice model to reproduce its
    // punctuation/wording rejects valid replies even after semantic verification.
    return latest ? transcript.find(line => line.id === latest &&
      line.role === "recipient" && line.original.trim()) : undefined;
  }
}
