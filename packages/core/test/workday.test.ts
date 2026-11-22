import { describe, expect, test } from "bun:test";
import { SourceError, sourceForLink, USER_AGENT, workday } from "../src/index.ts";
import { postedDate } from "../src/jobs/sources/workday.ts";

// Made-up company, in the shape a Workday careers site sends.
const API = "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/AcmeCareers";
const posting = (n: number, extra: Record<string, unknown> = {}) => ({
  title: `Job ${n}`,
  externalPath: `/job/Leeds/Job-${n}_R${n}`,
  locationsText: "Leeds, UK",
  postedOn: "Posted 30+ Days Ago",
  bulletFields: [`R${n}`],
  ...extra,
});

interface Call {
  url: string;
  method: string;
  body?: { limit: number; offset: number };
  headers: Record<string, string>;
}

/** Answers list pages by offset from `pages`. */
function fakeFetch(pages: Record<number, { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Call["body"]) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = url === `${API}/jobs` ? (pages[body!.offset] ?? { status: 404 }) : { status: 404 };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const opts = (f: typeof fetch) => ({ fetch: f, pauseMs: 0 });

describe("workday", () => {
  test("boards from tenant/wdN/site and from links", () => {
    expect(workday.parseBoard("acme/wd5/AcmeCareers")).toBe("acme/wd5/AcmeCareers");
    expect(workday.parseBoard("ACME/WD5/AcmeCareers")).toBe("acme/wd5/AcmeCareers");
    expect(workday.parseBoard("https://acme.wd5.myworkdayjobs.com/AcmeCareers")).toBe("acme/wd5/AcmeCareers");
    expect(workday.parseBoard("acme.wd12.myworkdayjobs.com/en-US/AcmeCareers/job/Leeds/Job_R1")).toBe("acme/wd12/AcmeCareers");
    expect(workday.parseBoard("https://acme.wd5.myworkdayjobs.com/")).toBeUndefined();
    expect(workday.parseBoard("acme")).toBeUndefined();
    expect(workday.parseBoard("https://job-boards.greenhouse.io/acme")).toBeUndefined();
    expect(sourceForLink("acme.wd1.myworkdayjobs.com/fr-CA/External")).toMatchObject({ board: "acme/wd1/External", source: { id: "workday" } });
  });

  test("posted dates are counted back from today; 30+ days is left out", () => {
    const now = new Date("2026-11-22T12:00:00Z");
    expect(postedDate("Posted Today", now)).toBe("2026-11-22");
    expect(postedDate("Posted Yesterday", now)).toBe("2026-11-21");
    expect(postedDate("Posted 3 Days Ago", now)).toBe("2026-11-19");
    expect(postedDate("Posted 30+ Days Ago", now)).toBeUndefined();
    expect(postedDate(undefined, now)).toBeUndefined();
  });

  test("reads every page into the common job shape, honestly and politely", async () => {
    const first = posting(1, { title: " Staff Engineer,  Payments &amp; Billing ", postedOn: "Posted Today", remoteType: "Remote", locationsText: "3 Locations" });
    const second = posting(2, { remoteType: "Flex" });
    const page0 = { total: 22, jobPostings: [first, second, ...Array.from({ length: 18 }, (_, i) => posting(100 + i))] };
    // Workday leaves the total at 0 after the first page.
    // An entry with no title or link isn't an ad: it's skipped, but still counts towards the pages.
    const page20 = { total: 0, jobPostings: [posting(21), { bulletFields: ["R999"] }] };
    const { f, calls } = fakeFetch({ 0: { status: 200, body: page0 }, 20: { status: 200, body: page20 } });
    const r = await workday.fetchBoard("acme/wd5/AcmeCareers", opts(f));

    expect(calls.map((c) => [c.method, c.body?.offset, c.body?.limit])).toEqual([
      ["POST", 0, 20],
      ["POST", 20, 20],
    ]);
    expect(calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
    expect(r).toMatchObject({ source: "workday", board: "acme/wd5/AcmeCareers", company: "acme" });
    expect(r.totalAds).toBeUndefined();
    expect(r.jobs).toHaveLength(21);
    const today = new Date().toISOString().slice(0, 10);
    expect(r.jobs[0]).toEqual({
      id: "workday:acme/wd5/AcmeCareers:Job-1_R1",
      source: "workday",
      board: "acme/wd5/AcmeCareers",
      company: "acme",
      title: "Staff Engineer, Payments & Billing",
      // "3 Locations" names none, so none are kept.
      locations: [],
      remote: true,
      url: "https://acme.wd5.myworkdayjobs.com/AcmeCareers/job/Leeds/Job-1_R1",
      postedAt: today,
      pay: [],
    });
    expect(r.jobs[1]).toMatchObject({ locations: ["Leeds, UK"] });
    expect(r.jobs[1]!.remote).toBeUndefined();
    expect(r.jobs[1]!.postedAt).toBeUndefined();
  });

  test("a huge board stops at 1000 jobs and says how many there were", async () => {
    const pages: Record<number, { status: number; body: unknown }> = {};
    for (let o = 0; o < 1100; o += 20) pages[o] = { status: 200, body: { total: o === 0 ? 2000 : 0, jobPostings: Array.from({ length: 20 }, (_, i) => posting(o + i)) } };
    const { f, calls } = fakeFetch(pages);
    const r = await workday.fetchBoard("acme/wd5/AcmeCareers", opts(f));
    expect(calls.filter((c) => c.url === `${API}/jobs`)).toHaveLength(50);
    expect(r.jobs).toHaveLength(1000);
    expect(r.totalAds).toBe(2000);
  });

  test("empty boards, unknown sites, refusals and odd shapes", async () => {
    expect((await workday.fetchBoard("acme/wd5/AcmeCareers", opts(fakeFetch({ 0: { status: 200, body: { total: 0, jobPostings: [] } } }).f))).jobs).toEqual([]);
    await expect(workday.fetchBoard("acme/wd5/AcmeCareers", opts(fakeFetch({}).f))).rejects.toThrow(/no site at "acme\/wd5\/AcmeCareers"/);
    await expect(workday.fetchBoard("acme/wd5/AcmeCareers", opts(fakeFetch({ 0: { status: 403 } }).f))).rejects.toThrow(/turned us away \(403\)/);
    await expect(workday.fetchBoard("acme/wd5/AcmeCareers", opts(fakeFetch({ 0: { status: 200, body: { jobPostings: "nope" } } }).f))).rejects.toThrow(SourceError);
    await expect(workday.fetchBoard("acme", opts(fakeFetch({}).f))).rejects.toThrow(/isn't a Workday board/);
  });
});
