// CSV writing for exports. Two protections:
//  1. RFC 4180 quoting, so commas, quotes and line breaks in ticket text cannot break the row structure.
//  2. Formula-injection defence: a text cell that a spreadsheet could execute (it starts with = + - @, or a tab/CR, optionally after
//     whitespace) is prefixed with an apostrophe, so Excel/Sheets show it as text instead of running it.

const FORMULA_START = /^[\s\u0000-\u001f]*[=+\-@]/u;
const NEEDS_QUOTES = /[",\r\n]/;

/** Neutralise a spreadsheet formula in user-controlled text. Non-strings (numbers, null) are never user text and are passed through. */
export function neutraliseFormula(value: string): string {
  return FORMULA_START.test(value) || value.startsWith("\t") || value.startsWith("\r") ? `'${value}` : value;
}

export function csvCell(value: string | number | boolean | Date | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === "string") s = neutraliseFormula(value);
  else s = String(value);
  return NEEDS_QUOTES.test(s) || s.startsWith(" ") || s.endsWith(" ") ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: Array<string | number | boolean | Date | null | undefined>): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

/** UTF-8 byte-order mark so Excel opens non-ASCII names correctly. */
export const CSV_BOM = "﻿";
