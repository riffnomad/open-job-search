/**
 * Teamtailor: every company's careers site on Teamtailor, through the public
 * RSS feed Teamtailor documents for it (no key).
 * https://support.teamtailor.com/en/articles/11171756-rss-feed-how-to-guide
 *
 *   GET https://{host}/jobs.rss?per_page=100&offset=0
 *
 * RSS 2.0, with Teamtailor's own fields in the "tt" namespace (locations,
 * department, role). It doesn't say what jobs pay, or how many jobs there
 * are, so we page with offset until a short page, up to a cap.
 *
 * The board is the careers site's host name: acme.teamtailor.com (a bare
 * "acme" means that), or the company's own domain (jobs.acme.example), which
 * points at Teamtailor too. A custom domain can't be told apart from any
 * other site offline, so a link to one is only read when Teamtailor is named
 * (ojs jobs fetch teamtailor jobs.acme.example), and the reply has to be a
 * Teamtailor feed before we trust it.
 *
 * Languages: each language a site offers has its own feed, with its own ads,
 * at /{locale}/jobs.rss (/en-GB/jobs.rss, /no/jobs.rss). The root feed is the
 * site's default language only, and for now that's all we read.
 */
import { htmlToText } from "../html.ts";
import { type BoardResult, type Job, saysRemote, splitLocations } from "../job.ts";
import { asUrl, type BoardSource, type FetchOptions, getText, isBoardName, SourceError } from "../source.ts";
import { parseXml, type XmlNode, xmlChild, xmlChildren, xmlText } from "../xml.ts";

/** Jobs per page. The feed sends 100 by default; we ask for it to be sure. */
const PAGE = 100;
/** Stop after this many jobs (10 pages). The feed doesn't give a total, so we can't say how many more there were. */
const MAX_JOBS = 1000;
/** Between pages, so a big board isn't read in a burst. */
const PAUSE_MS = 300;

const SUFFIX = ".teamtailor.com";
// Teamtailor's own sites on teamtailor.com, which are never a company's careers site.
const NOT_SITES = new Set(["www", "app", "api", "docs", "support", "ext", "assets", "status", "partner", "partners"]);
/** A public host name: dot-separated labels, ending in a TLD of letters (so no IP addresses or "localhost"). */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** acme.teamtailor.com, with one label before teamtailor.com that isn't one of Teamtailor's own. */
function isTeamtailorHost(host: string): boolean {
  if (!host.endsWith(SUFFIX)) return false;
  const sub = host.slice(0, -SUFFIX.length);
  return isBoardName(sub) && !NOT_SITES.has(sub);
}

/**
 * The careers site's host from a link, a host or a bare name. Links to
 * *.teamtailor.com always count; any other host only when the caller named
 * Teamtailor, since only fetching it can show it's a Teamtailor site.
 */
function parseBoard(input: string, opts: { named?: boolean } = {}): string | undefined {
  const s = input.trim();
  if (!/[./]/.test(s)) return isBoardName(s) ? `${s.toLowerCase()}${SUFFIX}` : undefined;
  const host = asUrl(s)?.hostname.toLowerCase();
  if (!host || !HOST.test(host)) return undefined;
  if (isTeamtailorHost(host)) return host;
  return opts.named && !host.endsWith(SUFFIX) && host !== "teamtailor.com" ? host : undefined;
}

/**
 * The location's own name, as the careers site shows it ("Östergötland, Sverige"); "city, country"
 * when it has none. The name comes first: the city and address can be a head office's, not where the job is.
 */
function place(loc: XmlNode): string {
  const name = xmlText(loc, "tt:name");
  if (name) return name;
  return [xmlText(loc, "tt:city"), xmlText(loc, "tt:country")].filter(Boolean).join(", ");
}

