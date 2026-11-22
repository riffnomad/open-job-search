/**
 * Workday: the careers sites many large employers run on Workday, at
 * {tenant}.wd{N}.myworkdayjobs.com/{site}.
 *
 * Unofficial. Workday publishes no jobs API for career sites; this reads the
 * same JSON the careers page itself loads, which needs no login or key:
 *
 *   POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 *        {"limit": 20, "offset": 0, "searchText": "", "appliedFacets": {}}
 *
 * It's undocumented, so it can change without notice. We read it gently: our
 * own name only (never a browser's), a pause between pages, a cap on how many
 * we read, and if Workday turns us away we stop and say so.
 *
 * The board is "tenant/wdN/site", e.g. "acme/wd5/AcmeCareers", or a link.
 */
import { z } from "zod";
import { decodeEntities } from "../html.ts";
import { type BoardResult, type Job, saysRemote, splitLocations } from "../job.ts";
import { asUrl, type BoardSource, type FetchOptions, isBoardName, postJson, SourceError } from "../source.ts";

/** The most Workday sends in one page; it refuses more. */
const PAGE = 20;
/**
 * Stop after this many jobs (50 pages). Workday lists the newest first, so a
 * very large board keeps its newest 1000.
 */
const MAX_JOBS = 1000;
/** Between pages, so a big board isn't read in a burst. */
const PAUSE_MS = 300;

const WdPosting = z.object({
  title: z.string(),
  externalPath: z.string(),
  locationsText: z.string().nullish(),
  postedOn: z.string().nullish(),
  remoteType: z.string().nullish(),
});

// Postings are checked one by one: some sites list entries with no title or link (only a requisition number), which aren't ads we can show.
const WdPage = z.object({ total: z.number().nullish(), jobPostings: z.array(z.unknown()).nullish() });

interface Board {
  tenant: string;
  /** "wd5" */
  pod: string;
  site: string;
}

const BARE = /^([a-z0-9][a-z0-9-]*)\/(wd\d+)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/i;
const HOST = /^([a-z0-9][a-z0-9-]*)\.(wd\d+)\.myworkdayjobs\.com$/i;
/** A locale at the start of the path: /en-US/AcmeCareers. */
const LOCALE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;

const boardName = (b: Board) => `${b.tenant}/${b.pod}/${b.site}`;

function splitBoard(board: string): Board | undefined {
  const m = BARE.exec(board.trim());
  return m ? { tenant: m[1]!.toLowerCase(), pod: m[2]!.toLowerCase(), site: m[3]! } : undefined;
}

function parseBoard(input: string): string | undefined {
  const s = input.trim();
  const bare = splitBoard(s);
  if (bare) return boardName(bare);
  const url = asUrl(s);
  const host = url && HOST.exec(url.hostname);
  if (!url || !host) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] && LOCALE.test(parts[0])) parts.shift();
  const site = parts[0];
  // The site name is case-sensitive, so it's kept as written.
  return site && isBoardName(site) ? boardName({ tenant: host[1]!.toLowerCase(), pod: host[2]!.toLowerCase(), site }) : undefined;
}

/** "Posted 3 Days Ago" as a date, counted back from when we read it. Left out when Workday only says "30+ Days". */
export function postedDate(text: string | null | undefined, now: Date): string | undefined {
  const t = (text ?? "").toLowerCase();
  const days = /\btoday\b/.test(t) ? 0 : /\byesterday\b/.test(t) ? 1 : /\b(\d+)\s+days?\s+ago\b/.exec(t)?.[1];
  if (days === undefined || /\+/.test(t)) return undefined;
  const d = new Date(now.getTime() - Number(days) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function toJob(b: Board, company: string, p: z.infer<typeof WdPosting>, now: Date): Job {
  // A job in several places only says "3 Locations" in the list; the places are in each ad.
  const text = p.locationsText?.trim() ?? "";
  const locations = /^\d+\s+locations?$/i.test(text) ? [] : splitLocations(text);
  const posted = postedDate(p.postedOn, now);
  const jobId = p.externalPath.split("/").filter(Boolean).pop() ?? p.externalPath;
  const board = boardName(b);
  return {
    id: `workday:${board}:${jobId}`,
    source: "workday",
    board,
    company,
    title: decodeEntities(p.title).replace(/\s+/g, " ").trim(),
    locations,
    // "Flex" and "Hybrid" mean some days in an office, so only "Remote" counts.
    ...(/^remote$/i.test(p.remoteType?.trim() ?? "") || saysRemote(locations) ? { remote: true as const } : {}),
    url: `https://${b.tenant}.${b.pod}.myworkdayjobs.com/${b.site}${p.externalPath}`,
    ...(posted ? { postedAt: posted } : {}),
    // Pay is only ever in the ad's text, and the text is one more call per job, so neither is read here.
    pay: [],
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchBoard(board: string, opts: FetchOptions = {}): Promise<BoardResult> {
  const b = splitBoard(board);
  if (!b) throw new SourceError(`"${board}" isn't a Workday board. Give tenant/wdN/site, or a link like acme.wd5.myworkdayjobs.com/AcmeCareers.`);
  const name = boardName(b);
  const what = `Workday (site "${name}")`;
  const api = `https://${b.tenant}.${b.pod}.myworkdayjobs.com/wday/cxs/${b.tenant}/${b.site}`;
  const pause = opts.pauseMs ?? PAUSE_MS;
  const postings: z.infer<typeof WdPosting>[] = [];
  let total = 0;
  /** Entries read, ads or not: what tells us whether we stopped before the end. */
  let seen = 0;
  for (let offset = 0; offset < MAX_JOBS; offset += PAGE) {
    if (offset > 0 && pause > 0) await sleep(pause);
    const raw = await postJson(`${api}/jobs`, { limit: PAGE, offset, searchText: "", appliedFacets: {} }, what, opts);
    if (raw === null) throw new SourceError(`Workday has no site at "${name}". Check the link to the company's careers site (<tenant>.wdN.myworkdayjobs.com/<site>).`);
    const parsed = WdPage.safeParse(raw);
    if (!parsed.success) throw new SourceError(`${what} sent jobs in a shape we don't recognise`);
    const list = parsed.data.jobPostings ?? [];
    // Workday only gives the total on the first page.
    if (offset === 0) total = parsed.data.total ?? 0;
    seen += list.length;
    for (const item of list) {
      const p = WdPosting.safeParse(item);
      if (p.success) postings.push(p.data);
    }
    if (list.length < PAGE || seen >= total) break;
  }
  const jobs = postings.slice(0, MAX_JOBS);
  // The list doesn't name the company, and each ad names the legal entity hiring (often a
  // subsidiary), so the board is named after the tenant: the name in the careers site's link.
  const company = b.tenant;
  const now = new Date();
  return {
    source: "workday",
    board: name,
    company,
    jobs: jobs.map((p) => toJob(b, company, p, now)),
    ...(total > seen ? { totalAds: total } : {}),
    fetchedAt: now.toISOString(),
  };
}

export const workday: BoardSource = {
  id: "workday",
  name: "Workday",
  boardHint: "tenant/wdN/site, or a link like acme.wd5.myworkdayjobs.com/AcmeCareers (unofficial)",
  parseBoard,
  fetchBoard,
};
