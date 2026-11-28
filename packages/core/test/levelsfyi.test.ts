import { describe, expect, test } from "bun:test";
import { levelsfyi, LEVELSFYI_CREDIT, lookUpPay, SEARCH_SOURCES, searchSource, SourceError, splitLevel } from "../src/index.ts";

// Made-up companies and figures, in the shape levels.fyi's MCP server sent in November 2026.
type Args = Record<string, unknown>;
type Answer = unknown | { status: number };

/** levels.fyi's MCP server: `tools` answers each tool call by name and arguments; `{status}` is an HTTP error. */
function fakeServer(tools: Record<string, (args: Args) => Answer>) {
  const calls: { name: string; args: Args }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== "https://mcp.levels.fyi/") return new Response("", { status: 404 });
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name: string; arguments: Args } };
    if (body.id === undefined) return new Response("", { status: 202 });
    let result: unknown = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "levels-mcp", version: "0.1.0" } };
    if (body.method === "tools/call") {
      const { name, arguments: args } = body.params!;
      calls.push({ name, args });
      const answer = tools[name]?.(args) ?? { status: 500 };
      if (answer && typeof answer === "object" && "status" in answer) return new Response("", { status: (answer as { status: number }).status });
      result = { content: [{ type: "text", text: JSON.stringify(answer) }] };
    }
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { f, calls };
}

const opts = (f: typeof fetch) => ({ fetch: f, pauseMs: 0 });
const london = () => [{ displayValue: "Greater London Area, GB", slug: "london-metro-area", type: "dma" }];

const job = (n: number, extra: Record<string, unknown> = {}) => ({
  jobId: `job${n}`,
  title: `Job ${n}`,
  company: "Acme",
  companySlug: "acme",
  locations: ["London, England, United Kingdom"],
  workArrangement: "hybrid",
  postedAt: "2026-11-16T00:00:00.000Z",
  baseSalaryRange: { min: 100000, max: 140000, currency: "USD" },
  totalCompensationRange: { min: 100000, max: 150000, currency: "USD" },
  url: `https://www.levels.fyi/jobs?jobId=job${n}&utm_source=levels_mcp&utm_medium=ai_assistant&utm_campaign=jobs`,
  applyUrl: `https://boards.example.com/acme/${n}`,
  ...extra,
});