/** RFC 822 ("Tue, 17 Nov 2026 11:14:24 +0100") as ISO 8601. Left out when it doesn't read as a date. */
function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** The number at the start of the link's last part (/jobs/8746132-customer-success-manager); else the guid. */
function jobId(link: string, guid: string | undefined): string | undefined {
  const last = link.split(/[?#]/)[0]!.split("/").filter(Boolean).pop() ?? "";
  return /^(\d+)(?:-|$)/.exec(last)?.[1] ?? guid;
}

function toJob(board: string, company: string, item: XmlNode): Job | undefined {
  const title = xmlText(item, "title")?.replace(/\s+/g, " ");
  const url = xmlText(item, "link");
  const id = url && jobId(url, xmlText(item, "guid"));
  if (!title || !url || !id) return undefined;
  const locations = splitLocations(...xmlChildren(xmlChild(item, "tt:locations"), "tt:location").map(place));
  const department = xmlText(item, "tt:department");
  const postedAt = isoDate(xmlText(item, "pubDate"));
  const html = xmlText(item, "description");
  const description = html ? htmlToText(html) : "";
  return {
    id: `teamtailor:${board}:${id}`,
    source: "teamtailor",
    board,
    company,
    title,
    locations,
    // "hybrid" means some days in an office, so only "fully" counts.
    ...(xmlText(item, "remoteStatus") === "fully" || saysRemote(locations) ? { remote: true as const } : {}),
    url,
    ...(department ? { department } : {}),
    ...(postedAt ? { postedAt } : {}),
    pay: [],
    ...(description ? { description } : {}),
  };
}

/** The feed's <channel>, once we're sure it's a Teamtailor feed. */
function readChannel(xml: string, host: string): XmlNode {
  const notOurs = new SourceError(`${host} doesn't look like a Teamtailor careers site: its /jobs.rss isn't a Teamtailor job feed.`);
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch {
    throw notOurs;
  }
  const channel = xmlChild(root, "channel");
  if (root.name !== "rss" || !channel || !/teamtailor\.com/i.test(root.attrs["xmlns:tt"] ?? "")) throw notOurs;
  return channel;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchBoard(board: string, opts: FetchOptions = {}): Promise<BoardResult> {
  const host = board.includes(".") ? board.trim().toLowerCase() : parseBoard(board);
  if (!host || !HOST.test(host)) throw new SourceError(`"${board}" isn't a Teamtailor careers site. Give the site's name or host, like acme.teamtailor.com.`);
  const what = `Teamtailor (${host})`;
  const pause = opts.pauseMs ?? PAUSE_MS;
  const jobs: Job[] = [];
  const seen = new Set<string>();
  let company = "";
  for (let offset = 0; offset < MAX_JOBS; offset += PAGE) {
    if (offset > 0 && pause > 0) await sleep(pause);
    const xml = await getText(`https://${host}/jobs.rss?per_page=${PAGE}&offset=${offset}`, what, opts, "application/rss+xml, application/xml, text/xml, */*");
    if (xml === null) throw new SourceError(`there's no Teamtailor careers site at ${host}. Check the host in the company's job links (<name>.teamtailor.com, or their own careers domain).`);
    const channel = readChannel(xml, host);
    const items = xmlChildren(channel, "item");
    company ||= xmlText(channel, "title") ?? xmlText(items[0], "company_name") ?? host;
    let added = 0;
    for (const item of items) {
      const job = toJob(host, company, item);
      if (job && !seen.has(job.id)) {
        seen.add(job.id);
        jobs.push(job);
        added++;
      }
    }
    // A short page is the last; a page with nothing new means the site ignores offset.
    if (items.length < PAGE || added === 0) break;
  }
  return {
    source: "teamtailor",
    board: host,
    company,
    jobs: jobs.slice(0, MAX_JOBS),
    fetchedAt: new Date().toISOString(),
  };
}

export const teamtailor: BoardSource = {
  id: "teamtailor",
  name: "Teamtailor",
  boardHint: "the site's name or host, like acme.teamtailor.com or the company's own careers domain",
  parseBoard,
  fetchBoard,
};
