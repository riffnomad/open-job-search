import { describe, expect, test } from "bun:test";
import { adzuna, SEARCH_SOURCES, searchSource, SourceError, USER_AGENT } from "../src/index.ts";

// Made-up companies and keys, in the shape Adzuna's API docs describe. Untested against the live API.
const ENV = { ADZUNA_APP_ID: "test-id-123", ADZUNA_APP_KEY: "test-key-secret" };

const ad = (n: number, extra: Record<string, unknown> = {}) => ({
  __CLASS__: "Adzuna::API::Response::Job",
  id: String(4000 + n),
  title: `Job ${n}`,
  description: `About job ${n}`,
  created: "2026-11-20T09:00:00Z",
  redirect_url: `https://www.adzuna.co.uk/jobs/land/ad/${4000 + n}?se=x`,
  company: { __CLASS__: "Adzuna::API::Response::Company", display_name: "Acme" },
  location: { __CLASS__: "Adzuna::API::Response::Location", display_name: "Leeds, West Yorkshire", area: ["UK", "Yorkshire And The Humber", "West Yorkshire", "Leeds"] },
  salary_min: 40000,
  salary_max: 50000,
  salary_is_predicted: "0",
  contract_time: "full_time",
  contract_type: "permanent",
  category: { label: "IT Jobs", tag: "it-jobs" },
  ...extra,
});

interface Call {
  url: URL;
  headers: Record<string, string>;
}

