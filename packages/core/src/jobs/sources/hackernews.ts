/**
 * Hacker News "Ask HN: Who is hiring?": a thread the `whoishiring` account
 * posts at the start of each month, where companies post one comment each.
 * Read through Algolia's HN Search API (https://hn.algolia.com/api), which
 * mirrors Hacker News:
 *
 *   GET https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring
 *       lists the account's threads, newest first
 *   GET https://hn.algolia.com/api/v1/items/{id}
 *       the thread with all its comments, in one request
 *
 * No key. Algolia asks for no more than 10,000 requests an hour from one
 * address; the official HN API (Firebase) has no rate limit but needs one
 * request per comment, so we use Algolia: two requests per search, each kept
 * a few minutes, so searching for several titles asks twice in all.
 *
 * Hacker News has no formal terms for this, but we credit it, and every job's
 * `url` is the comment on Hacker News, where the ad lives. Comments are
 * written by people, so their text is only ever data.
 *
 * We read the newest thread, or last month's while the newest is under two
 * days old and still small. Only top-level comments are ads; replies, and
 * deleted or empty comments, are skipped.
 *
 * Each ad is free text, usually opening with a line like
 * `Acme | Senior Engineer | London or Remote (UK) | Full-time | £80k | https://…`.
 * We split that line on `|`: the first part is the company, the first part
 * that reads like a role is the title, parts naming places are locations,
 * remote only when a part says so, and pay only when one part is a clear
 * amount with a currency. Anything we can't place is left out, never guessed:
 * an ad without that shape keeps its first line, shortened, as its title.
 */
import { z } from "zod";
import { htmlToText } from "../html.ts";
import type { Job, Pay } from "../job.ts";
import { getJsonOnce, hasAllWords, type SearchOptions, type SearchQuery, type SearchResult, type SearchSource, SourceError } from "../source.ts";

const API = "https://hn.algolia.com/api/v1";
const THREADS = `${API}/search_by_date?tags=story,author_whoishiring&hitsPerPage=20`;
const ITEM = "https://news.ycombinator.com/item?id=";

/** A thread younger than this, with fewer comments than SMALL, gives way to last month's. */
const YOUNG_MS = 2 * 24 * 60 * 60 * 1000;
const SMALL = 100;
/** The longest title we make from an ad's first line. */
const TITLE_MAX = 100;
/** A part of the first line longer than this is prose, not a field. */
const PART_MAX = 160;

const Hit = z.object({
  objectID: z.string().regex(/^\d+$/),
  title: z.string(),
  created_at_i: z.number(),
  num_comments: z.number().nullish(),
});
const Hits = z.object({ hits: z.array(z.unknown()) });

const Comment = z.object({
  id: z.number().int(),
  author: z.string().min(1),
  text: z.string().min(1),
  created_at_i: z.number().nullish(),
  created_at: z.string().nullish(),
  type: z.literal("comment").nullish(),
});
const Thread = z.object({ id: z.number().int(), title: z.string().nullish(), children: z.array(z.unknown()).nullish() });

export interface ThreadInfo {
  id: string;
  title: string;
  /** "November 2026", from the title. */
  month?: string;
}

const isHiringThread = (title: string) => /^Ask HN: Who is hiring\?/i.test(title.trim());

/** The thread to read: the newest, unless it's under two days old and small, then the one before. */
export function pickThread(hits: unknown[], now = Date.now()): ThreadInfo | undefined {
  const threads = hits
    .map((h) => Hit.safeParse(h))
    .flatMap((p) => (p.success && isHiringThread(p.data.title) ? [p.data] : []))
    .sort((a, b) => b.created_at_i - a.created_at_i);
  const [newest, before] = threads;
  if (!newest) return undefined;
  const young = now - newest.created_at_i * 1000 < YOUNG_MS && (newest.num_comments ?? 0) < SMALL;
  const t = young && before ? before : newest;
  const month = t.title.match(/\(([^)]+)\)\s*$/)?.[1]?.trim();
  return { id: t.objectID, title: t.title.trim(), ...(month ? { month } : {}) };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** One paragraph of comment HTML as one line of text. */
const lineOf = (html: string) => squash(htmlToText(html));

