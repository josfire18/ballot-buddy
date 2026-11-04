// Shared helpers for turning official candidate-list PDFs into rows of text.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function fetchPdf(url) {
  const res = await fetch(url, { headers: { "User-Agent": "BallotBuddy-importer (+https://github.com/josfire18/ballot-buddy)" } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (String.fromCharCode(...buf.slice(0, 4)) !== "%PDF") throw new Error(`${url} is not a PDF`);
  return buf;
}

/**
 * Every text item on every page, in the page's reading frame.
 * Rotated pages (the Secretary of State list is landscape printed sideways) come
 * back with `down` = distance from the top of the reading frame and `across`
 * = distance from the left, so callers never deal with the rotation.
 */
export async function pdfItems(data) {
  const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    const out = [];
    for (const it of items) {
      const s = it.str.replace(/\s+/g, " ").trim();
      if (!s) continue;
      const [a, b, , , e, f] = it.transform;
      const rotated = Math.abs(a) < 0.01 && Math.abs(b) > 0.01;
      out.push(rotated
        ? { page: p, down: Math.round(e), across: Math.round(f), size: Math.abs(b), s }
        : { page: p, down: -Math.round(f), across: Math.round(e), size: Math.abs(a), s });
    }
    pages.push(out);
  }
  return pages;
}

/** Group a page's items into rows (same `down`), each row sorted left to right. */
export function rows(items) {
  const map = new Map();
  for (const it of items) (map.get(it.down) || map.set(it.down, []).get(it.down)).push(it);
  return [...map.entries()].sort((x, y) => x[0] - y[0]).map(([, r]) => r.sort((a, b) => a.across - b.across));
}

export const PARTY = {
  DEM: { code: "D", label: "Democratic" },
  REP: { code: "R", label: "Republican" },
  LIB: { code: "L", label: "Libertarian" },
  GRN: { code: "G", label: "Green" },
  UST: { code: "O", label: "U.S. Taxpayers" },
  NLP: { code: "O", label: "Natural Law" },
  WCP: { code: "O", label: "Working Class" },
  NPA: { code: "I", label: "No party affiliation" },
  NP: { code: "N", label: "Nonpartisan" },
};

/** "Ludtke Jr., John Perry" → "John Perry Ludtke Jr." ; "Gilchrist II, Garlin" → "Garlin Gilchrist II" */
export function lastFirst(s) {
  const m = s.match(/^([^,]+),\s*(.+)$/);
  return (m ? `${m[2]} ${m[1]}` : s).replace(/\s+/g, " ").trim();
}

export const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

/** Title-case an ALL-CAPS label from a county list, keeping small words low. */
export function titleCase(s) {
  const small = new Set(["of", "the", "and", "for", "at", "in"]);
  return s.toLowerCase().replace(/\b([a-z])([a-z']*)/g, (w, a, b, i) => (i > 0 && small.has(w) ? w : a.toUpperCase() + b))
    .replace(/\bMc([a-z])/g, (m, c) => "Mc" + c.toUpperCase());
}
