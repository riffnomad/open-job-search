import { describe, expect, test } from "bun:test";
import { recruitee, SourceError, sourceForLink, USER_AGENT } from "../src/index.ts";

// Made-up careers site, in the shape Recruitee's XML offer feed sends: booleans as
// "true"/"false", empty values as empty elements, HTML and titles in CDATA.
const STAFF = `
  <offer>
    <id>201</id>
    <slug>staff-engineer-payments</slug>
    <title><![CDATA[ Staff Engineer,  Payments &amp; Billing ]]></title>
    <description><![CDATA[<p>Build &amp; run payments.</p>]]></description>
    <requirements><![CDATA[<ul><li><p>Go</p></li><li><p>Kafka</p></li></ul>]]></requirements>
    <highlight></highlight>
    <location>Remote job</location>
    <country>Germany</country>
    <city>Berlin</city>
    <country_code>DE</country_code>
    <remote>true</remote>
    <hybrid>false</hybrid>
    <on_site>false</on_site>
    <department>Engineering &amp; Data</department>
    <employment_type_code>fulltime_permanent</employment_type_code>
    <salary>
      <min>90000</min>
      <max>120000</max>
      <currency>eur</currency>
      <period>year</period>
    </salary>
    <company_name>Acme</company_name>
    <careers_url>https://acme.recruitee.com/o/staff-engineer-payments</careers_url>
    <apply_url>https://acme.recruitee.com/o/staff-engineer-payments/c/new</apply_url>
    <created_at>2026-09-30 15:00:00 UTC</created_at>
    <updated_at>2026-11-06 15:25:07 UTC</updated_at>
    <published_at>2026-10-01 09:00:00 UTC</published_at>
    <locations>
      <location>
        <id>1</id>
        <country>Germany</country>
        <state>Berlin</state>
        <name>Berlin</name>
        <city>Berlin</city>
      </location>
      <location>
        <id>2</id>
        <country>Netherlands</country>
        <state></state>
        <name>Netherlands (remote)</name>
        <city>Netherlands</city>
      </location>
    </locations>
  </offer>`;

const OFFICE = (salary = "<min>0</min><max>0</max><currency>GBP</currency><period></period>") => `
  <offer>
    <id>202</id>
    <slug>office-manager</slug>
    <title><![CDATA[Office Manager]]></title>
    <description><![CDATA[]]></description>
    <requirements></requirements>
    <location>Leeds, England, United Kingdom</location>
    <remote>false</remote>
    <department></department>
    <salary>${salary}</salary>
    <company_name></company_name>
    <careers_url>https://acme.recruitee.com/o/office-manager</careers_url>
    <created_at>2026-10-02 08:30:00 UTC</created_at>
    <updated_at></updated_at>
    <published_at></published_at>
    <locations>
    </locations>
  </offer>`;

// An ad with no link can't be shown, so it's left out.
const BROKEN = `<offer><id>203</id><title><![CDATA[No link]]></title><careers_url></careers_url></offer>`;

const feed = (...offers: string[]) => `<?xml version="1.0" encoding="UTF-8"?>\n<offers>\n${offers.join("\n")}\n</offers>\n`;

function fakeFetch(routes: Record<string, { status: number; body?: string }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = routes[url] ?? { status: 404, body: '{"error":"Not Found"}' };
    return new Response(r.body ?? "", { status: r.status, headers: { "content-type": "application/xml" } });
  }) as typeof fetch;
  return { f, calls };
}

const FEED = "https://acme.recruitee.com/api/feeds/offers.xml";

