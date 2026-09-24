export type HangupDetails = {
  cause?: string;
  source?: string;
  sipCause?: string;
};

/** Carrier evidence only: a rejected route is not necessarily a rejected recipient. */
export function hangupReason(details: HangupDetails, connected: boolean): string {
  const cause = details.cause?.toLowerCase();
  const source = details.source?.toLowerCase();
  const sip = details.sipCause;
  if (cause === "user_busy" || sip === "486" || sip === "600") return "RECIPIENT_BUSY";
  if (cause === "call_rejected" || sip === "603")
    return source === "callee" || (sip === "603" && source !== "caller")
      ? "RECIPIENT_REJECTED" : "CALL_REJECTED";
  if (cause === "no_answer" || (!connected && (cause === "timeout" || sip === "408")))
    return "NO_ANSWER";
  if (cause === "not_found" || sip === "404" || sip === "410") return "NUMBER_UNREACHABLE";
  if (cause === "time_limit") return "TIME_LIMIT";
  if (connected && cause === "normal_clearing" && source === "callee")
    return "RECIPIENT_HUNG_UP";
  return "CALL_ENDED_UNKNOWN";
}

export function hangupStatus(reason: string) {
  return reason === "RECIPIENT_HUNG_UP" || reason === "CALL_ENDED_UNKNOWN"
    ? "completed" as const : "failed" as const;
}
