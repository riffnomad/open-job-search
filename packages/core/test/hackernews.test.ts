import { describe, expect, test } from "bun:test";
import { hackernews, SEARCH_SOURCES, searchSource, SourceError, USER_AGENT } from "../src/index.ts";
import { firstLine, parseFirstLine, payOf, pickThread } from "../src/jobs/sources/hackernews.ts";

// Made-up companies, in the shape Algolia's HN Search API sends.
const THREADS = "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=20";
const ITEM = (id: number | string) => `https://hn.algolia.com/api/v1/items/${id}`;

const OCT = 1790000000; // 2026-09-21
const NOV = 1792600000; // 2026-10-21
const hit = (id: number, title: string, at: number, comments = 300) => ({ objectID: String(id), title, created_at_i: at, num_comments: comments, author: "whoishiring" });
const list = (...hits: unknown[]) => ({ hits, nbHits: hits.length });
const hiring = (id: number, month: string, at: number, comments?: number) => hit(id, `Ask HN: Who is hiring? (${month})`, at, comments);

const comment = (id: number, text: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  author: text === null ? null : `user${id}`,
  text,
  created_at: "2026-11-02T16:05:00.000Z",
  created_at_i: 1793635500,
  parent_id: 900,
  story_id: 900,
  type: "comment",
  points: null,
  children: [],
  ...extra,
});
const thread = (id: number, children: unknown[]) => ({ id, title: "Ask HN: Who is hiring? (November 2026)", author: "whoishiring", type: "story", children });

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fake fetch answering by URL. */
function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = routes[url] ?? { status: 404 };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const board = (children: unknown[]) =>
  fakeFetch({
    [THREADS]: { status: 200, body: list(hit(901, "Ask HN: Who wants to be hired? (November 2026)", NOV), hiring(900, "November 2026", NOV), hiring(800, "October 2026", OCT)) },
    [ITEM(900)]: { status: 200, body: thread(900, children) },
  });

