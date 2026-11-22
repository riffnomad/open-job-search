/**
 * Personio: every company's public job list, through Personio's documented
 * XML feed of open positions (no key).
 * https://developer.personio.de/docs/integration-of-open-positions
 *
 *   GET https://{company}.jobs.personio.de/xml
 *
 * The whole board comes back in one response. Boards live at
 * {company}.jobs.personio.de, or the same at .jobs.personio.com; Personio has
 * no custom domains. An unknown company is a 404.
 *
 * We don't send ?language=. Asking for English empties the descriptions of
 * ads that weren't written in English; the board's own language gives the
 * full text. The feed has no link to the ad (we build the board's job page)
 * and no remote flag (only an office that says "Remote" counts).
 */
import { htmlToText } from "../html.ts";
import { type BoardResult, type Job, type Pay, saysRemote, splitLocations } from "../job.ts";
import { asUrl, type BoardSource, type FetchOptions, getText, isBoardName, SourceError } from "../source.ts";
import { parseXml, XmlError, type XmlNode, xmlChild, xmlChildren, xmlText } from "../xml.ts";

const HOST = /^([a-z0-9][a-z0-9_-]*)\.jobs\.personio\.(?:de|com)$/i;

const boardUrl = (board: string) => `https://${board}.jobs.personio.de`;

function parseBoard(input: string): string | undefined {
  const s = input.trim();
  const url = asUrl(s);
  if (!url) return isBoardName(s) ? s.toLowerCase() : undefined;
  // acme.jobs.personio.de, acme.jobs.personio.com/job/123456
  return HOST.exec(url.hostname)?.[1]?.toLowerCase();
}

const PERIODS: Record<string, Pay["period"]> = {
  yearly: "year",
  annual: "year",
  monthly: "month",
  daily: "day",
  hourly: "hour",
};

function toPay(node: XmlNode): Pay | undefined {
  const currency = xmlText(node, "currencyCode")?.toUpperCase();
  const num = (name: string) => {
    const n = Number(xmlText(node, name));
    return xmlText(node, name) !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const min = num("min");
  const max = num("max");
  if (!currency || (min === undefined && max === undefined)) return undefined;
  const period = PERIODS[xmlText(node, "type")?.toLowerCase() ?? ""];
  return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }), currency, ...(period ? { period } : {}) };
}

/** The ad's sections as "Heading" then its text. */
function describe(position: XmlNode): string {
  return xmlChildren(xmlChild(position, "jobDescriptions"), "jobDescription")
    .map((d) => {
      const heading = xmlText(d, "name");
      const value = xmlText(d, "value");
      const text = value ? htmlToText(value) : "";
      return [heading, text].filter(Boolean).join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function toJob(board: string, position: XmlNode): Job | undefined {
  const id = xmlText(position, "id");
  const title = xmlText(position, "name")?.replace(/\s+/g, " ");
  if (!id || !title) return undefined;
  const offices = [xmlText(position, "office"), ...xmlChildren(xmlChild(position, "additionalOffices"), "office").map((o) => o.text.trim())];
  const locations = splitLocations(...offices);
  const department = xmlText(position, "department");
  const postedAt = xmlText(position, "createdAt");
  const pay: Pay[] = [];
  for (const p of xmlChildren(position, "salaryInformation").map(toPay)) {
    if (p && !pay.some((q) => JSON.stringify(q) === JSON.stringify(p))) pay.push(p);
  }
  const description = describe(position);
  return {
    id: `personio:${board}:${id}`,
    source: "personio",
    board,
    company: xmlText(position, "subcompany") ?? board,
    title,
    locations,
    ...(saysRemote(locations) ? { remote: true as const } : {}),
    url: `${boardUrl(board)}/job/${encodeURIComponent(id)}`,
    ...(department ? { department } : {}),
    ...(postedAt ? { postedAt } : {}),
    pay,
    ...(description ? { description } : {}),
  };
}

async function fetchBoard(board: string, opts: FetchOptions = {}): Promise<BoardResult> {
  if (!isBoardName(board)) throw new SourceError(`"${board}" isn't a Personio company name`);
  board = board.toLowerCase();
  const what = `Personio (company "${board}")`;
  const xml = await getText(`${boardUrl(board)}/xml`, what, opts);
  if (xml === null) throw new SourceError(`Personio has no job board called "${board}". Check the name in the company's job links (<company>.jobs.personio.de).`);
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (e) {
    if (e instanceof XmlError) throw new SourceError(`${what} sent a feed we couldn't read: ${e.message}`);
    throw e;
  }
  if (root.name !== "workzag-jobs") throw new SourceError(`${what} didn't send a job feed (expected <workzag-jobs>, got <${root.name}>)`);
  const jobs = xmlChildren(root, "position")
    .map((p) => toJob(board, p))
    .filter((j): j is Job => !!j);
  // The feed has no company name of its own; when every ad names the same subcompany, that's the company.
  const names = new Set(jobs.map((j) => j.company));
  return {
    source: "personio",
    board,
    company: names.size === 1 ? [...names][0]! : board,
    jobs,
    fetchedAt: new Date().toISOString(),
  };
}

export const personio: BoardSource = {
  id: "personio",
  name: "Personio",
  boardHint: "the company name, or a link like acme.jobs.personio.de",
  parseBoard,
  fetchBoard,
};
