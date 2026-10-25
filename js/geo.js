// Location → districts, using the Census Bureau's free TIGERweb map service.
// Everything runs in the browser; the only thing sent anywhere is the place
// name / ZIP / coordinates the person chooses to look up, sent to census.gov.

const BASE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/";
const PLACES = "Places_CouSub_ConCity_SubMCD";
const LAYER = {
  incorporated: [PLACES, 4],
  cdp: [PLACES, 5],
  cousub: [PLACES, 1],
  zcta: ["PUMA_TAD_TAZ_UGA_ZCTA", 1],
  county: ["State_County", 1],
  cd: ["Legislative", 0],        // 120th Congress districts (elected Nov 2026)
  sldu: ["Legislative", 1],      // 2026 state senate
  sldl: ["Legislative", 2],      // 2026 state house
};

export const STATES = {
  "01": ["AL", "Alabama"], "02": ["AK", "Alaska"], "04": ["AZ", "Arizona"], "05": ["AR", "Arkansas"], "06": ["CA", "California"],
  "08": ["CO", "Colorado"], "09": ["CT", "Connecticut"], "10": ["DE", "Delaware"], "11": ["DC", "District of Columbia"], "12": ["FL", "Florida"],
  "13": ["GA", "Georgia"], "15": ["HI", "Hawaii"], "16": ["ID", "Idaho"], "17": ["IL", "Illinois"], "18": ["IN", "Indiana"],
  "19": ["IA", "Iowa"], "20": ["KS", "Kansas"], "21": ["KY", "Kentucky"], "22": ["LA", "Louisiana"], "23": ["ME", "Maine"],
  "24": ["MD", "Maryland"], "25": ["MA", "Massachusetts"], "26": ["MI", "Michigan"], "27": ["MN", "Minnesota"], "28": ["MS", "Mississippi"],
  "29": ["MO", "Missouri"], "30": ["MT", "Montana"], "31": ["NE", "Nebraska"], "32": ["NV", "Nevada"], "33": ["NH", "New Hampshire"],
  "34": ["NJ", "New Jersey"], "35": ["NM", "New Mexico"], "36": ["NY", "New York"], "37": ["NC", "North Carolina"], "38": ["ND", "North Dakota"],
  "39": ["OH", "Ohio"], "40": ["OK", "Oklahoma"], "41": ["OR", "Oregon"], "42": ["PA", "Pennsylvania"], "44": ["RI", "Rhode Island"],
  "45": ["SC", "South Carolina"], "46": ["SD", "South Dakota"], "47": ["TN", "Tennessee"], "48": ["TX", "Texas"], "49": ["UT", "Utah"],
  "50": ["VT", "Vermont"], "51": ["VA", "Virginia"], "53": ["WA", "Washington"], "54": ["WV", "West Virginia"], "55": ["WI", "Wisconsin"],
  "56": ["WY", "Wyoming"],
};
const ABBR_TO_FIPS = Object.fromEntries(Object.entries(STATES).map(([f, [a]]) => [a, f]));

