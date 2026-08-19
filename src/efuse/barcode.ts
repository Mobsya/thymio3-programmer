import { partsToId } from "./protocol";

/**
 * Production label barcode: `T3-LLnnnnn` or `THYMIO3-LLnnnnn`.
 *
 * `LL` is the two character lot, letters only, `nnnnn` the robot number, 0 to
 * 65535, with or without leading zeros. Prototypes are the one exception: their
 * lot is `@` followed by a single letter, as in `T3-@A00007`.
 *
 * The prefix is matched case insensitively, but the lot is kept exactly as
 * scanned: it ends up in the eFuse word as two raw ASCII bytes, so `AB` and
 * `ab` are two different IDs. Digits are refused in the lot on purpose, since
 * a fully numeric label could not be split into lot and number unambiguously.
 */
const LABEL_PATTERN = /^(?:T3|THYMIO3)-(@[A-Za-z]|[A-Za-z]{2})([0-9]{1,5})$/i;

/** Prototype units carry this marker as the first lot character. */
export const PROTOTYPE_MARKER = "@";

export const MAX_ROBOT_NUMBER = 65535;

export interface ParsedLabel {
  /** The barcode as scanned, trimmed. */
  raw: string;
  lot: string;
  num: number;
  /** The 32 bit eFuse word the label maps to. */
  id: number;
  /** True for a prototype lot (`@` plus one letter). */
  prototype: boolean;
}

export type LabelError = "empty" | "format" | "range";

export interface LabelParseResult {
  label: ParsedLabel | null;
  error: LabelError | null;
}

export function parseThymio3Label(input: string): LabelParseResult {
  const raw = input.trim();
  if (raw.length === 0) return { label: null, error: "empty" };

  const match = LABEL_PATTERN.exec(raw);
  if (!match) return { label: null, error: "format" };

  const lot = match[1] ?? "";
  const num = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(num) || num < 0 || num > MAX_ROBOT_NUMBER) {
    return { label: null, error: "range" };
  }

  return {
    label: {
      raw,
      lot,
      num,
      id: partsToId(lot, num),
      prototype: lot.startsWith(PROTOTYPE_MARKER),
    },
    error: null,
  };
}

export function describeLabelError(error: LabelError): string {
  switch (error) {
    case "empty":
      return "empty barcode";
    case "range":
      return `robot number out of range (0 to ${MAX_ROBOT_NUMBER})`;
    case "format":
    default:
      return "expected T3-LLnnnnn or THYMIO3-LLnnnnn, lot in letters (@L for prototypes)";
  }
}
