/**
 * Lever: every company's public job site, through its documented, open
 * Postings API (no key). https://github.com/lever/postings-api
 *
 *   GET https://api.lever.co/v0/postings/{site}?mode=json
 *
 * Sites live at jobs.lever.co/{site}. EU-hosted ones live at
 * jobs.eu.lever.co/{site} and are served by api.eu.lever.co instead, so when
 * the global API has no jobs for a site we ask the EU one.
 *
 * Lever doesn't send the company's name, so the site name stands in for it.
 */
import { z } from "zod";
import { decodeEntities, htmlToText } from "../html.ts";
import { type BoardResult, type Job, type Pay, saysRemote, splitLocations } from "../job.ts";
import { asUrl, type BoardSource, type FetchOptions, getJson, isBoardName, SourceError } from "../source.ts";

const APIS = ["https://api.lever.co/v0/postings", "https://api.eu.lever.co/v0/postings"];

const LvPosting = z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  createdAt: z.number().nullish(),
  categories: z
    .object({
      location: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
      team: z.string().nullish(),
      department: z.string().nullish(),
    })
    .nullish(),
  description: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  lists: z.array(z.object({ text: z.string().nullish(), content: z.string().nullish() })).nullish(),
  additional: z.string().nullish(),
  additionalPlain: z.string().nullish(),
  salaryDescription: z.string().nullish(),
  salaryDescriptionPlain: z.string().nullish(),
  workplaceType: z.string().nullish(),
  salaryRange: z
    .object({ min: z.number().nullish(), max: z.number().nullish(), currency: z.string().nullish(), interval: z.string().nullish() })
    .nullish(),
});

const LvPostings = z.array(LvPosting);

const HOSTS = /^jobs(\.eu)?\.lever\.co$/i;

function parseBoard(input: string): string | undefined {
  const s = input.trim();
  const url = asUrl(s);
  if (!url) return isBoardName(s) ? s.toLowerCase() : undefined;
  if (!HOSTS.test(url.hostname)) return undefined;
  const first = url.pathname.split("/").filter(Boolean)[0];
  return first && isBoardName(first) ? first.toLowerCase() : undefined;
}

/** Lever's intervals: "per-year-salary", "per-hour-wage"… Left out when it's another (a week, one-off). */
function payPeriod(interval: string): Pay["period"] | undefined {
  const m = /\b(year|month|day|hour)\b/i.exec(interval);
  return m ? (m[1]!.toLowerCase() as Pay["period"]) : undefined;
}

function toPay(p: z.infer<typeof LvPosting>["salaryRange"]): Pay[] {
  if (!p?.currency || (p.min == null && p.max == null)) return [];
  // Placeholders: some sites enter 0–1 to hide pay. No real range tops out below 5 of any currency.
  if (Math.max(p.min ?? 0, p.max ?? 0) < 5) return [];
  const period = p.interval ? payPeriod(p.interval) : undefined;
  return [{
    ...(p.min != null ? { min: p.min } : {}),
    ...(p.max != null ? { max: p.max } : {}),
    currency: p.currency.toUpperCase(),
    ...(period ? { period } : {}),
  }];
}

const text = (html?: string | null, plain?: string | null) => (html ? htmlToText(html) : (plain ?? "").trim());

/** The ad as plain text: the description, each extra list under its heading, the note on pay, then the closing part. */
function toDescription(j: z.infer<typeof LvPosting>): string {
  const parts = [text(j.description, j.descriptionPlain)];
  for (const l of j.lists ?? []) {
    // List items arrive one per line; keep them together rather than a blank line apart.
    const items = text(l.content && `<ul>${l.content}</ul>`).replace(/\n+(?=- )/g, "\n");
    if (items) parts.push([l.text?.trim(), items].filter(Boolean).join("\n"));
  }
  parts.push(text(j.salaryDescription, j.salaryDescriptionPlain), text(j.additional, j.additionalPlain));
  return parts.filter(Boolean).join("\n\n");
}

function toJob(board: string, j: z.infer<typeof LvPosting>): Job {
  const c = j.categories;
  const locations = splitLocations(c?.location, ...(c?.allLocations ?? []));
  const department = c?.department?.trim() || c?.team?.trim();
  const description = toDescription(j);
  return {
    id: `lever:${board}:${j.id}`,
    source: "lever",
    board,
    company: board,
    title: decodeEntities(j.text).replace(/\s+/g, " ").trim(),
    locations,
    ...(j.workplaceType === "remote" || saysRemote(locations) ? { remote: true as const } : {}),
    url: j.hostedUrl,
    ...(department ? { department } : {}),
    ...(j.createdAt ? { postedAt: new Date(j.createdAt).toISOString() } : {}),
    pay: toPay(j.salaryRange),
    ...(description ? { description } : {}),
  };
}

async function fetchBoard(board: string, opts: FetchOptions = {}): Promise<BoardResult> {
  if (!isBoardName(board)) throw new SourceError(`"${board}" isn't a Lever site name`);
  const what = `Lever (site "${board}")`;
  // The global API first. For an EU-hosted site it answers "not found" or an
  // empty list, so then ask the EU one; a site with no jobs anywhere is empty.
  let raw: unknown = null;
  for (const api of APIS) {
    const got = await getJson(`${api}/${encodeURIComponent(board)}?mode=json`, what, opts);
    if (got !== null) raw = got;
    if (Array.isArray(got) ? got.length : got !== null) break;
  }
  if (raw === null) throw new SourceError(`Lever has no site called "${board}". Check the name in the company's job links (jobs.lever.co/<site>).`);
  const parsed = LvPostings.safeParse(raw);
  if (!parsed.success) throw new SourceError(`${what} sent jobs in a shape we don't recognise`);
  return {
    source: "lever",
    board,
    company: board,
    jobs: parsed.data.map((j) => toJob(board, j)),
    fetchedAt: new Date().toISOString(),
  };
}

export const lever: BoardSource = {
  id: "lever",
  name: "Lever",
  boardHint: "the site name, or a link like jobs.lever.co/acme",
  parseBoard,
  fetchBoard,
};
