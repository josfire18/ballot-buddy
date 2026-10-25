# Ballot Buddy

A free, static voter guide. Pick your city, township or ZIP and it finds every race on your 2026 ballot, ranks candidates by how closely they match your views, and lets you build a printable ballot.

## How it works, with no backend and no API keys

| What | Where it comes from | When |
|---|---|---|
| Your districts | U.S. Census Bureau TIGERweb map service (120th Congress districts and 2026 state legislative districts) | Live, in the browser |
| Candidates, endorsements, race ratings | Wikipedia's public API (2026 House, Senate, governor, SoS and AG election pages) | Live, cached 12 hours per browser |
| Stances | `data/curated/{STATE}.json` (hand-checked, sourced), then endorsements via `data/endorsers.json`, then party as a weak fallback | Bundled |

Every stance on a card is marked as **from the record**, **inferred from endorsements**, or **assumed from party**, and the match score weights them 1 / 0.5 / 0.3.

Your answers and picks never leave your browser (localStorage). Share links put the picks inside the URL itself.

## Adding a state

Copy `data/curated/MI.json` to `data/curated/XX.json` and fill in `candidates` with `blurb`, `stances` (`issue: [-2..2, "one-line summary"]`) and `sources`. Names must match Wikipedia's spelling; "Jr.", "II" and middle initials are ignored. Without a curated file the state still works from endorsements and party.

## Run locally

Any static server works, e.g. `npx serve .` or `python -m http.server`. Opening `index.html` as a file won't work because the browser blocks module loading from `file://`.

## Deploy

GitHub Pages: Settings → Pages → Deploy from branch → `main` / root.
