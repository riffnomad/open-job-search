import { describe, expect, test } from "bun:test";
import { parseXml, XmlError, xmlChild, xmlChildren, xmlText } from "../src/index.ts";

describe("xml reader", () => {
  test("elements, attributes, entities, CDATA and prefixed names", () => {
    const doc = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
      <!-- a made-up feed -->
      <rss version="2.0" xmlns:tt="https://example.com/tt">
        <channel>
          <title>Acme &amp; Co</title>
          <item>
            <title><![CDATA[Staff Engineer <Payments>]]></title>
            <description>&lt;p&gt;Build things&lt;/p&gt; &#8211; together</description>
            <tt:locations><tt:location><tt:city>Leeds</tt:city></tt:location><tt:location><tt:city>York</tt:city></tt:location></tt:locations>
            <remote/>
            <link href='https://acme.example/jobs/1?a=1&amp;b=2'/>
          </item>
          <item><title>Second</title></item>
        </channel>
      </rss>`);
    expect(doc.name).toBe("rss");
    expect(doc.attrs).toEqual({ version: "2.0", "xmlns:tt": "https://example.com/tt" });
    const channel = xmlChild(doc, "channel");
    expect(xmlText(channel, "title")).toBe("Acme & Co");
    const [first, second] = xmlChildren(channel, "item");
    expect(xmlText(first, "title")).toBe("Staff Engineer <Payments>");
    expect(xmlText(first, "description")).toBe("<p>Build things</p> – together");
    expect(xmlChildren(xmlChild(first, "tt:locations"), "tt:location").map((l) => xmlText(l, "tt:city"))).toEqual(["Leeds", "York"]);
    expect(xmlChild(first, "remote")).toMatchObject({ name: "remote", children: [], text: "" });
    expect(xmlText(first, "remote")).toBeUndefined();
    expect(xmlChild(first, "link")?.attrs.href).toBe("https://acme.example/jobs/1?a=1&b=2");
    expect(xmlText(second, "title")).toBe("Second");
    expect(xmlText(second, "missing")).toBeUndefined();
  });

  test("only direct children: a nested element with the same name isn't picked up", () => {
    const pos = parseXml("<position><additionalOffices><office>York</office></additionalOffices><office>Leeds</office></position>");
    expect(xmlText(pos, "office")).toBe("Leeds");
    expect(xmlChildren(xmlChild(pos, "additionalOffices"), "office").map((o) => o.text)).toEqual(["York"]);
  });

  test("XML that isn't well formed says why", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(XmlError);
    expect(() => parseXml("<a><b>")).toThrow(/never closed/);
    expect(() => parseXml("<a></a><b></b>")).toThrow(/one root/);
    expect(() => parseXml("")).toThrow(/one root/);
    expect(() => parseXml("<a>1 < 2</a>")).toThrow(/stray/);
  });
});

describe("getText", () => {
  test("reads a feed as text with our name; 404 is null", async () => {
    const { getText, USER_AGENT } = await import("../src/index.ts");
    const seen: Record<string, string>[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return String(input).endsWith("/missing") ? new Response("", { status: 404 }) : new Response("<jobs/>", { status: 200 });
    }) as typeof fetch;
    expect(await getText("https://acme.example/feed", "Acme", { fetch: f })).toBe("<jobs/>");
    expect(await getText("https://acme.example/missing", "Acme", { fetch: f })).toBeNull();
    expect(seen[0]).toMatchObject({ "user-agent": USER_AGENT, accept: "application/xml, text/xml, */*" });
  });
});