/** Answers search pages by page number from `pages`. */
function fakeFetch(pages: Record<number, { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const m = /^\/v1\/api\/jobs\/([a-z]{2})\/search\/(\d+)$/.exec(url.pathname);
    const r = url.host === "api.adzuna.com" && m ? (pages[Number(m[2])] ?? { status: 404 }) : { status: 404 };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const opts = (f: typeof fetch, env: Record<string, string | undefined> = ENV) => ({ fetch: f, pauseMs: 0, env });
const ok = (body: unknown) => ({ status: 200, body });

describe("adzuna", () => {
  test("is registered as a job board with its countries, keys and credit", () => {
    expect(SEARCH_SOURCES.adzuna).toBe(adzuna);
    expect(searchSource("Adzuna")).toBe(adzuna);
    expect(adzuna.countries![0]).toBe("gb");
    expect(adzuna.countries).toHaveLength(19);
    expect(adzuna.countries).toContain("us");
    expect(adzuna.keys).toEqual({ env: ["ADZUNA_APP_ID", "ADZUNA_APP_KEY"], signup: "https://developer.adzuna.com/signup", cost: "25 test calls, then a paid plan" });
    expect(adzuna.credit).toMatch(/Adzuna/);
    expect(adzuna.places).toBe(true);
  });

  test("the query: keys from env, words and place encoded, our own name", async () => {
    const { f, calls } = fakeFetch({ 1: ok({ count: 1, results: [ad(1)] }) });
    await adzuna.search({ what: "data & ML engineer", where: "Newcastle upon Tyne", country: "us" }, opts(f));
    expect(calls).toHaveLength(1);
    const { url, headers } = calls[0]!;
    expect(url.origin + url.pathname).toBe("https://api.adzuna.com/v1/api/jobs/us/search/1");
    expect(url.searchParams.get("app_id")).toBe("test-id-123");
    expect(url.searchParams.get("app_key")).toBe("test-key-secret");
    expect(url.searchParams.get("what")).toBe("data & ML engineer");
    expect(url.searchParams.get("where")).toBe("Newcastle upon Tyne");
    expect(url.searchParams.get("results_per_page")).toBe("50");
    expect(url.search).toContain("what=data+%26+ML+engineer");
    expect(headers["user-agent"]).toBe(USER_AGENT);

    // No place, no country: gb, and no where.
    const two = fakeFetch({ 1: ok({ count: 0, results: [] }) });
    const r = await adzuna.search({ what: "nurse" }, opts(two.f));
    expect(two.calls[0]!.url.pathname).toBe("/v1/api/jobs/gb/search/1");
    expect(two.calls[0]!.url.searchParams.has("where")).toBe(false);
    expect(r.query.country).toBe("gb");
    expect(r.jobs).toEqual([]);
  });

  test("reads a few pages, stops at the limit and says how many there were", async () => {
    const page = (p: number) => ok({ count: 1234, results: Array.from({ length: 50 }, (_, i) => ad(p * 100 + i)) });
    const { f, calls } = fakeFetch({ 1: page(1), 2: page(2), 3: page(3), 4: page(4) });
    const r = await adzuna.search({ what: "engineer", limit: 120 }, opts(f));
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v1/api/jobs/gb/search/1", "/v1/api/jobs/gb/search/2", "/v1/api/jobs/gb/search/3"]);
    expect(r.jobs).toHaveLength(120);
    expect(r.totalAds).toBe(1234);

    // A limit above the ceiling stops at three pages; the default reads one.
    const big = fakeFetch({ 1: page(1), 2: page(2), 3: page(3), 4: page(4) });
    expect((await adzuna.search({ what: "engineer", limit: 10_000 }, opts(big.f))).jobs).toHaveLength(150);
    expect(big.calls).toHaveLength(3);
    const one = fakeFetch({ 1: page(1), 2: page(2) });
    expect((await adzuna.search({ what: "engineer" }, opts(one.f))).jobs).toHaveLength(50);
    expect(one.calls).toHaveLength(1);

    // A small limit asks for fewer per page.
    const few = fakeFetch({ 1: ok({ count: 3, results: [ad(1), ad(2), ad(3)] }) });
    const r3 = await adzuna.search({ what: "engineer", limit: 5 }, opts(few.f));
    expect(few.calls[0]!.url.searchParams.get("results_per_page")).toBe("5");
    expect(r3.totalAds).toBeUndefined();
  });

  test("stops when a page comes back short", async () => {
    const { f, calls } = fakeFetch({ 1: ok({ count: 60, results: Array.from({ length: 50 }, (_, i) => ad(i)) }), 2: ok({ count: 60, results: Array.from({ length: 10 }, (_, i) => ad(100 + i)) }) });
    const r = await adzuna.search({ what: "engineer", limit: 150 }, opts(f));
    expect(calls).toHaveLength(2);
    expect(r.jobs).toHaveLength(60);
    expect(r.totalAds).toBeUndefined();
  });

  test("maps an ad into the common job shape", async () => {
    const first = ad(1, {
      title: "  Senior Engineer,\n  Payments &amp; Billing ",
      description: "Globex is hiring &amp; growing. <strong>Apply</strong> now&hellip;",
      company: { display_name: "Globex" },
    });
    const { f } = fakeFetch({ 1: ok({ count: 1, results: [first] }) });
    const r = await adzuna.search({ what: "engineer" }, opts(f));
    expect(r.source).toBe("adzuna");
    expect(r.jobs[0]).toEqual({
      id: "adzuna:gb:4001",
      source: "adzuna",
      board: "gb",
      company: "Globex",
      title: "Senior Engineer, Payments & Billing",
      locations: ["Leeds, West Yorkshire"],
      url: "https://www.adzuna.co.uk/jobs/land/ad/4001?se=x",
      postedAt: "2026-11-20T09:00:00Z",
      // No period: Adzuna doesn't say, and full_time/permanent aren't pay periods.
      pay: [{ min: 40000, max: 50000, currency: "GBP" }],
      description: "Globex is hiring & growing. Apply now…",
    });
  });

  test("pay: currency by country, and Adzuna's predicted salaries left out", async () => {
    const results = [
      ad(1),
      ad(2, { salary_is_predicted: "1" }),
      ad(3, { salary_is_predicted: 1 }),
      // Without the flag we can't tell an estimate from the ad's own pay.
      ad(4, { salary_is_predicted: undefined }),
      ad(5, { salary_min: undefined, salary_max: 30000, salary_is_predicted: 0 }),
      ad(6, { salary_min: undefined, salary_max: undefined }),
    ];
    const { f } = fakeFetch({ 1: ok({ count: 6, results }) });
    const r = await adzuna.search({ what: "engineer", country: "de" }, opts(f));
    expect(r.jobs.map((j) => j.pay)).toEqual([[{ min: 40000, max: 50000, currency: "EUR" }], [], [], [], [{ max: 30000, currency: "EUR" }], []]);
    expect(r.jobs[0]!.board).toBe("de");
    expect(r.jobs[0]!.id).toBe("adzuna:de:4001");
  });

  test("missing keys name the variables and where to get them", async () => {
    const { f, calls } = fakeFetch({});
    await expect(adzuna.search({ what: "x" }, opts(f, {}))).rejects.toThrow(/https:\/\/developer\.adzuna\.com\/signup.*ADZUNA_APP_ID and ADZUNA_APP_KEY/);
    await expect(adzuna.search({ what: "x" }, opts(f, { ADZUNA_APP_ID: "a" }))).rejects.toThrow(/set ADZUNA_APP_KEY in/);
    await expect(adzuna.search({ what: "x" })).rejects.toThrow(SourceError);
    expect(calls).toHaveLength(0);
  });

  test("a refused key, a missing search, refusals and odd shapes, never showing the key", async () => {
    const fails = async (pages: Record<number, { status: number; body?: unknown }>, re: RegExp) => {
      const err = await adzuna.search({ what: "x" }, opts(fakeFetch(pages).f)).then(() => undefined, (e: Error) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect(err!.message).toMatch(re);
      expect(err!.message).not.toContain("test-key-secret");
      expect(err!.message).not.toContain("test-id-123");
    };
    await fails({ 1: { status: 401, body: { exception: "AUTH_FAIL" } } }, /refused the key \(401\)/);
    // Adzuna's docs list 410 for "Authorisation failed".
    await fails({ 1: { status: 410, body: { exception: "AUTH_FAIL" } } }, /refused the key/);
    await fails({}, /no such search \(404\)/);
    await fails({ 1: { status: 429 } }, /asking too often/);
    await fails({ 1: { status: 403 } }, /turned us away \(403\)/);
    await fails({ 1: ok({ results: "nope" }) }, /shape we don't recognise/);
    await expect(adzuna.search({ what: "x", country: "jp" }, opts(fakeFetch({}).f))).rejects.toThrow(/doesn't cover "jp"/);

    // A network error that repeats the URL still doesn't show the key.
    const leaky = (async (input: string | URL | Request) => {
      throw new Error(`failed to fetch ${String(input)}`);
    }) as unknown as typeof fetch;
    const err = await adzuna.search({ what: "x" }, opts(leaky)).then(() => undefined, (e: Error) => e);
    expect(err!.message).toMatch(/couldn't reach Adzuna/);
    expect(err!.message).not.toContain("test-key-secret");
    expect(err!.message).not.toContain("test-id-123");
  });

  test("malformed ads are skipped, the rest kept", async () => {
    const results = [
      ad(1),
      { id: "9", title: "No link" },
      ad(2, { company: {} }),
      ad(3, { company: null, title: "x" }),
      ad(4, { redirect_url: "not a url" }),
      "junk",
      null,
      ad(5, { id: 4005, location: undefined, created: undefined, description: undefined, company: { display_name: "Globex" } }),
    ];
    const { f } = fakeFetch({ 1: ok({ count: 8, results }) });
    const r = await adzuna.search({ what: "x" }, opts(f));
    expect(r.jobs.map((j) => j.id)).toEqual(["adzuna:gb:4001", "adzuna:gb:4005"]);
    expect(r.jobs[1]).toEqual({ id: "adzuna:gb:4005", source: "adzuna", board: "gb", company: "Globex", title: "Job 5", locations: [], url: "https://www.adzuna.co.uk/jobs/land/ad/4005?se=x", pay: [{ min: 40000, max: 50000, currency: "GBP" }] });
    // Skipped entries still count as read.
    expect(r.totalAds).toBeUndefined();
  });

  test("labels every ad, as the terms ask", () => {
    expect(adzuna.creditEach).toBe("Adzuna");
  });
});
