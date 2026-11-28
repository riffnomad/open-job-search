/**
 * Dice: a US job board for tech roles. Read through Dice's own MCP server,
 * https://mcp.dice.com/mcp, which needs no sign-in or key (tried in November
 * 2026). Its search_jobs tool takes words, a place, filters and pages of up to
 * 100 jobs, and says how many match.
 *
 * Dice has US jobs only. Given a place elsewhere ("London") it answers with
 * US remote jobs, so we stop and say so rather than show those as London's.
 *
 * Dice's tool asks that results shown to people say they were found with AI
 * help and should be checked with the employer; that's in the credit. It
 * also puts our user agent in its links as a tracking tag, which we take out.
 * Dice publishes no terms for its MCP server that we could find, and names
 * no rate limit: we read few pages and pause between them.
 *
 * Its get_job_details tool has the full ad and skills, one call per job: for
 * the few jobs a person keeps, later, not for every search.
 */
import { z } from "zod";
import { decodeEntities } from "../html.ts";
import type { Job } from "../job.ts";
import { connectMcp } from "../mcp.ts";
import type { SearchOptions, SearchQuery, SearchResult, SearchSource } from "../source.ts";
import { SourceError } from "../source.ts";
import { parseSalary } from "./remotive.ts";

const MCP_URL = "https://mcp.dice.com/mcp";
const COUNTRIES = ["us"];
/** The most search_jobs sends in one page. */
const PAGE = 100;
const DEFAULT_LIMIT = 100;
/** Three pages at most per search. */
const MAX_LIMIT = 300;
const PAUSE_MS = 500;

const DiceJob = z.object({
  guid: z.string().min(1),
  title: z.string(),
  summary: z.string().nullish(),
  postedDate: z.string().nullish(),
  modifiedDate: z.string().nullish(),
  jobLocation: z.object({ displayName: z.string().nullish() }).nullish(),
  detailsPageUrl: z.string().url(),
  salary: z.string().nullish(),
  companyName: z.string().nullish(),
  companyPageUrl: z.string().url().nullish(),
  companyLogoUrl: z.string().url().nullish(),
  employmentType: z.string().nullish(),
  employerType: z.string().nullish(),
  workplaceTypes: z.array(z.string()).nullish(),
  isRemote: z.boolean().nullish(),
  willingToSponsor: z.boolean().nullish(),
});

// Jobs are checked one by one, so one odd entry doesn't lose the rest.
const DicePage = z.object({
  data: z.array(z.unknown()),
  metadata: z
    .object({
      total: z.number().nullish(),
      searchedLocation: z.object({ countryCode2: z.string().nullish() }).nullish(),
    })
    .nullish(),
});

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

/** Dice's link without the tracking tags it adds. */
function cleanLink(link: string): string {
  const u = new URL(link);
  for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
  return u.toString();
}

export function toJob(d: z.infer<typeof DiceJob>): Job | undefined {
  const company = clean(d.companyName ?? "");
  const title = clean(d.title);
  if (!company || !title) return undefined;
  const place = clean(d.jobLocation?.displayName ?? "");
  const workplaces = (d.workplaceTypes ?? []).map(clean).filter(Boolean);
  const salary = clean(d.salary ?? "");
  const pay = parseSalary(salary);
  // The search sends only the start of the ad. Pay we couldn't read ("70 - 75", no currency) goes after it, as Dice wrote it.
  const description = [clean(d.summary ?? ""), salary && !pay ? `Pay, as Dice gives it: ${salary}` : ""].filter(Boolean).join("\n\n");
  const signals = [
    clean(d.employmentType ?? ""),
    ...workplaces,
    // Dice says whether a recruiter or the employer posted the ad; with a recruiter, the company may be theirs, not the hiring one.
    /^recruiter$/i.test(d.employerType ?? "") ? "Posted by a recruiter" : "",
    d.willingToSponsor ? "Willing to sponsor" : "",
  ].filter(Boolean);
  return {
    id: `dice:us:${d.guid}`,
    source: "dice",
    board: "us",
    company,
    title,
    locations: place ? [place] : [],
    ...(d.isRemote || workplaces.some((w) => /^remote$/i.test(w)) ? { remote: true as const } : {}),
    url: cleanLink(d.detailsPageUrl),
    ...(d.postedDate ? { postedAt: d.postedDate } : {}),
    ...(d.modifiedDate ? { updatedAt: d.modifiedDate } : {}),
    pay: pay ? [pay] : [],
    ...(description ? { description } : {}),
    ...(d.companyPageUrl ? { companyPage: d.companyPageUrl } : {}),
    ...(d.companyLogoUrl ? { companyLogo: d.companyLogoUrl } : {}),
    ...(signals.length ? { signals } : {}),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function search(query: SearchQuery, opts: SearchOptions = {}): Promise<SearchResult> {
  const words = query.what.trim();
  if (!words) throw new SourceError("what should we look for on Dice? Give some words, like a job title.");
  const country = (query.country ?? COUNTRIES[0]!).trim().toLowerCase();
  if (!COUNTRIES.includes(country)) throw new SourceError(`Dice only has jobs in the United States, not "${country}".`);
  const where = query.where?.trim();
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const perPage = Math.min(PAGE, limit);
  const pause = opts.pauseMs ?? PAUSE_MS;
  const what = "Dice";

  const dice = await connectMcp(MCP_URL, what, opts);
  const jobs: Job[] = [];
  const ids = new Set<string>();
  let total = 0;
  let seen = 0;
  for (let page = 1; seen < limit; page++) {
    if (page > 1 && pause > 0) await sleep(pause);
    const raw = await dice.callTool("search_jobs", {
      keyword: words,
      ...(where ? { location: where } : {}),
      jobs_per_page: perPage,
      page_number: page,
    });
    const parsed = DicePage.safeParse(raw);
    if (!parsed.success) throw new SourceError(`${what} sent jobs in a shape we don't recognise`);
    const code = parsed.data.metadata?.searchedLocation?.countryCode2?.trim().toUpperCase();
    if (where && code && code !== "US")
      throw new SourceError(`Dice only has jobs in the United States, and "${where}" is in ${code}. It would show US remote jobs instead, so we stopped there.`);
    if (page === 1) total = parsed.data.metadata?.total ?? 0;
    const list = parsed.data.data.slice(0, limit - seen);
    seen += list.length;
    for (const item of list) {
      const d = DiceJob.safeParse(item);
      const job = d.success ? toJob(d.data) : undefined;
      if (job && !ids.has(job.id)) {
        ids.add(job.id);
        jobs.push(job);
      }
    }
    if (parsed.data.data.length < perPage || seen >= total) break;
  }
  return {
    source: "dice",
    query: { ...query, country },
    jobs,
    ...(total > seen ? { totalAds: total } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export const dice: SearchSource = {
  id: "dice",
  name: "Dice",
  covers: "US tech jobs, from employers and recruiters, with visa sponsorship marked",
  places: true,
  countries: COUNTRIES,
  credit: "Jobs from Dice (https://www.dice.com), found with AI-assisted search: check the details with the employer before applying",
  search,
};
