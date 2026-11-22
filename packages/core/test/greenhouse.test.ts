import { describe, expect, test } from "bun:test";
import { greenhouse, groupJobs, htmlToText, type Job, SourceError, sourceForLink, splitLocations, USER_AGENT } from "../src/index.ts";

// Made-up board, in the shape the Greenhouse Job Board API sends.
const JOBS = {
  jobs: [
    {
      id: 101,
      title: " Staff Engineer, Payments ",
      absolute_url: "https://job-boards.greenhouse.io/acme/jobs/101",
      updated_at: "2026-11-06T15:25:07-05:00",
      first_published: "2026-10-01T09:00:00-04:00",
      company_name: "Acme",
      location: { name: "Remote, United Kingdom" },
      departments: [{ name: "Engineering" }],
      offices: [{ name: "London" }],
      content: "&lt;p&gt;Build &amp;amp; run payments.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;li&gt;Kafka&lt;/li&gt;&lt;/ul&gt;",
      pay_input_ranges: [
        { min_cents: 9000000, max_cents: 12000000, currency_type: "gbp", title: "UK salary range:", blurb: "<p>The annual base salary for this role.</p>" },
        { min_cents: 100, max_cents: 200, currency_type: "USD", title: "Annual Salary:" },
        { min_cents: 5400, max_cents: 6000, currency_type: "USD", title: "SF Hourly Rate", blurb: "<p>Plus an annual bonus.</p>" },
      ],
    },
    {
      id: 102,
      title: "Office  Manager &amp; Host",
      absolute_url: "https://job-boards.greenhouse.io/acme/jobs/102",
      updated_at: null,
      location: { name: "" },
      offices: [{ name: "Leeds" }, { name: "York" }],
      departments: [],
      content: null,
      pay_input_ranges: [{ min_cents: null, max_cents: null, currency_type: "GBP", title: "n/a" }],
    },
  ],
  meta: { total: 2 },
};

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = Object.keys(routes).find((k) => url.startsWith(k) && (url.length === k.length || url[k.length] === "?"));
    const r = key ? routes[key]! : { status: 404 };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const API = "https://boards-api.greenhouse.io/v1/boards/acme";

