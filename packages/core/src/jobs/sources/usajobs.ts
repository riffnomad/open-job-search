/**
 * USAJOBS: the US federal government's job board, run by the Office of
 * Personnel Management (OPM). Official API, documented at
 * https://developer.usajobs.gov:
 *
 *   GET https://data.usajobs.gov/api/search?Keyword=…&LocationName=…&ResultsPerPage=…&Page=…
 *
 * It needs a free key, one per person: OPM's terms say credentials are
 * individual and mustn't be shared. The key is requested with an email
 * address, and every request must send that email as its User-Agent and the
 * key as Authorization-Key. We read them from USAJOBS_EMAIL and
 * USAJOBS_API_KEY. Neither ever goes into an error message or a log.
 *
 * Limits (as of November 2026): up to 500 rows a page and 10,000 a query, no
 * stated rate per minute; OPM may add limits without notice. We read few
 * pages and pause between them. Searches cover "Public" jobs by default,
 * which is what a person searching for themselves sees.
 *
 * The terms let us store and reformat what we fetch, and encourage (don't
 * require) naming USAJOBS as the source and linking to the official
 * announcement: every job's `url` is its USAJOBS page (PositionURI), and
 * `credit` names USAJOBS. Applications go through that announcement.
 */
import { z } from "zod";
import { decodeEntities, htmlToText } from "../html.ts";
import { type Job, type Pay, saysRemote, splitLocations } from "../job.ts";
import { getJson, type SearchOptions, type SearchQuery, type SearchResult, type SearchSource, SourceError } from "../source.ts";

const API = "https://data.usajobs.gov/api/search";
const SIGNUP = "https://developer.usajobs.gov/apirequest/";
const KEY_ENV = "USAJOBS_API_KEY";
const EMAIL_ENV = "USAJOBS_EMAIL";

/** USAJOBS allows 500 a page; ads carry long text, so we ask for fewer. */
const PAGE = 100;
const DEFAULT_LIMIT = 50;
/** Three pages at most per search. */
const MAX_LIMIT = 300;
const PAUSE_MS = 300;

const Text = z.string().nullish().catch(undefined);
const Named = z.object({ Name: Text, Code: Text }).passthrough();
const list = <T extends z.ZodTypeAny>(item: T) => z.array(z.unknown()).nullish().catch(undefined).transform((xs) =>
  (xs ?? []).flatMap((x) => {
    const r = item.safeParse(x);
    return r.success ? [r.data as z.infer<T>] : [];
  }),
);
/** A yes/no as USAJOBS may send it: true, "True", "true". */
const Flag = z.union([z.boolean(), z.string()]).nullish().catch(undefined).transform((v) => (typeof v === "string" ? /^(true|yes|y)$/i.test(v.trim()) : v ?? undefined));

const Details = z.object({
  JobSummary: Text,
  MajorDuties: z.union([z.array(z.unknown()), z.string()]).nullish().catch(undefined),
  WhoMayApply: Named.nullish().catch(undefined),
  LowGrade: Text,
  HighGrade: Text,
  PromotionPotential: Text,
  // Not in the documented response, but seen in announcements: read when there, ignored when not.
  HiringPath: z.union([z.array(z.unknown()), z.string()]).nullish().catch(undefined),
  SecurityClearance: Text,
  TeleworkEligible: Flag,
  RemoteIndicator: Flag,
}).passthrough();

