/**
 * A source is one way of reaching jobs. Two kinds:
 *
 * - A hiring system (ATS), a BoardSource: one module reads any company's
 *   public board on it, given the board's name ("acme") or a link to it.
 * - A job board or aggregator, a SearchSource: searched by words and place
 *   across many companies.
 *
 * Never a module for one company.
 *
 * Sources only fetch and reshape; judging jobs happens elsewhere.
 */
import type { BoardResult, Job } from "./job.ts";

export interface FetchOptions {
  /** For tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Milliseconds before giving up. */
  timeoutMs?: number;
  /** Milliseconds to wait between pages, for sources that ask to be read gently. Tests set 0. */
  pauseMs?: number;
}

export interface BoardSource {
  /** "greenhouse" */
  id: string;
  /** "Greenhouse" */
  name: string;
  /** What to pass: shown in help and errors. */
  boardHint: string;
  /**
   * The board's name from a link to it, or a bare name. Undefined when it isn't one of this source's.
   * `named` is set when the person named this source (ojs jobs fetch teamtailor <board>), so a source
   * whose boards can live on any domain may accept a link it couldn't claim among all the sources.
   */
  parseBoard(input: string, opts?: { named?: boolean }): string | undefined;
  fetchBoard(board: string, opts?: FetchOptions): Promise<BoardResult>;
}

/** What to look for on a job board. */
export interface SearchQuery {
  /** Words to look for, usually one job title: "data engineer". */
  what: string;
  /** A place as people write it: "Leeds", "Greater London". Sources that can't search by place say so (`places`). */
  where?: string;
  /** ISO 3166 two-letter code, lower case ("gb"), for sources split by country. */
  country?: string;
  /** The most jobs to bring back. Each source has its own default and ceiling. */
  limit?: number;
}

export interface SearchOptions extends FetchOptions {
  /** Where keys are read from. Core never reads process.env itself; the CLI passes it in. */
  env?: Record<string, string | undefined>;
}

/**
 * A job board or aggregator: searched across many companies, by words and
 * place, rather than read one company's board at a time.
 */
export interface SearchSource {
  /** "adzuna" */
  id: string;
  /** "Adzuna" */
  name: string;
  /** One line on what it covers: "Jobs from many boards in 19 countries". */
  covers: string;
  /** Whether it searches by place (`where`). Remote boards don't. */
  places: boolean;
  /** Country codes it can search, when it's split by country; the first is the default. */
  countries?: string[];
  /**
   * Keys it needs, by environment variable name, and where to get them. Never the values.
   * `cost` says what the key costs when it isn't free: "25 test calls, then a paid plan".
   */
  keys?: { env: string[]; signup: string; cost?: string };
  /** The credit its terms ask for, shown next to its jobs: "Jobs by Adzuna (https://www.adzuna.co.uk)". */
  credit?: string;
  /** A short label the terms want on every ad, not just once under the list: "Adzuna". */
  creditEach?: string;
  search(query: SearchQuery, opts?: SearchOptions): Promise<SearchResult>;
}

/** What one search of one job board brought back. */
export interface SearchResult {
  source: string;
  query: SearchQuery;
  jobs: Job[];
  /** How many matches the board says it has, set only when it has more than we read. */
  totalAds?: number;
  /** ISO 8601. */
  fetchedAt: string;
}

export class SourceError extends Error {
  override name = "SourceError";
}

/** Says who we are, so a site can see the traffic and reach the project. No personal details. */
export const USER_AGENT = "open-job-search (+https://github.com/riffnomad/open-job-search)";

/**
 * GET JSON, with a timeout and errors in plain words. 404 comes back as null.
 * `headers` are for APIs that take a key in a header. They're added to ours, and
 * never appear in an error message. Replacing our user-agent is only for an API
 * that demands it, with a value the person chose (USAJOBS wants their email).
 */
export function getJson(url: string, what: string, opts: FetchOptions = {}, headers?: Record<string, string>): Promise<unknown | null> {
  return requestJson(url, what, opts, headers ? { headers } : {});
}

/** Replies kept by getJsonOnce, per fetch function (tests each bring their own) and URL. */
const kept = new WeakMap<typeof fetch, Map<string, { at: number; reply: Promise<unknown | null> }>>();

/**
 * getJson, but a reply is kept for a few minutes and reused. For job boards
 * that send their whole feed at once and ask to be read rarely: searching for
 * five titles then asks once, not five times.
 */
export function getJsonOnce(url: string, what: string, opts: FetchOptions = {}, keepMs = 10 * 60_000): Promise<unknown | null> {
  const f = opts.fetch ?? fetch;
  let byUrl = kept.get(f);
  if (!byUrl) kept.set(f, (byUrl = new Map()));
  const hit = byUrl.get(url);
  if (hit && Date.now() - hit.at < keepMs) return hit.reply;
  const reply = getJson(url, what, opts);
  byUrl.set(url, { at: Date.now(), reply });
  // A failed request isn't kept, so the next try asks again.
  reply.catch(() => byUrl.delete(url));
  return reply;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A test for text holding every one of the words, each as a whole word (so
 * "engineer" isn't found in "engineering"), ignoring case. For job boards we
 * search ourselves, by reading their whole feed.
 */
export function hasAllWords(words: string): (text: string) => boolean {
  const res = words
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, "iu"));
  return (text) => res.every((re) => re.test(text));
}

/** POST a JSON body and read JSON back, the same way as getJson. For sources whose list of jobs is a search. */
export function postJson(url: string, body: unknown, what: string, opts: FetchOptions = {}): Promise<unknown | null> {
  return requestJson(url, what, opts, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

/** GET text (an XML or RSS feed), the same way as getJson. 404 comes back as null. */
export async function getText(url: string, what: string, opts: FetchOptions = {}, accept = "application/xml, text/xml, */*"): Promise<string | null> {
  const res = await request(url, what, opts, { headers: { accept } });
  return res && (await res.text());
}

async function requestJson(url: string, what: string, opts: FetchOptions, init: RequestParts = {}): Promise<unknown | null> {
  const res = await request(url, what, opts, init);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    throw new SourceError(`${what} didn't send valid JSON`);
  }
}

interface RequestParts {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

/** One request with our name, a timeout and errors in plain words. 404 comes back as null. */
async function request(url: string, what: string, opts: FetchOptions, init: RequestParts): Promise<Response | null> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      method: init.method ?? "GET",
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: { accept: "application/json", "user-agent": USER_AGENT, ...init.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "it took too long to answer" : (e as Error).message;
    throw new SourceError(`couldn't reach ${what}: ${msg}`);
  }
  if (res.status === 404) return null;
  if (res.status === 401) throw new SourceError(`${what} refused the key (401). Check it's set correctly.`);
  if (res.status === 429) throw new SourceError(`${what} says we're asking too often. Try again later.`);
  if (res.status === 403) throw new SourceError(`${what} turned us away (403). We don't try to get round that.`);
  if (!res.ok) throw new SourceError(`${what} answered ${res.status} ${res.statusText}`.trim());
  return res;
}

/** A board name as hiring systems use them: letters, digits, - and _. */
export const isBoardName = (s: string): boolean => /^[a-z0-9][a-z0-9_-]*$/i.test(s);

/** The input as a URL, if it is one. Accepts links without https://. */
export function asUrl(input: string): URL | undefined {
  const s = input.trim();
  if (!/[./]/.test(s)) return undefined;
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return undefined;
  }
}
