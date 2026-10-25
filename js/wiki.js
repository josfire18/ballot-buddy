// Pulls 2026 general-election candidates and endorsements from Wikipedia's
// free public API (CORS-enabled with origin=*). Results are cached for 12 hours.

const API = "https://en.wikipedia.org/w/api.php";
const REST = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const TTL = 12 * 60 * 60 * 1000;
const YEAR = 2026;

function cacheGet(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    if (v && Date.now() - v.t < TTL) return v.d;
  } catch {}
  return undefined;
}
function cacheSet(key, d) {
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); } catch {}
}

export async function wikitext(title) {
  const key = `bb:wt:${title}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const url = `${API}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext|revid&format=json&formatversion=2&redirects=1&origin=*`;
  const res = await fetch(url);
  const json = await res.json();
  const out = json.error ? null : { text: json.parse.wikitext, title: json.parse.title, revid: json.parse.revid };
  cacheSet(key, out);
  return out;
}

export async function summary(title) {
  const key = `bb:sum:${title}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch(REST + encodeURIComponent(title.replace(/ /g, "_")));
    if (!res.ok) { cacheSet(key, null); return null; }
    const j = await res.json();
    const out = j.type === "disambiguation" ? null : { extract: j.extract, description: j.description, thumb: j.thumbnail?.source || null, url: j.content_urls?.desktop?.page };
    cacheSet(key, out);
    return out;
  } catch { return null; }
}

// ---------- wikitext parsing ----------

/** Split template parameters on top-level pipes, respecting [[...]] and {{...}}. */
function splitParams(body) {
  const parts = []; let depthSq = 0, depthCu = 0, cur = "";
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === "[[") { depthSq++; cur += two; i++; continue; }
    if (two === "]]") { depthSq--; cur += two; i++; continue; }
    if (two === "{{") { depthCu++; cur += two; i++; continue; }
    if (two === "}}") { depthCu--; cur += two; i++; continue; }
    if (body[i] === "|" && depthSq === 0 && depthCu === 0) { parts.push(cur); cur = ""; continue; }
    cur += body[i];
  }
  parts.push(cur);
  const named = {};
  parts.slice(1).forEach((p) => { const k = p.indexOf("="); if (k > 0) named[p.slice(0, k).trim().toLowerCase()] = p.slice(k + 1).trim(); });
  return { name: parts[0].trim(), named };
}

