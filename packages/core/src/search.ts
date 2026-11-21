/**
 * A job search: what one person is looking for. Someone can run more than
 * one at a time (software engineering and product management), all drawing
 * on the same profile: the profile says who they are, a search says what
 * they want and which side of them to lead with.
 *
 * Lives in data/<person>/searches/<search>/search.yaml, with its own
 * history.md, and later the jobs found and applications made for it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify, YAMLParseError } from "yaml";
import { z } from "zod";
import { SEARCH_FILE } from "./paths.ts";
import { preferencesTemplateBody, preferenceShape, USUAL_PREFERENCES_FILE, UsualPreferences } from "./preferences.ts";
import { dropNulls, ProfileFileError } from "./profile/role-file.ts";

export const FIT_LEVELS = ["good", "stretch", "leap"] as const;
export type FitLevel = (typeof FIT_LEVELS)[number];

/**
 * How well the profile backs this search, at the level they're aiming for.
 * Saved so later steps can use the gaps, and stamped with the profile change
 * it was made against, so it's clear when the profile has moved on since.
 */
export const Fit = z.object({
  /** good: the profile clearly covers it. stretch: most of it, a gap or two (normal). leap: almost nothing the role needs. */
  level: z.enum(FIT_LEVELS),
  /** Profile lines, projects or past lives that back it, in short. */
  evidence: z.array(z.string()).default([]),
  /** What the role needs that the profile doesn't show yet. */
  gaps: z.array(z.string()).default([]),
  /** Anything else said about it: a stepping stone offered, what they decided. */
  note: z.string().optional(),
  assessedAt: z.string().min(1),
  /** The latest profile history entry when it was assessed (0 when there was none). */
  profileChange: z.number().int().nonnegative(),
});
export type Fit = z.infer<typeof Fit>;

export const SearchData = z.object({
  version: z.literal(1).default(1),
  /** In their words: "Software engineering", "Product management". */
  name: z.string().min(1),
  targetRoles: z.array(z.string()).default([]),
  /** Why they want this, in their words. */
  why: z.array(z.string()).default([]),
  fit: Fit.optional(),
  // Preferences: only what differs from the person's usual ones (preferences.ts).
  ...preferenceShape,
  /** How to present the same experience for this search. Tailoring uses it to choose what to lead with. */
  angle: z
    .object({
      /** What an employer hiring for this is really buying. */
      theyBuy: z.string().optional(),
      /** Roles, projects or skills to lead with, in the person's words. */
      leadWith: z.array(z.string()).default([]),
    })
    .default({ leadWith: [] }),
});
export type SearchData = z.infer<typeof SearchData>;

function parseYamlWith<T extends z.ZodType>(schema: T, text: string, file: string): z.infer<T> {
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (err) {
    const msg = err instanceof YAMLParseError ? err.message.split("\n")[0]!.replace(/:\s*$/, "") : String(err);
    throw new ProfileFileError(file, `not valid YAML: ${msg}`);
  }
  const result = schema.safeParse(dropNulls(raw));
  if (!result.success) throw new ProfileFileError(file, `invalid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export function parseSearchYaml(text: string, file = SEARCH_FILE): SearchData {
  return parseYamlWith(SearchData, text, file);
}

/** data/<person>/preferences.yaml: their usual preferences. */
export function parseUsualPreferences(text: string, file = USUAL_PREFERENCES_FILE): UsualPreferences {
  return parseYamlWith(UsualPreferences, text, file);
}

/** A person's usual preferences, or undefined when they haven't any yet. */
export async function loadUsualPreferences(personFolder: string): Promise<UsualPreferences | undefined> {
  const path = join(personFolder, USUAL_PREFERENCES_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  return parseUsualPreferences(text, path);
}

export async function loadSearch(dir: string): Promise<SearchData> {
  return parseSearchYaml(await readFile(join(dir, SEARCH_FILE), "utf8"), join(dir, SEARCH_FILE));
}

const yamlString = (s: string) => stringify(s).trimEnd();

/** search.yaml for a new search, with comments explaining each part. */
export function searchYamlTemplate(name: string, targetRoles: string[] = [], why: string[] = []): string {
  return `# One job search: what you're looking for. Your experience is shared by all
# your searches (data/<you>/profile/); this file is only about this one.
# Everything except the name is optional.
version: 1
name: ${yamlString(name)}

targetRoles: ${targetRoles.length ? `[${targetRoles.map(yamlString).join(", ")}]` : "[]"}${targetRoles.length ? "" : "   # e.g. [Backend engineer, Platform engineer]"}
why:${why.length ? `\n${why.map((w) => `  - ${yamlString(w)}`).join("\n")}` : " []               # why they want this, in their words"}
# fit: set with \`ojs search fit\`: how well the profile backs this search

# What this search wants. Leave a preference empty to use your usual one
# (data/<you>/preferences.yaml); deal-breakers add to your usual ones.
# Change them with \`ojs prefs set\`.
${preferencesTemplateBody()}

angle:             # how to present your experience for this search
  theyBuy:         # what an employer hiring for this is really buying
  leadWith: []     # roles, projects or skills to lead with
`;
}

export interface FitStatus {
  fit?: Fit;
  /** Profile changes made since the fit was assessed. */
  changesSince: number;
  /** True when there's no fit yet, or the profile has changed since. */
  needsAssessing: boolean;
}

/** Whether a search's fit is current, given the latest profile history entry. */
export function fitStatus(data: Pick<SearchData, "fit">, latestProfileChange: number): FitStatus {
  if (!data.fit) return { changesSince: 0, needsAssessing: true };
  const changesSince = Math.max(0, latestProfileChange - data.fit.profileChange);
  return { fit: data.fit, changesSince, needsAssessing: changesSince > 0 };
}