describe("hackernews", () => {
  test("is a job board with no key and no places, crediting Hacker News", () => {
    expect(SEARCH_SOURCES.hackernews).toBe(hackernews);
    expect(searchSource("HackerNews")).toBe(hackernews);
    expect(hackernews.places).toBe(false);
    expect(hackernews.credit).toMatch(/^From Hacker News: Ask HN: Who is hiring\?/);
    expect(hackernews.keys).toBeUndefined();
    expect(hackernews.countries).toBeUndefined();
  });

  test("finds the newest hiring thread, then reads it in one request, with our name", async () => {
    const { f, calls } = board([comment(1, "Acme | Backend Engineer | Remote | Full-time")]);
    const r = await hackernews.search({ what: "engineer" }, { fetch: f });
    expect(calls.map((c) => c.url)).toEqual([THREADS, ITEM(900)]);
    for (const c of calls) expect(c.headers["user-agent"]).toBe(USER_AGENT);
    expect(r.source).toBe("hackernews");
    expect(r.query).toEqual({ what: "engineer" });
    expect(r.jobs.map((j) => j.id)).toEqual(["hackernews:900:1"]);
  });

  test("searching again soon reuses the replies", async () => {
    const { f, calls } = board([comment(1, "Acme | Backend Engineer | Remote")]);
    await hackernews.search({ what: "engineer" }, { fetch: f });
    await hackernews.search({ what: "backend" }, { fetch: f });
    expect(calls).toHaveLength(2);
  });

  test("maps an ad into the common shape, linking to the comment on Hacker News", async () => {
    const text =
      "Acme Robotics | Senior Backend Engineer | London, UK | REMOTE (UK) | Full-time | £80k–£100k | <a href=\"https:&#x2F;&#x2F;acme.example&#x2F;jobs\" rel=\"nofollow\">https:&#x2F;&#x2F;acme.example&#x2F;jobs</a><p>We build robots &amp; more.<p>Email jobs@acme.example";
    const r = await hackernews.search({ what: "backend engineer" }, { fetch: board([comment(4242, text)]).f });
    expect(r.jobs).toEqual([
      {
        id: "hackernews:900:4242",
        source: "hackernews",
        board: "900",
        company: "Acme Robotics",
        title: "Senior Backend Engineer",
        locations: ["London, UK", "REMOTE (UK)"],
        remote: true,
        url: "https://news.ycombinator.com/item?id=4242",
        postedAt: "2026-11-02T16:05:00.000Z",
        pay: [{ min: 80000, max: 100000, currency: "GBP" }],
        description: "Acme Robotics | Senior Backend Engineer | London, UK | REMOTE (UK) | Full-time | £80k–£100k | https://acme.example/jobs\nWe build robots & more.\nEmail jobs@acme.example",
      },
    ]);
  });

  test("an ad without the usual shape keeps its first line, shortened, as its title, and nothing guessed", async () => {
    const long = `Globex is hiring engineers to build ${"very ".repeat(30)}good things.`;
    const r = await hackernews.search({ what: "globex" }, { fetch: board([comment(7, `${long}<p>Apply by email.`), comment(8, "Globex - Engineer - Berlin")]).f });
    const [a, b] = r.jobs;
    expect(a!.company).toBe("");
    expect(a!.title.length).toBeLessThanOrEqual(100);
    expect(a!.title.endsWith("…")).toBe(true);
    expect(a!.title.startsWith("Globex is hiring engineers")).toBe(true);
    expect(a!.locations).toEqual([]);
    expect(a!.remote).toBeUndefined();
    expect(a!.pay).toEqual([]);
    expect(a!.description).toContain("Apply by email.");
    expect(b!.title).toBe("Globex - Engineer - Berlin");
  });

  test("words are matched against the first line, not the rest of the ad", async () => {
    const r = await hackernews.search(
      { what: "rust" },
      { fetch: board([comment(1, "Acme | Rust Engineer | Remote"), comment(2, "Globex | Go Engineer | Remote<p>We also like Rust.")]).f },
    );
    expect(r.jobs.map((j) => j.id)).toEqual(["hackernews:900:1"]);
  });

  test("skips deleted, empty and malformed comments, and never reads replies", async () => {
    const reply = comment(99, "Acme | Engineer | Remote");
    const r = await hackernews.search(
      { what: "engineer" },
      {
        fetch: board([
          comment(1, null),
          comment(2, ""),
          { id: "x", author: "a", text: "Acme | Engineer | Remote" },
          null,
          "comment",
          comment(3, "Acme | Engineer | Remote", { children: [reply] }),
          comment(3, "Acme | Engineer | Remote"),
          comment(4, "<p><p>"),
        ]).f,
      },
    );
    expect(r.jobs.map((j) => j.id)).toEqual(["hackernews:900:3"]);
  });

  test("a limit keeps the first matches and says how many there were", async () => {
    const ads = [1, 2, 3].map((n) => comment(n, `Acme ${n} | Engineer | Remote`));
    const r = await hackernews.search({ what: "engineer", limit: 2 }, { fetch: board(ads).f });
    expect(r.jobs.map((j) => j.id)).toEqual(["hackernews:900:1", "hackernews:900:2"]);
    expect(r.totalAds).toBe(3);
    const all = await hackernews.search({ what: "engineer" }, { fetch: board(ads).f });
    expect(all.totalAds).toBeUndefined();
  });

  test("refusals, missing threads and odd shapes", async () => {
    const fail = (status: number) => fakeFetch({ [THREADS]: { status } }).f;
    await expect(hackernews.search({ what: "engineer" }, { fetch: fail(403) })).rejects.toThrow(/turned us away \(403\)/);
    await expect(hackernews.search({ what: "engineer" }, { fetch: fail(429) })).rejects.toThrow(/asking too often/);
    await expect(hackernews.search({ what: "engineer" }, { fetch: fail(404) })).rejects.toThrow(SourceError);
    await expect(hackernews.search({ what: "engineer" }, { fetch: fakeFetch({ [THREADS]: { status: 200, body: [] } }).f })).rejects.toThrow(/shape we don't recognise/);
    await expect(hackernews.search({ what: "engineer" }, { fetch: fakeFetch({ [THREADS]: { status: 200, body: list(hit(5, "Ask HN: Who wants to be hired? (May 2026)", NOV)) } }).f })).rejects.toThrow(/no "Ask HN: Who is hiring\?" thread/);

    const threadFails = (r: { status: number; body?: unknown }) => fakeFetch({ [THREADS]: { status: 200, body: list(hiring(900, "November 2026", NOV)) }, [ITEM(900)]: r }).f;
    await expect(hackernews.search({ what: "engineer" }, { fetch: threadFails({ status: 404 }) })).rejects.toThrow(/couldn't find the thread/);
    await expect(hackernews.search({ what: "engineer" }, { fetch: threadFails({ status: 403 }) })).rejects.toThrow(/403/);
    await expect(hackernews.search({ what: "engineer" }, { fetch: threadFails({ status: 429 }) })).rejects.toThrow(/asking too often/);
    await expect(hackernews.search({ what: "engineer" }, { fetch: threadFails({ status: 200, body: { hits: [] } }) })).rejects.toThrow(/shape we don't recognise/);
    // A thread with no comments yet is no jobs, not an error.
    expect((await hackernews.search({ what: "engineer" }, { fetch: threadFails({ status: 200, body: { id: 900 } }) })).jobs).toEqual([]);
  });
});

describe("hackernews: choosing the thread", () => {
  const day = 24 * 60 * 60;
  const now = (NOV + 10 * day) * 1000;

  test("the newest hiring thread, skipping other threads and odd hits", () => {
    expect(pickThread([hiring(800, "October 2026", OCT), hit(901, "Ask HN: Who wants to be hired? (November 2026)", NOV + 5), hiring(900, "November 2026", NOV), { objectID: 5 }, null], now)).toEqual({
      id: "900",
      title: "Ask HN: Who is hiring? (November 2026)",
      month: "November 2026",
    });
    expect(pickThread([], now)).toBeUndefined();
  });

  test("last month's while the newest is under two days old and small", () => {
    const young = (comments: number) => [hiring(900, "November 2026", NOV, comments), hiring(800, "October 2026", OCT)];
    expect(pickThread(young(20), (NOV + day) * 1000)?.id).toBe("800");
    expect(pickThread(young(250), (NOV + day) * 1000)?.id).toBe("900");
    expect(pickThread(young(20), (NOV + 3 * day) * 1000)?.id).toBe("900");
    // With nothing before it, the young thread is still read.
    expect(pickThread([hiring(900, "November 2026", NOV, 5)], (NOV + 60) * 1000)?.id).toBe("900");
  });
});

describe("hackernews: reading the first line", () => {
  test("the first paragraph with the | shape, past a note at the top", () => {
    expect(firstLine("UPDATE: roles filled.<p>Acme | Engineer | Remote<p>More")).toBe("Acme | Engineer | Remote");
    expect(firstLine("Acme | Engineer | Remote\nWe build things.")).toBe("Acme | Engineer | Remote");
    expect(firstLine("Acme is hiring<p>More")).toBe("Acme is hiring");
    expect(firstLine("")).toBe("");
    // An ad run on after the last | with no break: the prose isn't part of the line.
    expect(firstLine(`Acme | Engineer | Remote | Full-Time Acme makes ${"lots of ".repeat(30)}things.`)).toBe("Acme | Engineer | Remote");
  });

  test("company, title, places, remote and pay, by part", () => {
    expect(parseFirstLine("Acme | Senior Engineer | Austin, TX | REMOTE (US) | Full-time | $150k–$180k | https://acme.example")).toEqual({
      company: "Acme",
      title: "Senior Engineer",
      locations: ["Austin, TX", "REMOTE (US)"],
      remote: true,
      pay: [{ min: 150000, max: 180000, currency: "USD" }],
      structured: true,
    });
    // Places first, roles with commas, a bare REMOTE, onsite words, visas.
    expect(parseFirstLine("Globex | ONSITE Berlin, Germany | Backend Engineer, Payments | Visa sponsorship")).toMatchObject({
      company: "Globex",
      title: "Backend Engineer, Payments",
      locations: ["ONSITE Berlin, Germany"],
    });
    const bare = parseFirstLine("Globex | Remote | Full Time | Software Engineer");
    expect(bare).toMatchObject({ title: "Software Engineer", locations: [], remote: true });
    expect(parseFirstLine("Globex | Data Engineer | ONSITE (Jersey City, NJ) | Full-time").locations).toEqual(["ONSITE (Jersey City, NJ)"]);
    expect(parseFirstLine("Globex | Data Engineer | Hybrid, 3 days in office: San Francisco CA").locations).toEqual(["Hybrid, 3 days in office: San Francisco CA"]);
    expect(parseFirstLine("Globex | Designer | London (Shoreditch) | HYBRID").locations).toEqual(["London (Shoreditch)"]);
  });

  test("what isn't clear is left out", () => {
    // Not the | shape: nothing read.
    expect(parseFirstLine("Acme - Engineer - Remote")).toEqual({ locations: [], pay: [], structured: false });
    expect(parseFirstLine("Acme | Engineer")).toEqual({ locations: [], pay: [], structured: false });
    // No part reads like a role: no title, no remote, not structured.
    const p = parseFirstLine("Acme | ONSITE | Full-time | UK home fee status only");
    expect(p.title).toBeUndefined();
    expect(p.remote).toBeUndefined();
    expect(p.locations).toEqual([]);
    expect(p.structured).toBe(false);
    // An amount without a currency, two parts with money, a signing bonus: no pay.
    expect(parseFirstLine("Acme | Engineer | Remote | 200k - 300k").pay).toEqual([]);
    expect(parseFirstLine("Acme | Engineer | $100k | £80k").pay).toEqual([]);
    expect(parseFirstLine("Acme | Engineer | Remote | €10k signing bonus").pay).toEqual([]);
  });

  test("pay: ranges, k, periods, up to and from, currencies", () => {
    expect(payOf("£80k–£100k")).toEqual({ min: 80000, max: 100000, currency: "GBP" });
    expect(payOf("€100–140k + 0.5–1% equity")).toEqual({ min: 100000, max: 140000, currency: "EUR" });
    expect(payOf("70k - 100k EUR")).toEqual({ min: 70000, max: 100000, currency: "EUR" });
    expect(payOf("$156,750 - $215,000.")).toEqual({ min: 156750, max: 215000, currency: "USD" });
    expect(payOf("€5,000/month (full-time)")).toEqual({ min: 5000, max: 5000, currency: "EUR", period: "month" });
    expect(payOf("$55 - $75/hr")).toEqual({ min: 55, max: 75, currency: "USD", period: "hour" });
    expect(payOf("$60-120K USD/year")).toEqual({ min: 60000, max: 120000, currency: "USD", period: "year" });
    expect(payOf("up to £90k + up to 1% equity")).toEqual({ max: 90000, currency: "GBP" });
    expect(payOf("<$145k")).toEqual({ max: 145000, currency: "USD" });
    expect(payOf("£115k+")).toEqual({ min: 115000, currency: "GBP" });
    expect(payOf("$130k + equity")).toEqual({ min: 130000, max: 130000, currency: "USD" });
    expect(payOf("CHF 120,000 - 140,000 p.a.")).toEqual({ min: 120000, max: 140000, currency: "CHF", period: "year" });
    expect(payOf("C$90k-C$110k")).toEqual({ min: 90000, max: 110000, currency: "CAD" });
    // Not clear: no currency, two currencies, two amounts, backwards ranges, a billion.
    expect(payOf("200k - 300k")).toBeUndefined();
    expect(payOf("$100k or £80k")).toBeUndefined();
    expect(payOf("Junior $100k, Senior $150k")).toBeUndefined();
    expect(payOf("$200k - $100k")).toBeUndefined();
    expect(payOf("$3.5B in volume")).toBeUndefined();
  });
});
