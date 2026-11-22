/**
 * Recruitee: every company's public careers site, through its XML offer
 * feed (no key).
 *
 *   GET https://{company}.recruitee.com/api/feeds/offers.xml
 *
 * The feed carries the same fields as the Careers Site API's /api/offers/,
 * but only published ads. We read the feed because, from 10 February 2027,
 * /api/offers/ needs a per-company X-Careers-Sites-Token, and Recruitee says
 * the XML offer feed is not covered by that:
 * https://docs.recruitee.com/reference/authentication-1
 * (the feed's address: https://support.recruitee.com/en/articles/8213076-faq-api).
 *
 * Careers sites live at {company}.recruitee.com, ads at .../o/{slug}. Some
 * companies show their site on their own domain; the recruitee.com address
 * still answers for them, so we only read that one. An unknown company is a 404.
 */
import { decodeEntities, htmlToText } from "../html.ts";
import { type BoardResult, type Job, type Pay, saysRemote, splitLocations } from "../job.ts";
import { asUrl, type BoardSource, type FetchOptions, getText, SourceError } from "../source.ts";
import { parseXml, XmlError, type XmlNode, xmlChild, xmlChildren, xmlText } from "../xml.ts";

// The company's name becomes part of a hostname: one DNS label, nothing else.
const isCompany = (s: string): boolean => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s);
// recruitee.com's own sites, not careers sites.
const NOT_COMPANIES = new Set(["www", "app", "api", "docs", "support", "blog"]);

function parseBoard(input: string): string | undefined {
  const s = input.trim();
  const url = asUrl(s);
  const name = url ? /^([^.]+)\.recruitee\.com$/i.exec(url.hostname)?.[1] : s;
  if (!name || !isCompany(name) || NOT_COMPANIES.has(name.toLowerCase())) return undefined;
  return name.toLowerCase();
}

/** "2026-10-29 14:24:42 UTC", as Recruitee writes dates, in ISO 8601. */
function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(s.trim());
  if (m) return `${m[1]}T${m[2]}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const PERIODS: Record<string, Pay["period"]> = { year: "year", annual: "year", yearly: "year", month: "month", monthly: "month", day: "day", daily: "day", hour: "hour", hourly: "hour" };

/** A salary amount; 0 and blanks (the feed writes <min></min>) mean "not given". */
function amount(v: string | undefined): number | undefined {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Pay from <salary><min/><max/><currency/><period/></salary>. */
function toPay(salary: XmlNode | undefined): Pay | undefined {
  const min = amount(xmlText(salary, "min"));
  const max = amount(xmlText(salary, "max"));
  const currency = xmlText(salary, "currency");
  if (!currency || (min === undefined && max === undefined)) return undefined;
  const period = PERIODS[(xmlText(salary, "period") ?? "").toLowerCase()];
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    currency: currency.toUpperCase(),
    ...(period ? { period } : {}),
  };
}

/** "Berlin, Germany" from a location's city (or name) and country, without saying a place twice. */
function place(l: XmlNode): string {
  const parts: string[] = [];
  for (const t of [xmlText(l, "city") ?? xmlText(l, "name"), xmlText(l, "country")]) {
    if (t && !parts.some((x) => x.toLowerCase() === t.toLowerCase())) parts.push(t);
  }
  return parts.join(", ");
}

/** The feed writes booleans as "true" and "false". */
const isTrue = (o: XmlNode, name: string): boolean => xmlText(o, name)?.toLowerCase() === "true";

function toJob(board: string, company: string, o: XmlNode, id: string, title: string, url: string): Job {
  const listed = splitLocations(...xmlChildren(xmlChild(o, "locations"), "location").map(place));
  const locations = listed.length ? listed : splitLocations(xmlText(o, "location") || place(o));
  const department = xmlText(o, "department");
  const postedAt = isoDate(xmlText(o, "published_at")) ?? isoDate(xmlText(o, "created_at"));
  const updatedAt = isoDate(xmlText(o, "updated_at"));
  const pay = toPay(xmlChild(o, "salary"));
  // Recruitee keeps the requirements in their own field, shown under their own heading on the careers
  // site; without one here the duties and the requirements run together as one list.
  const about = htmlToText(xmlText(o, "description") ?? "");
  const needs = htmlToText(xmlText(o, "requirements") ?? "");
  const description = about && needs ? `${about}\n\nRequirements\n\n${needs}` : about || needs;
  return {
    id: `recruitee:${board}:${id}`,
    source: "recruitee",
    board,
    company: xmlText(o, "company_name") || company,
    title: decodeEntities(title).replace(/\s+/g, " ").trim(),
    locations,
    ...(isTrue(o, "remote") || saysRemote(locations) ? { remote: true as const } : {}),
    url,
    ...(department ? { department } : {}),
    ...(postedAt ? { postedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    pay: pay ? [pay] : [],
    ...(description ? { description } : {}),
  };
}

async function fetchBoard(board: string, opts: FetchOptions = {}): Promise<BoardResult> {
  if (!isCompany(board)) throw new SourceError(`"${board}" isn't a Recruitee careers site name`);
  const what = `Recruitee (careers site "${board}")`;
  const xml = await getText(`https://${board.toLowerCase()}.recruitee.com/api/feeds/offers.xml`, what, opts);
  if (xml === null) throw new SourceError(`Recruitee has no careers site called "${board}". Check the name in the company's job links (<name>.recruitee.com).`);
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (e) {
    if (e instanceof XmlError) throw new SourceError(`${what} sent a job feed we couldn't read (${e.message})`);
    throw e;
  }
  if (root.name !== "offers") throw new SourceError(`${what} sent jobs in a shape we don't recognise`);
  // The feed holds only published ads, so there's no status to check. An ad without an id, title or link can't be shown.
  const offers = xmlChildren(root, "offer").flatMap((o) => {
    const id = xmlText(o, "id");
    const title = xmlText(o, "title");
    const url = xmlText(o, "careers_url");
    return id && title && url ? [{ o, id, title, url }] : [];
  });
  const company = offers.map(({ o }) => xmlText(o, "company_name")).find(Boolean) || board;
  return {
    source: "recruitee",
    board,
    company,
    jobs: offers.map(({ o, id, title, url }) => toJob(board, company, o, id, title, url)),
    fetchedAt: new Date().toISOString(),
  };
}

export const recruitee: BoardSource = {
  id: "recruitee",
  name: "Recruitee",
  boardHint: "the careers site name, or a link like acme.recruitee.com",
  parseBoard,
  fetchBoard,
};
