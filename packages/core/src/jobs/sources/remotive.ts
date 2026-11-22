/**
 * Remotive: a job board of remote jobs only, from many companies.
 *
 * Its public API needs no key (docs: github.com/remotive-com/remote-jobs-api):
 *
 *   GET https://remotive.com/api/remote-jobs
 *
 * Its terms, which we keep to:
 * - Link back to the job's page on Remotive and name Remotive as the source:
 *   each job's `url` is its Remotive page, and `credit` says where it came from.
 * - Don't pass its jobs on to other sites (Jooble, Google Jobs, LinkedIn Jobs…),
 *   and don't show them to collect sign-ups or email addresses. We only show
 *   them to the person searching, on their own machine.
 * - Ask a couple of times a day at most (they advise no more than 4); more than
 *   2 requests a minute are blocked. So we read the whole feed in one request
 *   (it's small: the free feed holds a few dozen jobs at most) and keep it for a
 *   few minutes, and pick the jobs ourselves: searching for five titles asks once.
 * - Jobs appear 24 hours after Remotive publishes them.
 *
 * It can't search by place: every job is remote, and `candidate_required_location`
 * says where you may work from ("USA", "Worldwide", "Europe"), so it's kept as written.
 */
import { z } from "zod";
import { decodeEntities, htmlToText } from "../html.ts";
import type { Job, Pay } from "../job.ts";
import { getJsonOnce, hasAllWords, type SearchOptions, type SearchQuery, type SearchResult, type SearchSource, SourceError } from "../source.ts";

const API = "https://remotive.com/api/remote-jobs";
const DEFAULT_LIMIT = 50;
/** The feed comes in one reply (it has no pages), so this only trims what we keep. */
const MAX_LIMIT = 200;

const RmJob = z.object({
  id: z.union([z.number(), z.string()]),
  url: z.string().url(),
  title: z.string(),
  company_name: z.string(),
  category: z.string().nullish(),
  job_type: z.string().nullish(),
  publication_date: z.string().nullish(),
  candidate_required_location: z.string().nullish(),
  salary: z.string().nullish(),
  tags: z.array(z.unknown()).nullish(),
  description: z.string().nullish(),
});

// Jobs are checked one by one, so one odd entry doesn't lose the rest.
const RmReply = z.object({
  "job-count": z.number().nullish(),
  "total-job-count": z.number().nullish(),
  jobs: z.array(z.unknown()),
});

const SYMBOLS: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };
const CODES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "PLN", "INR", "SGD", "JPY", "BRL", "MXN", "ZAR"];
const CUR = `[$€£]|${CODES.join("|")}`;
/** 120000, 120,000, 3.5 or 14.50. Not "35,3" or "50.000", which could be read two ways. */
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;
/** An amount with its currency on either side; "CAD $90k" names the code and the symbol. */
const AMOUNT = new RegExp(`^(?:(${CODES.join("|")})\\s*)?([$€£])?\\s*(${NUM})\\s*(k)?\\s*(${CUR})?$`, "i");
const PERIODS: [RegExp, NonNullable<Pay["period"]>][] = [
  [/(?:\/|\bper\s+|\ban?\s+)\s*(?:hour|hr|h)\b\.?$|\bhourly$/i, "hour"],
  [/(?:\/|\bper\s+|\ban?\s+)\s*day\b\.?$|\bdaily$/i, "day"],
  [/(?:\/|\bper\s+|\ban?\s+)\s*(?:month|mo)\b\.?$|\bmonthly$/i, "month"],
  [/(?:\/|\bper\s+|\ban?\s+)\s*(?:year|yr|annum)\b\.?$|\b(?:yearly|annually|p\.?a\.?)$/i, "year"],
];

/**
 * Remotive's salary is free text ("$80k - $100k", "€50,000/year"). Read it only
 * when it can mean one thing: a currency, one amount or a range, k for thousand
 * on every amount or none, and the period only when it's written. Anything else
 * ("OTE $25k", "70K-80K", "$35,3k") is left unread.
 */
