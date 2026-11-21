/**
 * Greenhouse: every company's public job board, through its documented,
 * open Job Board API (no key). https://developers.greenhouse.io/job-board.html
 *
 *   GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true&pay_transparency=true
 *
 * Boards live at job-boards.greenhouse.io/{board} (or boards.greenhouse.io, or
 * job-boards.eu.greenhouse.io for EU-hosted ones: the same API serves them).
 */
import { z } from "zod";
import { decodeEntities, htmlToText } from "../html.ts";
import { type BoardResult, type Job, type Pay, saysRemote, splitLocations } from "../job.ts";
import { asUrl, type BoardSource, type FetchOptions, getJson, isBoardName, SourceError } from "../source.ts";

const API = "https://boards-api.greenhouse.io/v1/boards";

const GhPay = z.object({
  min_cents: z.number().nullish(),
  max_cents: z.number().nullish(),
  currency_type: z.string().nullish(),
  title: z.string().nullish(),
  blurb: z.string().nullish(),
});

const GhJob = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  updated_at: z.string().nullish(),
  first_published: z.string().nullish(),
  company_name: z.string().nullish(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  offices: z.array(z.object({ name: z.string().nullish() })).nullish(),
  departments: z.array(z.object({ name: z.string().nullish() })).nullish(),
  content: z.string().nullish(),
  pay_input_ranges: z.array(GhPay).nullish(),
});

const GhJobs = z.object({ jobs: z.array(GhJob) });
const GhBoard = z.object({ name: z.string().nullish() });

// EU-hosted boards (job-boards.eu.greenhouse.io) are served by the same API.
const HOSTS = /^(job-boards|boards)(\.eu)?\.greenhouse\.io$/i;

function parseBoard(input: string): string | undefined {
  const s = input.trim();
  const url = asUrl(s);
  if (!url) return isBoardName(s) ? s.toLowerCase() : undefined;
  if (!HOSTS.test(url.hostname)) return undefined;
  // The embed form: boards.greenhouse.io/embed/job_board?for=acme
  const forParam = url.searchParams.get("for");
  if (forParam && isBoardName(forParam)) return forParam.toLowerCase();
  const first = url.pathname.split("/").filter(Boolean)[0];
  return first && first !== "embed" && isBoardName(first) ? first.toLowerCase() : undefined;
}

/** "Annual salary", "per hour"… in the range's title or note. Left out when it doesn't say. */
function payPeriod(text: string): Pay["period"] | undefined {
  if (/\b(annual|annually|yearly|per (year|annum)|a year)\b/i.test(text)) return "year";
  if (/\b(hourly|per hour|an hour)\b/i.test(text)) return "hour";
  if (/\b(monthly|per month|a month)\b/i.test(text)) return "month";
  if (/\b(daily|per day|day rate|a day)\b/i.test(text)) return "day";
  return undefined;
}

function toPay(p: z.infer<typeof GhPay>): Pay | undefined {
  if (!p.currency_type || (p.min_cents == null && p.max_cents == null)) return undefined;
  const min = p.min_cents != null ? p.min_cents / 100 : undefined;
  const max = p.max_cents != null ? p.max_cents / 100 : undefined;
  // Placeholders: some boards enter 1–2 to hide pay. No real range tops out below 5 of any currency.
  if (Math.max(min ?? 0, max ?? 0) < 5) return undefined;
  const label = p.title?.trim().replace(/:$/, "").trim();
  // The range's own title wins ("Hourly base pay range"); the note under it can talk about other pay.
  const period = payPeriod(p.title ?? "") ?? (p.blurb ? payPeriod(htmlToText(p.blurb)) : undefined);
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    currency: p.currency_type.toUpperCase(),
    ...(period ? { period } : {}),
    ...(label ? { label } : {}),
  };
}

function toJob(board: string, company: string, j: z.infer<typeof GhJob>): Job {
  const fromLocation = splitLocations(j.location?.name);
  const locations = fromLocation.length ? fromLocation : splitLocations(...(j.offices ?? []).map((o) => o.name));
  const department = j.departments?.map((d) => d.name?.trim()).find(Boolean);
  const description = j.content ? htmlToText(j.content) : "";
  return {
    id: `greenhouse:${board}:${j.id}`,
    source: "greenhouse",
    board,
    company: j.company_name?.trim() || company,
    title: decodeEntities(j.title).replace(/\s+/g, " ").trim(),
    locations,
    ...(saysRemote(locations) ? { remote: true as const } : {}),
    url: j.absolute_url,
    ...(department ? { department } : {}),
    ...(j.first_published ? { postedAt: j.first_published } : {}),
    ...(j.updated_at ? { updatedAt: j.updated_at } : {}),
    pay: (j.pay_input_ranges ?? []).map(toPay).filter((p): p is Pay => !!p),
    ...(description ? { description } : {}),
  };
}

async function fetchBoard(board: string, opts: FetchOptions = {}): Promise<BoardResult> {
  if (!isBoardName(board)) throw new SourceError(`"${board}" isn't a Greenhouse board name`);
  const what = `Greenhouse (board "${board}")`;
  const [rawJobs, rawBoard] = await Promise.all([
    getJson(`${API}/${encodeURIComponent(board)}/jobs?content=true&pay_transparency=true`, what, opts),
    getJson(`${API}/${encodeURIComponent(board)}`, what, opts).catch(() => null),
  ]);
  if (rawJobs === null) throw new SourceError(`Greenhouse has no board called "${board}". Check the name in the company's job links (job-boards.greenhouse.io/<board>).`);
  const parsed = GhJobs.safeParse(rawJobs);
  if (!parsed.success) throw new SourceError(`${what} sent jobs in a shape we don't recognise`);
  const company = GhBoard.safeParse(rawBoard).data?.name?.trim() || parsed.data.jobs.find((j) => j.company_name)?.company_name?.trim() || board;
  return {
    source: "greenhouse",
    board,
    company,
    jobs: parsed.data.jobs.map((j) => toJob(board, company, j)),
    fetchedAt: new Date().toISOString(),
  };
}

export const greenhouse: BoardSource = {
  id: "greenhouse",
  name: "Greenhouse",
  boardHint: "the board name, or a link like job-boards.greenhouse.io/acme",
  parseBoard,
  fetchBoard,
};
