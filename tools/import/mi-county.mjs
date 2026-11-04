// Michigan county clerk "Official Candidate List" (the Qualified Voter File report
// most Michigan counties publish before each election). Gives every local race:
// county, city, township, village, school, library, community college, and the
// circuit/district courts on that county's ballot. Statewide/federal/legislative
// rows are skipped because the Secretary of State list (mi-sos.mjs) owns them.
import { pdfItems, rows, PARTY, slug, titleCase } from "./lib/pdf.mjs";

const STATE_LEVEL = /^(GOVERNOR AND|SECRETARY OF STATE|ATTORNEY GENERAL|UNITED STATES SENATOR|REPRESENTATIVE IN CONGRESS|ST SENATOR|STATE SENATOR|REPRESENTATIVE \(|REPRESENTATIVE IN STATE|MEMBER OF THE STATE BOARD|REGENT OF THE UNIVERSITY|TRUSTEE OF MICHIGAN STATE|GOVERNOR OF WAYNE STATE|JUSTICE SUPREME COURT|STATE PROPOSAL|^PROPOSAL$)/;

const OFFICE_FIX = [
  [/^LSD BRD MEMBER$|^SCH BRD$|^SCHOOL BOARD MEMBER$/, "BOARD MEMBER"],
  [/^VIL /, ""],
  [/^COMM COLLEGE TRUSTEE$/, "BOARD OF TRUSTEES MEMBER"],
  [/\bCT\b|\bCRT\b/g, "COURT"],
  [/\bCOMM\b/g, "COMMISSIONER"],
];

/** "COMMISSIONER (CITY OF BATTLE CREEK / 02)" → office, scope, where */
export function parseOffice(rawTitle, rawTerm, countyName) {
  let title = rawTitle.replace(/\s+/g, " ").trim();
  const posM = title.match(/\s*-\s*(NON-INCUMBENT|INCUMBENT) POSITION$/);
  title = title.replace(/\s*-\s*(NON-INCUMBENT|INCUMBENT) POSITION$/, "");
  const m = title.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  let office = (m ? m[1] : title).trim();
  const juris = m ? m[2].trim() : null;
  for (const [re, to] of OFFICE_FIX) office = office.replace(re, to).trim();

  let scope = { county: true }, where = `${countyName} County`, level = "county";
  let sub = null, court = null;
  if (juris) {
    const [j, part] = juris.split(/\s*\/\s*/);
    sub = part || null;
    let mm;
    if ((mm = j.match(/^CITY OF (.+)$/))) { scope = { city: titleCase(mm[1]) }; where = `City of ${titleCase(mm[1])}`; level = "city"; }
    else if ((mm = j.match(/^VILLAGE OF (.+)$/))) { scope = { village: titleCase(mm[1]) }; where = `Village of ${titleCase(mm[1])}`; level = "village"; }
    else if ((mm = j.match(/^(.+?) (CHARTER )?TOWNSHIP$/))) { scope = { township: titleCase(mm[1]) }; where = `${titleCase(mm[1])} Township`; level = "township"; }
    else if (/COMMUNITY COLLEGE/.test(j)) { scope = { college: titleCase(j) }; where = titleCase(j); level = "college"; }
    else if (/SCHOOL|SCHOOLS|ACADEMY/.test(j)) { scope = { school: titleCase(j) }; where = titleCase(j); level = "school"; }
    else if ((mm = j.match(/^(\d+)(?:ST|ND|RD|TH) (DISTRICT|CIRCUIT)$/))) {
      const n = +mm[1];
      // Courts on this county's ballot: scope to the county, remember which court.
      if (/APPEALS/.test(office)) { scope = { county: true }; court = { coa: n }; level = "judicial"; }
      else if (/CIRCUIT/.test(office)) { scope = { county: true }; court = { circuit: n }; level = "judicial"; }
      else if (/DISTRICT COURT/.test(office)) { scope = { county: true }; court = { districtCourt: n }; level = "judicial"; }
      else if (/COMMISSIONER/.test(office)) { scope = { county: true, commissionDistrict: n }; where = `${countyName} County`; }
      else { scope = { unmapped: true }; where = titleCase(j); }
    } else { scope = { unmapped: true }; where = titleCase(j); }
  }
  if (/PROBATE|JUDGE/.test(office) && scope.county) level = "judicial";
  if (sub) {
    const n = +sub.replace(/\D/g, "");
    if (scope.city || scope.village || scope.township) { scope.ward = n; }
  }
  const voteFor = +((rawTerm || "").match(/not more than (\d+)/i) || [, 1])[1];
  const term = (rawTerm || "").replace(/\s*-\s*Vote for not more than \d+/i, "").trim();
  let label = titleCase(office);
  if (court) label = court.coa ? `Court of Appeals, ${ord(court.coa)} District` : court.circuit ? `Circuit Court, ${ord(court.circuit)} Circuit` : `District Court, ${ord(court.districtCourt)} District`;
  if (scope.ward) label += `, ${/CITY OF ALBION/.test(juris || "") ? "Precinct" : "Ward"} ${scope.ward}`;
  if (scope.commissionDistrict) label += `, District ${scope.commissionDistrict}`;
  if (/^Partial/i.test(term)) label += ` (${term.replace(/^Partial Term/i, "partial term")})`;
  return { office: label, where, scope, level, voteFor, term, ...(court ? { court } : {}), position: posM ? (posM[1] === "INCUMBENT" ? "Incumbent position" : "Non-incumbent position") : null };
}
const ord = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

export async function importCounty(pdf, { url, fips, name }) {
  const pages = await pdfItems(pdf);
  const raw = [];
  let cur = null, inProposal = false;
  for (const page of pages) {
    for (const row of rows(page)) {
      if (row.some((i) => i.size >= 13)) continue;
      const first = row[0];
      const text = row.filter((i) => i.across < 700).map((i) => i.s).join(" ");
      if (first.across < 60 && first.size >= 9.5 && !/^Page \d|[AP]M$/.test(first.s)) {
        cur = { title: row.filter((i) => i.across < 400).map((i) => i.s).join(" "), term: "", cands: [], body: [] };
        inProposal = /PROPOSAL/.test(cur.title);
        raw.push(cur);
        continue;
      }
      if (!cur) continue;
      if (first.across < 60 && first.size < 9.5 && /Vote for|Term/i.test(text) && !cur.cands.length && !inProposal) { cur.term += (cur.term ? " " : "") + text; continue; }
      if (inProposal) { if (!/^(PARTY|CANDIDATE)\b/.test(text)) cur.body.push(text); continue; }
      const nm = row.find((i) => i.across >= 135 && i.across < 225);
      if (!nm || nm.s === "CANDIDATE") continue;
      const party = row.find((i) => i.across < 60)?.s || "";
      const wd = row.find((i) => i.across >= 60 && i.across < 135)?.s || "";
      const status = row.find((i) => i.across >= 680)?.s || "";
      if (!party && !wd && !status && cur.cands.length) { cur.cands[cur.cands.length - 1].name += " " + nm.s; continue; }
      cur.cands.push({ name: nm.s, party, mate: nm.across >= 146, wd, status });
    }
  }

  const contests = [], proposals = [];
  for (const k of raw) {
    if (/PROPOSAL/.test(k.title)) {
      if (/^PROPOSAL$|^STATE PROPOSAL/.test(k.title)) continue; // statewide proposals are curated separately
      const p = parseOffice(k.title.replace(/\s*PROPOSAL$/, ""), "", name);
      proposals.push({ id: `mi-${fips}-${slug(k.title)}`, title: titleCase(k.title), where: p.where, scope: p.scope, text: k.body.join(" ").replace(/\s+/g, " ").trim() });
      continue;
    }
    if (STATE_LEVEL.test(k.title)) continue;
    const p = parseOffice(k.title, k.term, name);
    const candidates = k.cands.filter((c) => !c.mate).map((c) => {
      const pr = PARTY[c.party];
      const out = { name: c.name.replace(/\s+/g, " ").trim() };
      if (pr && pr.code !== "N") { out.party = pr.code; out.partyLabel = pr.label; } else out.party = "N";
      if (/withdr/i.test(c.status) || c.wd) out.status = "withdrew";
      if (/disqual/i.test(c.status)) out.status = "disqualified";
      return out;
    });
    const partisan = candidates.some((c) => c.party && c.party !== "N");
    const id = `mi-${fips}-${slug(`${p.office} ${p.where || ""}`)}`;
    contests.push({ id, ...p, partisan, candidates, ...(p.position ? { note: p.position } : {}) });
  }
  return { source: { title: `${name} County Clerk, Official Candidate List`, url }, contests, proposals };
}
