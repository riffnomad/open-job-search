import { describe, expect, test } from "bun:test";
import { SEARCH_SOURCES, searchSource, SourceError, usajobs } from "../src/index.ts";

// Made-up agencies, keys and an example.com address, in the shape USAJOBS's API docs describe. Untested against the live API.
const ENV = { USAJOBS_API_KEY: "test-key-secret", USAJOBS_EMAIL: "someone@example.com" };

const ad = (n: number, extra: Record<string, unknown> = {}, details: Record<string, unknown> = {}) => ({
  MatchedObjectId: String(700000 + n),
  MatchedObjectDescriptor: {
    PositionID: `ACME-${n}`,
    PositionTitle: `Job ${n}`,
    PositionURI: `https://www.usajobs.gov:443/GetJob/ViewDetails/${700000 + n}`,
    ApplyURI: [`https://www.usajobs.gov:443/GetJob/ViewDetails/${700000 + n}?PostingChannelID=RESTAPI`],
    PositionLocationDisplay: "Springfield, Illinois",
    PositionLocation: [{ LocationName: "Springfield, Illinois", CountryCode: "United States", CityName: "Springfield, Illinois" }],
    OrganizationName: "Acme Agency",
    DepartmentName: "Department of Globex",
    JobCategory: [{ Name: "Information Technology Management", Code: "2210" }],
    JobGrade: [{ Code: "GS" }],
    PositionSchedule: [{ Name: "Full-time", Code: "1" }],
    PositionOfferingType: [{ Name: "Permanent", Code: "15317" }],
    QualificationSummary: "One year of specialized experience.",
    PositionRemuneration: [{ MinimumRange: "80000.0", MaximumRange: "104000.0", RateIntervalCode: "PA", Description: "Per Year" }],
    PublicationStartDate: "2026-11-20T00:00:00.0000",
    ApplicationCloseDate: "2026-12-04T23:59:59.9970",
    UserArea: {
      Details: {
        JobSummary: "Acme Agency keeps things running.",
        WhoMayApply: { Name: "United States Citizens", Code: "" },
        LowGrade: "12",
        HighGrade: "13",
        ...details,
      },
      IsRadialSearch: false,
    },
    ...extra,
  },
  RelevanceRank: 0,
});

const pageOf = (items: unknown[], all = items.length) => ({
  LanguageCode: "EN",
  SearchParameters: {},
  SearchResult: { SearchResultCount: items.length, SearchResultCountAll: all, SearchResultItems: items, UserArea: {} },
});

interface Call {
  url: URL;
  headers: Record<string, string>;
}

