/**
 * Adzuna: a job search engine that gathers ads from many boards and
 * employers, in 19 countries. Official API, documented at
 * https://developer.adzuna.com:
 *
 *   GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}
 *       ?app_id=…&app_key=…&what=…&where=…&results_per_page=…
 *
 * It needs a free key, one per person (Adzuna's terms treat several accounts
 * for one person as misuse), read from ADZUNA_APP_ID and ADZUNA_APP_KEY. Their
 * terms allow "personal job search", which is what this is. The key travels in
 * the URL, so the URL never goes into an error message or a log.
 *
 * Adzuna doesn't publish its limits (they're shown in each account, and the
 * free tier is meant for trying the API out), so we read few pages, with a
 * pause between them, and stop when Adzuna says we're asking too often.
 */
import { z } from "zod";
import { decodeEntities, htmlToText } from "../html.ts";
import { type Job, type Pay, saysRemote } from "../job.ts";
import { getJson, type SearchOptions, type SearchQuery, type SearchResult, type SearchSource, SourceError } from "../source.ts";

const API = "https://api.adzuna.com/v1/api/jobs";
const SIGNUP = "https://developer.adzuna.com/signup";
const ID_ENV = "ADZUNA_APP_ID";
const KEY_ENV = "ADZUNA_APP_KEY";

/** The most Adzuna sends in one page. */
const PAGE = 50;
/** One page unless asked for more: each page counts against the person's allowance. */
const DEFAULT_LIMIT = 50;
/** Three pages at most per search. */
const MAX_LIMIT = 150;
const PAUSE_MS = 300;

/** The countries Adzuna's API lists, with the currency its salaries are in ("given in the local currency"). */
const CURRENCY: Record<string, string> = {
  gb: "GBP", us: "USD", at: "EUR", au: "AUD", be: "EUR", br: "BRL", ca: "CAD", ch: "CHF", de: "EUR", es: "EUR",
  fr: "EUR", in: "INR", it: "EUR", mx: "MXN", nl: "EUR", nz: "NZD", pl: "PLN", sg: "SGD", za: "ZAR",
};
const COUNTRIES = Object.keys(CURRENCY);

const AzJob = z.object({
  id: z.union([z.string().min(1), z.number()]),
  title: z.string(),
  redirect_url: z.string().url(),
  description: z.string().nullish(),
  created: z.string().nullish(),
  company: z.object({ display_name: z.string().nullish() }).nullish(),
  location: z.object({ display_name: z.string().nullish() }).nullish(),
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish(),
  salary_is_predicted: z.union([z.string(), z.number()]).nullish(),
});

// Results are checked one by one, so one odd ad doesn't lose the rest.
const AzPage = z.object({ count: z.number().nullish(), results: z.array(z.unknown()) });

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

/**
 * Pay only when the ad itself gives it. Adzuna fills in a salary for ads that
 * have none, predicted by its "Jobsworth" model, and flags it with
 * salary_is_predicted "1". We leave predicted pay out: it isn't the ad's, a
 * person deciding whether to apply could take it as an offer, and Adzuna's
 * terms ask that a published estimate carry their Jobsworth icon, link and
 * mouseover, which a terminal or JSON can't. When the flag is missing we can't
 * tell, so the pay is left out too.
 *
 * Adzuna doesn't say what period the salary covers, so `period` is left out.
 * (contract_time and contract_type say full or part time, permanent or
 * contract: not how often pay comes.)
 */
function payOf(a: z.infer<typeof AzJob>, currency: string): Pay[] {
  if (String(a.salary_is_predicted ?? "").trim() !== "0") return [];
  const min = a.salary_min ?? undefined;
  const max = a.salary_max ?? undefined;
  if (!(min && min > 0) && !(max && max > 0)) return [];
  return [{ ...(min && min > 0 ? { min } : {}), ...(max && max > 0 ? { max } : {}), currency }];
}