const UsaJob = z.object({
  MatchedObjectId: z.union([z.string().min(1), z.number()]),
  MatchedObjectDescriptor: z.object({
    PositionTitle: z.string(),
    PositionURI: z.string().url(),
    PositionLocationDisplay: Text,
    PositionLocation: list(z.object({ LocationName: Text }).passthrough()),
    OrganizationName: Text,
    DepartmentName: Text,
    JobGrade: list(z.object({ Code: Text }).passthrough()),
    PositionSchedule: list(Named),
    PositionOfferingType: list(Named),
    QualificationSummary: Text,
    PositionRemuneration: list(z.object({
      MinimumRange: z.union([z.string(), z.number()]).nullish(),
      MaximumRange: z.union([z.string(), z.number()]).nullish(),
      RateIntervalCode: Text,
      Description: Text,
    }).passthrough()),
    PublicationStartDate: Text,
    ApplicationCloseDate: Text,
    UserArea: z.object({ Details: Details.nullish().catch(undefined) }).passthrough().nullish().catch(undefined),
  }).passthrough(),
});
type UsaJob = z.infer<typeof UsaJob>;

// Items are checked one by one, so one odd ad doesn't lose the rest.
const UsaPage = z.object({
  SearchResult: z.object({
    SearchResultCountAll: z.union([z.number(), z.string()]).nullish(),
    SearchResultItems: z.array(z.unknown()).nullish(),
  }),
});

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

/**
 * The pay periods we can say, from USAJOBS's own code list
 * (api/codelist/remunerationrateintervalcodes), by code or by its wording,
 * since the search may send either. Other codes (bi-weekly, fee basis, piece
 * work, school year, stipend) have no period of ours: the pay is kept with
 * the code's wording as its label, and no period. "Without Compensation" is
 * no pay at all.
 */
const PERIOD: Record<string, Pay["period"]> = { pa: "year", "per year": "year", pm: "month", "per month": "month", pd: "day", "per day": "day", ph: "hour", "per hour": "hour" };
const OTHER: Record<string, string> = { bw: "Bi-weekly", fb: "Fee Basis", pw: "Piece Work", st: "Student Stipend Paid", sy: "School Year" };
const UNPAID = new Set(["wc", "without compensation"]);

const amount = (v: string | number | null | undefined): number | undefined => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Federal pay is in US dollars; the API has no currency field because there's only one. */
function payOf(d: UsaJob["MatchedObjectDescriptor"]): Pay[] {
  const out: Pay[] = [];
  for (const r of d.PositionRemuneration) {
    const code = clean(r.RateIntervalCode ?? "").toLowerCase();
    if (UNPAID.has(code)) continue;
    const min = amount(r.MinimumRange);
    const max = amount(r.MaximumRange);
    if (!min && !max) continue;
    const period = PERIOD[code];
    const label = period ? undefined : OTHER[code] ?? (Object.values(OTHER).find((v) => v.toLowerCase() === code));
    const p: Pay = { ...(min ? { min } : {}), ...(max ? { max } : {}), currency: "USD", ...(period ? { period } : {}), ...(label ? { label } : {}) };
    if (!out.some((q) => JSON.stringify(q) === JSON.stringify(p))) out.push(p);
  }
  return out;
}

/** The documented hiring paths, in USAJOBS's own words. Unknown ones are shown as sent. */
const HIRING_PATH: Record<string, string> = {
  public: "The public",
  vet: "Veterans",
  nguard: "National Guard and Reserves",
  disability: "Individuals with disabilities",
  native: "Native Americans",
  mspouse: "Military spouses",
  student: "Students",
  ses: "Senior executives",
  peace: "Peace Corps and AmeriCorps VISTA",
  overseas: "Family of overseas employees",
  "fed-internal-search": "Internal to an agency",
  graduates: "Recent graduates",
  "fed-excepted": "Federal employees, excepted service",
  "fed-competitive": "Federal employees, competitive service",
  "fed-transition": "Career transition (CTAP, ICTAP, RPL)",
  land: "Land and base management",
  "special-authorities": "Special authorities",
};

const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).flatMap((x) => (typeof x === "string" && clean(x) ? [clean(x)] : []));

/**
 * The key facts about a federal job that Job has no field for, as lines to
 * end the description with. Only what the ad says.
 */