/** Answers search pages by Page number from `pages`. */
function fakeFetch(pages: Record<number, { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = url.host === "data.usajobs.gov" && url.pathname === "/api/search" ? (pages[Number(url.searchParams.get("Page"))] ?? { status: 404 }) : { status: 404 };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const opts = (f: typeof fetch, env: Record<string, string | undefined> = ENV) => ({ fetch: f, pauseMs: 0, env });
const ok = (body: unknown) => ({ status: 200, body });

describe("usajobs", () => {
  test("is registered as a US job board that searches by place, with its keys and credit", () => {
    expect(SEARCH_SOURCES.usajobs).toBe(usajobs);
    expect(searchSource("USAJOBS")).toBe(usajobs);
    expect(usajobs.places).toBe(true);
    expect(usajobs.countries).toEqual(["us"]);
    expect(usajobs.keys).toEqual({ env: ["USAJOBS_API_KEY", "USAJOBS_EMAIL"], signup: "https://developer.usajobs.gov/apirequest/" });
    expect(usajobs.credit).toMatch(/USAJOBS/);
    expect(usajobs.creditEach).toBeUndefined();
  });

  test("the request: words and place, the key and the person's email in headers, not the URL", async () => {
    const { f, calls } = fakeFetch({ 1: ok(pageOf([ad(1)])) });
    await usajobs.search({ what: "data & IT specialist", where: "Springfield, Illinois" }, opts(f));
    expect(calls).toHaveLength(1);
    const { url, headers } = calls[0]!;
    expect(url.origin + url.pathname).toBe("https://data.usajobs.gov/api/search");
    expect(url.searchParams.get("Keyword")).toBe("data & IT specialist");
    expect(url.searchParams.get("LocationName")).toBe("Springfield, Illinois");
    expect(url.searchParams.get("ResultsPerPage")).toBe("50");
    expect(url.searchParams.get("Page")).toBe("1");
    expect(url.search).toContain("Keyword=data+%26+IT+specialist");
    expect(url.search).not.toContain("test-key-secret");
    expect(url.search).not.toContain("example.com");
    // USAJOBS demands the email as the User-Agent: it replaces ours, and is the only user-agent sent.
    expect(headers["user-agent"]).toBe("someone@example.com");
    expect(headers["authorization-key"]).toBe("test-key-secret");
    expect(Object.keys(headers).filter((h) => h.toLowerCase() === "user-agent")).toHaveLength(1);

    // No place: no LocationName. The only country is us.
    const two = fakeFetch({ 1: ok(pageOf([])) });
    const r = await usajobs.search({ what: "nurse" }, opts(two.f));
    expect(two.calls[0]!.url.searchParams.has("LocationName")).toBe(false);
    expect(r.query.country).toBe("us");
    expect(r.jobs).toEqual([]);
    await expect(usajobs.search({ what: "x", country: "gb" }, opts(fakeFetch({}).f))).rejects.toThrow(/only covers US/);
  });

  test("maps an ad into the common job shape, with the federal facts at the end of the description", async () => {
    const first = ad(1, { PositionTitle: "  IT Specialist\n (INFOSEC) &amp; Ops " }, {
      MajorDuties: ["Keeps systems safe.", "Writes plans."],
      PromotionPotential: "13",
      HiringPath: ["public", "vet", "something-new"],
      SecurityClearance: "Secret",
      TeleworkEligible: true,
    });
    const { f } = fakeFetch({ 1: ok(pageOf([first])) });
    const r = await usajobs.search({ what: "it specialist" }, opts(f));
    expect(r.source).toBe("usajobs");
    expect(r.jobs[0]).toEqual({
      id: "usajobs:us:700001",
      source: "usajobs",
      board: "us",
      company: "Acme Agency",
      title: "IT Specialist (INFOSEC) & Ops",
      locations: ["Springfield, Illinois"],
      url: "https://www.usajobs.gov:443/GetJob/ViewDetails/700001",
      department: "Department of Globex",
      postedAt: "2026-11-20T00:00:00.0000",
      pay: [{ min: 80000, max: 104000, currency: "USD", period: "year" }],
      description: [
        "Acme Agency keeps things running.",
        "Duties:\n- Keeps systems safe.\n- Writes plans.",
        "Qualifications:\nOne year of specialized experience.",
        [
          "Grade: GS 12–13",
          "Promotion potential: 13",
          "Who may apply: United States Citizens",
          "Hiring paths: The public; Veterans; something-new",
          "Security clearance: Secret",
          "Telework eligible: yes",
          "Schedule: Full-time",
          "Appointment: Permanent",
          "Closes: 2026-12-04T23:59:59.9970",
        ].join("\n"),
      ].join("\n\n"),
    });
  });

  test("pay: period only from known codes, by code or wording", async () => {
    const pay = (...r: unknown[]) => ({ PositionRemuneration: r });
    const items = [
      ad(1, pay({ MinimumRange: "25.5", MaximumRange: "31.25", RateIntervalCode: "PH" })),
      ad(2, pay({ MinimumRange: 70000, MaximumRange: 90000, RateIntervalCode: "Per Year" })),
      ad(3, pay({ MinimumRange: "300", MaximumRange: "300", RateIntervalCode: "PD" }, { MinimumRange: "6000", MaximumRange: "7000", RateIntervalCode: "PM" })),
      ad(4, pay({ MinimumRange: "2000", MaximumRange: "2500", RateIntervalCode: "BW" })),
      ad(5, pay({ MinimumRange: "100", MaximumRange: "200", RateIntervalCode: "ZZ" })),
      ad(6, pay({ MinimumRange: "0", MaximumRange: "0", RateIntervalCode: "WC" })),
      ad(7, pay({ MinimumRange: "0.0", MaximumRange: "0.0", RateIntervalCode: "PA" })),
      ad(8, pay({ MinimumRange: "$1,000", MaximumRange: "nope", RateIntervalCode: "Without Compensation" })),
      ad(9, pay()),
    ];
    const { f } = fakeFetch({ 1: ok(pageOf(items)) });
    const r = await usajobs.search({ what: "x" }, opts(f));
    expect(r.jobs.map((j) => j.pay)).toEqual([
      [{ min: 25.5, max: 31.25, currency: "USD", period: "hour" }],
      [{ min: 70000, max: 90000, currency: "USD", period: "year" }],
      [{ min: 300, max: 300, currency: "USD", period: "day" }, { min: 6000, max: 7000, currency: "USD", period: "month" }],
      [{ min: 2000, max: 2500, currency: "USD", label: "Bi-weekly" }],
      [{ min: 100, max: 200, currency: "USD" }],
      [],
      [],
      [],
      [],
    ]);
  });

  test("remote only when the ad says so; telework isn't remote", async () => {
    const items = [
      ad(1, {}, { RemoteIndicator: true }),
      ad(2, { PositionLocation: [{ LocationName: "Anywhere in the U.S. (remote job)" }] }),
      ad(3, {}, { TeleworkEligible: "True" }),
      ad(4, {}, { RemoteIndicator: "False" }),
      ad(5, { PositionLocation: [{ LocationName: "Springfield, Illinois" }, { LocationName: "Shelbyville, Illinois" }, { LocationName: "springfield, illinois" }] }),
      ad(6, { PositionLocation: [], PositionLocationDisplay: "Multiple Locations" }),
    ];
    const { f } = fakeFetch({ 1: ok(pageOf(items)) });
    const r = await usajobs.search({ what: "x" }, opts(f));
    expect(r.jobs.map((j) => j.remote)).toEqual([true, true, undefined, undefined, undefined, undefined]);
    expect(r.jobs[2]!.description).toContain("Telework eligible: yes");
    expect(r.jobs[4]!.locations).toEqual(["Springfield, Illinois", "Shelbyville, Illinois"]);
    expect(r.jobs[5]!.locations).toEqual(["Multiple Locations"]);
  });

  test("reads a few pages, stops at the limit and says how many there were", async () => {
    const page = (p: number) => ok(pageOf(Array.from({ length: 100 }, (_, i) => ad(p * 1000 + i)), 5432));
    const { f, calls } = fakeFetch({ 1: page(1), 2: page(2), 3: page(3), 4: page(4) });
    const r = await usajobs.search({ what: "engineer", limit: 250 }, opts(f));
    expect(calls.map((c) => c.url.searchParams.get("Page"))).toEqual(["1", "2", "3"]);
    expect(calls.every((c) => c.url.searchParams.get("ResultsPerPage") === "100")).toBe(true);
    expect(r.jobs).toHaveLength(250);
    expect(r.totalAds).toBe(5432);

    // A limit above the ceiling stops at three pages; the default reads one page of 50.
    const big = fakeFetch({ 1: page(1), 2: page(2), 3: page(3), 4: page(4) });
    expect((await usajobs.search({ what: "engineer", limit: 10_000 }, opts(big.f))).jobs).toHaveLength(300);
    expect(big.calls).toHaveLength(3);
    const one = fakeFetch({ 1: ok(pageOf(Array.from({ length: 50 }, (_, i) => ad(i)), 5432)) });
    expect((await usajobs.search({ what: "engineer" }, opts(one.f))).jobs).toHaveLength(50);
    expect(one.calls).toHaveLength(1);

    // Everything read: no totalAds. A short page stops.
    const short = fakeFetch({ 1: ok(pageOf(Array.from({ length: 100 }, (_, i) => ad(i)), 130)), 2: ok(pageOf(Array.from({ length: 30 }, (_, i) => ad(500 + i)), 130)) });
    const r2 = await usajobs.search({ what: "engineer", limit: 300 }, opts(short.f));
    expect(short.calls).toHaveLength(2);
    expect(r2.jobs).toHaveLength(130);
    expect(r2.totalAds).toBeUndefined();
  });

  test("missing keys name the variables and where to get them, without calling", async () => {
    const { f, calls } = fakeFetch({});
    await expect(usajobs.search({ what: "x" }, opts(f, {}))).rejects.toThrow(/https:\/\/developer\.usajobs\.gov\/apirequest\/.*USAJOBS_API_KEY and USAJOBS_EMAIL/);
    await expect(usajobs.search({ what: "x" }, opts(f, { USAJOBS_API_KEY: "k" }))).rejects.toThrow(/set USAJOBS_EMAIL in/);
    await expect(usajobs.search({ what: "x" }, opts(f, { USAJOBS_EMAIL: "someone@example.com" }))).rejects.toThrow(/set USAJOBS_API_KEY in/);
    await expect(usajobs.search({ what: "x" })).rejects.toThrow(SourceError);
    // A value that isn't an email isn't repeated back.
    const bad = await usajobs.search({ what: "x" }, opts(f, { USAJOBS_API_KEY: "k", USAJOBS_EMAIL: "not-an-email-xyz" })).then(() => undefined, (e: Error) => e);
    expect(bad!.message).toMatch(/doesn't look like an email/);
    expect(bad!.message).not.toContain("not-an-email-xyz");
    expect(calls).toHaveLength(0);
  });

  test("a refused key, a missing search, refusals and odd shapes, never showing the key or email", async () => {
    const fails = async (pages: Record<number, { status: number; body?: unknown }>, re: RegExp) => {
      const err = await usajobs.search({ what: "x" }, opts(fakeFetch(pages).f)).then(() => undefined, (e: Error) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect(err!.message).toMatch(re);
      expect(err!.message).not.toContain("test-key-secret");
      expect(err!.message).not.toContain("someone@example.com");
    };
    await fails({ 1: { status: 401 } }, /refused the key \(401\)/);
    await fails({}, /no such search \(404\)/);
    await fails({ 1: { status: 429 } }, /asking too often/);
    await fails({ 1: { status: 403 } }, /turned us away \(403\)/);
    await fails({ 1: { status: 500 } }, /answered 500/);
    await fails({ 1: ok({ SearchResult: "nope" }) }, /shape we don't recognise/);
    await fails({ 1: ok([]) }, /shape we don't recognise/);

    // A network error that repeats the headers still doesn't show them.
    const leaky = (async (_: unknown, init?: RequestInit) => {
      throw new Error(`failed with ${JSON.stringify(init?.headers)}`);
    }) as unknown as typeof fetch;
    const err = await usajobs.search({ what: "x" }, opts(leaky)).then(() => undefined, (e: Error) => e);
    expect(err!.message).toMatch(/couldn't reach USAJOBS/);
    expect(err!.message).not.toContain("test-key-secret");
    expect(err!.message).not.toContain("someone@example.com");
  });

  test("malformed ads are skipped, the rest kept; missing extras are fine", async () => {
    const items = [
      ad(1),
      { MatchedObjectId: "9", MatchedObjectDescriptor: { PositionTitle: "No link" } },
      ad(2, { PositionURI: "not a url" }),
      ad(3, { PositionURI: "https://jobs.example.com/3" }),
      ad(4, { OrganizationName: null, DepartmentName: null }),
      ad(5, { PositionTitle: "   " }),
      "junk",
      null,
      ad(6, {
        OrganizationName: "",
        PositionLocation: "odd",
        JobGrade: null,
        PositionSchedule: [null, { Name: "Part-time" }],
        PositionOfferingType: undefined,
        PositionRemuneration: "odd",
        QualificationSummary: null,
        PublicationStartDate: undefined,
        ApplicationCloseDate: undefined,
        UserArea: { Details: "odd" },
      }),
    ];
    const { f } = fakeFetch({ 1: ok(pageOf(items)) });
    const r = await usajobs.search({ what: "x" }, opts(f));
    expect(r.jobs.map((j) => j.id)).toEqual(["usajobs:us:700001", "usajobs:us:700006"]);
    // No organisation: the department stands in, and isn't repeated as the department.
    expect(r.jobs[1]).toEqual({
      id: "usajobs:us:700006",
      source: "usajobs",
      board: "us",
      company: "Department of Globex",
      title: "Job 6",
      locations: ["Springfield, Illinois"],
      url: "https://www.usajobs.gov:443/GetJob/ViewDetails/700006",
      pay: [],
      description: "Schedule: Part-time",
    });
    expect(r.totalAds).toBeUndefined();
  });
});
