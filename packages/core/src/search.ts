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
import { dropNulls, ProfileFileError } from "./profile/role-file.ts";

export const SearchData = z.object({
  version: z.literal(1).default(1),
  /** In their words: "Software engineering", "Product management". */
  name: z.string().min(1),
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
  dealBreakers: z.array(z.string()).default([]),
  industries: z
    .object({ prefer: z.array(z.string()).default([]), avoid: z.array(z.string()).default([]) })
    .default({ prefer: [], avoid: [] }),
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

export function parseSearchYaml(text: string, file = SEARCH_FILE): SearchData {
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (err) {
    const msg = err instanceof YAMLParseError ? err.message.split("\n")[0]!.replace(/:\s*$/, "") : String(err);
    throw new ProfileFileError(file, `not valid YAML: ${msg}`);
  }
  const result = SearchData.safeParse(dropNulls(raw));
  if (!result.success) throw new ProfileFileError(file, `invalid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export async function loadSearch(dir: string): Promise<SearchData> {
  return parseSearchYaml(await readFile(join(dir, SEARCH_FILE), "utf8"), join(dir, SEARCH_FILE));
}

const yamlString = (s: string) => stringify(s).trimEnd();

/** search.yaml for a new search, with comments explaining each part. */
export function searchYamlTemplate(name: string, targetRoles: string[] = []): string {
  return `# One job search: what you're looking for. Your experience is shared by all
# your searches (data/<you>/profile/); this file is only about this one.
# Everything except the name is optional.
version: 1
name: ${yamlString(name)}

targetRoles: ${targetRoles.length ? `[${targetRoles.map(yamlString).join(", ")}]` : "[]"}${targetRoles.length ? "" : "   # e.g. [Backend engineer, Platform engineer]"}
seniority:         # e.g. senior, lead
locations: []      # e.g. [London, Remote (UK)]
workMode: []       # remote | hybrid | onsite
salary:            # { min: 60000, target: 70000, currency: GBP, period: year }
dealBreakers: []   # anything that rules a job out
industries: { prefer: [], avoid: [] }

angle:             # how to present your experience for this search
  theyBuy:         # what an employer hiring for this is really buying
  leadWith: []     # roles, projects or skills to lead with
`;
}
