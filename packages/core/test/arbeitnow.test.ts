import { describe, expect, test } from "bun:test";
import { arbeitnow, SEARCH_SOURCES, searchSource, SourceError, USER_AGENT } from "../src/index.ts";

// Made-up companies, in the shape Arbeitnow's API sends.
const API = "https://www.arbeitnow.com/api/job-board-api";
const ad = (n: number, extra: Record<string, unknown> = {}) => ({
  slug: `job-${n}-berlin-${1000 + n}`,
  company_name: "Acme GmbH",
  title: `Job ${n}`,
  description: "<p>Hello</p>",
  remote: false,
  url: `https://www.arbeitnow.com/jobs/companies/acme-gmbh/job-${n}-berlin-${1000 + n}`,
  tags: ["Engineering"],
  job_types: ["Full Time"],
  location: "Berlin",
  created_at: 1795341659,
  ...extra,
});
const page = (n: number, data: unknown[], more = true) => ({
  data,
  links: { first: `${API}?page=1`, last: null, prev: n > 1 ? `${API}?page=${n - 1}` : null, next: more ? `${API}?page=${n + 1}` : null },
  meta: { current_page: n, per_page: 300, terms: "This is a free public API for jobs, please do not abuse." },
});

interface Call {
  url: URL;
  headers: Record<string, string>;
}

