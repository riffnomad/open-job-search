import { describe, expect, test } from "bun:test";
import { BOARD_SOURCES, SourceError, sourceForLink, USER_AGENT, workable } from "../src/index.ts";

// Made-up account, in the shape Workable's public accounts endpoint sends.
const ACCOUNT = {
  name: " Acme Ltd ",
  description: "<p>We make everything.</p>",
  jobs: [
    {
      title: " Staff Engineer,  Payments &amp; Billing ",
      shortcode: "ACME0001",
      code: "",
      employment_type: "Full-time",
      telecommuting: false,
      department: "Engineering",
      url: "https://apply.workable.com/j/ACME0001",
      shortlink: "https://apply.workable.com/j/ACME0001",
      application_url: "https://apply.workable.com/j/ACME0001/apply",
      published_on: "2026-11-17",
      created_at: "2026-10-16",
      country: "United Kingdom",
      city: "London",
      state: "England",
      locations: [
        { country: "United Kingdom", countryCode: "GB", city: "London", region: "England", hidden: false },
        { country: "United Kingdom", countryCode: "GB", city: "Leeds", region: null, hidden: false },
        { country: "Spain", countryCode: "ES", city: "Madrid", region: "Madrid", hidden: false },
        { country: "France", countryCode: "FR", city: "Paris", region: null, hidden: true },
      ],
      description: "<p>Build &amp; run payments.</p><ul><li>Go</li><li>Kafka</li></ul>",
    },
    {
      title: "Office Manager",
      shortcode: "ACME0002",
      telecommuting: true,
      department: "",
      url: "",
      shortlink: "https://apply.workable.com/j/ACME0002",
      published_on: null,
      created_at: "2026-09-01",
      country: "Portugal",
      city: "",
      state: "",
      locations: [],
      description: "",
    },
    // No link at all: nowhere to read or apply, so it's left out.
    { title: "Ghost", shortcode: "ACME0003", url: null, shortlink: null },
  ],
};

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

const API = "https://www.workable.com/api/accounts/acme?details=true";

describe("workable", () => {
  test("is registered", () => {
    expect(BOARD_SOURCES.workable).toBe(workable);
  });

  test("account names from names and links", () => {
    expect(workable.parseBoard("Acme")).toBe("acme");
    expect(workable.parseBoard("https://apply.workable.com/acme/")).toBe("acme");
    expect(workable.parseBoard("apply.workable.com/acme/j/ACME0001")).toBe("acme");
    expect(workable.parseBoard("https://acme.workable.com/jobs/12345")).toBe("acme");
    expect(workable.parseBoard("acme.workable.com")).toBe("acme");
    // A job link without the account, and Workable's own sites, aren't boards.
    expect(workable.parseBoard("https://apply.workable.com/j/ACME0001")).toBeUndefined();
    expect(workable.parseBoard("https://www.workable.com/")).toBeUndefined();
    expect(workable.parseBoard("https://jobs.workable.com/company/xyz/jobs-at-acme")).toBeUndefined();
    expect(workable.parseBoard("https://job-boards.greenhouse.io/acme")).toBeUndefined();
    expect(workable.parseBoard("not a board!")).toBeUndefined();
    expect(sourceForLink("apply.workable.com/acme")).toMatchObject({ board: "acme", source: { id: "workable" } });
  });

  test("fetches an account into the common job shape", async () => {
    const { f, calls } = fakeFetch({ [API]: { status: 200, body: ACCOUNT } });
    const r = await workable.fetchBoard("acme", { fetch: f });
    expect(calls.map((c) => c.url)).toEqual([API]);
    expect(calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
    expect(r).toMatchObject({ source: "workable", board: "acme", company: "Acme Ltd" });
    expect(r.jobs).toHaveLength(2);
    expect(r.jobs[0]).toEqual({
      id: "workable:acme:ACME0001",
      source: "workable",
      board: "acme",
      company: "Acme Ltd",
      title: "Staff Engineer, Payments & Billing",
      // Every listed place, the hidden one left out and a region that repeats the city dropped.
      locations: ["London, England, United Kingdom", "Leeds, United Kingdom", "Madrid, Spain"],
      url: "https://apply.workable.com/j/ACME0001",
      department: "Engineering",
      postedAt: "2026-11-17",
      pay: [],
      description: "Build & run payments.\n\n- Go\n- Kafka",
    });
    // No locations list: falls back to the job's own fields. Telecommuting means remote. Missing fields stay out.
    expect(r.jobs[1]).toEqual({
      id: "workable:acme:ACME0002",
      source: "workable",
      board: "acme",
      company: "Acme Ltd",
      title: "Office Manager",
      locations: ["Portugal"],
      remote: true,
      url: "https://apply.workable.com/j/ACME0002",
      postedAt: "2026-09-01",
      pay: [],
    });
  });

  test("remote written in a place counts as remote", async () => {
    const body = { name: "Acme", jobs: [{ title: "Designer", shortcode: "ACME0009", url: "https://apply.workable.com/j/ACME0009", locations: [{ city: "Remote", country: "Spain" }] }] };
    const r = await workable.fetchBoard("acme", { fetch: fakeFetch({ [API]: { status: 200, body } }).f });
    expect(r.jobs[0]).toMatchObject({ locations: ["Remote, Spain"], remote: true });
  });

  test("errors in plain words", async () => {
    await expect(workable.fetchBoard("acme", { fetch: fakeFetch({}).f })).rejects.toThrow(/no account called "acme"/);
    await expect(workable.fetchBoard("acme", { fetch: fakeFetch({ [API]: { status: 429 } }).f })).rejects.toThrow(/asking too often/);
    await expect(workable.fetchBoard("acme", { fetch: fakeFetch({ [API]: { status: 200, body: { nope: 1 } } }).f })).rejects.toThrow(/shape we don't recognise/);
    await expect(workable.fetchBoard("../x")).rejects.toThrow(SourceError);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(workable.fetchBoard("acme", { fetch: down })).rejects.toThrow(/couldn't reach Workable \(account "acme"\): ECONNREFUSED/);
  });
});
