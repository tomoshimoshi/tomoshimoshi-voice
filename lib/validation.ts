import { z } from "zod";
import { isSupportedDestination } from "./phone";
export const callSchema = z
  .object({
    phone: z
      .string()
      .trim()
      .refine(
        isSupportedDestination,
        "Use a valid number in a supported calling country (currently Japan, +81).",
      ),
    objective: z.string().trim().min(5).max(1500),
    context: z.string().trim().max(4000).default(""),
    constraints: z.string().trim().max(2000).default(""),
    language: z.enum(["ja", "en", "es"]),
    mode: z.literal("live"),
    shareProfile: z.boolean(),
    scenario: z
      .enum(["appointment", "restaurant", "inquiry", "followup", "custom"])
      .default("appointment"),
  })
  .strict();
export const profileSchema = z
  .object({
    firstName: z.string().trim().max(100),
    lastName: z.string().trim().max(100),
    preferredName: z.string().trim().max(100),
    age: z
      .string()
      .refine((x) => x === "" || (/^\d{1,3}$/.test(x) && Number(x) <= 120)),
    sex: z.enum(["", "female", "male", "intersex", "prefer-not-to-say"]),
    nationality: z.string().trim().max(100),
    uiLanguage: z.enum(["en", "es"]),
  })
  .strict();
export const answerSchema = z
  .object({
    questionId: z.string().uuid(),
    answer: z.string().trim().min(1).max(2000),
  })
  .strict();

export const contactSchema = z
  .object({
    placeId: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_-]+$/),
    country: z.literal("JP"),
  })
  .strict();
