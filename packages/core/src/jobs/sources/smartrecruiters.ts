/**
 * SmartRecruiters: every company's public job board, through its documented
 * Posting API (no key needed for public postings).
 * https://developers.smartrecruiters.com/reference/v1listpostings
 *
 *   GET https://api.smartrecruiters.com/v1/companies/{company}/postings?limit=100&offset=0
 *
 * Boards live at jobs.smartrecruiters.com/{Company} (or careers.smartrecruiters.com).
 * The API doesn't mind the case of the company name ("Acme" and "acme" are the
 * same board), so names are kept in lower case like other sources.
 */
import { z } from "zod";
import { decodeEntities } from "../html.ts";
import { type BoardResult, type Job, saysRemote, splitLocations } from "../job.ts";
import { asUrl, type BoardSource, type FetchOptions, getJson, isBoardName, SourceError } from "../source.ts";

const API = "https://api.smartrecruiters.com/v1/companies";
/** The most the API sends in one page. */
const PAGE = 100;
/**
 * Stop after this many jobs (20 pages), so a huge board can't keep us asking for ever.
 * The API lists the newest first, so a very large board keeps its newest 2000.
 */
const MAX_JOBS = 2000;

const SrLabel = z.object({ label: z.string().nullish() }).nullish();

const SrPosting = z.object({
  id: z.string(),
  name: z.string(),
  releasedDate: z.string().nullish(),
  company: z.object({ identifier: z.string().nullish(), name: z.string().nullish() }).nullish(),
  location: z
    .object({
      city: z.string().nullish(),
      region: z.string().nullish(),
      country: z.string().nullish(),
      fullLocation: z.string().nullish(),
      remote: z.boolean().nullish(),
    })
    .nullish(),
  department: SrLabel,
  function: SrLabel,
});

const SrPage = z.object({ totalFound: z.number(), content: z.array(SrPosting) });

const HOSTS = /^(jobs|careers)\.smartrecruiters\.com$/i;

function parseBoard(input: string): string | undefined {
  const s = input.trim();
  const url = asUrl(s);
  if (!url) return isBoardName(s) ? s.toLowerCase() : undefined;
  if (!HOSTS.test(url.hostname)) return undefined;
  // jobs.smartrecruiters.com/Acme, /Acme/123-staff-engineer, or careers.smartrecruiters.com/Acme
  const first = url.pathname.split("/").filter(Boolean)[0];
  return first && isBoardName(first) ? first.toLowerCase() : undefined;
}

function locationsOf(l: z.infer<typeof SrPosting>["location"]): string[] {
  if (!l) return [];
  if (l.fullLocation?.trim()) return splitLocations(l.fullLocation);
  // Country is a two-letter code ("gb"); written as the ad would: "London, England, GB".
  const parts = [l.city, l.region, l.country?.toUpperCase()].map((p) => p?.trim()).filter((p): p is string => !!p);
  return splitLocations([...new Set(parts)].join(", "));
}

function toJob(board: string, company: string, p: z.infer<typeof SrPosting>): Job {
  const locations = locationsOf(p.location);
  const department = p.department?.label?.trim() || p.function?.label?.trim();
  // The list doesn't carry the ad's link; this is the link SmartRecruiters itself gives as postingUrl, minus the title slug it ignores.
  const slug = p.company?.identifier?.trim() || board;
  return {
    id: `smartrecruiters:${board}:${p.id}`,
    source: "smartrecruiters",
    board,
    company: p.company?.name?.trim() || company,
    title: decodeEntities(p.name).replace(/\s+/g, " ").trim(),
    locations,
    ...(p.location?.remote || saysRemote(locations) ? { remote: true as const } : {}),
    url: `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(p.id)}`,
    ...(department ? { department } : {}),
    ...(p.releasedDate ? { postedAt: p.releasedDate } : {}),
    // The Posting API has no pay fields, so none are guessed.
    pay: [],
    // No description: the list has no ad text, and getting it means one more call per job
    // (hundreds on a big board). Judging only needs titles, and the link has the full ad.
  };
}

async function fetchBoard(board: string, opts: FetchOptions = {}): Promise<BoardResult> {
  if (!isBoardName(board)) throw new SourceError(`"${board}" isn't a SmartRecruiters company name`);
  const what = `SmartRecruiters (company "${board}")`;
  const postings: z.infer<typeof SrPosting>[] = [];
  let total = 0;
  for (let offset = 0; offset < MAX_JOBS; offset += PAGE) {
    const raw = await getJson(`${API}/${encodeURIComponent(board)}/postings?limit=${PAGE}&offset=${offset}`, what, opts);
    if (raw === null) throw new SourceError(`SmartRecruiters has no company called "${board}". Check the name in the company's job links (jobs.smartrecruiters.com/<company>).`);
    const parsed = SrPage.safeParse(raw);
    if (!parsed.success) throw new SourceError(`${what} sent jobs in a shape we don't recognise`);
    postings.push(...parsed.data.content);
    total = parsed.data.totalFound;
    if (parsed.data.content.length < PAGE || postings.length >= parsed.data.totalFound) break;
  }
  // A company name SmartRecruiters doesn't know comes back as an empty list, the same as a
  // company with no open jobs, so we can't tell the two apart: either way it's an empty board.
  const jobs = postings.slice(0, MAX_JOBS);
  const company = postings.find((p) => p.company?.name)?.company?.name?.trim() || board;
  return {
    source: "smartrecruiters",
    board,
    company,
    jobs: jobs.map((p) => toJob(board, company, p)),
    ...(total > jobs.length ? { totalAds: total } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export const smartrecruiters: BoardSource = {
  id: "smartrecruiters",
  name: "SmartRecruiters",
  boardHint: "the company name, or a link like jobs.smartrecruiters.com/Acme",
  parseBoard,
  fetchBoard,
};
