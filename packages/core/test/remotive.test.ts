import { describe, expect, test } from "bun:test";
import { remotive, SEARCH_SOURCES, searchSource, SourceError, USER_AGENT } from "../src/index.ts";
import { parseSalary } from "../src/jobs/sources/remotive.ts";

// Made-up companies, in the shape Remotive's API sends.
const ad = (n: number, extra: Record<string, unknown> = {}) => ({
  id: 1000 + n,
  url: `https://remotive.com/remote-jobs/software-development/job-${n}-${1000 + n}`,
  title: `Job ${n}`,
  company_name: "Acme",
  company_logo: "https://remotive.com/job/logo",
  category: "Software Development",
  tags: ["python"],
  job_type: "full_time",
  publication_date: "2026-11-19T14:58:42",
  candidate_required_location: "Worldwide",
  salary: "",
  description: "<p>Build things.</p>",
  ...extra,
});

interface Call {
  url: URL;
  headers: Record<string, string>;
}

function fakeFetch(r: { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const opts = (f: typeof fetch) => ({ fetch: f });
const reply = (jobs: unknown[], extra: Record<string, unknown> = {}) => ({ "0-legal-notice": "…", "job-count": jobs.length, "total-job-count": jobs.length, jobs, ...extra });

describe("remotive", () => {
  test("is a job board that can't search by place and needs no key", () => {
    expect(SEARCH_SOURCES.remotive).toBe(remotive);
    expect(searchSource("Remotive")).toBe(remotive);
    expect(remotive.places).toBe(false);
    expect(remotive.countries).toBeUndefined();
    expect(remotive.keys).toBeUndefined();
    expect(remotive.credit).toMatch(/Remotive/);
    expect(remotive.credit).toMatch(/https:\/\/remotive\.com/);
  });

  test("reads the whole feed once, as itself, and picks by title and tags", async () => {
    const jobs = [ad(1, { title: "Data Engineer" }), ad(2, { title: "Office Assistant", description: "<p>Help our data engineers.</p>" }), ad(3, { title: "Analyst", tags: ["data", "engineer"] }), ad(4, { title: "Data Engineering Lead" })];
    const { f, calls } = fakeFetch({ status: 200, body: reply(jobs) });
    const r = await remotive.search({ what: " data engineer ", where: "Leeds", country: "gb" }, opts(f));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.toString()).toBe("https://remotive.com/api/remote-jobs");
    expect(calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
    // Not the assistant, whose ad only mentions engineers, nor "Engineering", which isn't the word.
    expect(r.jobs.map((j) => j.title)).toEqual(["Data Engineer", "Analyst"]);

    // A second title within minutes reads the same feed again without asking.
    await remotive.search({ what: "analyst" }, opts(f));
    expect(calls).toHaveLength(1);
    await expect(remotive.search({ what: "  " }, opts(f))).rejects.toThrow(/what should we look for/);
  });

  test("maps each ad into the common job shape, linking back to Remotive", async () => {
    const first = ad(1, {
      title: " Senior Engineer,  Payments &amp; Billing ",
      company_name: "Globex ",
      candidate_required_location: "USA only",
      category: "Software Development",
      salary: "$80k - $100k",
      description: "<p>We build <strong>things</strong>.</p><ul><li>Python</li></ul>",
    });
    const second = ad(2, { title: "Platform Engineer", candidate_required_location: "Europe", salary: "Competitive", job_type: "", category: "", publication_date: null, description: "" });
    const { f } = fakeFetch({ status: 200, body: reply([first, second]) });
    const r = await remotive.search({ what: "engineer" }, opts(f));
    expect(r).toMatchObject({ source: "remotive", query: { what: "engineer", limit: 50 } });
    expect(r.totalAds).toBeUndefined();
    expect(r.jobs[0]).toEqual({
      id: "remotive:remote:1001",
      source: "remotive",
      board: "remote",
      company: "Globex",
      title: "Senior Engineer, Payments & Billing",
      locations: ["USA only"],
      remote: true,
      url: "https://remotive.com/remote-jobs/software-development/job-1-1001",
      department: "Software Development",
      postedAt: "2026-11-19T14:58:42",
      pay: [{ min: 80000, max: 100000, currency: "USD" }],
      description: "We build things.\n\n- Python\n\nJob type: Full time",
    });
    // Pay it can't read stays where people see it.
    expect(r.jobs[1]).toEqual({
      id: "remotive:remote:1002",
      source: "remotive",
      board: "remote",
      company: "Acme",
      title: "Platform Engineer",
      locations: ["Europe"],
      remote: true,
      url: "https://remotive.com/remote-jobs/software-development/job-2-1002",
      pay: [],
      description: "Salary, as Remotive gives it: Competitive",
    });
  });

  test("reads salaries only when they mean one thing", () => {
    expect(parseSalary("$80k - $100k")).toEqual({ min: 80000, max: 100000, currency: "USD" });
    expect(parseSalary("€50,000")).toEqual({ min: 50000, max: 50000, currency: "EUR" });
    expect(parseSalary("£40,000 - £50,000 per year")).toEqual({ min: 40000, max: 50000, currency: "GBP", period: "year" });
    expect(parseSalary("$14/hour")).toEqual({ min: 14, max: 14, currency: "USD", period: "hour" });
    expect(parseSalary("$50-$75 /hour")).toEqual({ min: 50, max: 75, currency: "USD", period: "hour" });
    expect(parseSalary("$14.50 - $20 hourly")).toEqual({ min: 14.5, max: 20, currency: "USD", period: "hour" });
    expect(parseSalary("$3.5k–$5k/month")).toEqual({ min: 3500, max: 5000, currency: "USD", period: "month" });
    expect(parseSalary("90K - 120K EUR")).toEqual({ min: 90000, max: 120000, currency: "EUR" });
    expect(parseSalary("CAD $90k - $110k")).toEqual({ min: 90000, max: 110000, currency: "CAD" });
    expect(parseSalary("USD 60,000 to 80,000 annually")).toEqual({ min: 60000, max: 80000, currency: "USD", period: "year" });

    // No currency, a decimal comma, a European thousands dot, commission, k on one end only, two currencies, backwards, words.
    for (const s of ["70K-80K", "$35,3k- $52k", "€50.000", "OTE $25k - $35k", "$80 - 100k", "€50k USD", "$100k - $80k", "Competitive", "$0", "", null, undefined, "$80k - $100k + equity", "$1 - $2 - $3"])
      expect(parseSalary(s)).toBeUndefined();
  });

  test("keeps only what was asked for, and says how many there were", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ad(i));
    const { f } = fakeFetch({ status: 200, body: reply(many) });
    const r = await remotive.search({ what: "job", limit: 5 }, opts(f));
    expect(r.jobs).toHaveLength(5);
    expect(r.totalAds).toBe(12);
  });

  test("empty results, refusals and odd shapes", async () => {
    expect((await remotive.search({ what: "zzz" }, opts(fakeFetch({ status: 200, body: reply([]) }).f))).jobs).toEqual([]);
    await expect(remotive.search({ what: "x" }, opts(fakeFetch({ status: 404 }).f))).rejects.toThrow(/wasn't there \(404\)/);
    await expect(remotive.search({ what: "x" }, opts(fakeFetch({ status: 403 }).f))).rejects.toThrow(/turned us away \(403\)/);
    await expect(remotive.search({ what: "x" }, opts(fakeFetch({ status: 429 }).f))).rejects.toThrow(/asking too often/);
    await expect(remotive.search({ what: "x" }, opts(fakeFetch({ status: 200, body: { jobs: "nope" } }).f))).rejects.toThrow(SourceError);
    await expect(remotive.search({ what: "x" }, opts(fakeFetch({ status: 200, body: "<html>" }).f))).rejects.toThrow(/valid JSON/);

    // One bad entry doesn't lose the rest, and isn't counted as unread.
    const odd = reply([ad(1), { id: 2, title: "No link" }, null, ad(3, { url: "not a link" }), ad(4, { candidate_required_location: null, salary: null, description: null })]);
    const r = await remotive.search({ what: "job" }, opts(fakeFetch({ status: 200, body: odd }).f));
    expect(r.jobs.map((j) => j.id)).toEqual(["remotive:remote:1001", "remotive:remote:1004"]);
    expect(r.jobs[1]).toMatchObject({ locations: [], pay: [], description: "Job type: Full time" });
    expect(r.totalAds).toBeUndefined();
  });
});
