/**
 * LinkedIn: the biggest job board. Unofficial. LinkedIn has no job search API
 * open to the public; this reads the pages its own site loads for visitors who
 * aren't signed in:
 *
 *   GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
 *       ?keywords=…&location=…&start=…
 *
 * Each page is a short HTML list of job cards (about 10). No login, no key.
 *
 * LinkedIn's terms forbid "robots or other automated means" without its
 * permission, and its robots.txt asks crawlers to keep out of /jobs-guest/.
 * So this source is the one exception to our rule of reading only what a
 * site's terms allow, and it's off until the person switches it on
 * (`optIn`), after reading why. We keep it gentle: our own name on every
 * request (never a browser's), a pause between pages, few pages, the search
 * results only (never each job's page), and a full stop the first time
 * LinkedIn refuses (403, 429, or its own 999).
 */
import { decodeEntities, htmlToText } from "../html.ts";
import { type Job, saysRemote } from "../job.ts";
import { getText, type SearchOptions, type SearchQuery, type SearchResult, type SearchSource, SourceError } from "../source.ts";
import { parseSalary } from "./remotive.ts";

const API = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
/** Three pages unless asked for more. */
const DEFAULT_LIMIT = 30;
/** Ten pages at most per search. */
const MAX_LIMIT = 100;
const PAUSE_MS = 1500;
/** LinkedIn sends about 10 cards a page; a cap in case it ever sends the same ones over and over. */
const MAX_PAGES = 12;

const NOTICE =
  "LinkedIn's terms forbid automated access without its permission, and its robots.txt asks crawlers to keep out of the pages this reads. " +
  "ojs reads them anyway, gently: only the search results LinkedIn shows to anyone who isn't signed in, under our own name, a few pages at a time, " +
  "stopping the moment LinkedIn says no. Nothing is signed in, so your LinkedIn account isn't involved, but LinkedIn may block requests from your " +
  "internet connection for a while. For your own job search only.";

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

/** The text inside the first element with this class, tags taken out. */
function byClass(html: string, cls: string): string {
  const m = new RegExp(`<([a-z0-9]+)[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`, "i").exec(html);
  return m ? clean(htmlToText(m[2]!)) : "";
}

/** The company's LinkedIn page from the card's company link, on www and without tracking: "https://www.linkedin.com/company/acme". */
function companyPageOf(card: string): string | undefined {
  const sub = /class="[^"]*\bbase-search-card__subtitle\b[\s\S]*?<\/h4>/i.exec(card)?.[0] ?? "";
  const slug = /href="https:\/\/[a-z]{2,3}\.linkedin\.com\/company\/([^"/?#]+)/i.exec(sub)?.[1];
  return slug ? `https://www.linkedin.com/company/${slug}` : undefined;
}

/** The logo LinkedIn loads once the card is on screen (data-delayed-url); not its grey placeholder (data-ghost-url). */
function logoOf(card: string): string | undefined {
  const img = /<img\b[^>]*class="[^"]*\bartdeco-entity-image\b[^>]*>/i.exec(card)?.[0] ?? "";
  const url = /\bdata-delayed-url="(https:\/\/media\.licdn\.com\/[^"]+)"/i.exec(img)?.[1];
  return url ? decodeEntities(url) : undefined;
}

/** LinkedIn writes the period on both ends ("$120,000.00/yr - $150,000.00/yr"); keep it on the last only, when they match. */
function samePeriodOnce(s: string): string {
  const m = /^(.*?)(\/(?:yr|hr|mo|day))\s*([-–])\s*(.*?)(\/(?:yr|hr|mo|day))$/i.exec(s);
  return m && m[2]!.toLowerCase() === m[5]!.toLowerCase() ? `${m[1]} ${m[3]} ${m[4]}${m[5]}` : s;
}

