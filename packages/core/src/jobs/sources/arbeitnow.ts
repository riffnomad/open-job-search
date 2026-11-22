/**
 * Arbeitnow: a job board for Europe, mostly Germany, with many remote jobs and
 * jobs with visa sponsorship. Its free public API, described at
 * https://www.arbeitnow.com/blog/job-board-api:
 *
 *   GET https://www.arbeitnow.com/api/job-board-api?page=N
 *
 * No key. Each page holds 300 jobs, newest first (by `created_at`), and says
 * whether there's another (`links.next`); it doesn't say how many there are.
 * The reply asks "please do not abuse" and to link back to the site; the site's
 * terms say the same ("a link back to Arbeitnow.com"), so every job's `url` is
 * its page on Arbeitnow and `credit` names it. Replies carry a rate limit of 50
 * (x-ratelimit-limit); we read at most a few pages, with a pause between them.
 *
 * The API has no word search and no filter by place, only `visa_sponsorship`.
 * So we read the newest pages (a few days of ads) and keep the jobs whose title
 * or tags hold every word asked for. Each page is kept a few minutes, so
 * searching for several titles reads it once.
 *
 * Many ads are in German, some in French or Dutch, and so are some titles: a
 * search for "developer" won't find "Entwickler".
 */
import { z } from "zod";
import { decodeEntities, htmlToText } from "../html.ts";
import { type Job, splitLocations } from "../job.ts";
import { getJsonOnce, hasAllWords, type SearchOptions, type SearchQuery, type SearchResult, type SearchSource, SourceError } from "../source.ts";

const API = "https://www.arbeitnow.com/api/job-board-api";
/** Pages of 300: three is about 900 of the newest ads. */
const MAX_PAGES = 3;
const PAUSE_MS = 1000;
const DEFAULT_LIMIT = 50;

const AnJob = z.object({
  slug: z.string().min(1),
  company_name: z.string().nullish(),
  title: z.string(),
  description: z.string().nullish(),
  remote: z.boolean().nullish(),
  /** Not in the replies we've seen, but the API filters on it. Read when it's there. */
  visa_sponsorship: z.boolean().nullish(),
  url: z.string(),
  tags: z.array(z.unknown()).nullish(),
  job_types: z.array(z.unknown()).nullish(),
  location: z.string().nullish(),
  created_at: z.number().nullish(),
});
type AnJob = z.infer<typeof AnJob>;

// Jobs are checked one by one, so one odd ad doesn't lose the rest.
const AnPage = z.object({
  data: z.array(z.unknown()),
  links: z.object({ next: z.string().nullish() }).nullish(),
});

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

/** The job's page on Arbeitnow (arbeitnow.com, .co.uk, .fr, .ch, .nl …), which the terms ask us to link to. */
function jobUrl(j: AnJob): string | undefined {
  try {
    const u = new URL(j.url);
    if (u.protocol === "https:" && /(^|\.)arbeitnow\.[a-z]{2,3}(\.[a-z]{2})?$/i.test(u.hostname)) return u.toString();
  } catch {
    // Not a link.
  }
  return undefined;
}

function postedAt(j: AnJob): string | undefined {
  if (typeof j.created_at !== "number" || j.created_at <= 0) return undefined;
  const d = new Date(j.created_at * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const tagsOf = (j: AnJob): string[] => (j.tags ?? []).filter((t): t is string => typeof t === "string").map(clean).filter(Boolean);

/**
 * Arbeitnow has no pay field, so pay is left empty: some ads give pay in their
 * text, which is kept. Visa sponsorship matters to people moving country and
 * Job has no field for it, so it goes at the end of the description.
 */
function toJob(j: AnJob, url: string): Job | undefined {
  const title = clean(j.title);
  const company = clean(j.company_name ?? "");
  if (!title || !company) return undefined;
  const posted = postedAt(j);
  const text = j.description ? htmlToText(j.description) : "";
  const description = [text, j.visa_sponsorship === true ? "Visa sponsorship: yes" : ""].filter(Boolean).join("\n\n");
  return {
    id: `arbeitnow:europe:${j.slug}`,
    source: "arbeitnow",
    board: "europe",
    company,
    title,
    locations: splitLocations(clean(j.location ?? "")),
    ...(j.remote === true ? { remote: true as const } : {}),
    url,
    ...(posted ? { postedAt: posted } : {}),
    pay: [],
    ...(description ? { description } : {}),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function search(query: SearchQuery, opts: SearchOptions = {}): Promise<SearchResult> {
  const what = "Arbeitnow";
  const limit = query.limit && query.limit > 0 ? Math.floor(query.limit) : DEFAULT_LIMIT;
  const pause = opts.pauseMs ?? PAUSE_MS;
  const matches = hasAllWords(query.what);
  const jobs: Job[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= MAX_PAGES && jobs.length < limit; page++) {
    if (page > 1 && pause > 0) await sleep(pause);
    const raw = await getJsonOnce(`${API}?page=${page}`, what, opts);
    if (raw === null) {
      if (page === 1) throw new SourceError(`${what} has moved its API: ${API} wasn't found`);
      break;
    }
    const parsed = AnPage.safeParse(raw);
    if (!parsed.success) throw new SourceError(`${what} sent jobs in a shape we don't recognise`);
    for (const item of parsed.data.data) {
      const p = AnJob.safeParse(item);
      if (!p.success) continue;
      const url = jobUrl(p.data);
      if (!url) continue;
      if (!matches([clean(p.data.title), ...tagsOf(p.data)].join(" \n "))) continue;
      const job = toJob(p.data, url);
      if (!job || seen.has(job.id)) continue;
      seen.add(job.id);
      jobs.push(job);
    }
    if (!parsed.data.links?.next || parsed.data.data.length === 0) break;
  }

  const kept = jobs.slice(0, limit);
  return {
    source: "arbeitnow",
    query,
    jobs: kept,
    ...(kept.length < jobs.length ? { totalAds: jobs.length } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export const arbeitnow: SearchSource = {
  id: "arbeitnow",
  name: "Arbeitnow",
  covers: "Jobs in Europe, mostly Germany, many remote or with visa sponsorship: its newest 900 or so, matched by title and tags",
  places: false,
  credit: "Jobs from Arbeitnow (https://www.arbeitnow.com)",
  search,
};
