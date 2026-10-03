import { appointmentCategoryCopy } from "./appointment-categories";
import type { CallInput, Locale, Profile } from "./types";
import {
  callingCountries,
  defaultCallingCountry,
  destinationPhone,
  type CallingCountry,
} from "./phone";
export type Purpose =
  "appointment" | "restaurant" | "inquiry" | "followup" | "custom";
export type DateOption = { date: string; from: string; to: string };
export type CallPlan = {
  purpose: Purpose;
  category: string;
  reason: string;
  patient: string;
  business: string;
  businessAddress: string;
  phone: string;
  country: CallingCountry;
  language: CallInput["language"];
  shareProfile: boolean;
  canFillJapaneseForms: boolean | null;
  notes: string;
  reference: string;
  people: number;
  dates: DateOption[];
  confirmFirst: boolean;
};
export const purposeLabels = {
  en: {
    appointment: "Book an appointment",
    restaurant: "Reserve a table",
    inquiry: "Ask for information",
    followup: "Follow up",
    custom: "Something else",
  },
  es: {
    appointment: "Pedir una cita",
    restaurant: "Reservar una mesa",
    inquiry: "Pedir informes",
    followup: "Hacer seguimiento",
    custom: "Otra llamada",
  },

  ja: {
    appointment: "予約をする",
    restaurant: "席を予約する",
    inquiry: "問い合わせる",
    followup: "経過を確認する",
    custom: "その他",
  },
};
export function fullName(profile: Pick<Profile, "firstName" | "lastName">) {
  return [profile.firstName.trim(), profile.lastName.trim()]
    .filter(Boolean)
    .join(" ");
}
export function newPlan(purpose: Purpose = "appointment"): CallPlan {
  return {
    purpose,
    category: "",
    reason: "",
    patient: "",
    business: "",
    businessAddress: "",
    phone: "",
    country: defaultCallingCountry,
    language: "ja",
    shareProfile: true,
    canFillJapaneseForms: null,
    notes: "",
    reference: "",
    people: 2,
    dates: [],
    confirmFirst: true,
  };
}
export function needsDates(purpose: Purpose) {
  return purpose === "appointment" || purpose === "restaurant";
}
export function needsJapaneseForms(plan: Pick<CallPlan, "purpose" | "category">) {
  return plan.purpose === "appointment" &&
    appointmentCategoryCopy(plan.category, "en")?.service === "health";
}
export function callTitle(
  plan: Pick<CallPlan, "purpose" | "category">,
  locale: Locale,
) {
  if (plan.purpose !== "appointment")
    return purposeLabels[locale][plan.purpose];
  return (
    appointmentCategoryCopy(plan.category, locale)?.title ||
    (locale === "ja"
      ? "通話の準備が進んでいます"
      : locale === "es"
        ? "Tu llamada toma forma"
        : "Your call, taking shape")
  );
}

export function formatDateOption(d: DateOption, locale: Locale) {
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
    new Date(`${d.date}T12:00:00`),
  );
  const time =
    d.from && d.to
      ? `${d.from} – ${d.to}`
      : d.from
        ? `${locale === "ja" ? "開始" : locale === "es" ? "Desde" : "From"} ${d.from}`
        : d.to
          ? `${locale === "ja" ? "終了" : locale === "es" ? "Hasta" : "Until"} ${d.to}`
          : locale === "ja"
            ? "時間指定なし"
            : locale === "es"
              ? "Cualquier hora"
              : "Any time";
  return `${date} · ${time}`;
}
export function buildCallInput(plan: CallPlan, locale: Locale): CallInput {
  const timezone = callingCountries.find(
    (country) => country.code === plan.country,
  )!.timezone;
  const objective =
    plan.purpose === "appointment"
      ? `${appointmentCategoryCopy(plan.category, locale)?.request || purposeLabels[locale].appointment}: ${plan.reason.trim()}`
      : plan.purpose === "restaurant"
        ? locale === "ja"
          ? `${plan.people}名分の席を予約する。`
          : locale === "es"
            ? `Reservar una mesa para ${plan.people} personas.`
            : `Reserve a table for ${plan.people} people.`
        : `${purposeLabels[locale][plan.purpose]}: ${plan.reason.trim()}`;
  const context = [
    plan.business.trim() && `Business/recipient: ${plan.business.trim()}`,
    plan.businessAddress.trim() &&
      `Business address: ${plan.businessAddress.trim()}`,
    plan.purpose === "appointment" &&
      plan.patient &&
      `Existing patient/customer: ${plan.patient}`,
    needsJapaneseForms(plan) &&
      (plan.canFillJapaneseForms === true
        ? "Japanese clinic forms: the user can complete intake forms in Japanese independently. If the clinic asks, use this answer. This does not establish spoken Japanese ability."
        : plan.canFillJapaneseForms === false
          ? "Japanese clinic forms: the user needs help completing intake forms in Japanese. If the clinic asks, explain this and ask what assistance or alternative-language forms are available. Do not promise that the user will bring an interpreter."
          : "Japanese clinic forms: the user's ability is not specified. If the clinic asks, ask the app user privately before answering; do not assume their ability."),
    plan.purpose === "followup" &&
      plan.reference.trim() &&
      `Case/order/appointment reference: ${plan.reference.trim()}`,
    plan.notes.trim() && `Additional details from user: ${plan.notes.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
  const dates = needsDates(plan.purpose)
    ? plan.dates.filter((x) => x.date)
    : [];
  const constraints = [
    ...(needsDates(plan.purpose)
      ? [
          dates.length
            ? `Acceptable date options (YYYY-MM-DD, local time in ${timezone}):\n${dates.map((x) => `${x.date}: ${x.from ? `from ${x.from}` : "any time"}${x.to ? ` until ${x.to}` : ""}`).join("\n")}\nThese are alternatives, not multiple bookings. Ask the user before accepting any other date or time.`
            : "No availability was supplied. Ask the recipient for options, then ask the app user which works. Do not invent availability.",
        ]
      : []),
    plan.confirmFirst || !dates.length || !needsDates(plan.purpose)
      ? "Ask the app user before confirming a booking or any change. Information gathering is allowed."
      : "You may confirm one booking within the supplied date/time options. Report the exact confirmed date, time and timezone.",
    "Always ask the app user before accepting fees, purchases or cancellation charges.",
  ].join("\n");
  return {
    phone: destinationPhone(plan.phone, plan.country)?.number || "",
    objective,
    context,
    constraints,
    language: plan.language,
    shareProfile: plan.shareProfile,
    mode: "live",
    scenario: plan.purpose,
  };
}
