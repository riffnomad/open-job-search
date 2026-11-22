/**
 * Workable: every company's public job list, through Workable's documented,
 * open accounts endpoint (no key). https://workable.readme.io/reference/jobs-1
 *
 *   GET https://www.workable.com/api/accounts/{account}?details=true
 *
 * It answers with a redirect to the job widget's feed on apply.workable.com,
 * which sends the same thing. Boards live at apply.workable.com/{account}
 * (older ones at {account}.workable.com). It doesn't say what jobs pay.
 */
import { z } from "zod";
import { decodeEntities, htmlToText } from "../html.ts";
import { type BoardResult, type Job, saysRemote, splitLocations } from "../job.ts";
import { asUrl, type BoardSource, type FetchOptions, getJson, isBoardName, SourceError } from "../source.ts";

const API = "https://www.workable.com/api/accounts";

const WkLocation = z.object({
  city: z.string().nullish(),
  region: z.string().nullish(),
  country: z.string().nullish(),
  hidden: z.boolean().nullish(),
});

const WkJob = z.object({
  title: z.string(),
  shortcode: z.string(),
  url: z.string().nullish(),
  shortlink: z.string().nullish(),
  department: z.string().nullish(),
  telecommuting: z.boolean().nullish(),
  published_on: z.string().nullish(),
  created_at: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  country: z.string().nullish(),
  locations: z.array(WkLocation).nullish(),
  description: z.string().nullish(),
});

const WkAccount = z.object({ name: z.string().nullish(), jobs: z.array(WkJob) });

// Workable's own sites on workable.com, which are never a company's board.
const NOT_ACCOUNTS = new Set(["www", "apply", "jobs", "help", "resources", "api", "j"]);

function parseBoard(input: string): string | undefined {
  const s = input.trim();
  const url = asUrl(s);
  if (!url) return isBoardName(s) ? s.toLowerCase() : undefined;
  const host = url.hostname.toLowerCase();
  // apply.workable.com/acme, apply.workable.com/acme/j/ABC123
  if (host === "apply.workable.com") {
    const first = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    return first && !NOT_ACCOUNTS.has(first) && isBoardName(first) ? first : undefined;
  }
  // acme.workable.com
  const sub = /^([a-z0-9][a-z0-9_-]*)\.workable\.com$/.exec(host)?.[1];
  return sub && !NOT_ACCOUNTS.has(sub) ? sub : undefined;
}

/** "Leeds, England, United Kingdom", leaving out empty parts and a region that repeats the city. */
function place(city?: string | null, region?: string | null, country?: string | null): string {
  const c = city?.trim();
  const r = region?.trim();
  return [c, r && r.toLowerCase() !== c?.toLowerCase() ? r : undefined, country?.trim()].filter(Boolean).join(", ");
}

function toJob(board: string, company: string, j: z.infer<typeof WkJob>): Job | undefined {
  const url = j.url || j.shortlink;
  if (!url) return undefined;
  const listed = (j.locations ?? []).filter((l) => !l.hidden).map((l) => place(l.city, l.region, l.country));
  const locations = splitLocations(...(listed.length ? listed : [place(j.city, j.state, j.country)]));
  const department = j.department?.trim();
  const postedAt = j.published_on || j.created_at;
  const description = j.description ? htmlToText(j.description) : "";
  return {
    id: `workable:${board}:${j.shortcode}`,
    source: "workable",
    board,
    company,
    title: decodeEntities(j.title).replace(/\s+/g, " ").trim(),
    locations,
    ...(j.telecommuting || saysRemote(locations) ? { remote: true as const } : {}),
    url,
    ...(department ? { department } : {}),
    ...(postedAt ? { postedAt } : {}),
    pay: [],
    ...(description ? { description } : {}),
  };
}

async function fetchBoard(board: string, opts: FetchOptions = {}): Promise<BoardResult> {
  if (!isBoardName(board)) throw new SourceError(`"${board}" isn't a Workable account name`);
  const what = `Workable (account "${board}")`;
  const raw = await getJson(`${API}/${encodeURIComponent(board)}?details=true`, what, opts);
  if (raw === null) throw new SourceError(`Workable has no account called "${board}". Check the name in the company's job links (apply.workable.com/<account>).`);
  const parsed = WkAccount.safeParse(raw);
  if (!parsed.success) throw new SourceError(`${what} sent jobs in a shape we don't recognise`);
  const company = parsed.data.name?.trim() || board;
  return {
    source: "workable",
    board,
    company,
    jobs: parsed.data.jobs.map((j) => toJob(board, company, j)).filter((j): j is Job => !!j),
    fetchedAt: new Date().toISOString(),
  };
}

export const workable: BoardSource = {
  id: "workable",
  name: "Workable",
  boardHint: "the account name, or a link like apply.workable.com/acme",
  parseBoard,
  fetchBoard,
};
