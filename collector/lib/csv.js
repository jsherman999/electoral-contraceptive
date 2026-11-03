// Delimited-text parsing (CSV/TSV) with quoted fields.

export function sniffDelimiter(headerLine) {
  const counts = { '\t': 0, ',': 0, '|': 0, ';': 0 };
  for (const ch of headerLine) if (ch in counts) counts[ch] += 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/** Split one line. Handles "quoted, fields" and doubled quotes. */
export function splitLine(line, delim) {
  if (!line.includes('"')) return line.split(delim);
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parse a whole text into objects keyed by header. Quoted newlines are not supported (rare in results files). */
export function parseDelimited(text, { delimiter } = {}) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return { header: [], rows: [] };
  const delim = delimiter || sniffDelimiter(lines[0]);
  const header = splitLine(lines[0], delim).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = splitLine(lines[i], delim);
    const o = {};
    for (let j = 0; j < header.length; j++) o[header[j]] = f[j] !== undefined ? f[j].trim() : '';
    rows.push(o);
  }
  return { header, rows, delimiter: delim };
}

/** Async line iterator over a readable stream. */
export async function* lines(stream) {
  let rest = '';
  for await (const chunk of stream) {
    const s = rest + chunk.toString('utf8');
    const parts = s.split(/\r?\n/);
    rest = parts.pop();
    for (const p of parts) yield p;
  }
  if (rest) yield rest;
}

export const toNum = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
};
