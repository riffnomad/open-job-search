/**
 * Plain text out of a CV file, locally, with no AI.
 *
 * - .txt .md .tex: read as is
 * - .pdf: Poppler's `pdftotext -layout` when it's installed (keeps
 *   two-column CVs in reading order), otherwise unpdf (bundled)
 * - .docx: mammoth
 *
 * Scanned PDFs have no text layer; we say so instead of guessing (no OCR).
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { which } from "../detect.ts";

export class ExtractError extends Error {
  override name = "ExtractError";
}

export type ExtractMethod = "text" | "pdftotext" | "unpdf" | "mammoth";

export interface ExtractResult {
  text: string;
  method: ExtractMethod;
  pages?: number;
  warnings: string[];
}

export interface ExtractOptions {
  /** Use pdftotext when it's on PATH. Default true. */
  pdftotext?: boolean;
  env?: Record<string, string | undefined>;
}

const MAX_BYTES = 20 * 1024 * 1024;
/** Fewer non-space characters than this per page means there's no real text layer. */
const MIN_CHARS_PER_PAGE = 40;

const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".tex", ".text"]);
const CONVERT_FIRST: Record<string, string> = {
  ".doc": "an old Word file: save it as .docx or PDF first",
  ".odt": "an OpenDocument file: export it as .docx or PDF first",
  ".pages": "a Pages file: export it as .docx or PDF first",
  ".rtf": "an RTF file: save it as .docx or PDF first",
};
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tif", ".tiff", ".bmp"]);

export async function extractText(path: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXT.has(ext)) {
    throw new ExtractError(`${path} is an image. Text recognition isn't supported, so paste the text instead (\`ojs profile import --paste\`) or use a PDF with selectable text.`);
  }
  if (CONVERT_FIRST[ext]) throw new ExtractError(`${path} is ${CONVERT_FIRST[ext]}.`);

  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new ExtractError(`can't read ${path}: file not found`);
  }
  if (size > MAX_BYTES) throw new ExtractError(`${path} is ${Math.round(size / 1024 / 1024)} MB; CVs over 20 MB aren't supported.`);

  if (TEXT_EXT.has(ext)) return { text: tidy(await readFile(path, "utf8")), method: "text", warnings: [] };
  if (ext === ".pdf") return extractPdf(path, opts);
  if (ext === ".docx") return extractDocx(path);
  throw new ExtractError(`don't know how to read ${ext || "files without an extension"}. Supported: PDF, DOCX, Markdown, plain text.`);
}

async function extractPdf(path: string, opts: ExtractOptions): Promise<ExtractResult> {
  const warnings: string[] = [];
  const pdftotext = opts.pdftotext !== false ? which("pdftotext", opts.env) : undefined;
  let text: string;
  let pages: number;
  let method: ExtractMethod;

  if (pdftotext) {
    try {
      const raw = await run(pdftotext, ["-layout", "-enc", "UTF-8", path, "-"]);
      pages = raw.split("\f").filter((p, i, all) => i < all.length - 1 || p.trim()).length || 1;
      text = raw;
      method = "pdftotext";
    } catch (err) {
      warnings.push(`pdftotext failed (${(err as Error).message.split("\n")[0]}); used the built-in reader instead.`);
      ({ text, pages } = await unpdfText(path));
      method = "unpdf";
    }
  } else {
    ({ text, pages } = await unpdfText(path));
    method = "unpdf";
  }

  const chars = text.replace(/\s/g, "").length;
  if (chars < MIN_CHARS_PER_PAGE * Math.max(1, pages)) {
    throw new ExtractError(
      `${path} has almost no selectable text (${chars} characters over ${pages} page${pages === 1 ? "" : "s"}). It's probably scanned. ` +
        "Text recognition isn't supported, so paste the text instead (`ojs profile import --paste`) or export a PDF with selectable text.",
    );
  }
  return { text: tidy(text), method, pages, warnings };
}

async function unpdfText(path: string): Promise<{ text: string; pages: number }> {
  const { extractText: unpdfExtract, getDocumentProxy } = await import("unpdf");
  try {
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)), { verbosity: 0 });
    const { totalPages, text } = await unpdfExtract(pdf, { mergePages: false });
    return { text: text.join("\n\f"), pages: totalPages };
  } catch (err) {
    throw new ExtractError(`couldn't read ${path} as a PDF: ${(err as Error).message}`);
  }
}

async function extractDocx(path: string): Promise<ExtractResult> {
  const mammoth = (await import("mammoth")).default;
  let result: { value: string; messages: { type: string; message: string }[] };
  try {
    result = await mammoth.extractRawText({ path });
  } catch (err) {
    throw new ExtractError(`couldn't read ${path} as a Word file: ${(err as Error).message}`);
  }
  const text = tidy(result.value);
  if (!text) throw new ExtractError(`${path} has no text in it.`);
  const warnings = result.messages.filter((m) => m.type === "warning").map((m) => m.message);
  return { text, method: "mammoth", warnings };
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

/** Normalise line endings and whitespace without changing the words. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