function toJob(country: string, a: z.infer<typeof AzJob>): Job | undefined {
  const company = clean(a.company?.display_name ?? "");
  // Every job names its company; an ad that doesn't isn't one we can show or group.
  if (!company) return undefined;
  const title = clean(a.title);
  if (!title) return undefined;
  const place = clean(a.location?.display_name ?? "");
  const locations = place ? [place] : [];
  // Adzuna only sends a snippet of the ad (up to 500 characters), never the whole text: the full ad is at `url`.
  const description = a.description ? htmlToText(a.description) : "";
  return {
    id: `adzuna:${country}:${a.id}`,
    source: "adzuna",
    board: country,
    company,
    title,
    locations,
    ...(saysRemote(locations) ? { remote: true as const } : {}),
    // Adzuna's terms ask that people are sent to ads through redirect_url.
    url: a.redirect_url,
    ...(a.created ? { postedAt: a.created } : {}),
    pay: payOf(a, CURRENCY[country]!),
    ...(description ? { description } : {}),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The message with the keys taken out, in case anything below us ever repeats the URL. */
function redact(message: string, secrets: string[]): string {
  let m = message;
  for (const s of secrets) if (s) m = m.split(s).join("[hidden]").split(encodeURIComponent(s)).join("[hidden]");
  return m;
}

async function search(query: SearchQuery, opts: SearchOptions = {}): Promise<SearchResult> {
  const env = opts.env ?? {};
  const appId = env[ID_ENV]?.trim();
  const appKey = env[KEY_ENV]?.trim();
  if (!appId || !appKey) {
    const missing = [!appId && ID_ENV, !appKey && KEY_ENV].filter(Boolean).join(" and ");
    throw new SourceError(`Adzuna needs a free key. Get one at ${SIGNUP}, then set ${missing} in your environment.`);
  }
  const country = (query.country ?? COUNTRIES[0]!).trim().toLowerCase();
  if (!CURRENCY[country]) throw new SourceError(`Adzuna doesn't cover "${country}". Countries: ${COUNTRIES.join(", ")}`);
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const perPage = Math.min(PAGE, limit);
  const pause = opts.pauseMs ?? PAUSE_MS;
  const what = `Adzuna (${country})`;

  // Adzuna's docs say a refused key gets 410 ("Authorisation failed"); some APIs send 401. Both read as a refused key.
  const f = opts.fetch ?? fetch;
  const fetchAuth = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await f(input, init);
    return res.status === 410 ? new Response(null, { status: 401 }) : res;
  }) as typeof fetch;

  const jobs: Job[] = [];
  let count = 0;
  /** Entries read, ads or not: what tells us whether we stopped before the end. */
  let seen = 0;
  for (let page = 1; seen < limit; page++) {
    if (page > 1 && pause > 0) await sleep(pause);
    const params = new URLSearchParams({ app_id: appId, app_key: appKey, results_per_page: String(perPage) });
    if (query.what.trim()) params.set("what", query.what.trim());
    if (query.where?.trim()) params.set("where", query.where.trim());
    params.set("content-type", "application/json");
    let raw: unknown;
    try {
      raw = await getJson(`${API}/${country}/search/${page}?${params}`, what, { ...opts, fetch: fetchAuth });
    } catch (e) {
      if (e instanceof SourceError) throw new SourceError(redact(e.message, [appId, appKey]));
      throw new SourceError(`couldn't reach ${what}`);
    }
    if (raw === null) throw new SourceError(`${what} has no such search (404). Check the country code.`);
    const parsed = AzPage.safeParse(raw);
    if (!parsed.success) throw new SourceError(`${what} sent jobs in a shape we don't recognise`);
    if (page === 1) count = parsed.data.count ?? 0;
    const list = parsed.data.results.slice(0, limit - seen);
    seen += list.length;
    for (const item of list) {
      const a = AzJob.safeParse(item);
      const job = a.success ? toJob(country, a.data) : undefined;
      if (job) jobs.push(job);
    }
    if (parsed.data.results.length < perPage || seen >= count) break;
  }
  return {
    source: "adzuna",
    query: { ...query, country },
    jobs,
    ...(count > seen ? { totalAds: count } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export const adzuna: SearchSource = {
  id: "adzuna",
  name: "Adzuna",
  covers: `Jobs from many boards and employers in ${COUNTRIES.length} countries`,
  places: true,
  countries: COUNTRIES,
  keys: { env: [ID_ENV, KEY_ENV], signup: SIGNUP },
  // Their terms: label ads with "Adzuna", linked to adzuna.co.uk or the country's own Adzuna site.
  credit: "Jobs by Adzuna (https://www.adzuna.co.uk)",
  // The terms want every ad labelled "Adzuna", linking to Adzuna; each job's link is its Adzuna page.
  creditEach: "Adzuna",
  search,
};
