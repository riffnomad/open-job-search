import { describe, expect, test } from "bun:test";
import { BOARD_SOURCES, SourceError, sourceForLink, teamtailor, USER_AGENT } from "../src/index.ts";

// Made-up careers site, in the shape Teamtailor's public RSS feed sends.
function item(n: number, extra = ""): string {
  return `
    <item>
      <title>Job ${n}</title>
      <description>&lt;p&gt;Ad ${n}&lt;/p&gt;</description>
      <pubDate>Tue, 17 Nov 2026 11:14:24 +0100</pubDate>
      <link>https://acme.teamtailor.com/jobs/${1000 + n}-job-${n}</link>
      <remoteStatus>none</remoteStatus>
      <guid>00000000-0000-4000-8000-${String(n).padStart(12, "0")}</guid>
      ${extra}
    </item>`;
}

function feed(items: string, title = "Acme"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:tt="https://teamtailor.com/locations">
  <channel>
    <title>${title}</title>
    <description/>
    <link>https://acme.teamtailor.com/jobs</link>${items}
  </channel>
</rss>`;
}

const FULL_ITEM = `
    <item>
      <title> Staff Engineer,  Payments &amp; Billing </title>
      <description>&lt;h4&gt;About us&lt;/h4&gt;&lt;p&gt;Build &amp;amp; run payments.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;&lt;p&gt;Go&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;Kafka&lt;/p&gt;&lt;/li&gt;&lt;/ul&gt;</description>
      <pubDate>Tue, 17 Nov 2026 11:14:24 +0100</pubDate>
      <link>https://acme.teamtailor.com/jobs/8746132-staff-engineer-payments</link>
      <remoteStatus>hybrid</remoteStatus>
      <guid>6eabe92c-0000-4000-8000-000000000001</guid>
      <company_name>Acme</company_name>
      <tt:locations>
        <tt:location>
          <tt:name>Yorkshire, UK</tt:name>
          <tt:address>1 Example Street</tt:address>
          <tt:city>London</tt:city>
          <tt:country>United Kingdom</tt:country>
        </tt:location>
        <tt:location>
          <tt:city>Lisbon</tt:city>
          <tt:country>Portugal</tt:country>
        </tt:location>
      </tt:locations>
      <tt:department>Engineering</tt:department>
      <tt:role>Backend</tt:role>
    </item>`;

type Route = { status: number; body?: string };

function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = routes[url] ?? { status: 404 };
    return new Response(r.body ?? "", { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const rss = (host: string, offset = 0) => `https://${host}/jobs.rss?per_page=100&offset=${offset}`;
const HOST = "acme.teamtailor.com";

describe("teamtailor", () => {
  test("is registered", () => {
    expect(BOARD_SOURCES.teamtailor).toBe(teamtailor);
  });

  test("hosts from names and links", () => {
    expect(teamtailor.parseBoard("Acme")).toBe(HOST);
    expect(teamtailor.parseBoard("acme.teamtailor.com")).toBe(HOST);
    expect(teamtailor.parseBoard("https://Acme.teamtailor.com/jobs/8746132-staff-engineer")).toBe(HOST);
    expect(teamtailor.parseBoard("https://acme.teamtailor.com/en-GB/jobs")).toBe(HOST);
    // Teamtailor's own sites aren't careers sites.
    expect(teamtailor.parseBoard("https://www.teamtailor.com/")).toBeUndefined();
    expect(teamtailor.parseBoard("https://app.teamtailor.com/")).toBeUndefined();
    expect(teamtailor.parseBoard("https://teamtailor.com/")).toBeUndefined();
    // A custom domain can't be told apart offline: only when Teamtailor is named.
    expect(teamtailor.parseBoard("jobs.acme.example")).toBeUndefined();
    expect(teamtailor.parseBoard("https://jobs.acme.example/jobs", { named: true })).toBe("jobs.acme.example");
    expect(teamtailor.parseBoard("Jobs.Acme.Example", { named: true })).toBe("jobs.acme.example");
    expect(teamtailor.parseBoard("https://www.teamtailor.com/", { named: true })).toBeUndefined();
    // Not a public host name.
    expect(teamtailor.parseBoard("http://127.0.0.1/jobs", { named: true })).toBeUndefined();
    expect(teamtailor.parseBoard("http://localhost:3000", { named: true })).toBeUndefined();
  });

  test("links find teamtailor, but a custom domain isn't claimed", () => {
    expect(sourceForLink("https://acme.teamtailor.com/jobs")?.source).toBe(teamtailor);
    expect(sourceForLink("https://acme.teamtailor.com/jobs")?.board).toBe(HOST);
    expect(sourceForLink("https://jobs.acme.example/jobs")).toBeUndefined();
    expect(sourceForLink("https://job-boards.greenhouse.io/acme")?.source.id).toBe("greenhouse");
  });

  test("reads one item in full", async () => {
    const { f, calls } = fakeFetch({ [rss(HOST)]: { status: 200, body: feed(FULL_ITEM) } });
    const r = await teamtailor.fetchBoard(HOST, { fetch: f, pauseMs: 0 });
    expect(r.source).toBe("teamtailor");
    expect(r.board).toBe(HOST);
    expect(r.company).toBe("Acme");
    expect(r.totalAds).toBeUndefined();
    expect(r.jobs).toEqual([
      {
        id: "teamtailor:acme.teamtailor.com:8746132",
        source: "teamtailor",
        board: HOST,
        company: "Acme",
        title: "Staff Engineer, Payments & Billing",
        // The location's own name wins: its city and address are the head office's. No name: city, country.
        locations: ["Yorkshire, UK", "Lisbon, Portugal"],
        url: "https://acme.teamtailor.com/jobs/8746132-staff-engineer-payments",
        department: "Engineering",
        postedAt: "2026-11-17T10:14:24.000Z",
        pay: [],
        description: "About us\n\nBuild & run payments.\n\n- Go\n\n- Kafka",
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
  });

  test("pages with offset until a short page", async () => {
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => item(from + i)).join("");
    const { f, calls } = fakeFetch({
      [rss(HOST, 0)]: { status: 200, body: feed(page(0, 100)) },
      [rss(HOST, 100)]: { status: 200, body: feed(page(100, 100)) },
      [rss(HOST, 200)]: { status: 200, body: feed(page(200, 3)) },
    });
    const r = await teamtailor.fetchBoard(HOST, { fetch: f, pauseMs: 0 });
    expect(r.jobs).toHaveLength(203);
    expect(calls.map((c) => c.url)).toEqual([rss(HOST, 0), rss(HOST, 100), rss(HOST, 200)]);
    expect(new Set(r.jobs.map((j) => j.id)).size).toBe(203);
  });

  test("stops at the cap, and when a site ignores offset", async () => {
    const page = (from: number) => Array.from({ length: 100 }, (_, i) => item(from + i)).join("");
    const routes: Record<string, Route> = {};
    for (let o = 0; o < 1200; o += 100) routes[rss(HOST, o)] = { status: 200, body: feed(page(o)) };
    const big = fakeFetch(routes);
    const r = await teamtailor.fetchBoard(HOST, { fetch: big.f, pauseMs: 0 });
    expect(r.jobs).toHaveLength(1000);
    expect(big.calls).toHaveLength(10);

    const same = feed(page(0));
    const stuck = fakeFetch({ [rss(HOST, 0)]: { status: 200, body: same }, [rss(HOST, 100)]: { status: 200, body: same } });
    const s = await teamtailor.fetchBoard(HOST, { fetch: stuck.f, pauseMs: 0 });
    expect(s.jobs).toHaveLength(100);
    expect(stuck.calls).toHaveLength(2);
  });

  test("only remoteStatus fully means remote", async () => {
    const status = (n: number, s: string) => item(n).replace("<remoteStatus>none</remoteStatus>", `<remoteStatus>${s}</remoteStatus>`);
    const { f } = fakeFetch({ [rss(HOST)]: { status: 200, body: feed(status(1, "fully") + status(2, "hybrid") + status(3, "none")) } });
    const r = await teamtailor.fetchBoard(HOST, { fetch: f, pauseMs: 0 });
    expect(r.jobs.map((j) => j.remote)).toEqual([true, undefined, undefined]);
  });

  test("an item without locations, and the guid when the link has no number", async () => {
    const odd = item(1).replace("/jobs/1001-job-1", "/jobs/job-without-number");
    const { f } = fakeFetch({ [rss(HOST)]: { status: 200, body: feed(odd + item(2, "<tt:department/>")) } });
    const r = await teamtailor.fetchBoard(HOST, { fetch: f, pauseMs: 0 });
    expect(r.jobs[0]!.id).toBe("teamtailor:acme.teamtailor.com:00000000-0000-4000-8000-000000000001");
    expect(r.jobs[0]!.locations).toEqual([]);
    expect(r.jobs[1]!.id).toBe("teamtailor:acme.teamtailor.com:1002");
    expect(r.jobs[1]!.department).toBeUndefined();
  });

  test("a custom domain is read when its feed is Teamtailor's", async () => {
    const { f } = fakeFetch({ [rss("jobs.acme.example")]: { status: 200, body: feed(item(1)) } });
    const r = await teamtailor.fetchBoard("jobs.acme.example", { fetch: f, pauseMs: 0 });
    expect(r.board).toBe("jobs.acme.example");
    expect(r.jobs[0]!.id).toBe("teamtailor:jobs.acme.example:1001");
  });

  test("a reply that isn't a Teamtailor feed is refused", async () => {
    const plainRss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>${item(1)}</channel></rss>`;
    const html = "<!DOCTYPE html><html><body><p>Welcome</p></body></html>";
    for (const body of [plainRss, html]) {
      const { f } = fakeFetch({ [rss("blog.acme.example")]: { status: 200, body } });
      const err = await teamtailor.fetchBoard("blog.acme.example", { fetch: f, pauseMs: 0 }).catch((e) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect(err.message).toContain("doesn't look like a Teamtailor careers site");
    }
  });

  test("a 404 says there's no site there", async () => {
    const { f } = fakeFetch({});
    const err = await teamtailor.fetchBoard("nobody.teamtailor.com", { fetch: f, pauseMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.message).toContain("no Teamtailor careers site at nobody.teamtailor.com");
  });

  test("bad XML is a plain error", async () => {
    const { f } = fakeFetch({ [rss(HOST)]: { status: 200, body: feed(item(1)).replace("</channel>", "") } });
    const err = await teamtailor.fetchBoard(HOST, { fetch: f, pauseMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.message).toContain("isn't a Teamtailor job feed");
  });

  test("a board that isn't a host is refused before fetching", async () => {
    const { f, calls } = fakeFetch({});
    const err = await teamtailor.fetchBoard("not a host!", { fetch: f }).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(calls).toHaveLength(0);
  });
});