describe("levels.fyi job board", () => {
  test("is registered, with no key and the credit its terms ask for", () => {
    expect(SEARCH_SOURCES.levelsfyi).toBe(levelsfyi);
    expect(searchSource("levelsfyi")).toBe(levelsfyi);
    expect(levelsfyi.keys).toBeUndefined();
    expect(levelsfyi.places).toBe(true);
    expect(levelsfyi.credit).toBe(LEVELSFYI_CREDIT);
    expect(LEVELSFYI_CREDIT).toMatch(/^Data source: Levels\.fyi/);
  });

  test("looks the place up first, then searches; a job with its base pay, a clean link and its arrangement", async () => {
    const s = fakeServer({ "search-locations": london, "search-jobs": () => ({ jobs: [job(1)], totalMatchingJobs: 1, nextOffset: null }) });
    const r = await levelsfyi.search({ what: "backend engineer", where: "London" }, opts(s.f));
    expect(s.calls).toEqual([
      { name: "search-locations", args: { searchText: "London", limit: 1 } },
      { name: "search-jobs", args: { query: "backend engineer", locationSlug: "london-metro-area", limit: 25 } },
    ]);
    expect(r.query.where).toBe("Greater London Area, GB");
    expect(r.jobs).toEqual([
      {
        id: "levelsfyi:jobs:job1",
        source: "levelsfyi",
        board: "jobs",
        company: "Acme",
        title: "Job 1",
        locations: ["London, England, United Kingdom"],
        url: "https://www.levels.fyi/jobs?jobId=job1",
        postedAt: "2026-11-16T00:00:00.000Z",
        pay: [{ min: 100000, max: 140000, currency: "USD", period: "year", label: "Base pay, yearly, in US dollars as levels.fyi gives it" }],
        signals: ["Hybrid"],
      },
    ]);
    expect(r.totalAds).toBeUndefined();
  });

  test("total pay when there's no base; nothing when neither; remote; entries without a company skipped", async () => {
    const s = fakeServer({
      "search-jobs": () => ({
        jobs: [job(1, { baseSalaryRange: null, workArrangement: "remote" }), job(2, { baseSalaryRange: null, totalCompensationRange: null, workArrangement: null }), job(3, { company: "" }), { odd: true }],
        nextOffset: null,
      }),
    });
    const r = await levelsfyi.search({ what: "x" }, opts(s.f));
    expect(s.calls.map((c) => c.name)).toEqual(["search-jobs"]);
    expect(r.jobs[0]!.pay[0]!.label).toMatch(/^Total pay/);
    expect(r.jobs[0]!.remote).toBe(true);
    expect(r.jobs[1]!.pay).toEqual([]);
    expect(r.jobs[1]!.signals).toBeUndefined();
    expect(r.jobs).toHaveLength(2);
  });

  test("pages by nextOffset up to the limit, and says how many more there are", async () => {
    const pageOf = (from: number) => Array.from({ length: 50 }, (_, i) => job(from + i));
    const s = fakeServer({ "search-jobs": (a) => ({ jobs: pageOf(2 * Number(a.offset ?? 0)), totalMatchingJobs: 400, nextOffset: Number(a.offset ?? 0) + 25 }) });
    const r = await levelsfyi.search({ what: "x", limit: 120 }, opts(s.f));
    expect(r.jobs).toHaveLength(120);
    expect(r.totalAds).toBe(400);
    expect(s.calls.map((c) => c.args.offset)).toEqual([undefined, 25, 50]);
    // The default is 50: one page.
    const d = fakeServer({ "search-jobs": () => ({ jobs: pageOf(0), totalMatchingJobs: 400, nextOffset: 25 }) });
    expect((await levelsfyi.search({ what: "x" }, opts(d.f))).jobs).toHaveLength(50);
    expect(d.calls).toHaveLength(1);
  });

  test("a place it doesn't know, and no words, stop with a reason", async () => {
    const s = fakeServer({ "search-locations": () => [] });
    expect((await levelsfyi.search({ what: "x", where: "Atlantis" }, opts(s.f)).catch((e) => e)).message).toMatch(/doesn't know a place called "Atlantis"/);
    expect((await levelsfyi.search({ what: " " }, opts(s.f)).catch((e) => e)).message).toMatch(/what should we look for/);
  });
});

describe("pay from levels.fyi", () => {
  const families = () => [{ displayValue: "Software Engineer", slug: "software-engineer", type: "track" }];

  test("the median for a role in a place", async () => {
    const s = fakeServer({
      "search-job-families": families,
      "search-locations": london,
      "get-salary-percentiles": () => ({ window: "the last 12 months", locations: [{ locationSlug: "london-metro-area", medianTotalCompensation: 151920.6 }] }),
    });
    const a = await lookUpPay({ role: "software engineer", where: "London" }, opts(s.f));
    expect(a).toMatchObject({
      source: "levelsfyi",
      role: { name: "Software Engineer", slug: "software-engineer" },
      place: { name: "Greater London Area, GB", slug: "london-metro-area" },
      currency: "USD",
      median: 151921,
      window: "the last 12 months",
      credit: LEVELSFYI_CREDIT,
    });
    expect(s.calls.at(-1)).toEqual({ name: "get-salary-percentiles", args: { jobFamilySlug: "software-engineer", locationSlugs: ["london-metro-area"] } });
    const few = fakeServer({ "search-job-families": families, "search-locations": london, "get-salary-percentiles": () => ({ locations: [{ locationSlug: "london-metro-area", medianTotalCompensation: null }] }) });
    expect((await lookUpPay({ role: "x", where: "y" }, opts(few.f))).median).toBeNull();
  });

  test("pay by level per company; one needing a sign-in or unknown doesn't hide the rest", async () => {
    const s = fakeServer({
      "search-job-families": families,
      "search-locations": london,
      "search-companies": (a) => (a.searchText === "Nowhere Inc" ? [] : [{ name: a.searchText === "acme" ? "Acme" : String(a.searchText), slug: String(a.searchText).toLowerCase() }]),
      "get-salaries-by-company-level": (a) =>
        (a.companySlugs as string[])[0] === "globex"
          ? { status: 401 }
          : {
              companies: [
                {
                  companySlug: "acme",
                  levels: [
                    { level: "E3", secondaryLevelName: "Engineer", medianTotalCompensation: 120000.4, p10TotalCompensation: 100000, p90TotalCompensation: 150000, averageTotalCompensation: 125000, averageBaseSalary: 100000, averageStockPerYear: 20000, averageBonus: 5000 },
                    { level: "E4", secondaryLevelName: "E4", medianTotalCompensation: 160000, p10TotalCompensation: null },
                  ],
                },
              ],
            },
    });
    const a = await lookUpPay({ role: "software engineer", where: "London", companies: ["acme", "Globex", "Nowhere Inc"] }, opts(s.f));
    expect(a.median).toBeUndefined();
    expect(a.companies).toEqual([
      {
        asked: "acme",
        company: "Acme",
        slug: "acme",
        levels: [
          { level: "E3", alsoCalled: "Engineer", median: 120000, p10: 100000, p90: 150000, average: 125000, averageBase: 100000, averageStockPerYear: 20000, averageBonus: 5000 },
          { level: "E4", median: 160000 },
        ],
      },
      { asked: "Globex", company: "Globex", slug: "globex", levels: [], note: "levels.fyi shows pay by level for this company only to people signed in to it" },
      { asked: "Nowhere Inc", levels: [], note: "levels.fyi doesn't know this company" },
    ]);
    expect(s.calls.filter((c) => c.name === "get-salaries-by-company-level").map((c) => c.args)).toEqual([
      { jobFamilySlug: "software-engineer", locationSlug: "london-metro-area", companySlugs: ["acme"] },
      { jobFamilySlug: "software-engineer", locationSlug: "london-metro-area", companySlugs: ["globex"] },
    ]);
  });

  test("asks for a role and a place, at most five companies, and says when it doesn't know the role", async () => {
    const none = fakeServer({});
    expect((await lookUpPay({ role: "", where: "London" }, opts(none.f)).catch((e) => e)).message).toMatch(/which role/);
    expect((await lookUpPay({ role: "x", where: " " }, opts(none.f)).catch((e) => e)).message).toMatch(/where\?/);
    expect((await lookUpPay({ role: "x", where: "y", companies: ["a", "b", "c", "d", "e", "f"] }, opts(none.f)).catch((e) => e)).message).toMatch(/at most 5/);
    expect(none.calls).toHaveLength(0);
    const e = await lookUpPay({ role: "wizard", where: "London" }, opts(fakeServer({ "search-job-families": () => [] }).f)).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect(e.message).toMatch(/no role like "wizard"/);
  });

  test("level words come off the role and are reported back, since the median can't be narrowed by level", async () => {
    expect(splitLevel("principal software engineer")).toEqual({ role: "software engineer", level: "principal" });
    expect(splitLevel("Sr. Product Manager")).toEqual({ role: "Product Manager", level: "sr" });
    expect(splitLevel("software engineer II")).toEqual({ role: "software engineer", level: "ii" });
    expect(splitLevel("software engineer")).toEqual({ role: "software engineer" });
    // A role that's only a level word stays as it is.
    expect(splitLevel("Senior")).toEqual({ role: "Senior" });
    const s = fakeServer({
      "search-job-families": families,
      "search-locations": london,
      "get-salary-percentiles": () => ({ locations: [{ locationSlug: "london-metro-area", medianTotalCompensation: 150000 }] }),
    });
    const a = await lookUpPay({ role: "principal software engineer", where: "London" }, opts(s.f));
    expect(s.calls[0]).toEqual({ name: "search-job-families", args: { searchText: "software engineer", limit: 1 } });
    expect(a.levelAsked).toBe("principal");
    expect(a.median).toBe(150000);
  });
});