describe("greenhouse", () => {
  test("board names from names and links", () => {
    expect(greenhouse.parseBoard("Acme")).toBe("acme");
    expect(greenhouse.parseBoard("https://job-boards.greenhouse.io/acme/jobs/101")).toBe("acme");
    expect(greenhouse.parseBoard("boards.greenhouse.io/acme")).toBe("acme");
    expect(greenhouse.parseBoard("https://job-boards.eu.greenhouse.io/acme/jobs/7")).toBe("acme");
    expect(greenhouse.parseBoard("https://boards.greenhouse.io/embed/job_board?for=acme")).toBe("acme");
    expect(greenhouse.parseBoard("https://jobs.lever.co/acme")).toBeUndefined();
    expect(greenhouse.parseBoard("not a board!")).toBeUndefined();
    expect(sourceForLink("job-boards.greenhouse.io/acme")).toMatchObject({ board: "acme", source: { id: "greenhouse" } });
    expect(sourceForLink("acme")).toBeUndefined();
  });

  test("fetches a board into the common job shape", async () => {
    const { f, calls } = fakeFetch({ [`${API}/jobs`]: { status: 200, body: JOBS }, [API]: { status: 200, body: { name: "Acme Ltd" } } });
    const r = await greenhouse.fetchBoard("acme", { fetch: f });
    expect(calls.map((c) => c.url)).toContain(`${API}/jobs?content=true&pay_transparency=true`);
    expect(calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
    expect(r).toMatchObject({ source: "greenhouse", board: "acme", company: "Acme Ltd" });
    expect(r.jobs[0]).toEqual({
      id: "greenhouse:acme:101",
      source: "greenhouse",
      board: "acme",
      company: "Acme",
      title: "Staff Engineer, Payments",
      locations: ["Remote, United Kingdom"],
      remote: true,
      url: "https://job-boards.greenhouse.io/acme/jobs/101",
      department: "Engineering",
      postedAt: "2026-10-01T09:00:00-04:00",
      updatedAt: "2026-11-06T15:25:07-05:00",
      pay: [
        { min: 90000, max: 120000, currency: "GBP", period: "year", label: "UK salary range" },
        { min: 54, max: 60, currency: "USD", period: "hour", label: "SF Hourly Rate" },
      ],
      description: "Build & run payments.\n\n- Go\n- Kafka",
    });
    // No location: falls back to offices. Empty pay ranges are dropped. Missing fields stay out.
    expect(r.jobs[1]).toEqual({
      id: "greenhouse:acme:102",
      source: "greenhouse",
      board: "acme",
      company: "Acme Ltd",
      title: "Office Manager & Host",
      locations: ["Leeds", "York"],
      url: "https://job-boards.greenhouse.io/acme/jobs/102",
      pay: [],
    });
  });

  test("errors in plain words", async () => {
    await expect(greenhouse.fetchBoard("acme", { fetch: fakeFetch({}).f })).rejects.toThrow(/no board called "acme"/);
    await expect(greenhouse.fetchBoard("acme", { fetch: fakeFetch({ [`${API}/jobs`]: { status: 429 } }).f })).rejects.toThrow(/asking too often/);
    await expect(greenhouse.fetchBoard("acme", { fetch: fakeFetch({ [`${API}/jobs`]: { status: 200, body: { nope: 1 } } }).f })).rejects.toThrow(/shape we don't recognise/);
    await expect(greenhouse.fetchBoard("../x")).rejects.toThrow(SourceError);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(greenhouse.fetchBoard("acme", { fetch: down })).rejects.toThrow(/couldn't reach Greenhouse \(board "acme"\): ECONNREFUSED/);
  });
});

describe("htmlToText", () => {
  test("keeps paragraphs and lists, drops tags and scripts, decodes entities", () => {
    expect(htmlToText("<h2>About</h2><p>We&rsquo;re <b>small</b>.<br>Pay: &pound;90k&nbsp;&ndash; &#163;120k</p><script>x()</script><ol><li>One</li><li>Two</li></ol>")).toBe(
      "About\n\nWe’re small.\nPay: £90k – £120k\n\n- One\n- Two",
    );
    expect(htmlToText("<ul><li><p>One</p></li><li><p>Two</p></li></ul>")).toBe("- One\n\n- Two");
    // Pasted from a rich editor: line breaks carry styles.
    expect(htmlToText('<span>One.</span><br style="margin:0"><br class="x"/>Two')).toBe("One.\n\nTwo");
  });
});

describe("locations and grouping", () => {
  test("one field holding several places becomes a list", () => {
    expect(splitLocations("London, UK; Remote (Travel) | Leeds, UK", "london, uk", null)).toEqual(["London, UK", "Remote (Travel)", "Leeds, UK"]);
  });

  test("the same job posted per place is one group, keeping every ad, place and pay range", () => {
    const job = (id: string, loc: string, pay: number, postedAt: string, title = "Staff Engineer"): Job => ({
      id: `greenhouse:acme:${id}`, source: "greenhouse", board: "acme", company: "Acme", title, locations: [loc],
      url: `https://job-boards.greenhouse.io/acme/jobs/${id}`, department: "Platform", postedAt, pay: [{ min: pay, currency: "GBP" }],
    });
    const groups = groupJobs([job("1", "London", 100, "2026-11-01"), job("2", "Leeds", 90, "2026-11-03"), job("3", "London", 100, "2026-11-02", "Office Manager"), job("4", "York", 90, "2026-10-01", "staff  engineer")]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ title: "Staff Engineer", locations: ["Leeds", "London", "York"], pay: [{ min: 90, currency: "GBP" }, { min: 100, currency: "GBP" }], postedAt: "2026-11-03" });
    expect(groups[0]!.jobs.map((j) => j.id)).toEqual(["greenhouse:acme:2", "greenhouse:acme:1", "greenhouse:acme:4"]);
  });
});
