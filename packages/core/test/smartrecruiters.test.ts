import { describe, expect, test } from "bun:test";
import { SourceError, smartrecruiters, sourceForLink, USER_AGENT } from "../src/index.ts";

// Made-up company, in the shape the SmartRecruiters Posting API sends.
const posting = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Job ${id}`,
  uuid: `uuid-${id}`,
  refNumber: `REF${id}`,
  company: { identifier: "Acme", name: "Acme Inc" },
  releasedDate: "2026-11-01T10:00:00.000Z",
  location: { city: "Leeds", country: "gb", remote: false },
  ...extra,
});

const FIRST = posting("101", {
  name: " Staff Engineer,  Payments &amp; Billing ",
  location: { city: "London", region: "England", country: "gb", remote: true, hybrid: false, fullLocation: "London, England, United Kingdom" },
  department: { id: "1", label: "Engineering" },
  function: { id: "it", label: "Information Technology" },
});
const SECOND = posting("202", { company: { identifier: "Acme" }, location: { city: "York", region: "York", country: "gb" }, department: null, function: { id: "ops", label: "Operations" } });

const PAGE_1 = { offset: 0, limit: 100, totalFound: 101, content: [FIRST, ...Array.from({ length: 99 }, (_, i) => posting(String(1000 + i)))] };
const PAGE_2 = { offset: 100, limit: 100, totalFound: 101, content: [SECOND] };

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = routes[url] ?? { status: 404 };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const API = "https://api.smartrecruiters.com/v1/companies/acme/postings";
const page = (offset: number) => `${API}?limit=100&offset=${offset}`;

describe("smartrecruiters", () => {
  test("company names from names and links", () => {
    expect(smartrecruiters.parseBoard("Acme")).toBe("acme");
    expect(smartrecruiters.parseBoard("https://jobs.smartrecruiters.com/Acme")).toBe("acme");
    expect(smartrecruiters.parseBoard("jobs.smartrecruiters.com/Acme/101-staff-engineer")).toBe("acme");
    expect(smartrecruiters.parseBoard("https://careers.smartrecruiters.com/Acme")).toBe("acme");
    expect(smartrecruiters.parseBoard("https://job-boards.greenhouse.io/acme")).toBeUndefined();
    expect(smartrecruiters.parseBoard("https://jobs.smartrecruiters.com/")).toBeUndefined();
    expect(smartrecruiters.parseBoard("not a board!")).toBeUndefined();
    expect(sourceForLink("jobs.smartrecruiters.com/Acme")).toMatchObject({ board: "acme", source: { id: "smartrecruiters" } });
  });

  test("reads every page into the common job shape", async () => {
    const { f, calls } = fakeFetch({ [page(0)]: { status: 200, body: PAGE_1 }, [page(100)]: { status: 200, body: PAGE_2 } });
    const r = await smartrecruiters.fetchBoard("acme", { fetch: f });
    expect(calls.map((c) => c.url)).toEqual([page(0), page(100)]);
    expect(calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
    expect(r).toMatchObject({ source: "smartrecruiters", board: "acme", company: "Acme Inc" });
    expect(r.jobs).toHaveLength(101);
    expect(r.jobs[0]).toEqual({
      id: "smartrecruiters:acme:101",
      source: "smartrecruiters",
      board: "acme",
      company: "Acme Inc",
      title: "Staff Engineer, Payments & Billing",
      locations: ["London, England, United Kingdom"],
      remote: true,
      url: "https://jobs.smartrecruiters.com/Acme/101",
      department: "Engineering",
      postedAt: "2026-11-01T10:00:00.000Z",
      pay: [],
    });
    // No full location: built from city, region and country, without repeats. Function stands in for department.
    expect(r.jobs[100]).toEqual({
      id: "smartrecruiters:acme:202",
      source: "smartrecruiters",
      board: "acme",
      company: "Acme Inc",
      title: "Job 202",
      locations: ["York, GB"],
      url: "https://jobs.smartrecruiters.com/Acme/202",
      department: "Operations",
      postedAt: "2026-11-01T10:00:00.000Z",
      pay: [],
    });
  });

  test("a board too big to read in full keeps its newest 2000 ads and says how many there are", async () => {
    const full = (offset: number) => ({ offset, limit: 100, totalFound: 5200, content: Array.from({ length: 100 }, (_, i) => posting(String(offset + i))) });
    const routes = Object.fromEntries(Array.from({ length: 21 }, (_, n) => [page(n * 100), { status: 200, body: full(n * 100) }]));
    const { f, calls } = fakeFetch(routes);
    const r = await smartrecruiters.fetchBoard("acme", { fetch: f });
    expect(calls).toHaveLength(20);
    expect(r.jobs).toHaveLength(2000);
    expect(r.totalAds).toBe(5200);
    // Read in full: no total given.
    const small = await smartrecruiters.fetchBoard("acme", { fetch: fakeFetch({ [page(0)]: { status: 200, body: PAGE_1 }, [page(100)]: { status: 200, body: PAGE_2 } }).f });
    expect(small.totalAds).toBeUndefined();
  });

  test("a company with no jobs (or an unknown name) is an empty board", async () => {
    const { f, calls } = fakeFetch({ [page(0)]: { status: 200, body: { offset: 0, limit: 100, totalFound: 0, content: [] } } });
    const r = await smartrecruiters.fetchBoard("acme", { fetch: f });
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ board: "acme", company: "acme", jobs: [] });
  });

  test("errors in plain words", async () => {
    await expect(smartrecruiters.fetchBoard("acme", { fetch: fakeFetch({}).f })).rejects.toThrow(/no company called "acme"/);
    await expect(smartrecruiters.fetchBoard("acme", { fetch: fakeFetch({ [page(0)]: { status: 429 } }).f })).rejects.toThrow(/asking too often/);
    await expect(smartrecruiters.fetchBoard("acme", { fetch: fakeFetch({ [page(0)]: { status: 200, body: { nope: 1 } } }).f })).rejects.toThrow(/shape we don't recognise/);
    await expect(smartrecruiters.fetchBoard("../x")).rejects.toThrow(SourceError);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(smartrecruiters.fetchBoard("acme", { fetch: down })).rejects.toThrow(/couldn't reach SmartRecruiters \(company "acme"\): ECONNREFUSED/);
  });
});
