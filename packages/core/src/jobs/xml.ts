/**
 * A small XML reader for job feeds (RSS, Personio, Recruitee). Feeds are
 * simple: elements, attributes, text and CDATA. That's all this handles; no
 * DTDs, no namespaces beyond keeping "tt:location" as the element's name.
 * Plain TypeScript, so core stays portable and needs no dependency.
 */
import { decodeEntities } from "./html.ts";

export interface XmlNode {
  /** As written, prefix included: "position", "tt:location". */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** The element's own text and CDATA, decoded; not its children's. */
  text: string;
}

export class XmlError extends Error {
  override name = "XmlError";
}

const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)|(<)/gi;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

/** The document's root element. Throws XmlError when the XML isn't well formed. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  for (const m of xml.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!;
    const [, cdata, closing, name, attrText, selfClosing, text, stray] = m;
    if (stray) throw new XmlError("a stray < in the text");
    if (cdata !== undefined) top.text += cdata;
    else if (text !== undefined) top.text += decodeEntities(text);
    else if (!name) continue; // comment, <?xml ?> or DOCTYPE
    else if (closing) {
      if (stack.length < 2 || top.name !== name) throw new XmlError(`</${name}> doesn't close <${top.name || "nothing"}>`);
      stack.pop();
    } else {
      const attrs: Record<string, string> = {};
      for (const a of (attrText ?? "").matchAll(ATTR)) attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? "");
      const node: XmlNode = { name, attrs, children: [], text: "" };
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  if (stack.length > 1) throw new XmlError(`<${stack[stack.length - 1]!.name}> is never closed`);
  const el = root.children[0];
  if (!el || root.children.length > 1) throw new XmlError("there should be exactly one root element");
  return el;
}

/** Direct children with this name. */
export const xmlChildren = (node: XmlNode | undefined, name: string): XmlNode[] => node?.children.filter((c) => c.name === name) ?? [];

/** The first direct child with this name. */
export const xmlChild = (node: XmlNode | undefined, name: string): XmlNode | undefined => node?.children.find((c) => c.name === name);

/** The trimmed text of the first direct child with this name; undefined when it's missing or empty. */
export function xmlText(node: XmlNode | undefined, name: string): string | undefined {
  const t = xmlChild(node, name)?.text.trim();
  return t ? t : undefined;
}