describe("recruitee", () => {
  test("careers site names from names and links", () => {
    expect(recruitee.parseBoard("Acme")).toBe("acme");
    expect(recruitee.parseBoard("acme-labs")).toBe("acme-labs");
    expect(recruitee.parseBoard("https://acme.recruitee.com/o/staff-engineer")).toBe("acme");
    expect(recruitee.parseBoard("acme.recruitee.com")).toBe("acme");
    expect(recruitee.parseBoard("https://acme.recruitee.com/l/en/o/staff-engineer?lang=en")).toBe("acme");
    expect(recruitee.parseBoard("https://job-boards.greenhouse.io/acme")).toBeUndefined();
    expect(recruitee.parseBoard("https://careers.acme.example/o/staff-engineer")).toBeUndefined();
    expect(recruitee.parseBoard("app.recruitee.com")).toBeUndefined();
    expect(recruitee.parseBoard("a.b.recruitee.com")).toBeUndefined();
    // Anything that would change the host we call is refused.
    for (const bad of ["evil.com#", "a.b", "evil.com#.recruitee.com", "acme_labs", "-acme", "acme-", "a/b", "acme@evil.com", "not a site!"]) {
      expect(recruitee.parseBoard(bad)).toBeUndefined();
    }
    expect(sourceForLink("acme.recruitee.com/o/staff-engineer")).toMatchObject({ board: "acme", source: { id: "recruitee" } });
  });

  test("fetches a careers site into the common job shape", async () => {
    const { f, calls } = fakeFetch({ [FEED]: { status: 200, body: feed(STAFF, OFFICE(), BROKEN) } });
    const r = await recruitee.fetchBoard("acme", { fetch: f });
    expect(calls.map((c) => c.url)).toEqual([FEED]);
    expect(calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
    expect(calls[0]!.headers.accept).toContain("xml");
    expect(r).toMatchObject({ source: "recruitee", board: "acme", company: "Acme" });
    expect(r.jobs).toHaveLength(2); // the ad without a link is left out
    expect(r.jobs[0]).toEqual({
      id: "recruitee:acme:201",
      source: "recruitee",
      board: "acme",
      company: "Acme",
      title: "Staff Engineer, Payments & Billing",
      locations: ["Berlin, Germany", "Netherlands"],
      remote: true,
      url: "https://acme.recruitee.com/o/staff-engineer-payments",
      department: "Engineering & Data",
      postedAt: "2026-10-01T09:00:00Z",
      updatedAt: "2026-11-06T15:25:07Z",
      pay: [{ min: 90000, max: 120000, currency: "EUR", period: "year" }],
      description: "Build & run payments.\n\nRequirements\n\n- Go\n\n- Kafka",
    });
    // No locations list: falls back to the location line. Zero pay is dropped. Empty fields stay out; "false" isn't remote.
    expect(r.jobs[1]).toEqual({
      id: "recruitee:acme:202",
      source: "recruitee",
      board: "acme",
      company: "Acme",
      title: "Office Manager",
      locations: ["Leeds, England, United Kingdom"],
      url: "https://acme.recruitee.com/o/office-manager",
      postedAt: "2026-10-02T08:30:00Z",
      pay: [],
    });
  });

  test("pay without a known period keeps the range and leaves the period out", async () => {
    const { f } = fakeFetch({ [FEED]: { status: 200, body: feed(OFFICE("<min>45000</min><max></max><currency>GBP</currency><period>week</period>")) } });
    const r = await recruitee.fetchBoard("acme", { fetch: f });
    expect(r.jobs[0]!.pay).toEqual([{ min: 45000, currency: "GBP" }]);
    expect(r.company).toBe("acme"); // no company name in the feed: the site's name
  });

  test("blank pay, as most feeds send it, gives no pay; no city or line gives no places", async () => {
    const bare = OFFICE("<min></min><max></max><currency></currency><period></period>").replace(/<location>[^<]*<\/location>/, "<location></location>");
    const { f } = fakeFetch({ [FEED]: { status: 200, body: feed(bare) } });
    const r = await recruitee.fetchBoard("acme", { fetch: f });
    expect(r.jobs[0]).toMatchObject({ pay: [], locations: [] });
  });

  test("a careers site with no ads", async () => {
    const { f } = fakeFetch({ [FEED]: { status: 200, body: feed() } });
    const r = await recruitee.fetchBoard("acme", { fetch: f });
    expect(r).toMatchObject({ company: "acme", jobs: [] });
  });

  test("errors in plain words", async () => {
    await expect(recruitee.fetchBoard("acme", { fetch: fakeFetch({}).f })).rejects.toThrow(/no careers site called "acme"/);
    await expect(recruitee.fetchBoard("acme", { fetch: fakeFetch({ [FEED]: { status: 429 } }).f })).rejects.toThrow(/asking too often/);
    // Well-formed XML, but not an offer feed.
    await expect(recruitee.fetchBoard("acme", { fetch: fakeFetch({ [FEED]: { status: 200, body: "<html><body>Hi</body></html>" } }).f })).rejects.toThrow(/shape we don't recognise/);
    // Not XML at all, or cut off part way.
    for (const body of ['{"offers":[]}', "<offers><offer><id>1</id>", "<offers>a < b</offers>"]) {
      const err = await recruitee.fetchBoard("acme", { fetch: fakeFetch({ [FEED]: { status: 200, body } }).f }).catch((e) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect(err.message).toMatch(/Recruitee \(careers site "acme"\) sent a job feed we couldn't read/);
    }
    await expect(recruitee.fetchBoard("evil.com#")).rejects.toThrow(SourceError);
    await expect(recruitee.fetchBoard("a.b")).rejects.toThrow(SourceError);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(recruitee.fetchBoard("acme", { fetch: down })).rejects.toThrow(/couldn't reach Recruitee \(careers site "acme"\): ECONNREFUSED/);
  });
});
