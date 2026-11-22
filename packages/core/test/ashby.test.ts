import { describe, expect, test } from "bun:test";
import { ashby, SourceError, sourceForLink, USER_AGENT } from "../src/index.ts";

// Made-up board, in the shape the Ashby Job Postings API sends.
const BOARD = {
  apiVersion: "1",
  jobs: [
    {
      id: "a1b2c3d4-0000-4000-8000-000000000001",
      title: " Staff Engineer,  Payments &amp; Billing ",
      department: "Engineering",
      team: "Payments",
      employmentType: "FullTime",
      location: "Remote - United Kingdom",
      secondaryLocations: [
        { location: "London", address: { postalAddress: { addressLocality: "London", addressCountry: "United Kingdom" } } },
        { location: "remote - united kingdom", address: { postalAddress: { addressCountry: "United Kingdom" } } },
      ],
      publishedAt: "2026-10-01T09:00:00.000+00:00",
      isListed: true,
      isRemote: true,
      workplaceType: "Remote",
      shouldDisplayCompensationOnJobPostings: true,
      jobUrl: "https://jobs.ashbyhq.com/Acme/a1b2c3d4-0000-4000-8000-000000000001",
      applyUrl: "https://jobs.ashbyhq.com/acme/a1b2c3d4-0000-4000-8000-000000000001/application",
      descriptionHtml: "<p>Build &amp; run payments.</p>",
      descriptionPlain: " Build & run payments.\n\n\n - Go\n - Kafka ",
      compensation: {
        compensationTierSummary: "£90K – £120K • Offers Equity",
        compensationTiers: [
          {
            id: "t1",
            title: " UK  Tier 1 ",
            components: [
              { id: "c1", compensationType: "Salary", interval: "1 YEAR", currencyCode: "gbp", minValue: 90000, maxValue: 120000 },
              { id: "c2", compensationType: "EquityPercentage", interval: "NONE", currencyCode: null, minValue: null, maxValue: null },
              { id: "c3", compensationType: "Commission", interval: "1 YEAR", currencyCode: "GBP", minValue: 10000, maxValue: 20000 },
            ],
          },
          {
            id: "t2",
            title: null,
            components: [
              { id: "c4", compensationType: "Salary", interval: "1 HOUR", currencyCode: "USD", minValue: 54, maxValue: null },
              { id: "c5", compensationType: "Salary", interval: "1 YEAR", currencyCode: "USD", minValue: null, maxValue: null },
            ],
          },
        ],
      },
    },
    {
      // Ashby marks hybrid jobs isRemote too: not remote. No plain text: falls back to the HTML.
      id: "a1b2c3d4-0000-4000-8000-000000000002",
      title: "Office Manager",
      team: "Workplace",
      location: "Leeds; York",
      secondaryLocations: [],
      isListed: true,
      isRemote: true,
      workplaceType: "Hybrid",
      shouldDisplayCompensationOnJobPostings: false,
      jobUrl: "https://jobs.ashbyhq.com/acme/a1b2c3d4-0000-4000-8000-000000000002",
      descriptionHtml: "<p>Run the office.</p><ul><li>Desks</li><li>Coffee</li></ul>",
      descriptionPlain: "",
      compensation: { compensationTiers: [{ title: "UK", components: [{ compensationType: "Salary", interval: "1 YEAR", currencyCode: "GBP", minValue: 30000, maxValue: 35000 }] }] },
    },
    {
      id: "a1b2c3d4-0000-4000-8000-000000000003",
      title: "Hidden Role",
      isListed: false,
      jobUrl: "https://jobs.ashbyhq.com/acme/a1b2c3d4-0000-4000-8000-000000000003",
    },
  ],
};

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

const API = "https://api.ashbyhq.com/posting-api/job-board/acme";

