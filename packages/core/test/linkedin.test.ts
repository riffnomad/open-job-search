import { describe, expect, test } from "bun:test";
import { isSwitchedOn, linkedin, reed, SEARCH_SOURCES, searchSource, SourceError, USER_AGENT } from "../src/index.ts";
import { parseCard, parsePage } from "../src/jobs/sources/linkedin.ts";

// Made-up companies, in the shape of the job cards LinkedIn's guest search sent in November 2026.
const card = (n: number, o: { title?: string; company?: string; place?: string; date?: string; salary?: string; urn?: boolean; logo?: boolean; badges?: string[]; companyLink?: boolean } = {}) => `<li>
  <div class="base-card relative w-full base-search-card job-search-card" ${o.urn === false ? "" : `data-entity-urn="urn:li:jobPosting:${4000000000 + n}"`} data-row="${n}">
    <a class="base-card__full-link absolute" href="https://uk.linkedin.com/jobs/view/job-${n}-at-acme-${4000000000 + n}?position=1&amp;pageNum=0&amp;refId=abc%3D%3D&amp;trackingId=xyz">
      <span class="sr-only">${o.title ?? `Job ${n}`}</span>
    </a>
    <div class="search-entity-media">
      ${o.logo === false ? "" : `<img class="artdeco-entity-image artdeco-entity-image--square-4" data-delayed-url="https://media.licdn.com/dms/image/v2/X/company-logo_100_100/0/1/acme_logo?e=2147483647&amp;v=beta&amp;t=abc" data-ghost-classes="artdeco-entity-image--ghost" data-ghost-url="https://static.licdn.com/aero-v1/sc/h/ghost" alt>`}
    </div>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title">
        ${o.title ?? `Job ${n}`}
      </h3>
      <h4 class="base-search-card__subtitle">
        ${o.companyLink === false ? (o.company ?? "Acme") : `<a class="hidden-nested-link" href="https://uk.linkedin.com/company/acme-co?trk=public_jobs">
          ${o.company ?? "Acme"}
        </a>`}
      </h4>
      <div class="base-search-card__metadata">
        <span class="job-search-card__location">
          ${o.place ?? "London, England, United Kingdom"}
        </span>
        ${o.salary ? `<span class="job-search-card__salary-info">\n  ${o.salary}\n</span>` : ""}
        ${(o.badges ?? []).map((b) => `<div class="job-posting-benefits text-sm"><icon class="job-posting-benefits__icon"></icon><span class="job-posting-benefits__text">
  ${b}
<!---->        </span></div>`).join("")}
        <time class="job-search-card__listdate" datetime="${o.date ?? "2026-11-20"}">
          1 week ago
        </time>
      </div>
    </div>
  </div>
</li>`;

const page = (...cards: string[]) => `\n\n${cards.join("\n")}\n`;

