/**
 * Reed: a large UK job board, with ads from employers and many recruitment
 * agencies. Official Jobseeker API, documented at
 * https://www.reed.co.uk/developers/jobseeker:
 *
 *   GET https://www.reed.co.uk/api/1.0/search
 *       ?keywords=…&locationName=…&resultsToTake=…&resultsToSkip=…
 *
 * It needs a key, read from REED_API_KEY. Reed hands Jobseeker keys out free
 * from that page, as of November 2026. The key goes as the user name of HTTP
 * basic auth with an empty password, in a header, so it never appears in a URL.
 * Reed publishes no API terms we could find and names no rate limit; its site
 * terms allow copying "for your own private or domestic purposes", which a
 * person's own job search is. We read few pages and pause between them.
 *
 * Reed also has a details call (/api/1.0/jobs/{id}) with the full ad, the
 * salary type (per hour, day, week, month or annum) and the contract type.
 * We don't call it per job: one search would become a hundred calls. It's
 * the way to get pay periods and full text later, for the few jobs a person
 * keeps.
 */
import { z } from "zod";
import { decodeEntities, htmlToText } from "../html.ts";
import { type Job, type Pay, saysRemote } from "../job.ts";
import { getJson, type SearchOptions, type SearchQuery, type SearchResult, type SearchSource, SourceError } from "../source.ts";

const API = "https://www.reed.co.uk/api/1.0/search";
const SIGNUP = "https://www.reed.co.uk/developers/jobseeker";
const KEY_ENV = "REED_API_KEY";
const COUNTRIES = ["gb"];

/** The most Reed sends in one page (resultsToTake: "default and limit: 100"). */
const PAGE = 100;
const DEFAULT_LIMIT = 100;
/** Three pages at most per search. */
const MAX_LIMIT = 300;
const PAUSE_MS = 300;

const ReedJob = z.object({
  jobId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  employerName: z.string().nullish(),
  jobTitle: z.string(),
  locationName: z.string().nullish(),
  minimumSalary: z.number().nullish(),
  maximumSalary: z.number().nullish(),
  currency: z.string().nullish(),
  /** "dd/mm/yyyy" */
  date: z.string().nullish(),
  jobDescription: z.string().nullish(),
  jobUrl: z.string().url(),
});

// Results are checked one by one, so one odd ad doesn't lose the rest.
const ReedPage = z.object({ results: z.array(z.unknown()), totalResults: z.number().nullish() });

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

/** Reed's "dd/mm/yyyy" as ISO 8601 ("yyyy-mm-dd"), or undefined when it isn't a real date. */
function isoDate(s: string | null | undefined): string | undefined {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s ?? "").trim());
  if (!m) return undefined;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso) ? iso : undefined;
}

/**
 * The ad's own pay, when Reed gives it (it sends none when the ad hides it).
 * The search reply doesn't say the period: an hourly job's numbers come as
 * they are, next to yearly ones, so `period` is left out. The currency is the
 * ad's own; without one, the pay is left out rather than assumed to be pounds.
 */
function payOf(r: z.infer<typeof ReedJob>): Pay[] {
  const currency = r.currency?.trim().toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return [];
  const min = r.minimumSalary ?? undefined;
  const max = r.maximumSalary ?? undefined;
  if (!(min && min > 0) && !(max && max > 0)) return [];
  return [{ ...(min && min > 0 ? { min } : {}), ...(max && max > 0 ? { max } : {}), currency }];
}

function toJob(r: z.infer<typeof ReedJob>): Job | undefined {
  // Often a recruitment agency rather than the hiring company: Reed's search says which name posted the ad, not who's hiring.
  const company = clean(r.employerName ?? "");
  if (!company) return undefined;
  const title = clean(r.jobTitle);
  if (!title) return undefined;
  const place = clean(r.locationName ?? "");
  const locations = place ? [place] : [];
  // The search sends only the start of the ad; the full text is at `url` (or the details call).
  const description = r.jobDescription ? htmlToText(r.jobDescription) : "";
  const postedAt = isoDate(r.date);
  return {
    id: `reed:gb:${r.jobId}`,
    source: "reed",
    board: "gb",
    company,
    title,
    locations,
    ...(saysRemote(locations) ? { remote: true as const } : {}),
    url: r.jobUrl,
    ...(postedAt ? { postedAt } : {}),
    pay: payOf(r),
    ...(description ? { description } : {}),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The message with the key taken out, in case anything below us ever repeats it. */
function redact(message: string, secrets: string[]): string {
  let m = message;
  for (const s of secrets) if (s) m = m.split(s).join("[hidden]");
  return m;
}

async function search(query: SearchQuery, opts: SearchOptions = {}): Promise<SearchResult> {
  const key = opts.env?.[KEY_ENV]?.trim();
  if (!key) throw new SourceError(`Reed needs a free key. Get one at ${SIGNUP}, then set ${KEY_ENV} in your environment.`);
  const country = (query.country ?? COUNTRIES[0]!).trim().toLowerCase();
  if (!COUNTRIES.includes(country)) throw new SourceError(`Reed doesn't cover "${country}". Countries: ${COUNTRIES.join(", ")}`);
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const perPage = Math.min(PAGE, limit);
  const pause = opts.pauseMs ?? PAUSE_MS;
  const what = "Reed";
  const auth = `Basic ${btoa(`${key}:`)}`;

  const jobs: Job[] = [];
  let total = 0;
  /** Entries read, ads or not: what tells us whether we stopped before the end. */
  let seen = 0;
  for (let page = 0; seen < limit; page++) {
    if (page > 0 && pause > 0) await sleep(pause);
    const params = new URLSearchParams();
    if (query.what.trim()) params.set("keywords", query.what.trim());
    // Reed searches 10 miles round the place unless told otherwise; we keep its default.
    if (query.where?.trim()) params.set("locationName", query.where.trim());
    params.set("resultsToTake", String(perPage));
    params.set("resultsToSkip", String(seen));
    let raw: unknown;
    try {
      raw = await getJson(`${API}?${params}`, what, opts, { authorization: auth });
    } catch (e) {
      if (e instanceof SourceError) throw new SourceError(redact(e.message, [key, auth]));
      throw new SourceError(`couldn't reach ${what}`);
    }
    if (raw === null) throw new SourceError(`${what} has no such search (404)`);
    const parsed = ReedPage.safeParse(raw);
    if (!parsed.success) throw new SourceError(`${what} sent jobs in a shape we don't recognise`);
    if (page === 0) total = parsed.data.totalResults ?? 0;
    const list = parsed.data.results.slice(0, limit - seen);
    seen += list.length;
    for (const item of list) {
      const r = ReedJob.safeParse(item);
      const job = r.success ? toJob(r.data) : undefined;
      if (job) jobs.push(job);
    }
    if (parsed.data.results.length < perPage || seen >= total) break;
  }
  return {
    source: "reed",
    query: { ...query, country },
    jobs,
    ...(total > seen ? { totalAds: total } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export const reed: SearchSource = {
  id: "reed",
  name: "Reed",
  covers: "UK jobs from employers and recruitment agencies",
  places: true,
  countries: COUNTRIES,
  keys: { env: [KEY_ENV], signup: SIGNUP },
  // Reed asks for no credit that we could find; we name it anyway, and each job links to its Reed page.
  credit: "Jobs by reed.co.uk (https://www.reed.co.uk)",
  search,
};