function factsOf(d: UsaJob["MatchedObjectDescriptor"], det: z.infer<typeof Details> | undefined | null): string[] {
  const facts: string[] = [];
  const plan = d.JobGrade.map((g) => clean(g.Code ?? "")).find(Boolean);
  const low = clean(det?.LowGrade ?? "");
  const high = clean(det?.HighGrade ?? "");
  const grades = low && high && low !== high ? `${low}–${high}` : low || high;
  if (plan || grades) facts.push(`Grade: ${[plan, grades].filter(Boolean).join(" ")}`);
  const promo = clean(det?.PromotionPotential ?? "");
  if (promo) facts.push(`Promotion potential: ${promo}`);
  const who = clean(det?.WhoMayApply?.Name ?? "");
  if (who) facts.push(`Who may apply: ${who}`);
  const paths = strings(det?.HiringPath).map((p) => HIRING_PATH[p.toLowerCase()] ?? p);
  if (paths.length) facts.push(`Hiring paths: ${paths.join("; ")}`);
  const clearance = clean(det?.SecurityClearance ?? "");
  if (clearance) facts.push(`Security clearance: ${clearance}`);
  if (det?.TeleworkEligible !== undefined) facts.push(`Telework eligible: ${det.TeleworkEligible ? "yes" : "no"}`);
  const schedule = d.PositionSchedule.map((s) => clean(s.Name ?? "")).filter(Boolean);
  if (schedule.length) facts.push(`Schedule: ${schedule.join(", ")}`);
  const offering = d.PositionOfferingType.map((s) => clean(s.Name ?? "")).filter(Boolean);
  if (offering.length) facts.push(`Appointment: ${offering.join(", ")}`);
  const closes = clean(d.ApplicationCloseDate ?? "");
  if (closes) facts.push(`Closes: ${closes}`);
  return facts;
}

const isUsajobsPage = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && /(^|\.)usajobs\.gov$/i.test(u.hostname);
  } catch {
    return false;
  }
};

const textOf = (s: string | null | undefined) => (s ? htmlToText(s) : "");