function fakeFetch(pages: Record<number, { status: number; body?: string }>) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const start = Number(url.searchParams.get("start"));
    const r = url.host === "www.linkedin.com" && url.pathname === "/jobs-guest/jobs/api/seeMoreJobPostings/search" ? (pages[start] ?? { status: 200, body: "" }) : { status: 404 };
    return new Response(r.body ?? "", { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const opts = (f: typeof fetch) => ({ fetch: f, pauseMs: 0 });
const ten = (from: number) => page(...Array.from({ length: 10 }, (_, i) => card(from + i)));

describe("linkedin", () => {
  test("is registered, off until switched on, with a reason and a credit", () => {
    expect(SEARCH_SOURCES.linkedin).toBe(linkedin);
    expect(searchSource("LinkedIn")).toBe(linkedin);
    expect(linkedin.places).toBe(true);
    expect(linkedin.keys).toBeUndefined();
    expect(linkedin.optIn).toMatch(/terms/);
    expect(linkedin.covers).toMatch(/unofficial/);
    expect(linkedin.credit).toMatch(/LinkedIn/);
    expect(isSwitchedOn(linkedin, [])).toBe(false);
    expect(isSwitchedOn(linkedin, ["linkedin"])).toBe(true);
    // Boards without optIn are always on.
    expect(isSwitchedOn(reed, [])).toBe(true);
  });

  test("a card: title, company, place, date, a clean link, nothing guessed", () => {
    const job = parseCard(card(1, { title: "Senior Engineer (f/m/d) &amp; Lead", company: "Globex &amp; Co" }));
    expect(job).toEqual({
      id: "linkedin:jobs:4000000001",
      source: "linkedin",
      board: "jobs",
      company: "Globex & Co",
      title: "Senior Engineer (f/m/d) & Lead",
      locations: ["London, England, United Kingdom"],
      url: "https://www.linkedin.com/jobs/view/4000000001",
      postedAt: "2026-11-20",
      pay: [],
      companyPage: "https://www.linkedin.com/company/acme-co",
      companyLogo: "https://media.licdn.com/dms/image/v2/X/company-logo_100_100/0/1/acme_logo?e=2147483647&v=beta&t=abc",
    });
  });

  test("badges as signals, in LinkedIn's words; no logo or company link when the card has none", () => {
    expect(parseCard(card(1, { badges: ["Be an early applicant", "Actively Hiring"] }))?.signals).toEqual(["Be an early applicant", "Actively Hiring"]);
    const bare = parseCard(card(2, { logo: false, companyLink: false }))!;
    expect(bare.company).toBe("Acme");
    expect(bare.signals).toBeUndefined();
    expect(bare.companyLogo).toBeUndefined();
    expect(bare.companyPage).toBeUndefined();
  });

  test("pay only when the card shows it plainly; remote when the place says so", () => {
    expect(parseCard(card(1, { salary: "$120,000.00/yr - $150,000.00/yr" }))?.pay).toEqual([{ min: 120000, max: 150000, currency: "USD", period: "year" }]);
    expect(parseCard(card(6, { salary: "$50.00/hr - $60.00/yr" }))?.pay).toEqual([]);
    expect(parseCard(card(2, { salary: "$120,000.00 - $150,000.00" }))?.pay).toEqual([{ min: 120000, max: 150000, currency: "USD" }]);
    expect(parseCard(card(3, { salary: "£45,000/yr" }))?.pay).toEqual([{ min: 45000, max: 45000, currency: "GBP", period: "year" }]);
    expect(parseCard(card(4, { place: "United Kingdom (Remote)" }))?.remote).toBe(true);
    expect(parseCard(card(5))?.remote).toBeUndefined();
  });

  test("the id from the link when the card has no urn; cards missing a title or company are skipped", () => {
    expect(parseCard(card(7, { urn: false }))?.id).toBe("linkedin:jobs:4000000007");
    expect(parseCard(card(8, { company: "" }))).toBeUndefined();
    expect(parseCard(card(9, { title: "" }))).toBeUndefined();
    expect(parsePage(page(card(1), card(2, { company: "" }), card(3)))).toMatchObject({ cards: 3, jobs: [{ title: "Job 1" }, { title: "Job 3" }] });
  });

  test("the query: words and place, start counting cards, our own name", async () => {
    const { f, calls } = fakeFetch({ 0: { status: 200, body: page(card(1)) } });
    const r = await linkedin.search({ what: "data engineer", where: "Leeds" }, opts(f));
    expect(r.jobs.map((j) => j.title)).toEqual(["Job 1"]);
    expect(calls[0]!.url.searchParams.get("keywords")).toBe("data engineer");
    expect(calls[0]!.url.searchParams.get("location")).toBe("Leeds");
    expect(calls[0]!.url.searchParams.get("start")).toBe("0");
    expect(calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
    expect(r.totalAds).toBeUndefined();
  });

  test("reads pages up to the limit, three by default, ten at most", async () => {
    const pages = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [i * 10, { status: 200, body: ten(i * 10) }]));
    const a = fakeFetch(pages);
    expect((await linkedin.search({ what: "x" }, opts(a.f))).jobs).toHaveLength(30);
    expect(a.calls.map((c) => c.url.searchParams.get("start"))).toEqual(["0", "10", "20"]);
    const b = fakeFetch(pages);
    expect((await linkedin.search({ what: "x", limit: 15 }, opts(b.f))).jobs).toHaveLength(15);
    expect(b.calls).toHaveLength(2);
    const c = fakeFetch(pages);
    expect((await linkedin.search({ what: "x", limit: 1000 }, opts(c.f))).jobs).toHaveLength(100);
  });

  test("stops at an empty page, a 400 past the end, or a page with nothing new", async () => {
    const empty = fakeFetch({ 0: { status: 200, body: ten(0) }, 10: { status: 200, body: "" } });
    expect((await linkedin.search({ what: "x" }, opts(empty.f))).jobs).toHaveLength(10);
    const end = fakeFetch({ 0: { status: 200, body: ten(0) }, 10: { status: 400 } });
    expect((await linkedin.search({ what: "x" }, opts(end.f))).jobs).toHaveLength(10);
    const same = fakeFetch({ 0: { status: 200, body: ten(0) }, 10: { status: 200, body: ten(0) }, 20: { status: 200, body: ten(0) } });
    expect((await linkedin.search({ what: "x" }, opts(same.f))).jobs).toHaveLength(10);
    expect(same.calls).toHaveLength(2);
  });

  test("stops at the first refusal and says so", async () => {
    for (const status of [999, 429, 403]) {
      const { f, calls } = fakeFetch({ 0: { status: 200, body: ten(0) }, 10: { status } });
      const err = await linkedin.search({ what: "x" }, opts(f)).catch((e) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect(err.message).toMatch(status === 999 ? /turned us away \(999\)/ : status === 429 ? /asking too often/ : /turned us away \(403\)/);
      expect(calls).toHaveLength(2);
    }
    // A 400 on the first page is an error, not the end.
    const { f } = fakeFetch({ 0: { status: 400 } });
    expect(await linkedin.search({ what: "x" }, opts(f)).catch((e) => e)).toBeInstanceOf(SourceError);
  });
});
