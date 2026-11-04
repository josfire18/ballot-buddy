// Michigan Secretary of State "Official Candidate Listing" (offices certified by the
// Board of State Canvassers). One PDF covers every federal, statewide, legislative,
// state board, appellate and circuit court race in all 83 counties.
import { pdfItems, rows, PARTY, lastFirst, ordinal } from "./lib/pdf.mjs";

const WIKI = { "mi-governor": "governor", "mi-sos": "sos", "mi-ag": "ag", "us-senate": "us-senate" };

/** Turn the raw office header into a contest skeleton (id, office, scope...). */
export function classify(raw) {
  const header = raw.replace(/\s+Files In [A-Z .]+ County/i, "").replace(/\s*\(\d+\)\s*Position/i, "").replace(/\s+Position\s*$/i, "").trim();
  const voteFor = +(header.match(/\((\d+)\)s?\s*$/) || [, 1])[1];
  const clean = header.replace(/\s*\(\d+\)s?\s*$/, "");
  const term = (clean.match(/((?:\d+ Year Terms?)|(?:Partial Term[^)]*))$/i) || [, ""])[1].replace(/Terms$/, "Term");
  const title = clean.slice(0, clean.length - term.length).trim();
  const n = +(title.match(/^(\d+)(?:st|nd|rd|th)\b/) || [, 0])[1];
  const incumbentPos = /\bIncumbent\b/.test(title) && !/Non-Incumbent/.test(title) ? "Incumbent position" : /Non-Incumbent/.test(title) ? "Non-incumbent position" : null;
  const base = { voteFor, term, partisan: true };
  const partial = /^Partial/i.test(term) ? "-partial" : "";
  let c;
  if (/^Governor \/ Lt/i.test(title)) c = { id: "mi-governor", office: "Governor and Lieutenant Governor", level: "state", scope: { state: true }, ticket: true };
  else if (/^Secretary of State/i.test(title)) c = { id: "mi-sos", office: "Secretary of State", level: "state", scope: { state: true } };
  else if (/^Attorney General/i.test(title)) c = { id: "mi-ag", office: "Attorney General", level: "state", scope: { state: true } };
  else if (/^U\.?S\.? Senate/i.test(title)) c = { id: "us-senate", office: "U.S. Senate", level: "federal", scope: { state: true } };
  else if (/Representative in Congress/i.test(title)) c = { id: `us-house-${n}`, office: `U.S. House, ${ordinal(n)} District`, level: "federal", scope: { cd: n }, wiki: "us-house" };
  else if (/State Senator/i.test(title)) c = { id: `mi-senate-${n}`, office: `State Senate, ${ordinal(n)} District`, level: "legislative", scope: { sldu: n } };
  else if (/Representative in State Legislature/i.test(title)) c = { id: `mi-house-${n}`, office: `State House, ${ordinal(n)} District`, level: "legislative", scope: { sldl: n } };
  else if (/State Board of Education/i.test(title)) c = { id: "mi-sbe", office: "State Board of Education", level: "board", scope: { state: true } };
  else if (/University of Michigan/i.test(title)) c = { id: "mi-um-regents", office: "University of Michigan Board of Regents", level: "board", scope: { state: true } };
  else if (/Michigan State University/i.test(title)) c = { id: "mi-msu-trustees", office: "Michigan State University Board of Trustees", level: "board", scope: { state: true } };
  else if (/Wayne State University/i.test(title)) c = { id: "mi-wsu-governors", office: "Wayne State University Board of Governors", level: "board", scope: { state: true } };
  else if (/Supreme Court/i.test(title)) c = { id: `mi-supreme-court${partial}`, office: "Michigan Supreme Court", level: "judicial", scope: { state: true }, partisan: false };
  else if (/Court of Appeals/i.test(title)) c = { id: `mi-coa-${n}${incumbentPos?.startsWith("Non") ? "-open" : ""}${partial}`, office: `Court of Appeals, ${ordinal(n)} District`, level: "judicial", scope: { coa: n }, partisan: false };
  else if (/Circuit Court/i.test(title)) c = { id: `mi-circuit-${n}${incumbentPos?.startsWith("Non") ? "-open" : ""}${partial}`, office: `Circuit Court, ${ordinal(n)} Circuit`, level: "judicial", scope: { circuit: n }, partisan: false };
  else if (/District Court/i.test(title)) c = { id: `mi-district-court-${n}${incumbentPos?.startsWith("Non") ? "-open" : ""}${partial}`, office: `District Court, ${ordinal(n)} District`, level: "judicial", scope: { districtCourt: n }, partisan: false };
  else if (/Probate/i.test(title)) c = { id: `mi-probate-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}${partial}`, office: title, level: "judicial", scope: { unmapped: true }, partisan: false };
  else c = { id: `mi-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}${partial}`, office: title, level: "other", scope: { unmapped: true } };
  if (incumbentPos) c.note = incumbentPos;
  if (partial) c.office += ` (${term.replace(/^Partial Term\s*-?\s*/i, "partial term, ").replace(/\s+/g, " ")})`;
  if (WIKI[c.id]) c.wiki = WIKI[c.id];
  return { ...base, ...c };
}

export async function importSos(pdf, { url }) {
  const pages = await pdfItems(pdf);
  const contests = [];
  let cur = null;
  for (const page of pages) {
    for (const row of rows(page)) {
      const hdr = row.find((i) => i.across < 40 && i.size > 10.5 && /Term|Position/.test(i.s));
      if (hdr) { cur = { raw: hdr.s, cands: [] }; contests.push(cur); continue; }
      const name = row.find((i) => i.across > 100 && i.across < 200);
      if (!cur || !name || name.s === "Candidate Name") continue;
      cur.cands.push({
        name: name.s,
        party: row.filter((i) => i.across >= 50 && i.across < 100).map((i) => i.s).join(" "),
        status: row.filter((i) => i.across < 50).map((i) => i.s).join(" "),
      });
    }
  }

  const out = [];
  const seen = new Map();
  for (const k of contests) {
    const c = classify(k.raw);
    const candidates = [];
    for (const r of k.cands) {
      const isMate = / \/ Lt\.? Governor$/i.test(r.name);
      const name = lastFirst(r.name.replace(/ \/ (Lt\.? )?Governor$/i, ""));
      if (isMate && candidates.length) { candidates[candidates.length - 1].runningMate = name; continue; }
      const p = PARTY[r.party] || null;
      const cand = { name };
      if (c.partisan) { cand.party = p?.code || "O"; cand.partyLabel = p?.label || r.party || "Other"; }
      if (/INCUM/i.test(r.party) || /INCUM/i.test(r.status)) cand.incumbent = true;
      if (/withdr/i.test(r.status)) cand.status = "withdrew";
      if (/disqual/i.test(r.status)) cand.status = "disqualified";
      candidates.push(cand);
    }
    // Same office split across a page break shows up twice; merge.
    if (seen.has(c.id)) { seen.get(c.id).candidates.push(...candidates); continue; }
    const contest = { ...c, candidates };
    seen.set(c.id, contest);
    out.push(contest);
  }
  return { source: { title: "Michigan Department of State, Official Candidate Listing (offices certified by the Board of State Canvassers)", url }, contests: out };
}
