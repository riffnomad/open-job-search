/**
 * Ashby: every company's public job board, through its documented, open
 * Job Postings API (no key). https://developers.ashbyhq.com/docs/public-job-posting-api
 *
 *   GET https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true
 *
 * Boards live at jobs.ashbyhq.com/{board}. The API doesn't send the company's
 * name, so the board's name stands in for it, spelt as the job links spell it.
 */
import { z } from "zod";
import { decodeEntities, htmlToText } from "../html.ts";
import { type BoardResult, type Job, type Pay, saysRemote, splitLocations } from "../job.ts";
import { asUrl, type BoardSource, type FetchOptions, getJson, SourceError } from "../source.ts";

const API = "https://api.ashbyhq.com/posting-api/job-board";

const AshbyComponent = z.object({
  compensationType: z.string().nullish(),
  interval: z.string().nullish(),
  currencyCode: z.string().nullish(),
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
});

const AshbyJob = z.object({
  id: z.string(),
  title: z.string(),
  jobUrl: z.string(),
  department: z.string().nullish(),
  team: z.string().nullish(),
  location: z.string().nullish(),
  secondaryLocations: z.array(z.object({ location: z.string().nullish() })).nullish(),
  isListed: z.boolean().nullish(),
  isRemote: z.boolean().nullish(),
  workplaceType: z.string().nullish(),
  publishedAt: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  shouldDisplayCompensationOnJobPostings: z.boolean().nullish(),
  compensation: z
    .object({ compensationTiers: z.array(z.object({ title: z.string().nullish(), components: z.array(AshbyComponent).nullish() })).nullish() })
    .nullish(),
});

const AshbyBoard = z.object({ jobs: z.array(AshbyJob) });

// Ashby board names are freer than most: mixed case, dots and spaces turn up.
// Letters, digits, space, ".", "-" and "_"; never "..". Encoded before going in a URL.
const isAshbyBoard = (s: string): boolean => /^[a-z0-9][a-z0-9 ._-]*$/i.test(s) && !s.includes("..");

function parseBoard(input: string): string | undefined {
  const s = input.trim();
  const url = asUrl(s);
  if (!url) return isAshbyBoard(s) ? s.toLowerCase() : undefined;
  if (url.hostname.toLowerCase() !== "jobs.ashbyhq.com") return undefined;
  const first = url.pathname.split("/").filter(Boolean)[0];
  if (!first) return undefined;
  let name: string;
  try {
    name = decodeURIComponent(first).trim();
  } catch {
    return undefined;
  }
  return isAshbyBoard(name) ? name.toLowerCase() : undefined;
}

/** "1 YEAR", "1 HOUR"… Left out when it's anything else. */
function payPeriod(interval: string | null | undefined): Pay["period"] | undefined {
  const m = /^1 (YEAR|MONTH|DAY|HOUR)$/i.exec(interval?.trim() ?? "");
  return m ? (m[1]!.toLowerCase() as Pay["period"]) : undefined;
}

/** Only the salary in each tier; equity, bonus and commission aren't base pay. */
function toPay(j: z.infer<typeof AshbyJob>): Pay[] {
  if (j.shouldDisplayCompensationOnJobPostings === false) return [];
  const out: Pay[] = [];
  for (const tier of j.compensation?.compensationTiers ?? []) {
    const label = tier.title?.replace(/\s+/g, " ").trim();
    for (const c of tier.components ?? []) {
      if (c.compensationType !== "Salary" || !c.currencyCode || (c.minValue == null && c.maxValue == null)) continue;
      const period = payPeriod(c.interval);
      out.push({
        ...(c.minValue != null ? { min: c.minValue } : {}),
        ...(c.maxValue != null ? { max: c.maxValue } : {}),
        currency: c.currencyCode.toUpperCase(),
        ...(period ? { period } : {}),
        ...(label ? { label } : {}),
      });
    }
  }
  return out;
}

/** The board's name as Ashby writes it in a job link ("Acme Labs"), else as given. */
function boardName(board: string, jobs: z.infer<typeof AshbyJob>[]): string {
  const first = jobs.map((j) => asUrl(j.jobUrl)?.pathname.split("/").filter(Boolean)[0]).find(Boolean);
  try {
    const name = first ? decodeURIComponent(first).trim() : "";
    return name.toLowerCase() === board ? name : board;
  } catch {
    return board;
  }
}

function toJob(board: string, company: string, j: z.infer<typeof AshbyJob>): Job {
  const locations = splitLocations(j.location, ...(j.secondaryLocations ?? []).map((l) => l.location));
  // Ashby sets isRemote for hybrid jobs too, so the workplace type wins when it's there.
  const remote = j.workplaceType ? j.workplaceType === "Remote" : !!j.isRemote;
  const department = j.department?.trim() || j.team?.trim();
  // Ashby's own plain text, tidied ("\n\n - Item" becomes "\n\n- Item"); else the HTML as text.
  const plain = (j.descriptionPlain ?? "").split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const description = plain || (j.descriptionHtml ? htmlToText(j.descriptionHtml) : "");
  return {
    id: `ashby:${board}:${j.id}`,
    source: "ashby",
    board,
    company,
    title: decodeEntities(j.title).replace(/\s+/g, " ").trim(),
    locations,
    ...(remote || saysRemote(locations) ? { remote: true as const } : {}),
    url: j.jobUrl,
    ...(department ? { department } : {}),
    ...(j.publishedAt ? { postedAt: j.publishedAt } : {}),
    pay: toPay(j),
    ...(description ? { description } : {}),
  };
}

async function fetchBoard(board: string, opts: FetchOptions = {}): Promise<BoardResult> {
  if (!isAshbyBoard(board)) throw new SourceError(`"${board}" isn't an Ashby board name`);
  const what = `Ashby (board "${board}")`;
  const raw = await getJson(`${API}/${encodeURIComponent(board)}?includeCompensation=true`, what, opts);
  if (raw === null) throw new SourceError(`Ashby has no board called "${board}". Check the name in the company's job links (jobs.ashbyhq.com/<board>).`);
  const parsed = AshbyBoard.safeParse(raw);
  if (!parsed.success) throw new SourceError(`${what} sent jobs in a shape we don't recognise`);
  const listed = parsed.data.jobs.filter((j) => j.isListed !== false);
  const company = boardName(board, listed);
  return {
    source: "ashby",
    board,
    company,
    jobs: listed.map((j) => toJob(board, company, j)),
    fetchedAt: new Date().toISOString(),
  };
}

export const ashby: BoardSource = {
  id: "ashby",
  name: "Ashby",
  boardHint: "the board name, or a link like jobs.ashbyhq.com/acme",
  parseBoard,
  fetchBoard,
};
