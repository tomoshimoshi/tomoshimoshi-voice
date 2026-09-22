export type Locale = "en" | "es";
export type Status =
  "dialing" | "connected" | "waiting" | "completed" | "cancelled" | "failed";
export type Profile = {
  firstName: string;
  lastName: string;
  preferredName: string;
  age: string;
  sex: string;
  nationality: string;
  uiLanguage: Locale;
};
export type CallInput = {
  phone: string;
  objective: string;
  context: string;
  constraints: string;
  language: "ja" | "en" | "es";
  mode: "demo" | "live";
  shareProfile: boolean;
  scenario: "appointment" | "restaurant" | "inquiry" | "followup" | "custom";
};
export type Transcript = {
  id: string;
  role: "agent" | "recipient" | "user" | "system";
  original: string;
  translations: Partial<Record<Locale, string>>;
  at: string;
  interrupted?: boolean;
};
export type Question = {
  id: string;
  text: string;
  kind: "information" | "approval";
  answered?: string;
};
export type Call = CallInput & {
  id: string;
  status: Status;
  createdAt: string;
  endedAt?: string;
  billing?: {
    pricingVersionId: string;
    ratePerMinute: string;
    maxDurationSeconds: number;
    connectedAt: string | null;
    endedAt: string | null;
    durationSeconds: number | null;
    customerChargeJpy: string | null;
    status: "reserved" | "pending" | "settled";
  };
  transcript: Transcript[];
  question?: Question;
  result?: {
    outcome: "success" | "incomplete" | "cancelled" | "failed";
    summary: string;
    details: string[];
  };
  error?: string;
  uiLanguage: Locale;
};
export type Readiness = {
  ready: boolean;
  checks: { name: string; configured: boolean }[];
};
export const terminal = (status: Status) =>
  ["completed", "cancelled", "failed"].includes(status);
