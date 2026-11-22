import { describe, expect, test } from "bun:test";
import { BOARD_SOURCES, lever, SourceError, sourceForLink, USER_AGENT } from "../src/index.ts";

// Made-up site, in the shape the Lever Postings API sends.
const POSTINGS = [
  {
    id: "0f1e2d3c-aaaa-4bbb-8ccc-000000000101",
    text: " Staff Engineer,  Payments &amp; Billing ",
    hostedUrl: "https://jobs.lever.co/acme/0f1e2d3c-aaaa-4bbb-8ccc-000000000101",
    applyUrl: "https://jobs.lever.co/acme/0f1e2d3c-aaaa-4bbb-8ccc-000000000101/apply",
    createdAt: 1793620800000,
    country: "GB",
    workplaceType: "remote",
    categories: { commitment: "Full-time", department: "Engineering", team: "Payments", location: "London, UK", allLocations: ["London, UK", "Leeds, UK"] },
    description: "<div>Build &amp; run payments.</div><div><br></div><div>Small team.</div>",
    descriptionPlain: "Build & run payments.\n\nSmall team.",
    lists: [
      { text: "What you'll need", content: "<div>\n<li>Go</li>\n<li>Kafka</li>\n</div>" },
      { text: "Empty", content: "" },
    ],
    salaryDescription: "<div>Plus equity.</div>",
    additional: "<div>We sponsor visas.</div>",
    additionalPlain: "We sponsor visas.",
    salaryRange: { min: 90000, max: 120000, currency: "gbp", interval: "per-year-salary" },
  },
  {
    id: "0f1e2d3c-aaaa-4bbb-8ccc-000000000102",
    text: "Office Manager",
    hostedUrl: "https://jobs.lever.co/acme/0f1e2d3c-aaaa-4bbb-8ccc-000000000102",
    workplaceType: "onsite",
    categories: { team: "Operations", location: "York" },
    descriptionPlain: "Run the office.",
    lists: [],
    additional: "",
    additionalPlain: "",
    salaryRange: { min: 18, max: 22, currency: "GBP", interval: "per-hour-wage" },
  },
  {
    id: "0f1e2d3c-aaaa-4bbb-8ccc-000000000103",
    text: "Support Lead",
    hostedUrl: "https://jobs.lever.co/acme/0f1e2d3c-aaaa-4bbb-8ccc-000000000103",
    workplaceType: "unspecified",
    categories: { location: "Remote - Europe" },
    salaryRange: { min: 0, max: 0, currency: "EUR", interval: "per-year-salary" },
  },
];

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = Object.keys(routes).find((k) => url.startsWith(k) && (url.length === k.length || url[k.length] === "?"));
    const r = key ? routes[key]! : { status: 404 };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const API = "https://api.lever.co/v0/postings/acme";
const EU_API = "https://api.eu.lever.co/v0/postings/acme";

