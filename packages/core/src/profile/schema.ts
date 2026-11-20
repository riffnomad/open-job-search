/**
 * profile.yaml: the short, structured part of the profile. The deep
 * experience lives in roles/*.md and past-lives/*.md (see role-file.ts).
 *
 * Everything has a default so a new or half-filled profile still loads;
 * `reviewProfile` (later) tells the user what's missing.
 */
import { z } from "zod";
import { PartialDate } from "./dates.ts";

const yearMonth = PartialDate;
const year = PartialDate;

export const LANGUAGE_LEVELS = ["native", "fluent", "professional", "conversational", "basic"] as const;

export const WORK_STATUSES = ["citizen", "settled", "visa", "needs-sponsorship"] as const;

export const Basics = z.object({
  name: z.string().optional(),
  headline: z.string().optional(),
  location: z.string().optional(),
  email: z.email().optional(),
  phone: z.string().optional(),
  links: z.array(z.object({ label: z.string(), url: z.url() })).default([]),
});

export const Eligibility = z.object({
  /** Where the user may work, and on what basis. */
  workAuthorization: z
    .array(
      z.object({
        country: z.string().min(1),
        status: z.enum(WORK_STATUSES),
        visaType: z.string().optional(), // e.g. "Skilled Worker", "Graduate", "Student"
        expires: yearMonth.optional(),
      }),
    )
    .default([]),
  /**
   * Limits that are separate from "am I allowed to hold this job at all":
   * a student visa capped at 20 hours a week in term time, a permit that
   * starts on a given date, a fixed notice period ending.
   */
  constraints: z
    .array(
      z.object({
        kind: z.enum(["hours", "start-date", "location", "other"]),
        note: z.string().min(1),
        until: yearMonth.optional(),
      }),
    )
    .default([]),
  securityClearance: z
    .array(
      z.object({
        country: z.string().min(1),
        level: z.string().min(1), // e.g. "BPSS", "SC", "DV"
        active: z.boolean().default(true),
      }),
    )
    .default([]),
});

/**
 * An angle the user can present: the same experience, framed for a kind of
 * role. Optional. Tailoring (step 6) uses it to choose what to lead with.
 */
export const Positioning = z.object({
  name: z.string().min(1), // "Backend / platform engineer"
  targetTitles: z.array(z.string()).default([]),
  /** What an employer hiring for this is really buying. */
  theyBuy: z.string().optional(),
  /** Role files, projects or skills to lead with, in the user's words. */
  leadWith: z.array(z.string()).default([]),
});

export const Preferences = z.object({
  targetRoles: z.array(z.string()).default([]),
  seniority: z.string().optional(),
  locations: z.array(z.string()).default([]), // "London", "UK", "Remote (UK)"
  workMode: z.array(z.enum(["remote", "hybrid", "onsite"])).default([]),
  salary: z
    .object({
      min: z.number().positive(),
      target: z.number().positive().optional(),
      currency: z.string().length(3).default("GBP"),
      period: z.enum(["year", "day", "hour"]).default("year"),
    })
    .optional(),
  noticePeriod: z.string().optional(),
  dealBreakers: z.array(z.string()).default([]), // hard blockers in step 4
  industries: z
    .object({ prefer: z.array(z.string()).default([]), avoid: z.array(z.string()).default([]) })
    .default({ prefer: [], avoid: [] }),
});

export const ProfileData = z.object({
  version: z.literal(1).default(1),
  basics: Basics.default({ links: [] }),
  languages: z.array(z.object({ language: z.string().min(1), level: z.enum(LANGUAGE_LEVELS) })).default([]),
  education: z
    .array(
      z.object({
        institution: z.string().min(1),
        qualification: z.string().optional(),
        field: z.string().optional(),
        start: year.optional(),
        end: year.optional(),
        notes: z.string().optional(),
      }),
    )
    .default([]),
  certifications: z
    .array(z.object({ name: z.string().min(1), issuer: z.string().optional(), date: year.optional(), expires: year.optional() }))
    .default([]),
  gaps: z.array(z.object({ start: yearMonth, end: yearMonth.optional(), note: z.string().optional() })).default([]),
  eligibility: Eligibility.default({ workAuthorization: [], constraints: [], securityClearance: [] }),
  positioning: z.array(Positioning).default([]),
  preferences: Preferences.default({ targetRoles: [], locations: [], workMode: [], dealBreakers: [], industries: { prefer: [], avoid: [] } }),
});
export type ProfileData = z.infer<typeof ProfileData>;