async function query([svc, layer], params, { post = false } = {}) {
  const url = `${BASE}${svc}/MapServer/${layer}/query`;
  const body = new URLSearchParams({ f: "json", ...params });
  const res = post
    ? await fetch(url, { method: "POST", body })
    : await fetch(`${url}?${body}`);
  if (!res.ok) throw new Error(`Census map service returned ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "Census map service error");
  return json.features || [];
}

const esc = (s) => s.replace(/'/g, "''");

/** Search cities, townships, villages and ZIP codes. "Battle Creek", "Emmett MI", "49017". */
export async function searchPlaces(text) {
  const raw = text.trim();
  if (/^\d{5}$/.test(raw)) {
    const f = await query(LAYER.zcta, { where: `ZCTA5='${raw}'`, outFields: "GEOID,NAME,INTPTLAT,INTPTLON", returnGeometry: "false" });
    return f.map(({ attributes: a }) => ({ kind: "zcta", id: a.GEOID, layer: "zcta", label: `ZIP ${a.GEOID}`, sub: "ZIP code area", state: null, lat: +a.INTPTLAT, lon: +a.INTPTLON }));
  }
  // Optional trailing state: "Lansing, MI" / "Lansing Michigan"
  let name = raw, stateFips = null;
  const m = raw.match(/^(.*?)[,\s]+([A-Za-z]{2}|[A-Za-z ]{4,})$/);
  if (m) {
    const s = m[2].trim();
    const byAbbr = ABBR_TO_FIPS[s.toUpperCase()];
    const byName = Object.entries(STATES).find(([, [, n]]) => n.toLowerCase() === s.toLowerCase());
    if (byAbbr || byName) { name = m[1].trim(); stateFips = byAbbr || byName[0]; }
  }
  if (name.length < 2) return [];
  const where = `UPPER(BASENAME) LIKE '${esc(name.toUpperCase())}%'` + (stateFips ? ` AND STATE='${stateFips}'` : "");
  // Places layers have no COUNTY field; county subdivisions do.
  const base = { where, returnGeometry: "false", resultRecordCount: "12", orderByFields: "BASENAME" };
  const placeFields = "GEOID,NAME,BASENAME,STATE,INTPTLAT,INTPTLON";
  const [inc, cdp, cs] = await Promise.all([
    query(LAYER.incorporated, { ...base, outFields: placeFields }).catch(() => []),
    query(LAYER.cdp, { ...base, outFields: placeFields }).catch(() => []),
    query(LAYER.cousub, { ...base, outFields: placeFields + ",COUNTY" }).catch(() => []),
  ]);
  const out = [];
  const seen = new Map();
  const push = (layer, kindLabel) => ({ attributes: a }) => {
    const key = `${a.STATE}|${a.NAME.toLowerCase()}`;
    // Michigan cities show up both as places and county subdivisions; keep one, borrow its county.
    if (seen.has(key)) { const prev = seen.get(key); if (!prev.county && a.COUNTY) prev.county = a.COUNTY; return; }
    const item = {
      kind: layer, layer, id: a.GEOID, state: a.STATE, county: a.COUNTY || null,
      label: a.NAME, sub: STATES[a.STATE]?.[1] || "", kindLabel,
      lat: +a.INTPTLAT, lon: +a.INTPTLON,
    };
    seen.set(key, item); out.push(item);
  };
  inc.forEach(push("incorporated", "city or village"));
  cs.forEach(push("cousub", "township"));
  cdp.forEach(push("cdp", "community"));
  // Exact name matches first, then alphabetical.
  const lower = name.toLowerCase();
  out.sort((x, y) => (startsExact(y, lower) - startsExact(x, lower)) || x.label.localeCompare(y.label));
  await addCountyNames(out);
  return out.slice(0, 12);
}
const startsExact = (p, lower) => (p.label.toLowerCase().replace(/ (city|village|township|charter township|cdp)$/i, "") === lower ? 1 : 0);

const countyCache = new Map();
async function addCountyNames(list) {
  const need = [...new Set(list.filter((p) => p.county && p.state).map((p) => `${p.state}${p.county}`))].filter((k) => !countyCache.has(k));
  if (need.length) {
    const where = need.map((k) => `GEOID='${k}'`).join(" OR ");
    const f = await query(LAYER.county, { where, outFields: "GEOID,NAME", returnGeometry: "false" }).catch(() => []);
    f.forEach(({ attributes: a }) => countyCache.set(a.GEOID, a.NAME));
  }
  list.forEach((p) => {
    const c = p.county && countyCache.get(`${p.state}${p.county}`);
    if (c) p.sub = `${c}, ${p.sub}`;
  });
}

// ---- geometry helpers (no library: ray casting on generalized rings) ----
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Esri polygons: rings with even-odd semantics (holes are just more rings).
const inPolygon = (x, y, rings) => rings.reduce((acc, r) => (inRing(x, y, r) ? !acc : acc), false);
function bbox(rings) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const r of rings) for (const [x, y] of r) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
}

/**
 * For a chosen place, return which districts it falls in and roughly what
 * share of the place's area is in each (by sampling a grid of points).
 */
export async function districtsForPlace(place) {
  const [shape] = await query(LAYER[place.layer], {
    where: `GEOID='${place.id}'`, outFields: "GEOID", returnGeometry: "true", outSR: "4326", maxAllowableOffset: "0.0005",
  });
  if (!shape) throw new Error("Couldn't load that place's boundary from the Census map service.");
  const rings = shape.geometry.rings;
  const geometry = JSON.stringify({ rings, spatialReference: { wkid: 4326 } });
  const spatial = { geometry, geometryType: "esriGeometryPolygon", inSR: "4326", spatialRel: "esriSpatialRelIntersects", outSR: "4326", maxAllowableOffset: "0.001" };
  const fields = "GEOID,STATE,BASENAME,NAME";
  const [cds, upper, lower] = await Promise.all([
    query(LAYER.cd, { ...spatial, outFields: fields, returnGeometry: "true" }, { post: true }),
    query(LAYER.sldu, { ...spatial, outFields: fields, returnGeometry: "true" }, { post: true }).catch(() => []),
    query(LAYER.sldl, { ...spatial, outFields: fields, returnGeometry: "true" }, { post: true }).catch(() => []),
  ]);
  if (!cds.length) throw new Error("No congressional district found for that place.");
  const share = (feats) => {
    if (feats.length === 1) return [{ ...attrs(feats[0]), share: 1 }];
    const [x0, y0, x1, y1] = bbox(rings);
    const N = 36, counts = new Map(), total = { n: 0 };
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x = x0 + ((i + 0.5) / N) * (x1 - x0), y = y0 + ((j + 0.5) / N) * (y1 - y0);
      if (!inPolygon(x, y, rings)) continue;
      total.n++;
      const hit = feats.find((f) => inPolygon(x, y, f.geometry.rings));
      if (hit) counts.set(hit.attributes.GEOID, (counts.get(hit.attributes.GEOID) || 0) + 1);
    }
    return feats
      .map((f) => ({ ...attrs(f), share: total.n ? (counts.get(f.attributes.GEOID) || 0) / total.n : 0 }))
      .filter((d) => d.share >= 0.02)
      .sort((a, b) => b.share - a.share);
  };
  const state = cds[0].attributes.STATE;
  return { state, congressional: share(cds), stateSenate: share(upper), stateHouse: share(lower) };
}

/** Exact districts for a single point (from "Use my location"). */
export async function districtsForPoint(lat, lon) {
  const spatial = { geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects", outFields: "GEOID,STATE,BASENAME,NAME", returnGeometry: "false" };
  const [cds, upper, lower] = await Promise.all([
    query(LAYER.cd, spatial), query(LAYER.sldu, spatial).catch(() => []), query(LAYER.sldl, spatial).catch(() => []),
  ]);
  if (!cds.length) throw new Error("That location isn't inside a U.S. congressional district.");
  const one = (f) => f.map((x) => ({ ...attrs(x), share: 1 }));
  return { state: cds[0].attributes.STATE, congressional: one(cds), stateSenate: one(upper), stateHouse: one(lower) };
}

function attrs(f) {
  const a = f.attributes;
  const num = a.BASENAME === "00" || /at large/i.test(a.NAME) ? 0 : parseInt(a.BASENAME, 10);
  return { geoid: a.GEOID, state: a.STATE, number: Number.isNaN(num) ? a.BASENAME : num, name: a.NAME };
}