/** Answers API pages by page number from `pages`; anything else is 404. */
function fakeFetch(pages: Record<number, { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = url.origin + url.pathname === API ? (pages[Number(url.searchParams.get("page"))] ?? { status: 404 }) : { status: 404 };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const ok = (body: unknown) => ({ status: 200, body });
const opts = (f: typeof fetch) => ({ fetch: f, pauseMs: 0 });

describe("arbeitnow", () => {
  test("is a job board with no key, searched by words only, crediting Arbeitnow", () => {
    expect(SEARCH_SOURCES.arbeitnow).toBe(arbeitnow);
    expect(searchSource("Arbeitnow")).toBe(arbeitnow);
    expect(arbeitnow).toMatchObject({ places: false, credit: "Jobs from Arbeitnow (https://www.arbeitnow.com)" });
    expect(arbeitnow.keys).toBeUndefined();
    expect(arbeitnow.countries).toBeUndefined();
  });

  test("reads pages in order with our name, keeps jobs whose title or tags hold the words, stops at the last page", async () => {
    const { f, calls } = fakeFetch({
      1: ok(page(1, [ad(1, { title: "Backend Engineer (m/w/d)" }), ad(2, { title: "Account Executive", tags: ["Sales"] })])),
      2: ok(page(2, [ad(3, { title: "Platform Lead", tags: ["Software Engineer"] }), ad(4, { title: "Engineering Manager", tags: [] })], false)),
    });
    const r = await arbeitnow.search({ what: "engineer" }, opts(f));
    expect(calls.map((c) => c.url.toString())).toEqual([`${API}?page=1`, `${API}?page=2`]);
    expect(calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
    expect(r.source).toBe("arbeitnow");
    expect(r.query).toEqual({ what: "engineer" });
    expect(r.jobs.map((j) => j.id)).toEqual(["arbeitnow:europe:job-1-berlin-1001", "arbeitnow:europe:job-3-berlin-1003"]);
    expect(r.totalAds).toBeUndefined();
  });

  test("reads at most three pages, and each page once across searches", async () => {
    const { f, calls } = fakeFetch({ 1: ok(page(1, [ad(1)])), 2: ok(page(2, [ad(2)])), 3: ok(page(3, [ad(3)])), 4: ok(page(4, [ad(4)])) });
    const r = await arbeitnow.search({ what: "job" }, opts(f));
    expect(r.jobs).toHaveLength(3);
    expect(calls).toHaveLength(3);
    await arbeitnow.search({ what: "engineering" }, opts(f));
    expect(calls).toHaveLength(3);
  });

  test("maps a job into the common shape, linking to its Arbeitnow page", async () => {
    const job = ad(7, {
      title: "  Senior Engineer,\n Payments &amp; Billing ",
      company_name: " Globex &amp; Co ",
      description: "<p>Build <b>things</b>.</p><ul><li>Rust</li></ul>",
      remote: true,
      visa_sponsorship: true,
      location: "Munich, Bavaria",
      url: "https://www.arbeitnow.fr/jobs/companies/globex/senior-engineer-7",
    });
    const r = await arbeitnow.search({ what: "senior engineer" }, opts(fakeFetch({ 1: ok(page(1, [job], false)) }).f));
    expect(r.jobs).toEqual([
      {
        id: "arbeitnow:europe:job-7-berlin-1007",
        source: "arbeitnow",
        board: "europe",
        company: "Globex & Co",
        title: "Senior Engineer, Payments & Billing",
        locations: ["Munich, Bavaria"],
        remote: true,
        url: "https://www.arbeitnow.fr/jobs/companies/globex/senior-engineer-7",
        postedAt: new Date(1795341659 * 1000).toISOString(),
        pay: [],
        description: "Build things.\n\n- Rust\n\nVisa sponsorship: yes",
      },
    ]);
  });

  test("remote only when true, visa only when true; empty locations, dates and descriptions left out", async () => {
    const r = await arbeitnow.search(
      { what: "job" },
      {
        ...opts(
          fakeFetch({
            1: ok(
              page(
                1,
                [
                  ad(1, { remote: false, visa_sponsorship: false, location: "Remote" }),
                  ad(2, { remote: null, location: "", created_at: null, description: "" }),
                  ad(3, { location: null, created_at: 0, description: null, visa_sponsorship: true }),
                ],
                false,
              ),
            ),
          }).f,
        ),
      },
    );
    const [a, b, c] = r.jobs;
    expect(a!.remote).toBeUndefined();
    expect(a!.locations).toEqual(["Remote"]);
    expect(a!.description).toBe("Hello");
    expect(b!.remote).toBeUndefined();
    expect(b!.locations).toEqual([]);
    expect(b!.postedAt).toBeUndefined();
    expect(b!.description).toBeUndefined();
    expect(c!.locations).toEqual([]);
    expect(c!.postedAt).toBeUndefined();
    expect(c!.description).toBe("Visa sponsorship: yes");
  });

  test("a limit stops reading once it's met, and says how many matched on the pages read", async () => {
    const { f, calls } = fakeFetch({ 1: ok(page(1, [ad(1), ad(2), ad(3)])), 2: ok(page(2, [ad(4)])) });
    const r = await arbeitnow.search({ what: "job", limit: 2 }, opts(f));
    expect(calls).toHaveLength(1);
    expect(r.jobs.map((j) => j.title)).toEqual(["Job 1", "Job 2"]);
    expect(r.totalAds).toBe(3);
  });

  test("empty pages and no matches", async () => {
    expect((await arbeitnow.search({ what: "engineer" }, opts(fakeFetch({ 1: ok(page(1, [])) }).f))).jobs).toEqual([]);
    expect((await arbeitnow.search({ what: "astronaut" }, opts(fakeFetch({ 1: ok(page(1, [ad(1)], false)) }).f))).jobs).toEqual([]);
    // A later page that's gone ends the reading; what was found is kept.
    const r = await arbeitnow.search({ what: "job" }, opts(fakeFetch({ 1: ok(page(1, [ad(1)])) }).f));
    expect(r.jobs).toHaveLength(1);
  });

  test("refusals, a missing API and odd shapes", async () => {
    await expect(arbeitnow.search({ what: "x" }, opts(fakeFetch({ 1: { status: 403 } }).f))).rejects.toThrow(/turned us away \(403\)/);
    await expect(arbeitnow.search({ what: "x" }, opts(fakeFetch({ 1: { status: 429 } }).f))).rejects.toThrow(/asking too often/);
    await expect(arbeitnow.search({ what: "x" }, opts(fakeFetch({}).f))).rejects.toThrow(SourceError);
    await expect(arbeitnow.search({ what: "x" }, opts(fakeFetch({ 1: ok([ad(1)]) }).f))).rejects.toThrow(/shape we don't recognise/);
    // A refusal on a later page stops the search.
    await expect(arbeitnow.search({ what: "job" }, opts(fakeFetch({ 1: ok(page(1, [ad(1)])), 2: { status: 429 } }).f))).rejects.toThrow(/asking too often/);

    // Malformed entries are skipped one by one; the good ones are kept.
    const r = await arbeitnow.search(
      { what: "job" },
      opts(
        fakeFetch({
          1: ok(
            page(
              1,
              [
                null,
                "job",
                42,
                { slug: "x" },
                ad(5, { title: 7 }),
                ad(6, { slug: "" }),
                ad(7, { url: "https://example.com/elsewhere" }),
                ad(8, { url: "not a link" }),
                ad(9, { company_name: "" }),
                ad(10, { tags: "not a list" }),
                ad(11, { remote: "yes" }),
                ad(12, { tags: [1, null, "Job"], title: "Designer" }),
                ad(13),
                ad(13),
              ],
              false,
            ),
          ),
        }).f,
      ),
    );
    expect(r.jobs.map((j) => j.id)).toEqual(["arbeitnow:europe:job-12-berlin-1012", "arbeitnow:europe:job-13-berlin-1013"]);
  });
});