/** Find every {{Template ...}} whose name starts with `prefix`, returning raw bodies. */
function templates(text, prefix) {
  const out = []; const re = new RegExp(`\\{\\{\\s*${prefix}`, "gi"); let m;
  while ((m = re.exec(text))) {
    let depth = 0, i = m.index;
    for (; i < text.length; i++) {
      if (text.startsWith("{{", i)) { depth++; i++; }
      else if (text.startsWith("}}", i)) { depth--; i++; if (depth === 0) break; }
    }
    out.push({ start: m.index, body: text.slice(m.index + 2, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

const stripRefs = (s) => s.replace(/<ref[^>]*\/>/gi, "").replace(/<ref[\s\S]*?<\/ref>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
/** "[[Mike Rogers (Michigan politician)|Mike Rogers]] (incumbent)" → { name, link, incumbent } */
function parseName(raw) {
  let s = stripRefs(raw || "");
  const incumbent = /\(incumbent\)/i.test(s);
  const link = (s.match(/\[\[([^|\]]+)/) || [])[1] || null;
  s = s.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/'''?/g, "").replace(/\{\{[^}]*\}\}/g, "").replace(/\((incumbent|write-in)\)/gi, "").replace(/\s+/g, " ").trim();
  return { name: s, link: link && !/^(file|image):/i.test(link) ? link.trim() : null, incumbent };
}

export function partyCode(p) {
  const s = (p || "").toLowerCase();
  if (/democrat/.test(s)) return "D";
  if (/republican/.test(s)) return "R";
  if (/libertarian/.test(s)) return "L";
  if (/green/.test(s)) return "G";
  if (/independent|no party|nonpartisan/.test(s)) return "I";
  return "O";
}
export function partyName(p) {
  const s = stripRefs(p || "").replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/ \(United States\)/, "").replace(/^party=/, "").trim();
  return s || "Other";
}

/** Candidates in the first election box that follows `fromIndex` within text. */
function candidatesFromBox(text) {
  const boxes = templates(text, "Election box (?:candidate|winning candidate)");
  return boxes.map(({ body }) => {
    const { named } = splitParams(body);
    const n = parseName(named.candidate);
    if (!n.name || /write-in|other|total/i.test(n.name)) return null;
    return { ...n, party: partyCode(named.party), partyLabel: partyName(named.party) };
  }).filter(Boolean);
}

function generalBox(section) {
  // Prefer the box after a "General election" heading; else the last box (the general is usually last).
  const gi = section.search(/^=+\s*General election\s*=+\s*$/im);
  const scope = gi >= 0 ? section.slice(gi) : section;
  const begins = [...scope.matchAll(/\{\{\s*Election box begin/gi)].map((m) => m.index);
  if (!begins.length) return [];
  const startAt = gi >= 0 ? begins[0] : begins[begins.length - 1];
  const end = scope.indexOf("Election box end", startAt);
  const box = scope.slice(startAt, end > 0 ? end : undefined);
  return candidatesFromBox(box);
}

function infoboxNominees(text) {
  const [ib] = templates(text, "Infobox election");
  if (!ib) return [];
  const { named } = splitParams(ib.body);
  const out = [];
  for (let i = 1; i <= 8; i++) {
    if (!named[`nominee${i}`]) continue;
    const n = parseName(named[`nominee${i}`]);
    out.push({ ...n, party: partyCode(named[`party${i}`]), partyLabel: partyName(named[`party${i}`]), runningMate: named[`running_mate${i}`] ? parseName(named[`running_mate${i}`]).name : null });
  }
  return out;
}

/** Endorsements boxes → { "Tom Barrett": [{name, link}], ... } */
function endorsements(text) {
  const out = {};
  for (const { body } of templates(text, "Endorsements box")) {
    const { named } = splitParams(body);
    const who = parseName((named.title || "").replace(/\s*\([A-Z]\)\s*$/, "")).name;
    if (!who) continue;
    const list = stripRefs(named.list || "");
    const items = [];
    for (const line of list.split("\n")) {
      if (!/^\*/.test(line)) continue;
      const m = line.match(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/);
      const text = line.replace(/^\*+/, "").replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/\{\{[^}]*\}\}/g, "").replace(/''/g, "").split(",")[0].trim();
      items.push({ name: m ? (m[2] || m[1]).trim() : text, link: m ? m[1].trim() : null, text });
    }
    const key = normName(who);
    out[key] = (out[key] || []).concat(items);
  }
  return out;
}

function ratings(section) {
  const gi = section.search(/Predictions/i);
  if (gi < 0) return [];
  const chunk = section.slice(gi, gi + 4000);
  const rows = [...chunk.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\][^\n]*\n\s*\|\s*\{\{USRaceRating\|([^}]*)\}\}/g)];
  return rows.map((r) => ({ source: r[1], rating: r[2].split("|").filter((x) => x && !/^flip$/i.test(x)).join(" ").replace(/\bD\b/, "Dem").replace(/\bR\b/, "GOP") })).slice(0, 4);
}

export const normName = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "").replace(/[^a-z ]/g, " ").replace(/\b[a-z]\b/g, "").replace(/\s+/g, " ").trim();

function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

// ---------- public: race loaders ----------

export async function houseRace(stateName, district) {
  const page = (await wikitext(`${YEAR} United States House of Representatives elections in ${stateName}`))
    || (await wikitext(`${YEAR} United States House of Representatives election in ${stateName}`));
  if (!page) return null;
  let section = page.text;
  if (district > 0) {
    const re = new RegExp(`^==\\s*District ${district}\\s*==\\s*$`, "m");
    const s = page.text.search(re);
    if (s < 0) return null;
    const rest = page.text.slice(s + 5);
    const e = rest.search(/^==\s*[^=]/m);
    section = page.text.slice(s, e > 0 ? s + 5 + e : undefined);
  }
  const candidates = generalBox(section);
  return {
    id: `us-house-${district}`, office: district > 0 ? `U.S. House, ${ordinal(district)} District` : "U.S. House, at-large",
    level: "federal", candidates, endorsements: endorsements(section), ratings: ratings(section),
    source: { title: page.title + (district > 0 ? ` § District ${district}` : ""), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}${district > 0 ? `#District_${district}` : ""}` },
  };
}

export async function statewideRace(id, office, titles) {
  for (const t of titles) {
    const page = await wikitext(t);
    if (!page) continue;
    const gi = page.text.search(/^==\s*General election\s*==\s*$/im);
    const general = gi >= 0 ? page.text.slice(gi) : "";
    let candidates = general ? generalBox(general) : [];
    const ib = infoboxNominees(page.text);
    if (!candidates.length) candidates = ib;
    // Attach running mates from the infobox.
    candidates.forEach((c) => { const m = ib.find((x) => normName(x.name) === normName(c.name)); if (m?.runningMate) c.runningMate = m.runningMate; });
    if (!candidates.length) continue;
    return {
      id, office, level: id === "us-senate" ? "federal" : "state", candidates,
      endorsements: endorsements(page.text), ratings: ratings(general),
      source: { title: page.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}` },
    };
  }
  return null;
}

export function statewideRaceSpecs(stateName) {
  return [
    { id: "us-senate", office: "U.S. Senate", titles: [`${YEAR} United States Senate election in ${stateName}`] },
    { id: "us-senate-special", office: "U.S. Senate (special election)", titles: [`${YEAR} United States Senate special election in ${stateName}`] },
    { id: "governor", office: "Governor", titles: [`${YEAR} ${stateName} gubernatorial election`] },
    { id: "sos", office: "Secretary of State", titles: [`${YEAR} ${stateName} Secretary of State election`] },
    { id: "ag", office: "Attorney General", titles: [`${YEAR} ${stateName} Attorney General election`] },
  ];
}
