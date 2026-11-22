import { describe, expect, test } from "bun:test";
import { reed, SEARCH_SOURCES, searchSource, SourceError, USER_AGENT } from "../src/index.ts";

// Made-up companies and key, in the shape Reed's Jobseeker API sends. Untested against the live API.
const KEY = "test-reed-key-secret";
const ENV = { REED_API_KEY: KEY };

const ad = (n: number, extra: Record<string, unknown> = {}) => ({
  jobId: 50000 + n,
  employerId: 700,
  employerName: "Acme",
  employerProfileId: null,
  employerProfileName: null,
  jobTitle: `Job ${n}`,
  locationName: "Leeds",
  minimumSalary: 40000.0,
  maximumSalary: 50000.0,
  currency: "GBP",
  expirationDate: "31/12/2026",
  date: "20/11/2026",
  jobDescription: `About job ${n}...`,
  applications: 3,
  jobUrl: `https://www.reed.co.uk/jobs/job-${n}/${50000 + n}`,
  ...extra,
});

interface Call {
  url: URL;
  headers: Record<string, string>;
}

/** Answers search pages by resultsToSkip from `pages`. */
function fakeFetch(pages: Record<number, { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const skip = Number(url.searchParams.get("resultsToSkip"));
    const r = url.host === "www.reed.co.uk" && url.pathname === "/api/1.0/search" ? (pages[skip] ?? { status: 404 }) : { status: 404 };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const opts = (f: typeof fetch, env: Record<string, string | undefined> = ENV) => ({ fetch: f, pauseMs: 0, env });
const ok = (body: unknown) => ({ status: 200, body });
const reply = (results: unknown[], totalResults = results.length) => ok({ results, ambiguousLocations: [], totalResults });

describe("reed", () => {
  test("is registered as a UK job board with a free key and a credit", () => {
    expect(SEARCH_SOURCES.reed).toBe(reed);
    expect(searchSource("Reed")).toBe(reed);
    expect(reed.places).toBe(true);
    expect(reed.countries).toEqual(["gb"]);
    expect(reed.keys).toEqual({ env: ["REED_API_KEY"], signup: "https://www.reed.co.uk/developers/jobseeker" });
    expect(reed.credit).toMatch(/reed\.co\.uk/);
    expect(reed.creditEach).toBeUndefined();
  });

  test("the query: words and place encoded, key in basic auth, our own name", async () => {
    const { f, calls } = fakeFetch({ 0: reply([ad(1)]) });
    await reed.search({ what: "data & ML engineer", where: "Newcastle upon Tyne" }, opts(f));
    expect(calls).toHaveLength(1);
    const { url, headers } = calls[0]!;
    expect(url.origin + url.pathname).toBe("https://www.reed.co.uk/api/1.0/search");
    expect(url.searchParams.get("keywords")).toBe("data & ML engineer");
    expect(url.searchParams.get("locationName")).toBe("Newcastle upon Tyne");
    expect(url.searchParams.get("resultsToTake")).toBe("100");
    expect(url.searchParams.get("resultsToSkip")).toBe("0");
    expect(url.searchParams.has("distanceFromLocation")).toBe(false);
    // The key never travels in the URL.
    expect(url.toString()).not.toContain(KEY);
    expect(headers.authorization).toBe(`Basic ${btoa(`${KEY}:`)}`);
    expect(headers["user-agent"]).toBe(USER_AGENT);

    // No place: no locationName; the country is gb.
    const two = fakeFetch({ 0: reply([]) });
    const r = await reed.search({ what: "nurse" }, opts(two.f));
    expect(two.calls[0]!.url.searchParams.has("locationName")).toBe(false);
    expect(r.query.country).toBe("gb");
    expect(r.jobs).toEqual([]);
    expect(r.totalAds).toBeUndefined();
  });

  test("reads a few pages, stops at the limit and says how many there were", async () => {
    const page = (skip: number) => reply(Array.from({ length: 100 }, (_, i) => ad(skip + i)), 4321);
    const pages = { 0: page(0), 100: page(100), 200: page(200), 300: page(300) };
    const { f, calls } = fakeFetch(pages);
    const r = await reed.search({ what: "engineer", limit: 250 }, opts(f));
    expect(calls.map((c) => c.url.searchParams.get("resultsToSkip"))).toEqual(["0", "100", "200"]);
    expect(r.jobs).toHaveLength(250);
    expect(r.totalAds).toBe(4321);

    // A limit above the ceiling stops at three pages; the default reads one.
    const big = fakeFetch(pages);
    expect((await reed.search({ what: "engineer", limit: 10_000 }, opts(big.f))).jobs).toHaveLength(300);
    expect(big.calls).toHaveLength(3);
    const one = fakeFetch(pages);
    expect((await reed.search({ what: "engineer" }, opts(one.f))).jobs).toHaveLength(100);
    expect(one.calls).toHaveLength(1);

    // A small limit asks for fewer.
    const few = fakeFetch({ 0: reply([ad(1), ad(2), ad(3)]) });
    const r3 = await reed.search({ what: "engineer", limit: 5 }, opts(few.f));
    expect(few.calls[0]!.url.searchParams.get("resultsToTake")).toBe("5");
    expect(r3.jobs).toHaveLength(3);
    expect(r3.totalAds).toBeUndefined();
  });

  test("stops when a page comes back short or everything is read", async () => {
    const { f, calls } = fakeFetch({ 0: reply(Array.from({ length: 100 }, (_, i) => ad(i)), 130), 100: reply(Array.from({ length: 30 }, (_, i) => ad(100 + i)), 130) });
    const r = await reed.search({ what: "engineer", limit: 300 }, opts(f));
    expect(calls).toHaveLength(2);
    expect(r.jobs).toHaveLength(130);
    expect(r.totalAds).toBeUndefined();

    const exact = fakeFetch({ 0: reply(Array.from({ length: 100 }, (_, i) => ad(i)), 100) });
    await reed.search({ what: "engineer", limit: 300 }, opts(exact.f));
    expect(exact.calls).toHaveLength(1);
  });

  test("maps an ad into the common job shape", async () => {
    const first = ad(1, {
      jobTitle: "  Senior Engineer,\n  Payments &amp; Billing ",
      employerName: "Globex",
      locationName: "Leeds",
      jobDescription: "Globex is hiring &amp; growing. <strong>Apply</strong> now...",
    });
    const { f } = fakeFetch({ 0: reply([first]) });
    const r = await reed.search({ what: "engineer" }, opts(f));
    expect(r.source).toBe("reed");
    expect(r.jobs[0]).toEqual({
      id: "reed:gb:50001",
      source: "reed",
      board: "gb",
      company: "Globex",
      title: "Senior Engineer, Payments & Billing",
      locations: ["Leeds"],
      url: "https://www.reed.co.uk/jobs/job-1/50001",
      postedAt: "2026-11-20",
      // No period: the search reply doesn't say.
      pay: [{ min: 40000, max: 50000, currency: "GBP" }],
      description: "Globex is hiring & growing. Apply now...",
    });

    const remote = fakeFetch({ 0: reply([ad(2, { locationName: "Remote" })]) });
    expect((await reed.search({ what: "x" }, opts(remote.f))).jobs[0]!.remote).toBe(true);
  });

  test("pay: only the ad's own, with its currency, never a guessed period", async () => {
    const results = [
      ad(1),
      // An hourly job sends hourly numbers; still no period.
      ad(2, { minimumSalary: 12.5, maximumSalary: 14 }),
      ad(3, { minimumSalary: null, maximumSalary: 30000 }),
      // Hidden pay: nothing sent.
      ad(4, { minimumSalary: null, maximumSalary: null, currency: null }),
      // No currency: left out, not assumed to be pounds.
      ad(5, { currency: null }),
      ad(6, { minimumSalary: 0, maximumSalary: 0 }),
      ad(7, { currency: "eur" }),
    ];
    const { f } = fakeFetch({ 0: reply(results) });
    const r = await reed.search({ what: "x" }, opts(f));
    expect(r.jobs.map((j) => j.pay)).toEqual([
      [{ min: 40000, max: 50000, currency: "GBP" }],
      [{ min: 12.5, max: 14, currency: "GBP" }],
      [{ max: 30000, currency: "GBP" }],
      [],
      [],
      [],
      [{ min: 40000, max: 50000, currency: "EUR" }],
    ]);
  });

  test("dates: dd/mm/yyyy becomes ISO; anything else is left out", async () => {
    const results = [ad(1, { date: "05/01/2026" }), ad(2, { date: "31/02/2026" }), ad(3, { date: "2026-11-20" }), ad(4, { date: null })];
    const { f } = fakeFetch({ 0: reply(results) });
    const r = await reed.search({ what: "x" }, opts(f));
    expect(r.jobs.map((j) => j.postedAt)).toEqual(["2026-01-05", undefined, undefined, undefined]);
  });

  test("a missing key names the variable and where to get it, without asking Reed", async () => {
    const { f, calls } = fakeFetch({});
    await expect(reed.search({ what: "x" }, opts(f, {}))).rejects.toThrow(/free key.*https:\/\/www\.reed\.co\.uk\/developers\/jobseeker.*REED_API_KEY/);
    await expect(reed.search({ what: "x" }, opts(f, { REED_API_KEY: "  " }))).rejects.toThrow(SourceError);
    await expect(reed.search({ what: "x" })).rejects.toThrow(SourceError);
    expect(calls).toHaveLength(0);
  });

  test("a refused key, a missing search, refusals and odd shapes, never showing the key", async () => {
    const fails = async (pages: Record<number, { status: number; body?: unknown }>, re: RegExp) => {
      const err = await reed.search({ what: "x" }, opts(fakeFetch(pages).f)).then(() => undefined, (e: Error) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect(err!.message).toMatch(re);
      expect(err!.message).not.toContain(KEY);
      expect(err!.message).not.toContain(btoa(`${KEY}:`));
    };
    await fails({ 0: { status: 401 } }, /refused the key \(401\)/);
    await fails({}, /no such search \(404\)/);
    await fails({ 0: { status: 429 } }, /asking too often/);
    await fails({ 0: { status: 403 } }, /turned us away \(403\)/);
    await fails({ 0: { status: 500 } }, /answered 500/);
    await fails({ 0: ok({ results: "nope" }) }, /shape we don't recognise/);
    await fails({ 0: ok([ad(1)]) }, /shape we don't recognise/);
    await expect(reed.search({ what: "x", country: "us" }, opts(fakeFetch({}).f))).rejects.toThrow(/doesn't cover "us"/);

    // A network error that repeats the key still doesn't show it.
    const leaky = (async (_input: string | URL | Request, init?: RequestInit) => {
      throw new Error(`failed with ${JSON.stringify(init?.headers)} ${KEY}`);
    }) as unknown as typeof fetch;
    const err = await reed.search({ what: "x" }, opts(leaky)).then(() => undefined, (e: Error) => e);
    expect(err!.message).toMatch(/couldn't reach Reed/);
    expect(err!.message).not.toContain(KEY);
    expect(err!.message).not.toContain(btoa(`${KEY}:`));
  });

  test("malformed ads are skipped, the rest kept; a missing total reads as no more", async () => {
    const results = [
      ad(1),
      { jobId: 9, jobTitle: "No link" },
      ad(2, { employerName: "" }),
      ad(3, { employerName: null }),
      ad(4, { jobUrl: "not a url" }),
      ad(5, { jobId: -1 }),
      "junk",
      null,
      ad(6, { jobId: "50006", locationName: null, date: undefined, jobDescription: null, minimumSalary: undefined, maximumSalary: undefined, employerName: "Globex" }),
    ];
    const { f } = fakeFetch({ 0: ok({ results }) });
    const r = await reed.search({ what: "x" }, opts(f));
    expect(r.jobs.map((j) => j.id)).toEqual(["reed:gb:50001", "reed:gb:50006"]);
    expect(r.jobs[1]).toEqual({ id: "reed:gb:50006", source: "reed", board: "gb", company: "Globex", title: "Job 6", locations: [], url: "https://www.reed.co.uk/jobs/job-6/50006", pay: [] });
    expect(r.totalAds).toBeUndefined();
  });
});