function toJob(a: UsaJob): Job | undefined {
  const d = a.MatchedObjectDescriptor;
  const title = clean(d.PositionTitle);
  const company = clean(d.OrganizationName ?? "") || clean(d.DepartmentName ?? "");
  if (!title || !company) return undefined;
  // The terms point people to the official announcement, on USAJOBS.
  if (!isUsajobsPage(d.PositionURI)) return undefined;
  const det = d.UserArea?.Details;
  const locations = splitLocations(...d.PositionLocation.map((l) => clean(l.LocationName ?? "")));
  if (!locations.length && d.PositionLocationDisplay) locations.push(...splitLocations(clean(d.PositionLocationDisplay)));
  // Remote only when the ad says so: USAJOBS's remote flag, or "remote" in a location
  // ("Anywhere in the U.S. (remote job)"). Telework eligible isn't remote; it's listed in the facts.
  const remote = det?.RemoteIndicator === true || saysRemote(locations);
  const department = clean(d.DepartmentName ?? "");
  const duties = strings(det?.MajorDuties).map(htmlToText).filter(Boolean);
  const facts = factsOf(d, det);
  const description = [
    textOf(det?.JobSummary),
    duties.length ? `Duties:\n${duties.map((x) => (x.includes("\n") ? x : `- ${x}`)).join("\n")}` : "",
    textOf(d.QualificationSummary) ? `Qualifications:\n${textOf(d.QualificationSummary)}` : "",
    facts.join("\n"),
  ].filter(Boolean).join("\n\n");
  return {
    id: `usajobs:us:${a.MatchedObjectId}`,
    source: "usajobs",
    board: "us",
    company,
    title,
    locations,
    ...(remote ? { remote: true as const } : {}),
    url: d.PositionURI,
    ...(department && department !== company ? { department } : {}),
    ...(d.PublicationStartDate ? { postedAt: d.PublicationStartDate } : {}),
    pay: payOf(d),
    ...(description ? { description } : {}),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The message with the key and email taken out, in case anything below us ever repeats them. */
function redact(message: string, secrets: string[]): string {
  let m = message;
  for (const s of secrets) if (s) m = m.split(s).join("[hidden]").split(encodeURIComponent(s)).join("[hidden]");
  return m;
}

async function search(query: SearchQuery, opts: SearchOptions = {}): Promise<SearchResult> {
  const env = opts.env ?? {};
  const key = env[KEY_ENV]?.trim();
  const email = env[EMAIL_ENV]?.trim();
  if (!key || !email) {
    const missing = [!key && KEY_ENV, !email && EMAIL_ENV].filter(Boolean).join(" and ");
    throw new SourceError(`USAJOBS needs a free key. Get one at ${SIGNUP}, then set ${missing} in your environment (${EMAIL_ENV} is the email you asked for the key with).`);
  }
  // Never repeat the value: only say what's wrong with it.
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new SourceError(`${EMAIL_ENV} doesn't look like an email address. USAJOBS wants the one you asked for the key with.`);
  const country = (query.country ?? "us").trim().toLowerCase();
  if (country !== "us") throw new SourceError(`USAJOBS only covers US federal jobs ("us"), not "${country}"`);
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const perPage = Math.min(PAGE, limit);
  const pause = opts.pauseMs ?? PAUSE_MS;
  const what = "USAJOBS";

  // USAJOBS demands the person's own email as the User-Agent (it's how they know who
  // holds the key), so this is the one source that replaces ours. Only ever with the
  // value the person set in USAJOBS_EMAIL; never a default. The Host header their docs
  // list is the URL's own host, which fetch sends by itself.
  const headers = { "user-agent": email, "authorization-key": key };

  const jobs: Job[] = [];
  let count = 0;
  /** Entries read, ads or not: what tells us whether we stopped before the end. */
  let seen = 0;
  for (let page = 1; seen < limit; page++) {
    if (page > 1 && pause > 0) await sleep(pause);
    const params = new URLSearchParams();
    if (query.what.trim()) params.set("Keyword", query.what.trim());
    if (query.where?.trim()) params.set("LocationName", query.where.trim());
    params.set("ResultsPerPage", String(perPage));
    params.set("Page", String(page));
    let raw: unknown;
    try {
      raw = await getJson(`${API}?${params}`, what, opts, headers);
    } catch (e) {
      if (e instanceof SourceError) throw new SourceError(redact(e.message, [key, email]));
      throw new SourceError(`couldn't reach ${what}`);
    }
    if (raw === null) throw new SourceError(`${what} has no such search (404)`);
    const parsed = UsaPage.safeParse(raw);
    if (!parsed.success) throw new SourceError(`${what} sent jobs in a shape we don't recognise`);
    const items = parsed.data.SearchResult.SearchResultItems ?? [];
    if (page === 1) count = Number(parsed.data.SearchResult.SearchResultCountAll ?? 0) || 0;
    const batch = items.slice(0, limit - seen);
    seen += batch.length;
    for (const item of batch) {
      const a = UsaJob.safeParse(item);
      const job = a.success ? toJob(a.data) : undefined;
      if (job) jobs.push(job);
    }
    if (items.length < perPage || seen >= count) break;
  }
  return {
    source: "usajobs",
    query: { ...query, country },
    jobs,
    ...(count > seen ? { totalAds: count } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export const usajobs: SearchSource = {
  id: "usajobs",
  name: "USAJOBS",
  covers: "US federal government jobs, from the official board",
  places: true,
  countries: ["us"],
  keys: { env: [KEY_ENV, EMAIL_ENV], signup: SIGNUP },
  // The terms encourage naming USAJOBS and linking to the official announcement (each job's url),
  // and saying a product isn't endorsed by OPM.
  credit: "Jobs from USAJOBS (https://www.usajobs.gov). Not endorsed by OPM; check each official announcement.",
  search,
};
