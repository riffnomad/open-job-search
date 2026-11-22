/**
 * The job titles a search looks for, built in step 3 from the roles they
 * want. A title is one clue to seniority, not the test: flat companies give
 * everyone the same title, startups say "Engineer" for any level, and big
 * companies inflate titles. So a search keeps four lists:
 *
 * - core: the titles they'd call the job, as job ads write them.
 * - related: other titles the profile backs, each with why.
 * - open: titles that don't show seniority, fine when a condition holds
 *   ("pay at or above target"). Checked against the whole job ad later.
 * - exclude: words that rule an ad out by its title alone.
 */
import { z } from "zod";

const title = z.string().trim().min(1);

export const RelatedTitle = z.union([
  title.transform((t): { title: string; why?: string } => ({ title: t })),
  z.object({ title, why: z.string().trim().min(1).optional() }),
]);
export type RelatedTitle = z.infer<typeof RelatedTitle>;

export const OpenTitle = z.object({
  title,
  /** When it's worth a look, in plain words: "pay at or above target", "the ad describes setting technical direction". */
  if: z.string().trim().min(1),
  why: z.string().trim().min(1).optional(),
});
export type OpenTitle = z.infer<typeof OpenTitle>;

export const Titles = z.object({
  core: z.array(title).default([]),
  related: z.array(RelatedTitle).default([]),
  open: z.array(OpenTitle).default([]),
  exclude: z.array(title).default([]),
});
export type Titles = z.infer<typeof Titles>;

export const TITLE_LISTS = ["core", "related", "open", "exclude"] as const;
export type TitleList = (typeof TITLE_LISTS)[number];

export const emptyTitles = (): Titles => ({ core: [], related: [], open: [], exclude: [] });

/** True when no list has anything in it. */
export const titlesEmpty = (t: Titles | undefined): boolean => !t || TITLE_LISTS.every((k) => t[k].length === 0);

/** Lower case, punctuation as spaces, padded, so whole words can be found with includes(). */
const words = (s: string): string => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, " ").trim()} `;
const has = (haystack: string, needle: string): boolean => words(haystack).includes(words(needle));

/** Every title it looks for, with the list it's in. */
function searched(t: Titles): { list: Exclude<TitleList, "exclude">; title: string }[] {
  return [
    ...t.core.map((x) => ({ list: "core" as const, title: x })),
    ...t.related.map((x) => ({ list: "related" as const, title: x.title })),
    ...t.open.map((x) => ({ list: "open" as const, title: x.title })),
  ];
}

/** Things in the lists that don't fit together. */
export function checkTitles(t: Titles): string[] {
  const out: string[] = [];
  const all = searched(t);
  for (const w of t.exclude) {
    const hit = all.find((x) => has(x.title, w));
    if (hit) out.push(`"${w}" rules a title out, but it's in "${hit.title}" (${hit.list}), so that would never show.`);
  }
  const seen = new Map<string, string>();
  for (const x of all) {
    const k = words(x.title);
    const before = seen.get(k);
    if (before) out.push(`"${x.title}" is listed twice (${before} and ${x.list}).`);
    else seen.set(k, x.list);
  }
  return out;
}

/** Related and open titles with no reason yet. */
export function titlesUnexplained(t: Titles): string[] {
  return [...t.related, ...t.open].filter((x) => !x.why).map((x) => x.title);
}

export type TitleMatch =
  | { match: "excluded"; word: string }
  | { match: "core" | "related"; title: string }
  | { match: "open"; title: string; if: string }
  | { match: "none" };

/**
 * What the lists alone say for certain about a job ad's title: an exclude
 * word anywhere rules it out; an ad title that is exactly one of their titles
 * (ignoring case and punctuation) is in that list. Anything else is "none":
 * not decided here. Whether "Staff Software Engineer" is the same job and
 * level as "Staff Engineer" depends on the field, so that's judged
 * elsewhere (jobs/judge.ts). An open match still needs its condition checked.
 */
export function matchTitle(adTitle: string, t: Titles): TitleMatch {
  const word = t.exclude.find((w) => has(adTitle, w));
  if (word) return { match: "excluded", word };
  const ad = words(adTitle);
  for (const list of ["core", "related"] as const) {
    const hit = searched(t).find((x) => x.list === list && words(x.title) === ad);
    if (hit) return { match: list, title: hit.title };
  }
  const open = t.open.find((x) => words(x.title) === ad);
  if (open) return { match: "open", title: open.title, if: open.if };
  return { match: "none" };
}
