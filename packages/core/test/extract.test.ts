import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "../src/detect.ts";
import { extractText, ExtractError, tidy } from "../src/profile/extract.ts";
import { makePdf } from "./helpers/make-pdf.ts";

const dir = await mkdtemp(join(tmpdir(), "ojs-extract-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const fixtures = join(import.meta.dir, "fixtures");

const cvPages = [
  ["Sam Example", "Synthetic CV for tests. Not a real person.", "Experience", "Acme Logistics - Software Engineer (2019 - 2023)", "Rebuilt route planning for 30 depots."],
  ["Earlier", "Northwind Cafe - Shift Manager (2014 - 2017)", "Ran a team of 6 baristas and cut waste by 20%."],
];
const cvPdf = join(dir, "cv.pdf");
const scannedPdf = join(dir, "scanned.pdf");
await writeFile(cvPdf, makePdf(cvPages));
await writeFile(scannedPdf, makePdf([[], []]));

describe("extractText", () => {
  test("plain text and markdown, tidied", async () => {
    const p = join(dir, "cv.md");
    await writeFile(p, "# Sam\r\n\r\n\r\n\r\nEngineer   \r\n");
    expect(await extractText(p)).toEqual({ text: "# Sam\n\nEngineer", method: "text", warnings: [] });
  });

  test("PDF with the built-in reader", async () => {
    const r = await extractText(cvPdf, { pdftotext: false });
    expect(r.method).toBe("unpdf");
    expect(r.pages).toBe(2);
    for (const line of [...cvPages[0]!, ...cvPages[1]!]) expect(r.text).toContain(line);
    expect(r.text.indexOf("Acme Logistics")).toBeLessThan(r.text.indexOf("Northwind"));
  });

  test.skipIf(!which("pdftotext"))("PDF with pdftotext when installed", async () => {
    const r = await extractText(cvPdf);
    expect(r.method).toBe("pdftotext");
    expect(r.pages).toBe(2);
    expect(r.text).toContain("Rebuilt route planning for 30 depots.");
    expect(r.text).toContain("Ran a team of 6 baristas");
  });

  test("falls back to the built-in reader when pdftotext isn't on PATH", async () => {
    const r = await extractText(cvPdf, { env: { PATH: "/nonexistent" } });
    expect(r.method).toBe("unpdf");
  });

  test("scanned PDFs (no text layer) are refused with a way forward", async () => {
    for (const pdftotext of [false, true]) {
      const err = await extractText(scannedPdf, { pdftotext }).catch((e) => e);
      expect(err).toBeInstanceOf(ExtractError);
      expect(err.message).toMatch(/probably scanned/);
      expect(err.message).toMatch(/--paste/);
    }
  });

  test("Word .docx", async () => {
    const r = await extractText(join(fixtures, "cv-sam.docx"));
    expect(r.method).toBe("mammoth");
    expect(r.text).toContain("Northwind Café, Shift Manager, 2014 – 2017");
    expect(r.text).toContain("Ran a team of 6 baristas and cut waste by 20%.");
  });

  test("unsupported and broken files say what to do", async () => {
    const cases: [string, string | Uint8Array, RegExp][] = [
      ["photo.jpg", "x", /image.*paste the text/],
      ["old.doc", "x", /save it as \.docx or PDF/],
      ["cv.pages", "x", /export it as \.docx or PDF/],
      ["data.xyz", "x", /don't know how to read \.xyz/],
      ["broken.pdf", "not a pdf", /couldn't read .* as a PDF|probably scanned|pdftotext failed/],
      ["broken.docx", "not a zip", /couldn't read .* as a Word file/],
    ];
    for (const [name, content, msg] of cases) {
      const p = join(dir, name);
      await writeFile(p, content);
      const err = await extractText(p, { pdftotext: false }).catch((e) => e);
      expect(err).toBeInstanceOf(ExtractError);
      expect(err.message).toMatch(msg);
    }
    await expect(extractText(join(dir, "missing.pdf"))).rejects.toThrow(/file not found/);
  });

  test("tidy keeps words, fixes whitespace", () => {
    expect(tidy("a b  \n\n\n\nc\fd\r\n")).toBe("a b\n\nc\n\nd");
  });
});
