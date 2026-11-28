/**
 * levels.fyi: pay that people add themselves, by company, level and place,
 * and open jobs with the pay their ads state. Read through levels.fyi's own
 * MCP server, https://mcp.levels.fyi/, on its free tier: no sign-in, 20 calls
 * a minute shared by everyone not signed in (tried in November 2026). Pay by
 * level outside about 40 big tech companies needs a levels.fyi sign-in, which
 * ojs doesn't do yet; it says so instead.
 *
 * Its terms allow personal, non-commercial use only, with no bulk or
 * systematic retrieval and no compiling of datasets, and ask for the credit
 * "Data source: Levels.fyi". So ojs only asks when the person asks: one search
 * or one pay question at a time, never in a background scan.
 *
 * Its tools take slugs, not words: a place, a role or a company is looked up
 * first ("London" is "london-metro-area"). Every amount is yearly, in US
 * dollars, converted by levels.fyi where the ad or person gave another currency.
 */
import { z } from "zod";
import { decodeEntities } from "../html.ts";
import type { Job, Pay } from "../job.ts";
import { connectMcp, type McpSession, SignInNeeded } from "../mcp.ts";
import type { FetchOptions, SearchOptions, SearchQuery, SearchResult, SearchSource } from "../source.ts";
import { SourceError } from "../source.ts";

const MCP_URL = "https://mcp.levels.fyi/";
const WHAT = "levels.fyi";
export const LEVELSFYI_CREDIT = "Data source: Levels.fyi (https://www.levels.fyi)";
/** Companies per page, the most search-jobs takes; each brings up to 2 jobs. */
const COMPANIES_PER_PAGE = 25;
const DEFAULT_LIMIT = 50;
/** Three pages at most per search: the free tier is 20 calls a minute, shared. */
const MAX_LIMIT = 150;
const PAUSE_MS = 1000;
/** levels.fyi compares at most this many companies at once. */
const MAX_COMPANIES = 5;

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** levels.fyi's link without the tracking tags it adds. */
function cleanLink(link: string): string {
  const u = new URL(link);
  for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
  return u.toString();
}

// ---------------------------------------------------------------- looking up names

const Named = z.object({ slug: z.string().min(1), displayValue: z.string().nullish(), name: z.string().nullish(), type: z.string().nullish() });

/** The first of a search tool's matches, as {slug, name}; undefined when there are none. */
async function first(mcp: McpSession, tool: string, searchText: string): Promise<{ slug: string; name: string } | undefined> {
  const raw = await mcp.callTool(tool, { searchText, limit: 1 });
  const list = z.array(z.unknown()).safeParse(raw);
  if (!list.success) throw new SourceError(`${WHAT} sent ${tool} results in a shape we don't recognise`);
  for (const item of list.data) {
    const n = Named.safeParse(item);
    if (n.success) return { slug: n.data.slug, name: clean(n.data.displayValue ?? n.data.name ?? n.data.slug) };
  }
  return undefined;
}

async function placeSlug(mcp: McpSession, where: string): Promise<{ slug: string; name: string }> {
  const place = await first(mcp, "search-locations", where);
  if (!place) throw new SourceError(`${WHAT} doesn't know a place called "${where}". Try a city or country name on its own ("Cambridge", not "Cambridge, MA").`);
  return place;
}

// ---------------------------------------------------------------- the job board

const LfJob = z.object({
  jobId: z.string().min(1),
  title: z.string(),
  company: z.string().nullish(),
  locations: z.array(z.string()).nullish(),
  workArrangement: z.string().nullish(),
  postedAt: z.string().nullish(),
  baseSalaryRange: z.object({ min: z.number().nullish(), max: z.number().nullish(), currency: z.string().nullish() }).nullish(),
  totalCompensationRange: z.object({ min: z.number().nullish(), max: z.number().nullish(), currency: z.string().nullish() }).nullish(),
  url: z.string().url(),
  applyUrl: z.string().nullish(),
});

const LfPage = z.object({ jobs: z.array(z.unknown()), totalMatchingJobs: z.number().nullish(), nextOffset: z.number().nullish() });

/** The ad's base pay, or its total pay when that's all there is; yearly, as levels.fyi gives it. */
function payOf(j: z.infer<typeof LfJob>): Pay[] {
  for (const [range, label] of [
    [j.baseSalaryRange, "Base pay, yearly, in US dollars as levels.fyi gives it"],
    [j.totalCompensationRange, "Total pay, yearly, in US dollars as levels.fyi gives it"],
  ] as const) {
    const currency = range?.currency?.trim().toUpperCase();
    const min = range?.min && range.min > 0 ? range.min : undefined;
    const max = range?.max && range.max > 0 ? range.max : undefined;
    if (currency && /^[A-Z]{3}$/.test(currency) && (min || max)) return [{ ...(min ? { min } : {}), ...(max ? { max } : {}), currency, period: "year", label }];
  }
  return [];
}