describe("ashby", () => {
  test("board names from names and links", () => {
    expect(ashby.parseBoard("Acme")).toBe("acme");
    expect(ashby.parseBoard("Acme Labs")).toBe("acme labs");
    expect(ashby.parseBoard("https://jobs.ashbyhq.com/Acme")).toBe("acme");
    expect(ashby.parseBoard("jobs.ashbyhq.com/acme/a1b2c3d4-0000-4000-8000-000000000001")).toBe("acme");
    expect(ashby.parseBoard("https://jobs.ashbyhq.com/Acme%20Labs/a1b2c3d4/application")).toBe("acme labs");
    expect(ashby.parseBoard("https://jobs.ashbyhq.com/acme.io")).toBe("acme.io");
    expect(ashby.parseBoard("https://jobs.ashbyhq.com/")).toBeUndefined();
    expect(ashby.parseBoard("https://jobs.ashbyhq.com/..%2Fx")).toBeUndefined();
    expect(ashby.parseBoard("https://job-boards.greenhouse.io/acme")).toBeUndefined();
    expect(ashby.parseBoard("not a board!")).toBeUndefined();
    expect(sourceForLink("jobs.ashbyhq.com/acme")).toMatchObject({ board: "acme", source: { id: "ashby" } });
  });

  test("fetches a board into the common job shape", async () => {
    const { f, calls } = fakeFetch({ [API]: { status: 200, body: BOARD } });
    const r = await ashby.fetchBoard("acme", { fetch: f });
    expect(calls.map((c) => c.url)).toEqual([`${API}?includeCompensation=true`]);
    expect(calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
    expect(r).toMatchObject({ source: "ashby", board: "acme", company: "Acme" });
    expect(r.jobs).toHaveLength(2);
    expect(r.jobs[0]).toEqual({
      id: "ashby:acme:a1b2c3d4-0000-4000-8000-000000000001",
      source: "ashby",
      board: "acme",
      company: "Acme",
      title: "Staff Engineer, Payments & Billing",
      locations: ["Remote - United Kingdom", "London"],
      remote: true,
      url: "https://jobs.ashbyhq.com/Acme/a1b2c3d4-0000-4000-8000-000000000001",
      department: "Engineering",
      postedAt: "2026-10-01T09:00:00.000+00:00",
      pay: [
        { min: 90000, max: 120000, currency: "GBP", period: "year", label: "UK Tier 1" },
        { min: 54, currency: "USD", period: "hour" },
      ],
      description: "Build & run payments.\n\n- Go\n- Kafka",
    });
    // Hybrid isn't remote; team stands in for department; pay the company hides stays hidden.
    expect(r.jobs[1]).toEqual({
      id: "ashby:acme:a1b2c3d4-0000-4000-8000-000000000002",
      source: "ashby",
      board: "acme",
      company: "Acme",
      title: "Office Manager",
      locations: ["Leeds", "York"],
      url: "https://jobs.ashbyhq.com/acme/a1b2c3d4-0000-4000-8000-000000000002",
      department: "Workplace",
      pay: [],
      description: "Run the office.\n\n- Desks\n- Coffee",
    });
  });

  test("names with spaces are encoded in the link", async () => {
    const { f, calls } = fakeFetch({ [`${API}%20labs`]: { status: 200, body: { jobs: [] } } });
    const r = await ashby.fetchBoard("acme labs", { fetch: f });
    expect(calls[0]!.url).toBe(`${API}%20labs?includeCompensation=true`);
    expect(r.jobs).toEqual([]);
  });

  test("errors in plain words", async () => {
    await expect(ashby.fetchBoard("acme", { fetch: fakeFetch({}).f })).rejects.toThrow(/no board called "acme"/);
    await expect(ashby.fetchBoard("acme", { fetch: fakeFetch({ [API]: { status: 429 } }).f })).rejects.toThrow(/asking too often/);
    await expect(ashby.fetchBoard("acme", { fetch: fakeFetch({ [API]: { status: 200, body: { nope: 1 } } }).f })).rejects.toThrow(/shape we don't recognise/);
    await expect(ashby.fetchBoard("../x")).rejects.toThrow(SourceError);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(ashby.fetchBoard("acme", { fetch: down })).rejects.toThrow(/couldn't reach Ashby \(board "acme"\): ECONNREFUSED/);
  });
});