/** One job card from a results page, or undefined when it's missing what every job needs. */
export function parseCard(card: string): Job | undefined {
  const id = /data-entity-urn="urn:li:jobPosting:(\d+)"/.exec(card)?.[1] ?? /\/jobs\/view\/[^"?]*?-?(\d{6,})(?:[/?"])/.exec(card)?.[1];
  if (!id) return undefined;
  const title = byClass(card, "base-search-card__title");
  const company = byClass(card, "base-search-card__subtitle");
  if (!title || !company) return undefined;
  const place = byClass(card, "job-search-card__location");
  const locations = place ? [place] : [];
  const postedAt = /<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/.exec(card)?.[1];
  const pay = parseSalary(samePeriodOnce(byClass(card, "job-search-card__salary-info")));
  const companyPage = companyPageOf(card);
  const companyLogo = logoOf(card);
  const signals = [...card.matchAll(/class="[^"]*\bjob-posting-benefits__text\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)].map((m) => clean(htmlToText(m[1]!))).filter(Boolean);
  return {
    id: `linkedin:jobs:${id}`,
    source: "linkedin",
    board: "jobs",
    company,
    title,
    locations,
    ...(saysRemote(locations) ? { remote: true as const } : {}),
    // The plain link, without the tracking LinkedIn adds to it.
    url: `https://www.linkedin.com/jobs/view/${id}`,
    ...(postedAt ? { postedAt } : {}),
    pay: pay ? [pay] : [],
    ...(companyPage ? { companyPage } : {}),
    ...(companyLogo ? { companyLogo } : {}),
    ...(signals.length ? { signals } : {}),
  };
}

/** Every job card on a results page, in order. */
export function parsePage(html: string): { cards: number; jobs: Job[] } {
  const cards = html.split(/<li\b[^>]*>/i).slice(1);
  const jobs: Job[] = [];
  for (const c of cards) {
    const job = parseCard(c);
    if (job) jobs.push(job);
  }
  return { cards: cards.length, jobs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function search(query: SearchQuery, opts: SearchOptions = {}): Promise<SearchResult> {
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const pause = opts.pauseMs ?? PAUSE_MS;
  const what = "LinkedIn";
  const jobs = new Map<string, Job>();
  let start = 0;
  for (let page = 0; jobs.size < limit && page < MAX_PAGES; page++) {
    if (page > 0 && pause > 0) await sleep(pause);
    const params = new URLSearchParams();
    if (query.what.trim()) params.set("keywords", query.what.trim());
    if (query.where?.trim()) params.set("location", query.where.trim());
    params.set("start", String(start));
    let html: string | null;
    try {
      html = await getText(`${API}?${params}`, what, opts, "text/html");
    } catch (e) {
      // LinkedIn's own "go away" is 999. We stop there, as with 403 and 429.
      if (e instanceof SourceError && /\b999\b/.test(e.message)) throw new SourceError(`${what} turned us away (999). We don't try to get round that; try again another day.`);
      // Asked for a page past the last, LinkedIn sometimes answers 400: the end, not an error.
      if (page > 0 && e instanceof SourceError && /\b400\b/.test(e.message)) break;
      throw e;
    }
    // Past the last page LinkedIn answers with an empty page, or sometimes 400 or 404.
    if (html === null) break;
    const { cards, jobs: found } = parsePage(html);
    if (!cards) break;
    const before = jobs.size;
    for (const j of found) if (jobs.size < limit && !jobs.has(j.id)) jobs.set(j.id, j);
    // A page with nothing new: LinkedIn is repeating itself, so it has no more.
    if (jobs.size === before) break;
    start += cards;
  }
  return { source: "linkedin", query, jobs: [...jobs.values()], fetchedAt: new Date().toISOString() };
}

export const linkedin: SearchSource = {
  id: "linkedin",
  name: "LinkedIn",
  covers: "Jobs worldwide from the biggest job board: the results it shows to anyone not signed in (unofficial)",
  places: true,
  optIn: NOTICE,
  credit: "Jobs from LinkedIn (https://www.linkedin.com/jobs), read unofficially",
  search,
};
