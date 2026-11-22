import { describe, expect, test } from "bun:test";
import { remoteok, SEARCH_SOURCES, searchSource, SourceError, USER_AGENT } from "../src/index.ts";
import { hasAllWords as matchesAll } from "../src/index.ts";

// Made-up companies, in the shape Remote OK's feed sends.
const FEED = "https://remoteok.com/api";
const legal = { last_updated: 1795312805, legal: "API Terms of Service: please link back and mention the source." };
const ad = (n: number, extra: Record<string, unknown> = {}) => ({
  slug: `remote-job-${n}-acme-${n}`,
  id: String(n),
  epoch: 1795258805,
  date: "2026-11-21T11:00:05+00:00",
  company: "Acme",
  company_logo: "",
  position: `Job ${n}`,
  tags: ["other"],
  description: "<p>Hello</p>",
  location: "Worldwide",
  apply_url: `https://remoteOK.com/remote-jobs/remote-job-${n}-acme-${n}`,
  salary_min: 0,
  salary_max: 0,
  logo: "",
  url: `https://remoteOK.com/remote-jobs/remote-job-${n}-acme-${n}`,
  ...extra,
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(r: { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const ok = (body: unknown) => fakeFetch({ status: 200, body });

describe("remoteok", () => {
  test("is a remote job board with no key, searched by words only, crediting Remote OK", () => {
    expect(SEARCH_SOURCES.remoteok).toBe(remoteok);
    expect(searchSource("RemoteOK")).toBe(remoteok);
    expect(remoteok).toMatchObject({ places: false, credit: "Jobs from Remote OK (https://remoteok.com)" });
    expect(remoteok.keys).toBeUndefined();
    expect(remoteok.countries).toBeUndefined();
  });

  test("words match whole words, all of them, ignoring case", () => {
    expect(matchesAll("data engineer")("Senior Data Engineer")).toBe(true);
    expect(matchesAll("Engineer DATA")("senior data engineer")).toBe(true);
    expect(matchesAll("data engineer")("Data Analyst")).toBe(false);
    expect(matchesAll("engineer")("Engineering Manager")).toBe(false);
    expect(matchesAll("go")("Golang Developer")).toBe(false);
    expect(matchesAll("c++")("Senior C++ Developer")).toBe(true);
    expect(matchesAll("node.js")("Node.js Engineer")).toBe(true);
    expect(matchesAll("node.js")("Nodexjs Engineer")).toBe(false);
  });

  test("reads the feed once, skips the terms notice, keeps jobs whose title or tags hold the words", async () => {
    const { f, calls } = ok([
      legal,
      ad(1, { position: "Backend Engineer" }),
      ad(2, { position: "Account Executive", tags: ["sales"] }),
      ad(3, { position: "Platform Lead", tags: ["devops", "Engineer"] }),
      ad(4, { position: "Engineering Manager" }),
    ]);
    const r = await remoteok.search({ what: "engineer" }, { fetch: f });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(FEED);
    expect(calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
    expect(r.source).toBe("remoteok");
    expect(r.query).toEqual({ what: "engineer" });
    expect(r.jobs.map((j) => j.id)).toEqual(["remoteok:remote:1", "remoteok:remote:3"]);
    expect(r.totalAds).toBeUndefined();
  });

  test("maps a job into the common shape, linking back to Remote OK", async () => {
    const job = ad(1137962, {
      position: "  Senior Engineer,\n  Payments &amp; Billing ",
      company: " Globex &amp; Co ",
      location: "US Only",
      salary_min: 70000,
      salary_max: 80000,
      description: "<p>Build <b>things</b>.</p><ul><li>Rust</li></ul>",
      id: 1137962,
    });
    const r = await remoteok.search({ what: "senior engineer" }, { fetch: ok([legal, job]).f });
    expect(r.jobs).toEqual([
      {
        id: "remoteok:remote:1137962",
        source: "remoteok",
        board: "remote",
        company: "Globex & Co",
        title: "Senior Engineer, Payments & Billing",
        locations: ["US Only"],
        remote: true,
        url: "https://remoteok.com/remote-jobs/remote-job-1137962-acme-1137962",
        postedAt: "2026-11-21T11:00:05.000Z",
        pay: [{ min: 70000, max: 80000, currency: "USD" }],
        description: "Build things.\n\n- Rust",
      },
    ]);
  });

  test("zero or missing salaries and empty locations are left out; dates fall back to epoch; links to the slug", async () => {
    const r = await remoteok.search(
      { what: "job" },
      {
        fetch: ok([
          legal,
          ad(1),
          ad(2, { salary_min: 90000, salary_max: 0, location: "", date: "nonsense" }),
          ad(3, { salary_min: "100000", salary_max: null, location: null, date: null, description: "" }),
          ad(4, { url: "https://example.com/elsewhere" }),
        ]).f,
      },
    );
    const [a, b, c, d] = r.jobs;
    expect(a!.pay).toEqual([]);
    expect(b!.pay).toEqual([{ min: 90000, currency: "USD" }]);
    expect(b!.locations).toEqual([]);
    expect(b!.postedAt).toBe(new Date(1795258805 * 1000).toISOString());
    expect(c!.pay).toEqual([]);
    expect(c!.locations).toEqual([]);
    expect(c!.description).toBeUndefined();
    // A link off Remote OK isn't used: the job's own page is built from its slug.
    expect(d!.url).toBe("https://remoteok.com/remote-jobs/remote-job-4-acme-4");
  });

  test("a limit keeps the first matches and says how many there were", async () => {
    const r = await remoteok.search({ what: "job", limit: 2 }, { fetch: ok([legal, ad(1), ad(2), ad(3)]).f });
    expect(r.jobs.map((j) => j.id)).toEqual(["remoteok:remote:1", "remoteok:remote:2"]);
    expect(r.totalAds).toBe(3);
  });

  test("empty feeds and no matches", async () => {
    expect((await remoteok.search({ what: "engineer" }, { fetch: ok([]).f })).jobs).toEqual([]);
    expect((await remoteok.search({ what: "engineer" }, { fetch: ok([legal]).f })).jobs).toEqual([]);
    expect((await remoteok.search({ what: "astronaut" }, { fetch: ok([legal, ad(1)]).f })).jobs).toEqual([]);
  });

  test("refusals, a missing feed and odd shapes", async () => {
    await expect(remoteok.search({ what: "engineer" }, { fetch: fakeFetch({ status: 403 }).f })).rejects.toThrow(/turned us away \(403\)/);
    await expect(remoteok.search({ what: "engineer" }, { fetch: fakeFetch({ status: 429 }).f })).rejects.toThrow(/asking too often/);
    await expect(remoteok.search({ what: "engineer" }, { fetch: fakeFetch({ status: 404 }).f })).rejects.toThrow(SourceError);
    await expect(remoteok.search({ what: "engineer" }, { fetch: ok({ jobs: [] }).f })).rejects.toThrow(/shape we don't recognise/);

    // Malformed entries are skipped one by one; the good ones are kept.
    const r = await remoteok.search(
      { what: "job" },
      {
        fetch: ok([
          legal,
          null,
          "job",
          42,
          { id: "9" },
          ad(5, { position: 7 }),
          ad(6, { id: "" }),
          ad(7, { url: null, slug: null }),
          ad(8, { tags: "not a list" }),
          ad(9, { tags: [1, null, "Job"], position: "Designer" }),
          ad(10),
          ad(10),
        ]).f,
      },
    );
    expect(r.jobs.map((j) => j.id)).toEqual(["remoteok:remote:9", "remoteok:remote:10"]);
  });
});
