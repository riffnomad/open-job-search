/**
 * Remote OK: a board of remote jobs, read from its public JSON feed.
 *
 *   GET https://remoteok.com/api
 *
 * No key. The feed is a JSON array whose first element is a notice of the
 * API terms, not a job; the rest are the newest jobs (about 100). The terms
 * ask for two things, which we do: link back to each job's page on Remote OK
 * (every job's `url` is that page) and name Remote OK as the source (`credit`).
 * They also ask that the Remote OK logo isn't used, and we never show it.
 *
 * Remote OK has no word search, only a filter by its own tags ("dev",
 * "devops", "exec"), which are broad categories rather than job titles. So we
 * read the whole feed in one request and keep the jobs whose title or tags
 * hold every word asked for, as whole words, ignoring case.
 *
 * It can't search by place: every job is remote, and its location says where
 * candidates may live ("Worldwide", "US Only").
 */
import { z } from "zod";
import { decodeEntities, htmlToText } from "../html.ts";
import type { Job, Pay } from "../job.ts";
import { getJsonOnce, hasAllWords, type SearchOptions, type SearchQuery, type SearchResult, type SearchSource, SourceError } from "../source.ts";

const FEED = "https://remoteok.com/api";
const SITE = "https://remoteok.com";

const RoJob = z.object({
  id: z.union([z.string().min(1), z.number().int()]),
  slug: z.string().nullish(),
  epoch: z.number().nullish(),
  date: z.string().nullish(),
  company: z.string().nullish(),
  position: z.string(),
  tags: z.array(z.unknown()).nullish(),
  location: z.string().nullish(),
  salary_min: z.unknown(),
  salary_max: z.unknown(),
  description: z.string().nullish(),
  url: z.string().nullish(),
});
type RoJob = z.infer<typeof RoJob>;

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

/** The job's page on Remote OK, which the terms ask us to link to. Undefined when it gives neither a Remote OK link nor a slug. */
function jobUrl(j: RoJob): string | undefined {
  if (j.url) {
    try {
      const u = new URL(j.url);
      // The feed writes the host as "remoteOK.com"; URL lower-cases it.
      if (u.protocol === "https:" && /(^|\.)remoteok\.com$/i.test(u.hostname)) return u.toString();
    } catch {
      // Fall through to the slug.
    }
  }
  return j.slug && /^[a-z0-9-]+$/i.test(j.slug) ? `${SITE}/remote-jobs/${j.slug}` : undefined;
}

function postedAt(j: RoJob): string | undefined {
  const fromDate = j.date ? new Date(j.date) : undefined;
  if (fromDate && !Number.isNaN(fromDate.getTime())) return fromDate.toISOString();
  if (typeof j.epoch === "number" && j.epoch > 0) {
    const d = new Date(j.epoch * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

const amount = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/**
 * Remote OK sends 0 for "no salary given". Its amounts are in US dollars (the site shows them with $),
 * and the ones we've seen look yearly, but neither the API nor the terms say so, so the period is left out.
 */
function pay(j: RoJob): Pay[] {
  const min = amount(j.salary_min);
  const max = amount(j.salary_max);
  if (min === undefined && max === undefined) return [];
  return [{ ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), currency: "USD" }];
}

const tagsOf = (j: RoJob): string[] => (j.tags ?? []).filter((t): t is string => typeof t === "string").map(clean).filter(Boolean);

function toJob(j: RoJob, url: string): Job {
  const id = String(j.id);
  const location = clean(j.location ?? "");
  const posted = postedAt(j);
  const description = j.description ? htmlToText(j.description) : "";
  return {
    id: `remoteok:remote:${id}`,
    source: "remoteok",
    board: "remote",
    company: clean(j.company ?? ""),
    title: clean(j.position),
    locations: location ? [location] : [],
    remote: true,
    url,
    ...(posted ? { postedAt: posted } : {}),
    pay: pay(j),
    ...(description ? { description } : {}),
  };
}

async function search(query: SearchQuery, opts: SearchOptions = {}): Promise<SearchResult> {
  const what = "Remote OK";
  // Kept a few minutes, so searching for several titles reads the feed once.
  const raw = await getJsonOnce(FEED, what, opts);
  if (raw === null) throw new SourceError(`${what} has moved its feed: ${FEED} wasn't found`);
  if (!Array.isArray(raw)) throw new SourceError(`${what} sent jobs in a shape we don't recognise`);

  const matches = hasAllWords(query.what);
  const jobs: Job[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    // The first element is the notice of the API terms, not a job.
    if (item && typeof item === "object" && "legal" in item) continue;
    const p = RoJob.safeParse(item);
    if (!p.success) continue;
    const url = jobUrl(p.data);
    if (!url) continue;
    const title = clean(p.data.position);
    if (!title || !matches([title, ...tagsOf(p.data)].join(" \n "))) continue;
    const job = toJob(p.data, url);
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    jobs.push(job);
  }

  const limit = query.limit && query.limit > 0 ? query.limit : undefined;
  const kept = limit ? jobs.slice(0, limit) : jobs;
  return {
    source: "remoteok",
    query,
    jobs: kept,
    ...(kept.length < jobs.length ? { totalAds: jobs.length } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export const remoteok: SearchSource = {
  id: "remoteok",
  name: "Remote OK",
  covers: "Remote jobs worldwide: its newest 100 or so, matched by title and tags",
  places: false,
  credit: "Jobs from Remote OK (https://remoteok.com)",
  search,
};
