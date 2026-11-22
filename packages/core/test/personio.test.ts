import { describe, expect, test } from "bun:test";
import { BOARD_SOURCES, personio, SourceError, sourceForLink, USER_AGENT } from "../src/index.ts";

// Made-up board, in the shape of Personio's public XML feed of open positions.
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
    <id>1000001</id>
    <subcompany>Acme GmbH</subcompany>
    <office>Berlin</office>
    <additionalOffices>
        <office>Hamburg</office>
        <office>berlin</office>
        <office>Remote</office>
    </additionalOffices>
    <department>Engineering</department>
    <recruitingCategory>Technology</recruitingCategory>
    <name> Senior Backend Engineer   (m/w/d) </name>
    <jobDescriptions>
        <jobDescription>
            <name>About the role</name>
            <value><![CDATA[<p>Build &amp; run payments.</p><ul><li>Go</li><li>Kafka</li></ul>]]></value>
        </jobDescription>
        <jobDescription>
            <name>What we offer</name>
            <value><![CDATA[<p>Good coffee.</p>]]></value>
        </jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <seniority>experienced</seniority>
    <schedule>full-time</schedule>
    <yearsOfExperience>5-7</yearsOfExperience>
    <keywords>Go,Kafka</keywords>
    <occupation>software_development</occupation>
    <salaryInformation>
        <min>70000.00</min>
        <max>90000.00</max>
        <currencySymbol>€</currencySymbol>
        <currencyCode>EUR</currencyCode>
        <type>yearly</type>
    </salaryInformation>
    <createdAt>2026-11-13T16:21:35+00:00</createdAt>
</position>
<position>
    <id>1000002</id>
    <office>München</office>
    <name>Office Manager</name>
    <jobDescriptions></jobDescriptions>
    <salaryInformation>
        <min>20.00</min>
        <currencyCode>eur</currencyCode>
        <type>per_shift</type>
    </salaryInformation>
    <salaryInformation>
        <min>3000</min>
        <max>3500</max>
        <currencyCode>EUR</currencyCode>
        <type>monthly</type>
    </salaryInformation>
    <createdAt>2026-10-01T09:00:00+00:00</createdAt>
</position>
<position>
    <id></id>
    <name>No id, so no link: left out</name>
</position>
</workzag-jobs>`;

function fakeFetch(routes: Record<string, { status: number; body?: string }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = routes[url] ?? { status: 404, body: "<!DOCTYPE html><html><body>Not found</body></html>" };
    return new Response(r.body ?? "", { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const FEED_URL = "https://acme.jobs.personio.de/xml";

describe("personio", () => {
  test("is registered", () => {
    expect(BOARD_SOURCES.personio).toBe(personio);
  });

  test("board names from names and links", () => {
    expect(personio.parseBoard("Acme")).toBe("acme");
    expect(personio.parseBoard("https://acme.jobs.personio.de/")).toBe("acme");
    expect(personio.parseBoard("https://acme.jobs.personio.com")).toBe("acme");
    expect(personio.parseBoard("acme.jobs.personio.de/job/1000001?display=en")).toBe("acme");
    expect(personio.parseBoard("https://ACME-labs.jobs.personio.com/job/1000001")).toBe("acme-labs");
    // Personio's own sites, other hosts and look-alikes aren't boards.
    expect(personio.parseBoard("https://www.personio.de/")).toBeUndefined();
    expect(personio.parseBoard("https://jobs.personio.de/")).toBeUndefined();
    expect(personio.parseBoard("https://acme.jobs.personio.de.example.com/")).toBeUndefined();
    expect(personio.parseBoard("https://jobs.acme.com/")).toBeUndefined();
    expect(personio.parseBoard("https://apply.workable.com/acme")).toBeUndefined();
    expect(personio.parseBoard("not a board!")).toBeUndefined();
    expect(sourceForLink("acme.jobs.personio.com")).toMatchObject({ board: "acme", source: { id: "personio" } });
  });

  test("fetches a board into the common job shape", async () => {
    const { f, calls } = fakeFetch({ [FEED_URL]: { status: 200, body: FEED } });
    const r = await personio.fetchBoard("acme", { fetch: f });
    // No ?language=: the board's own language keeps every description.
    expect(calls.map((c) => c.url)).toEqual([FEED_URL]);
    expect(calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
    // Ads name different companies (one names none), so the board falls back to its name.
    expect(r).toMatchObject({ source: "personio", board: "acme", company: "acme" });
    expect(r.jobs).toHaveLength(2);
    expect(r.jobs[0]).toEqual({
      id: "personio:acme:1000001",
      source: "personio",
      board: "acme",
      company: "Acme GmbH",
      title: "Senior Backend Engineer (m/w/d)",
      // The office then the additional ones, without repeats.
      locations: ["Berlin", "Hamburg", "Remote"],
      remote: true,
      url: "https://acme.jobs.personio.de/job/1000001",
      department: "Engineering",
      postedAt: "2026-11-13T16:21:35+00:00",
      pay: [{ min: 70000, max: 90000, currency: "EUR", period: "year" }],
      description: "About the role\n\nBuild & run payments.\n\n- Go\n- Kafka\n\nWhat we offer\n\nGood coffee.",
    });
  });

  test("no subcompany, no description, and pay with an unknown period", async () => {
    const r = await personio.fetchBoard("acme", { fetch: fakeFetch({ [FEED_URL]: { status: 200, body: FEED } }).f });
    expect(r.jobs[1]).toEqual({
      id: "personio:acme:1000002",
      source: "personio",
      board: "acme",
      company: "acme",
      title: "Office Manager",
      locations: ["München"],
      url: "https://acme.jobs.personio.de/job/1000002",
      postedAt: "2026-10-01T09:00:00+00:00",
      pay: [
        { min: 20, currency: "EUR" },
        { min: 3000, max: 3500, currency: "EUR", period: "month" },
      ],
    });
  });

  test("one subcompany across the board names the company", async () => {
    const body = `<workzag-jobs><position><id>7</id><subcompany>Acme GmbH</subcompany><name>Designer</name></position></workzag-jobs>`;
    const r = await personio.fetchBoard("ACME", { fetch: fakeFetch({ [FEED_URL]: { status: 200, body } }).f });
    expect(r).toMatchObject({ board: "acme", company: "Acme GmbH" });
    expect(r.jobs[0]).toMatchObject({ locations: [], pay: [] });
  });

  test("an empty board", async () => {
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<workzag-jobs>\n</workzag-jobs>`;
    const r = await personio.fetchBoard("acme", { fetch: fakeFetch({ [FEED_URL]: { status: 200, body } }).f });
    expect(r).toMatchObject({ company: "acme", jobs: [] });
  });

  test("errors in plain words", async () => {
    await expect(personio.fetchBoard("acme", { fetch: fakeFetch({}).f })).rejects.toThrow(/no job board called "acme"/);
    await expect(personio.fetchBoard("acme", { fetch: fakeFetch({ [FEED_URL]: { status: 429 } }).f })).rejects.toThrow(/asking too often/);
    await expect(personio.fetchBoard("acme", { fetch: fakeFetch({ [FEED_URL]: { status: 200, body: "<workzag-jobs><position>" } }).f })).rejects.toThrow(
      /Personio \(company "acme"\) sent a feed we couldn't read: <position> is never closed/,
    );
    await expect(personio.fetchBoard("acme", { fetch: fakeFetch({ [FEED_URL]: { status: 200, body: "<html><body>Hi</body></html>" } }).f })).rejects.toThrow(
      /didn't send a job feed/,
    );
    await expect(personio.fetchBoard("../x")).rejects.toThrow(SourceError);
  });
});
