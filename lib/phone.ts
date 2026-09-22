import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/max";

// Product rollout list. Add countries deliberately, with dialing tests and
// verified carrier permissions; the same list protects the API and the form.
export const callingCountries = [
  {
    code: "JP",
    prefix: "+81",
    name: { en: "Japan", es: "Japón" },
    example: "070-1234-5678",
    timezone: "Asia/Tokyo",
  },
] as const satisfies readonly {
  code: CountryCode;
  prefix: string;
  name: { en: string; es: string };
  example: string;
  timezone: string;
}[];
export type CallingCountry = (typeof callingCountries)[number]["code"];
export const defaultCallingCountry: CallingCountry = "JP";

export function destinationPhone(
  input: string,
  country: CallingCountry = defaultCallingCountry,
) {
  if (
    !callingCountries.some((item) => item.code === country) ||
    input.length > 64
  )
    return;
  const value = input.normalize("NFKC").trim();
  // No extensions, prose, short codes or carrier-selection prefixes.
  if (!/^\+?[\d\s().-]+$/.test(value)) return;
  const number = parsePhoneNumberFromString(value, {
    defaultCountry: country,
    extract: false,
  });
  if (!number || number.country !== country || number.ext || !number.isValid())
    return;
  return number;
}

export function isSupportedDestination(input: string) {
  if (!/^\+[1-9]\d{7,14}$/.test(input)) return false;
  return callingCountries.some(
    ({ code }) => destinationPhone(input, code)?.number === input,
  );
}

export function phoneNumberPart(
  input: string,
  country: CallingCountry = defaultCallingCountry,
) {
  const number = destinationPhone(input, country);
  return number
    ? number.formatInternational().slice(number.countryCallingCode.length + 2)
    : input;
}