describe("lever", () => {
  test("is registered", () => {
    expect(BOARD_SOURCES.lever).toBe(lever);
  });

  test("site names from names and links", () => {
    expect(lever.parseBoard("Acme")).toBe("acme");
    expect(lever.parseBoard("https://jobs.lever.co/acme")).toBe("acme");
    expect(lever.parseBoard("jobs.lever.co/acme/0f1e2d3c-aaaa-4bbb-8ccc-000000000101")).toBe("acme");
    expect(lever.parseBoard("https://jobs.lever.co/acme/0f1e2d3c-aaaa-4bbb-8ccc-000000000101/apply")).toBe("acme");
    expect(lever.parseBoard("https://jobs.eu.lever.co/acme")).toBe("acme");
    expect(lever.parseBoard("jobs.eu.lever.co/acme/0f1e2d3c")).toBe("acme");
    expect(lever.parseBoard("https://job-boards.greenhouse.io/acme")).toBeUndefined();
    expect(lever.parseBoard("https://jobs.lever.co/")).toBeUndefined();
    expect(lever.parseBoard("not a board!")).toBeUndefined();
    expect(sourceForLink("jobs.lever.co/acme")).toMatchObject({ board: "acme", source: { id: "lever" } });
    expect(sourceForLink("https://jobs.eu.lever.co/acme")).toMatchObject({ board: "acme", source: { id: "lever" } });
  });

  test("fetches a site into the common job shape", async () => {
    const { f, calls } = fakeFetch({ [API]: { status: 200, body: POSTINGS } });
    const r = await lever.fetchBoard("acme", { fetch: f });
    expect(calls.map((c) => c.url)).toEqual([`${API}?mode=json`]);
    expect(calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
    expect(r).toMatchObject({ source: "lever", board: "acme", company: "acme" });
    expect(r.jobs[0]).toEqual({
      id: "lever:acme:0f1e2d3c-aaaa-4bbb-8ccc-000000000101",
      source: "lever",
      board: "acme",
      company: "acme",
      title: "Staff Engineer, Payments & Billing",
      locations: ["London, UK", "Leeds, UK"],
      remote: true,
      url: "https://jobs.lever.co/acme/0f1e2d3c-aaaa-4bbb-8ccc-000000000101",
      department: "Engineering",
      postedAt: "2026-11-02T12:00:00.000Z",
      pay: [{ min: 90000, max: 120000, currency: "GBP", period: "year" }],
      description: "Build & run payments.\n\nSmall team.\n\nWhat you'll need\n- Go\n- Kafka\n\nPlus equity.\n\nWe sponsor visas.",
    });
    // No department: the team stands in. Plain description when there's no HTML. Missing fields stay out.
    expect(r.jobs[1]).toEqual({
      id: "lever:acme:0f1e2d3c-aaaa-4bbb-8ccc-000000000102",
      source: "lever",
      board: "acme",
      company: "acme",
      title: "Office Manager",
      locations: ["York"],
      url: "https://jobs.lever.co/acme/0f1e2d3c-aaaa-4bbb-8ccc-000000000102",
      department: "Operations",
      pay: [{ min: 18, max: 22, currency: "GBP", period: "hour" }],
      description: "Run the office.",
    });
    // "Remote" in the location counts; a 0–0 placeholder isn't pay.
    expect(r.jobs[2]).toMatchObject({ locations: ["Remote - Europe"], remote: true, pay: [] });
  });

  test("a site the global API doesn't know is looked for in the EU", async () => {
    const { f, calls } = fakeFetch({ [EU_API]: { status: 200, body: [POSTINGS[1]] } });
    const r = await lever.fetchBoard("acme", { fetch: f });
    expect(calls.map((c) => c.url)).toEqual([`${API}?mode=json`, `${EU_API}?mode=json`]);
    expect(r.jobs).toHaveLength(1);
  });

  test("an EU site the global API lists as empty is looked for in the EU", async () => {
    const { f, calls } = fakeFetch({ [API]: { status: 200, body: [] }, [EU_API]: { status: 200, body: [POSTINGS[1]] } });
    const r = await lever.fetchBoard("acme", { fetch: f });
    expect(calls.map((c) => c.url)).toEqual([`${API}?mode=json`, `${EU_API}?mode=json`]);
    expect(r.jobs).toHaveLength(1);
  });

  test("a site with no open jobs is empty, not an error", async () => {
    const r = await lever.fetchBoard("acme", { fetch: fakeFetch({ [API]: { status: 200, body: [] } }).f });
    expect(r.jobs).toEqual([]);
  });

  test("errors in plain words", async () => {
    await expect(lever.fetchBoard("acme", { fetch: fakeFetch({}).f })).rejects.toThrow(/no site called "acme"/);
    await expect(lever.fetchBoard("acme", { fetch: fakeFetch({ [API]: { status: 429 } }).f })).rejects.toThrow(/asking too often/);
    await expect(lever.fetchBoard("acme", { fetch: fakeFetch({ [API]: { status: 200, body: { ok: true } } }).f })).rejects.toThrow(/shape we don't recognise/);
    await expect(lever.fetchBoard("acme", { fetch: fakeFetch({ [API]: { status: 200, body: [{ id: 1 }] } }).f })).rejects.toThrow(/shape we don't recognise/);
    await expect(lever.fetchBoard("../x")).rejects.toThrow(SourceError);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(lever.fetchBoard("acme", { fetch: down })).rejects.toThrow(/couldn't reach Lever \(site "acme"\): ECONNREFUSED/);
  });
});