/** The ad's first line: the first of its opening paragraphs split by `|`, else its first paragraph. */
export function firstLine(html: string): string {
  // A raw newline isn't a paragraph on Hacker News, but posters often end the first line with one.
  const paras = html.split(/<p\b[^>]*>|\n/i).map(lineOf).filter(Boolean);
  const line = paras.slice(0, 3).find((p) => p.split("|").length >= 3);
  if (!line) return paras[0] ?? "";
  // Some run the ad on after the last |, with no break: that's prose, not part of the line.
  const parts = line.split("|");
  return parts[parts.length - 1]!.trim().length > PART_MAX ? parts.slice(0, -1).join("|").trim() : line;
}

function shorten(s: string, max = TITLE_MAX): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trim()}…`;
}

// --- Reading the parts of a first line ---

const ROLE = /\b(engineer\w*|developer\w*|programmer|architect|scientist\w*|researcher\w*|designer\w*|manager\w*|director\w*|head of|lead|staff|principal|founding|intern\w*|analyst\w*|administrator\w*|admin|devops|sre|cto|vp|chief|consultant\w*|specialist\w*|technician\w*|executive|account executive|ae|sales|marketing|recruiter\w*|operations|ops|product|support|success|csms?|pms?|phd|postdoc\w*|roles?|positions?|openings?|member of technical staff|mts|swe|full[- ]?stack|front[- ]?end|back[- ]?end|ml|ai|data|security|mobile|ios|android|qa|tester|writer|editor)\b/i;
const EMPLOYMENT = /\b(full[- ]?time|part[- ]?time|contract\w*|freelance|permanent|temporary|internships?|hourly|ft|pt|w2|1099|c2c)\b/i;
const EMPLOYMENT_ALL = new RegExp(EMPLOYMENT.source, "gi");
const VISA = /\b(visa|sponsor\w*|relocation|citizen\w*|clearance|work authori[sz]ation|authori[sz]ed to work)\b/i;
const REMOTE = /\bremote\b/i;
const WORKPLACE = /\b(on[- ]?site|in[- ]?office|in[- ]?person|hybrid|office)\b/i;
const WORKPLACE_ALL = new RegExp(WORKPLACE.source, "gi");
/** Words that make a part a role even when it has commas like a place: "Backend Engineer, Foundations". */
const STRONG_ROLE = /\b(engineer\w*|developer\w*|programmer\w*|architect\w*|scientist\w*|researcher\w*|designer\w*|manager\w*|director\w*|consultant\w*|analyst\w*|administrator\w*|recruiter\w*|specialist\w*|executive\w*|roles?|positions?|openings?|pms|csms?|sre|founding|mts|interns?|full[- ]?stack|member of technical staff)\b/i;
const URLISH = /^(https?:\/\/|www\.)|^[\w-]+(\.[\w-]+)+(\/\S*)?$/i;

/** Big places and the short names people use, for parts with a place and nothing else to go on. */
const PLACES = [
  "usa", "us", "uk", "eu", "emea", "apac", "latam", "europe", "americas", "north america", "south america", "asia", "africa", "worldwide", "global", "anywhere",
  "united states", "united kingdom", "canada", "mexico", "brazil", "argentina", "germany", "france", "spain", "portugal", "italy", "netherlands", "the netherlands",
  "belgium", "switzerland", "austria", "ireland", "denmark", "sweden", "norway", "finland", "poland", "czechia", "estonia", "israel", "india", "japan", "singapore",
  "greece", "romania", "hungary", "ukraine", "turkey", "egypt", "nigeria", "kenya", "south africa", "pakistan", "philippines", "vietnam", "indonesia", "colombia", "chile", "peru", "uruguay",
  "australia", "new zealand", "south korea", "taiwan", "hong kong", "china", "uae", "dubai", "saudi arabia",
  "nyc", "ny", "new york", "new york city", "sf", "san francisco", "bay area", "sf bay area", "silicon valley", "la", "los angeles", "seattle", "boston", "austin", "chicago",
  "denver", "boulder", "miami", "atlanta", "washington", "dc", "washington dc", "philadelphia", "pittsburgh", "san diego", "san jose", "palo alto", "mountain view",
  "toronto", "vancouver", "montreal", "london", "cambridge", "oxford", "manchester", "edinburgh", "bristol", "dublin", "paris", "berlin", "munich", "hamburg",
  "amsterdam", "rotterdam", "utrecht", "zurich", "zürich", "geneva", "lausanne", "vienna", "stockholm", "copenhagen", "oslo", "helsinki", "warsaw", "krakow",
  "prague", "lisbon", "madrid", "barcelona", "milan", "tel aviv", "bangalore", "bengaluru", "tokyo", "sydney", "melbourne",
];
const placeAlt = PLACES.map((p) => p.replace(/\s+/g, "\\s+")).join("|");
const PLACE_START = new RegExp(`^(${placeAlt})(?![\\p{L}\\p{N}])`, "iu");
const PLACE_ANYWHERE = new RegExp(`(?<![\\p{L}\\p{N}])(${placeAlt})(?![\\p{L}\\p{N}])`, "iu");
/** "Austin, TX", "Utrecht, The Netherlands", "Lausanne, CH". */
const CITY_THEN = /^\p{Lu}[\p{L}.'’-]*(?:\s+\p{Lu}[\p{L}.'’-]*)*\s*,\s*(.*)$/u;
const cityComma = (s: string) => {
  const tail = s.match(CITY_THEN)?.[1];
  return tail !== undefined && (/^\p{Lu}{2}\b/u.test(tail) || PLACE_START.test(tail));
};
/** "Jersey City, NJ", "Sunnyvale CA", anywhere in a part. */
const CITY_STATE = /\p{Lu}[\p{L}.'’-]+,?\s+(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/u;

const CURRENCY_SIGNS: [RegExp, string][] = [
  [/US\$|\bUSD\b/i, "USD"], [/(?<![A-Z])C\$|\bCAD\b/i, "CAD"], [/(?<![A-Z])A\$|\bAUD\b/i, "AUD"], [/NZ\$|\bNZD\b/i, "NZD"], [/(?<![A-Z])S\$|\bSGD\b/i, "SGD"],
  [/£|\bGBP\b/i, "GBP"], [/€|\bEUR\b/i, "EUR"], [/\bCHF\b/i, "CHF"], [/\bSEK\b/i, "SEK"], [/\bNOK\b/i, "NOK"], [/\bDKK\b/i, "DKK"],
  [/\bPLN\b/i, "PLN"], [/₹|\bINR\b/i, "INR"], [/¥|\bJPY\b/i, "JPY"],
];

/** The one currency a part names. A bare $ is US dollars unless another dollar is named. Undefined when none or several. */
function currencyOf(part: string): string | undefined {
  const found = new Set(CURRENCY_SIGNS.filter(([re]) => re.test(part)).map(([, c]) => c));
  if (found.size === 0 && /\$/.test(part)) found.add("USD");
  return found.size === 1 ? [...found][0] : undefined;
}

const SIGN = String.raw`(?:US\$|(?<![A-Z])[CAS]\$|NZ\$|[$£€₹¥])`;
const CODE = String.raw`(?:USD|CAD|AUD|NZD|SGD|GBP|EUR|CHF|SEK|NOK|DKK|PLN|INR|JPY)`;
/** A number, maybe with thousands separators and a k. Not one run into other letters ("3.5B", "32h") or a percentage. */
const NUM = String.raw`(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)(?:\s*([kK]))?(?![\d%]|[.,]\d|\p{L})`;
/** "$130k", "€100–140k", "70k - 100k EUR", "$55 - $75". */
const MONEY = new RegExp(String.raw`((?:${SIGN}|\b${CODE})\s*)?${NUM}(?:\s*(?:-|–|—|to)\s*(?:${SIGN}\s*)?${NUM})?(\s*${CODE}\b)?`, "giu");

function periodOf(part: string): Pay["period"] | undefined {
  if (/\/\s*(yr|year|annum)\b|\bper\s+(year|annum)\b|\bannual\w*|\byearly\b|\bp\.?a\.?(?![\p{L}])/iu.test(part)) return "year";
  if (/\/\s*(mo|month)\b|\bper\s+month\b|\bmonthly\b/i.test(part)) return "month";
  if (/\/\s*(day|d)\b|\bper\s+day\b|\bdaily\b|\bday rate\b/i.test(part)) return "day";
  if (/\/\s*(hr|hour|h)\b|\bper\s+hour\b|\bhourly\b/i.test(part)) return "hour";
  return undefined;
}

const toNumber = (digits: string) => Number(digits.replace(/[,.](?=\d{3}\b)/g, ""));

/** Pay from one part, only when it's one clear amount or range in one currency. */
export function payOf(part: string): Pay | undefined {
  const currency = currencyOf(part);
  if (!currency) return undefined;
  // A bonus isn't the pay.
  if (/\b(signing|sign-on|joining|relocation)\b/i.test(part)) return undefined;
  // Only amounts written with their currency: "10 openings" or "32h" aren't pay.
  const found = [...part.matchAll(MONEY)].filter((m) => m[1] || m[6]);
  if (found.length !== 1) return undefined;
  const m = found[0]!;
  const a = { n: toNumber(m[2]!), k: Boolean(m[3]) };
  const b = m[4] ? { n: toNumber(m[4]), k: Boolean(m[5]) } : undefined;
  // "€100–140k": a k on the second amount covers the first.
  const anyK = a.k || Boolean(b?.k);
  const value = (x: { n: number; k: boolean }) => (x.k || (anyK && x.n < 1000) ? x.n * 1000 : x.n);
  const lo = value(a);
  const hi = b ? value(b) : undefined;
  if (!(lo > 0) || (hi !== undefined && !(hi >= lo))) return undefined;
  const period = periodOf(part);
  const after = part.slice((m.index ?? 0) + m[0].length);
  const before = part.slice(0, m.index ?? 0);
  let pay: Pay;
  if (hi !== undefined) pay = { min: lo, max: hi, currency };
  else if (/\b(up to|max(imum)?|under)\s*$|[<≤]\s*$/i.test(before)) pay = { max: lo, currency };
  // "£115k+", but not "£115k + equity".
  else if (/\b(from|min(imum)?|starting at)\s*$/i.test(before) || /^\s*\+(?!\s*(equity|bonus|benefits|stock|options|shares|health|commission|variable|ote)\b)/iu.test(after)) pay = { min: lo, currency };
  else pay = { min: lo, max: lo, currency };
  return { ...pay, ...(period ? { period } : {}) };
}

/** Whether a part names a place, as opposed to a role, terms or anything else. */
function isPlace(part: string): boolean {
  if (REMOTE.test(part)) return true;
  // With a workplace word, a known place anywhere will do: "Hybrid, 3 days in office: San Francisco CA".
  if (WORKPLACE.test(part) && (PLACE_ANYWHERE.test(part) || CITY_STATE.test(part))) return true;
  // Otherwise the part must open with a place: "ONSITE Berlin, Germany" is one, "ONSITE" alone isn't,
  // and "UK home fee status only" says something else.
  const rest = squash(part.replace(WORKPLACE_ALL, " ").replace(/[()]/g, " ").replace(/^[\s:,-]+/, ""));
  if (!rest) return false;
  const opens = rest.match(PLACE_START);
  if (opens) return rest.slice(opens[0].length).split(/\s+/).filter((w) => /\p{L}/u.test(w)).length <= 3 || /[,/&]|\b(or|and)\b/.test(rest);
  return cityComma(rest);
}

export interface ParsedLine {
  company?: string;
  title?: string;
  locations: string[];
  remote?: true;
  pay: Pay[];
  /** True when the line had the usual `|` shape and gave a role. */
  structured: boolean;
}

/** Read an ad's first line. What it doesn't clearly say is left out. */
export function parseFirstLine(line: string): ParsedLine {
  const parts = line.split("|").map(squash).filter(Boolean);
  if (parts.length < 3) return { locations: [], pay: [], structured: false };
  const [company, ...rest] = parts as [string, ...string[]];
  let title: string | undefined;
  const locations: string[] = [];
  let remote = false;
  const pays: Pay[] = [];
  let payParts = 0;
  for (const part of rest) {
    if (URLISH.test(part) || part.length > PART_MAX) continue;
    if (currencyOf(part) || /[$£€]/.test(part)) {
      payParts++;
      const p = payOf(part);
      if (p) pays.push(p);
      continue;
    }
    const says = REMOTE.test(part) || WORKPLACE.test(part);
    if (!says && VISA.test(part)) continue;
    if (!says && STRONG_ROLE.test(part)) {
      if (!title) title = part;
      continue;
    }
    if (isPlace(part)) {
      if (REMOTE.test(part)) remote = true;
      // A bare "REMOTE" says remote but names no place.
      if (!/^remote$/i.test(part)) locations.push(part);
      continue;
    }
    if (EMPLOYMENT.test(part) && !ROLE.test(part.replace(EMPLOYMENT_ALL, ""))) continue;
    if (VISA.test(part)) continue;
    if (!title && ROLE.test(part)) title = part;
  }
  return {
    ...(company && !URLISH.test(company) && company.length <= 120 ? { company } : {}),
    ...(title ? { title } : {}),
    locations,
    ...(remote ? { remote: true as const } : {}),
    // Pay only when exactly one part spoke of money and it read cleanly.
    pay: payParts === 1 ? pays : [],
    structured: Boolean(title),
  };
}

function postedAt(c: z.infer<typeof Comment>): string | undefined {
  if (typeof c.created_at_i === "number" && c.created_at_i > 0) return new Date(c.created_at_i * 1000).toISOString();
  const d = c.created_at ? new Date(c.created_at) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
}

export function toJob(threadId: string, c: z.infer<typeof Comment>): Job | undefined {
  const line = firstLine(c.text);
  if (!line) return undefined;
  const p = parseFirstLine(line);
  const description = htmlToText(c.text);
  const posted = postedAt(c);
  return {
    id: `hackernews:${threadId}:${c.id}`,
    source: "hackernews",
    board: threadId,
    company: p.company ?? "",
    title: p.title ?? shorten(line),
    locations: p.locations,
    ...(p.remote ? { remote: true as const } : {}),
    url: `${ITEM}${c.id}`,
    ...(posted ? { postedAt: posted } : {}),
    pay: p.pay,
    ...(description ? { description } : {}),
  };
}

/** The latest thread and its ads, read in two requests that are kept a few minutes. */
export async function readThread(opts: SearchOptions = {}): Promise<{ thread: ThreadInfo; ads: { job: Job; line: string }[] }> {
  const what = "Hacker News (via Algolia)";
  const list = await getJsonOnce(THREADS, what, opts);
  const hits = Hits.safeParse(list);
  if (list === null || !hits.success) throw new SourceError(`${what} sent the list of "Who is hiring?" threads in a shape we don't recognise`);
  const thread = pickThread(hits.data.hits);
  if (!thread) throw new SourceError(`${what} lists no "Ask HN: Who is hiring?" thread`);

  const raw = await getJsonOnce(`${API}/items/${thread.id}`, what, opts);
  if (raw === null) throw new SourceError(`${what} couldn't find the thread "${thread.title}"`);
  const t = Thread.safeParse(raw);
  if (!t.success) throw new SourceError(`${what} sent the thread in a shape we don't recognise`);

  const ads: { job: Job; line: string }[] = [];
  const seen = new Set<number>();
  // Only top-level comments are ads; their replies (children) are never read.
  for (const child of t.data.children ?? []) {
    const c = Comment.safeParse(child);
    if (!c.success || seen.has(c.data.id)) continue;
    seen.add(c.data.id);
    const job = toJob(thread.id, c.data);
    if (job) ads.push({ job, line: firstLine(c.data.text) });
  }
  return { thread, ads };
}

async function search(query: SearchQuery, opts: SearchOptions = {}): Promise<SearchResult> {
  const { ads } = await readThread(opts);
  const matches = hasAllWords(query.what);
  const jobs = ads.filter((a) => matches(`${a.line} \n ${a.job.title}`)).map((a) => a.job);
  const limit = query.limit && query.limit > 0 ? query.limit : undefined;
  const kept = limit ? jobs.slice(0, limit) : jobs;
  return {
    source: "hackernews",
    query,
    jobs: kept,
    ...(kept.length < jobs.length ? { totalAds: jobs.length } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export const hackernews: SearchSource = {
  id: "hackernews",
  name: "Hacker News",
  covers: "This month's \"Ask HN: Who is hiring?\" thread: ads posted by the companies hiring, matched by their first line",
  places: false,
  credit: 'From Hacker News: Ask HN: Who is hiring? (https://news.ycombinator.com/submitted?id=whoishiring)',
  search,
};
