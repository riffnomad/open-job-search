import { z } from "zod";

/**
 * A date as precise as the source says: "2021-03" or just "2021".
 * We never invent a month a CV didn't give. YAML reads an unquoted 2021
 * as a number, so numbers are accepted too.
 */
export const PartialDate = z
  .union([z.number().int(), z.string()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/, "must be YYYY-MM or YYYY, e.g. 2021-03 or 2021"));

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Turn what CVs write ("Mar 2021", "03/2021", "2021", "Present") into a
 * PartialDate, "present", or undefined when it can't be read.
 */
export function normalizeDate(raw: string | number | null | undefined): string | "present" | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).trim().toLowerCase().replace(/[’']/g, "");
  if (!s) return undefined;
  if (/^(present|current|now|today|ongoing|to date|date)$/.test(s)) return "present";
  const pad = (m: number) => String(m).padStart(2, "0");
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/.exec(s))) {
    const month = Number(m[2]);
    return month >= 1 && month <= 12 ? `${m[1]}-${pad(month)}` : m[1];
  }
  if ((m = /^(\d{1,2})[-/.](\d{4})$/.exec(s))) {
    const month = Number(m[1]);
    return month >= 1 && month <= 12 ? `${m[2]}-${pad(month)}` : m[2];
  }
  if ((m = /^([a-z]{3,9})\.?,?\s+(\d{4})$/.exec(s))) {
    const i = MONTHS.indexOf(m[1]!.slice(0, 3));
    return i === -1 ? m[2] : `${m[2]}-${pad(i + 1)}`;
  }
  if ((m = /^(\d{4})$/.exec(s))) return m[1];
  return undefined;
}