export function parseSalary(text: string | null | undefined): Pay | undefined {
  let s = (text ?? "").trim().replace(/\s+/g, " ");
  if (!s) return undefined;
  let period: Pay["period"];
  for (const [re, p] of PERIODS) {
    const m = re.exec(s);
    if (m) {
      period = p;
      s = s.slice(0, m.index).trim();
      break;
    }
  }
  const parts = s.split(/\s*(?:-|–|—|\bto\b)\s*/i);
  if (parts.length < 1 || parts.length > 2) return undefined;
  const found = parts.map((p) => AMOUNT.exec(p));
  if (found.some((m) => !m)) return undefined;
  const ms = found as RegExpExecArray[];
  // "$80 - 100k" could be 80 thousand or 80 dollars: only read k when every amount has it, or none does.
  const ks = new Set(ms.map((m) => !!m[4]));
  if (ks.size > 1) return undefined;
  const marks = ms.flatMap((m) => [m[1], m[2], m[5]]).filter((c): c is string => !!c).map((c) => c.toUpperCase());
  const codes = new Set(marks.filter((c) => !SYMBOLS[c]));
  const symbols = new Set(marks.filter((c) => SYMBOLS[c]).map((c) => SYMBOLS[c]!));
  let currency: string | undefined;
  if (codes.size > 1) return undefined;
  if (codes.size === 1) {
    currency = [...codes][0]!;
    // "CAD $90k" is Canadian dollars; "€50k USD" says two things.
    if ([...symbols].some((c) => c !== currency && c !== "USD")) return undefined;
    if (symbols.has("USD") && !/D$/.test(currency)) return undefined;
  } else if (symbols.size === 1) currency = [...symbols][0]!;
  if (!currency) return undefined;
  const values = ms.map((m) => Number(m[3]!.replace(/,/g, "")) * (m[4] ? 1000 : 1));
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) return undefined;
  const [min, max = min] = values as [number, number?];
  if (max! < min) return undefined;
  return { min, max: max!, currency, ...(period ? { period } : {}) };
}

/** "full_time" as "Full time". */
const jobType = (t: string) => {
  const s = t.replace(/[_-]+/g, " ").trim().toLowerCase();
  return s && s[0]!.toUpperCase() + s.slice(1);
};

function toJob(j: z.infer<typeof RmJob>): Job {
  const location = j.candidate_required_location?.trim();
  const pay = parseSalary(j.salary);
  const salary = j.salary?.trim();
  // The Job shape has no place for free-text pay or the kind of contract, so what
  // we couldn't read goes at the end of the description, where people will see it.
  const extra = [
    j.job_type?.trim() ? `Job type: ${jobType(j.job_type)}` : "",
    salary && !pay ? `Salary, as Remotive gives it: ${salary}` : "",
  ].filter(Boolean);
  const body = j.description ? htmlToText(j.description) : "";
  const description = [body, extra.join("\n")].filter(Boolean).join("\n\n");
  return {
    id: `remotive:remote:${j.id}`,
    source: "remotive",
    board: "remote",
    company: decodeEntities(j.company_name).replace(/\s+/g, " ").trim(),
    title: decodeEntities(j.title).replace(/\s+/g, " ").trim(),
    locations: location ? [location] : [],
    remote: true,
    url: j.url,
    ...(j.category?.trim() ? { department: j.category.trim() } : {}),
    ...(j.publication_date?.trim() ? { postedAt: j.publication_date.trim() } : {}),
    pay: pay ? [pay] : [],
    ...(description ? { description } : {}),
  };
}

async function search(query: SearchQuery, opts: SearchOptions = {}): Promise<SearchResult> {
  const what = query.what.trim();
  if (!what) throw new SourceError("what should we look for on Remotive? Give some words, like a job title.");
  const limit = Math.max(1, Math.min(Math.floor(query.limit ?? DEFAULT_LIMIT), MAX_LIMIT));

  const raw = await getJsonOnce(API, "Remotive", opts);
  if (raw === null) throw new SourceError("Remotive's job feed wasn't there (404). Its API may have moved.");
  const parsed = RmReply.safeParse(raw);
  if (!parsed.success) throw new SourceError("Remotive sent jobs in a shape we don't recognise");
  // Remotive's own search also reads the ad's text, so "engineer" finds an office assistant whose ad
  // mentions engineers. We match the title and tags instead, as whole words.
  const matches = hasAllWords(what);
  const jobs: Job[] = [];
  for (const item of parsed.data.jobs) {
    const j = RmJob.safeParse(item);
    if (!j.success) continue;
    const tags = (j.data.tags ?? []).filter((t): t is string => typeof t === "string");
    if (matches([j.data.title, ...tags].join(" \n "))) jobs.push(toJob(j.data));
  }
  const kept = jobs.slice(0, limit);
  return {
    source: "remotive",
    query: { what, limit },
    jobs: kept,
    ...(jobs.length > kept.length ? { totalAds: jobs.length } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export const remotive: SearchSource = {
  id: "remotive",
  name: "Remotive",
  covers: "Remote jobs from many companies, worldwide (shown 24 hours after they're posted)",
  places: false,
  credit: "Jobs from Remotive (https://remotive.com): each links to its page there.",
  search,
};
