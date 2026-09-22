import type { Profile } from "./types";
export const defaultProfile: Profile = {
  firstName: "",
  lastName: "",
  preferredName: "",
  age: "",
  sex: "",
  nationality: "",
  uiLanguage: "en",
};
export function profileComplete(profile: Profile) {
  return !!profile.firstName.trim() && !!profile.lastName.trim();
}