export function toJob(j: z.infer<typeof LfJob>): Job | undefined {
  const company = clean(j.company ?? "");
  const title = clean(j.title);
  if (!company || !title) return undefined;
  const locations = (j.locations ?? []).map(clean).filter(Boolean);
  const arrangement = clean(j.workArrangement ?? "");
  return {
    id: `levelsfyi:jobs:${j.jobId}`,
    source: "levelsfyi",
    board: "jobs",
    company,
    title,
    locations,
    ...(/^remote$/i.test(arrangement) || locations.some((l) => /\bremote\b/i.test(l)) ? { remote: true as const } : {}),
    // The levels.fyi page shows the pay and links to where the ad is (often LinkedIn or the company's site).
    url: cleanLink(j.url),
    ...(j.postedAt ? { postedAt: j.postedAt } : {}),
    pay: payOf(j),
    ...(arrangement ? { signals: [arrangement[0]!.toUpperCase() + arrangement.slice(1)] } : {}),
  };
}

async function search(query: SearchQuery, opts: SearchOptions = {}): Promise<SearchResult> {
  const words = query.what.trim();
  if (!words) throw new SourceError("what should we look for on levels.fyi? Give some words, like a job title.");
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const pause = opts.pauseMs ?? PAUSE_MS;
  const mcp = await connectMcp(MCP_URL, WHAT, opts);
  const where = query.where?.trim();
  const place = where ? await placeSlug(mcp, where) : undefined;

  const jobs: Job[] = [];
  const ids = new Set<string>();
  let total = 0;
  let offset: number | undefined;
  for (let page = 0; jobs.length < limit; page++) {
    if (pause > 0 && (page > 0 || place)) await sleep(pause);
    const raw = await mcp.callTool("search-jobs", {
      query: words,
      ...(place ? { locationSlug: place.slug } : {}),
      limit: COMPANIES_PER_PAGE,
      ...(offset !== undefined ? { offset } : {}),
    });
    const parsed = LfPage.safeParse(raw);
    if (!parsed.success) throw new SourceError(`${WHAT} sent jobs in a shape we don't recognise`);
    if (page === 0) total = parsed.data.totalMatchingJobs ?? 0;
    for (const item of parsed.data.jobs) {
      const j = LfJob.safeParse(item);
      const job = j.success ? toJob(j.data) : undefined;
      if (job && !ids.has(job.id) && jobs.length < limit) {
        ids.add(job.id);
        jobs.push(job);
      }
    }
    const next = parsed.data.nextOffset;
    if (next == null || next === offset || parsed.data.jobs.length === 0) break;
    offset = next;
  }
  return {
    source: "levelsfyi",
    query: { ...query, ...(place ? { where: place.name } : {}) },
    jobs,
    ...(total > jobs.length ? { totalAds: total } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export const levelsfyi: SearchSource = {
  id: "levelsfyi",
  name: "levels.fyi",
  covers: "Tech jobs worldwide with the pay their ads state, in US dollars",
  places: true,
  credit: LEVELSFYI_CREDIT,
  search,
};

// ---------------------------------------------------------------- pay

/**
 * Words that say a level, not a role. levels.fyi's roles are families
 * ("Software Engineer") with no level in them, and its free tier can't narrow
 * a median by level, so these are taken off the role and reported back.
 */
const LEVEL_WORDS = /\b(?:junior|jr|graduate|grad|entry[- ]level|intern|mid[- ]level|mid|intermediate|senior|sr|staff|principal|lead|distinguished|fellow|associate|chief|head of|i{1,3}|iv|v)\b\.?/gi;

/** The role without level words, and the level words found ("principal software engineer" → "software engineer", "principal"). */
export function splitLevel(role: string): { role: string; level?: string } {
  const found = role.match(LEVEL_WORDS)?.map((w) => w.replace(/\.$/, "").toLowerCase()) ?? [];
  const rest = role.replace(LEVEL_WORDS, " ").replace(/\s+/g, " ").trim();
  return rest && found.length ? { role: rest, level: found.join(" ") } : { role: role.trim() };
}

export interface PayQuestion {
  /** A role as people say it: "software engineer", "product manager". */
  role: string;
  /** A place as people write it: "London". */
  where: string;
  /** Companies to see pay by level at, at most five. Without them: the median for the role there. */
  companies?: string[];
}

export interface LevelPay {
  /** The company's own name for the level: "L5". */
  level: string;
  /** Another name it goes by: "Senior SWE". */
  alsoCalled?: string;
  median?: number;
  p10?: number;
  p90?: number;
  average?: number;
  averageBase?: number;
  averageStockPerYear?: number;
  averageBonus?: number;
}

export interface CompanyPay {
  /** As the person wrote it. */
  asked: string;
  /** levels.fyi's name and slug for it, when found. */
  company?: string;
  slug?: string;
  /** Lowest level first. Empty when levels.fyi has no level data for it there. */
  levels: LevelPay[];
  /** Why there are no levels, when it isn't just no data: not found, or needs a sign-in. */
  note?: string;
}

export interface PayAnswer {
  source: "levelsfyi";
  role: { name: string; slug: string };
  /** The level words taken off the role ("principal"). The median isn't narrowed by them: levels.fyi's free tier can't. Pay by level is per company. */
  levelAsked?: string;
  place: { name: string; slug: string };
  /** Every amount: yearly total pay (base, stock and bonus), in US dollars. */
  currency: "USD";
  /** Without companies: the median for the role in the place, all levels together; null when too few people added theirs. */
  median?: number | null;
  /** The time the median covers, as levels.fyi says it: "the last 12 months". */
  window?: string;
  companies?: CompanyPay[];
  credit: string;
  fetchedAt: string;
}

const Percentiles = z.object({
  window: z.string().nullish(),
  locations: z.array(z.object({ locationSlug: z.string(), medianTotalCompensation: z.number().nullish() })),
});

const num = z.number().nullish();
const ByLevel = z.object({
  companies: z.array(
    z.object({
      companySlug: z.string(),
      levels: z.array(
        z.object({
          level: z.string(),
          secondaryLevelName: z.string().nullish(),
          medianTotalCompensation: num,
          p10TotalCompensation: num,
          p90TotalCompensation: num,
          averageTotalCompensation: num,
          averageBaseSalary: num,
          averageStockPerYear: num,
          averageBonus: num,
        }),
      ),
    }),
  ),
});

const round = (n: number | null | undefined) => (n == null ? undefined : Math.round(n));

function levelPay(l: z.infer<typeof ByLevel>["companies"][number]["levels"][number]): LevelPay {
  const out: LevelPay = { level: clean(l.level) };
  const also = clean(l.secondaryLevelName ?? "");
  if (also && also !== out.level) out.alsoCalled = also;
  const fields: [keyof LevelPay, number | null | undefined][] = [
    ["median", l.medianTotalCompensation],
    ["p10", l.p10TotalCompensation],
    ["p90", l.p90TotalCompensation],
    ["average", l.averageTotalCompensation],
    ["averageBase", l.averageBaseSalary],
    ["averageStockPerYear", l.averageStockPerYear],
    ["averageBonus", l.averageBonus],
  ];
  for (const [k, v] of fields) if (round(v) !== undefined) (out as unknown as Record<string, number>)[k] = round(v)!;
  return out;
}

/**
 * What a role pays in a place, from levels.fyi: the median, or pay by level at
 * up to five companies. A few calls per question; never call it in a loop over
 * many companies, which levels.fyi's terms forbid.
 */
export async function lookUpPay(q: PayQuestion, opts: FetchOptions = {}): Promise<PayAnswer> {
  const { role, level } = splitLevel(q.role);
  const where = q.where.trim();
  if (!role) throw new SourceError("which role? For example: software engineer.");
  if (!where) throw new SourceError("where? Pay depends on the place: give a city or country.");
  const asked = (q.companies ?? []).map((c) => c.trim()).filter(Boolean);
  if (asked.length > MAX_COMPANIES) throw new SourceError(`levels.fyi compares at most ${MAX_COMPANIES} companies at once.`);

  const mcp = await connectMcp(MCP_URL, WHAT, opts);
  const family = await first(mcp, "search-job-families", role);
  if (!family) throw new SourceError(`${WHAT} has no role like "${role}". Try a broader name, like "software engineer" or "product manager".`);
  const place = await placeSlug(mcp, where);
  const base = { source: "levelsfyi" as const, role: family, ...(level ? { levelAsked: level } : {}), place, currency: "USD" as const, credit: LEVELSFYI_CREDIT };

  if (!asked.length) {
    const raw = await mcp.callTool("get-salary-percentiles", { jobFamilySlug: family.slug, locationSlugs: [place.slug] });
    const p = Percentiles.safeParse(raw);
    if (!p.success) throw new SourceError(`${WHAT} sent pay in a shape we don't recognise`);
    const median = p.data.locations.find((l) => l.locationSlug === place.slug)?.medianTotalCompensation;
    return { ...base, median: median == null ? null : Math.round(median), ...(p.data.window ? { window: p.data.window } : {}), fetchedAt: new Date().toISOString() };
  }

  // One company per call: a company that needs a sign-in then doesn't hide the others.
  const companies: CompanyPay[] = [];
  for (const name of asked) {
    const found = await first(mcp, "search-companies", name);
    if (!found) {
      companies.push({ asked: name, levels: [], note: `${WHAT} doesn't know this company` });
      continue;
    }
    const entry: CompanyPay = { asked: name, company: found.name, slug: found.slug, levels: [] };
    try {
      const raw = await mcp.callTool("get-salaries-by-company-level", { jobFamilySlug: family.slug, locationSlug: place.slug, companySlugs: [found.slug] });
      const b = ByLevel.safeParse(raw);
      if (!b.success) throw new SourceError(`${WHAT} sent pay in a shape we don't recognise`);
      entry.levels = (b.data.companies.find((c) => c.companySlug === found.slug)?.levels ?? []).map(levelPay);
      if (!entry.levels.length) entry.note = "no pay by level for this role here yet";
    } catch (e) {
      if (!(e instanceof SignInNeeded)) throw e;
      entry.note = "levels.fyi shows pay by level for this company only to people signed in to it";
    }
    companies.push(entry);
  }
  return { ...base, companies, fetchedAt: new Date().toISOString() };
}
