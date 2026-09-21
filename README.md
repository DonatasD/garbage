# 🗑️ Garbage calendar — Samanų g., Didžioji Riešė

Subscribable iCal feed with waste collection dates for **Samanų g., Didžioji Riešė**
(Riešės sen., Vilniaus r.). Served by GitHub Pages, updated by GitHub Actions.

**Subscribe:** `https://garbage.donugne.com/garbage.ics`
(landing page with one-click buttons: `https://garbage.donugne.com/`)

## Waste streams

| Stream | Cadence | Source |
| --- | --- | --- |
| 🗑️ Buitinės (mišrios) atliekos | every 2nd Wednesday | XLSX, parsed automatically |
| ♻️ Pakuočių atliekos | ~monthly | PDF, parsed automatically |
| 🍾 Stiklo pakuočių atliekos | ~quarterly | PDF, parsed automatically |
| 🌿 Žaliosios atliekos | every 2nd Wednesday, Apr–Nov | PDF, parsed automatically |

Operators: [UAB Nemenčinės komunalininkas](https://www.nemenkom.lt/buitiniu-ir-pakuociu-atlieku-surinkimo-grafikas/)
(mixed, packaging, glass) · [UAB Ecoservice](https://ecoservice.lt/zaliuju-atlieku-isvezimo-grafikas/) (green waste) ·
Municipality: [vrsa.lt](https://vrsa.lt/atlieku-tvarkymas/atlieku-surinkimo-grafikai/404)

## How it works

- `data/schedule.json` — source of truth for all pickup dates.
- `scripts/fetch.mjs` — downloads Nemenčinės komunalininkas' household-waste XLSX and the
  quarterly packaging/glass PDFs, finds the street group containing `Samanų g.` in
  `Didžioji Riešė`, and merges the dates in (PDF dates replace the months the PDF covers).
  If a source cannot be fetched at all, or a file cannot be handled automatically (unknown
  file type, or our row is not found), the workflow opens a GitHub issue with the fetch log
  (and comments on it while the problem persists) so the JSON can be updated by hand.
  It also downloads Ecoservice's green-waste PDF (one row per address) and reads
  the dates for `Samanų g.` in `Didžiosios Riešės k.`; all of Didžioji Riešė shares
  the same green-waste dates, so any row from the town is used as a fallback.
- `scripts/build.mjs` — validates the data (dates must be real, mixed-waste dates
  must fall on the declared weekday) and generates `public/garbage.ics` + `public/index.html`.
- `.github/workflows/build.yml` — runs on push and every Monday, commits schedule
  updates, and deploys `public/` to GitHub Pages.

## Local development

```bash
npm install
npm run fetch   # optional: pull latest data from nemenkom.lt and ecoservice.lt
npm run build   # writes public/garbage.ics + public/index.html
```

## Adapting to another street

Edit `data/schedule.json` (location + dates) and, in `scripts/fetch.mjs`, the
`GROUP_RE` regex (your street's row in the Nemenčinės komunalininkas XLSX and PDFs) and the
`ECO_TOWN_RE` / `ECO_STREET_RE` regexes (your row in the Ecoservice PDF).
