import { localeIndex } from "./types";
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
export const categoryLabels = {
  en: {
    dentist: "Dentist",
    doctor: "Doctor",
    beauty: "Beauty & wellness",
    other: "Another service",
  },
  es: {
    dentist: "Dentista",
    doctor: "Médico",
    beauty: "Belleza y bienestar",
    other: "Otro servicio",
  },

  ja: {
    dentist: "歯科",
    doctor: "医療機関",
    beauty: "美容・ウェルネス",
    other: "その他のサービス",
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
    shareProfile: false,
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
export function callTitle(
  plan: Pick<CallPlan, "purpose" | "category">,
  locale: Locale,
) {
  if (plan.purpose !== "appointment")
    return purposeLabels[locale][plan.purpose];
  const titles: Record<string, [string, string, string]> = {
    dentist: [
      "Booking a dentist appointment",
      "Una cita con el dentista",
      "歯科の予約",
    ],
    doctor: [
      "Booking a doctor’s appointment",
      "Una cita con el médico",
      "医療機関の予約",
    ],
    beauty: [
      "Booking a little time for you",
      "Un momento para ti",
      "自分のための時間を予約",
    ],
    other: ["Booking your appointment", "Tu próxima cita", "次の予約"],
  };
  return (
    titles[plan.category]?.[localeIndex(locale)] ||
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
  const appointmentRequest: Record<string, [string, string, string]> = {
    dentist: [
      "Book a dentist appointment",
      "Pedir una cita con el dentista",
      "歯科を予約する",
    ],
    doctor: [
      "Book a doctor’s appointment",
      "Pedir una cita con el médico",
      "医療機関を予約する",
    ],
    beauty: [
      "Book a beauty or wellness appointment",
      "Pedir una cita de belleza y bienestar",
      "美容・ウェルネスの予約をする",
    ],
  };
  const objective =
    plan.purpose === "appointment"
      ? `${appointmentRequest[plan.category]?.[localeIndex(locale)] || purposeLabels[locale].appointment}: ${plan.reason.trim()}`
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
