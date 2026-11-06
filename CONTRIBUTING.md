# Contributing to Ballot Buddy

Thanks for helping voters get accurate information. There are three ways to help, from easiest to most involved.

## 1. Report a problem (no coding)

[Open a correction](../../issues/new?template=correction.yml): a wrong or missing candidate, a race that shows up in the wrong place, an outdated bio. Include a link to where the correct information comes from.

## 2. Add or fix candidate research

Research lives in `data/research/<STATE>/people.jsonl`, one candidate per line. Edit it right on GitHub (the pencil icon) and open a pull request.

```json
{"id":"mi/jim-haadsma","name":"Jim Haadsma","blurb":"Battle Creek labor attorney...","stances":{"climate":{"value":1,"summary":"88% lifetime score from the League of Conservation Voters.","sources":[{"title":"...","url":"https://..."}]}},"endorsedBy":["Michigan Education Association"],"sources":[{"title":"...","url":"https://..."}]}
```

Rules:
- **Every fact needs a source** you can link to. Prefer the candidate's own words (campaign site, questionnaire answers, votes) over commentary about them.
- **`name` must match the official candidate list** (see `official/*/candidacies.jsonl`). "Jr.", "II" and middle initials are ignored when matching.
- **`id`** is the state code plus the name in lowercase with hyphens: `mi/jim-haadsma`.
- **Stances** use the issues in `data/issues.json`. `value` is how much the candidate agrees with that issue's statement, from -2 (strongly disagrees) to 2 (strongly agrees). Only add a stance you can source. A missing stance is better than a guessed one.
- **Neutral wording.** Describe what candidates have said and done; leave out adjectives, predictions and opinions. Apply the same standard to every candidate in a race.
- Keep the file sorted by `id` and one record per line.

Race context goes in `contest-notes.jsonl` (`{"contest": "<contest id>", "note": "..."}`); statewide proposals in `proposals.jsonl`. The full field reference is in `schema/`.

## 3. Add coverage (code)

**A Michigan county:** add the county clerk's *Official Candidate List* PDF to `data/elections/MI/<date>/election.json` under `counties` with `"format": "mi-county"`. Most Michigan counties publish the same report, so the existing importer usually just works. Run the importer and build (below) and check the result.

**A new state:** add `data/elections/<ST>/<date>/election.json`, then write an importer in `tools/import/` that turns the state's official candidate list into contests and candidates (see `mi-sos.mjs` for the shape) and register it in `FORMATS` in `tools/import/run.mjs`. Each contest needs a `scope` saying who votes in it; `js/ballot.js` matches scopes against the Census lookup.

Importer output in `official/` is never edited by hand. If it's wrong, fix the importer.

## Running it

```sh
npm ci
npm run import        # downloads official lists (only rewrites a source when its file changed)
npm run build         # validates everything, writes data/ballots/ and dist/ballot.sqlite
npm run check         # validate only
npx serve .           # run the site locally
```

Pull requests are validated automatically. A pull request that breaks a schema, points at a race that doesn't exist, or makes an official list parse to almost nothing will fail its check.

## License

By contributing you agree that code is licensed under MIT and data under CC BY 4.0 (see `LICENSE` and `data/LICENSE.md`).
