# 🗑️ Garbage calendar — Samanų g., Didžioji Riešė

Subscribable iCal feed with waste collection dates for **Samanų g., Didžioji Riešė**
(Riešės sen., Vilniaus r.). Served by GitHub Pages, updated by GitHub Actions.

**Subscribe:** `https://donatasd.com/garbage/garbage.ics`
(landing page with one-click buttons: `https://donatasd.com/garbage/`)

## Waste streams

| Stream | Cadence | Source |
| --- | --- | --- |
| 🗑️ Buitinės (mišrios) atliekos | every 2nd Wednesday | XLSX, parsed automatically |
| ♻️ Pakuočių atliekos | ~monthly | PDF, entered manually |
| 🍾 Stiklo pakuočių atliekos | ~quarterly | PDF, entered manually |

Operator: [UAB Nemenčinės komunalininkas](https://www.nemenkom.lt/buitiniu-ir-pakuociu-atlieku-surinkimo-grafikas/) ·
Municipality: [vrsa.lt](https://vrsa.lt/atlieku-tvarkymas/atlieku-surinkimo-grafikai/404)

## How it works

- `data/schedule.json` — source of truth for all pickup dates.
- `scripts/fetch.mjs` — downloads the operator's household-waste XLSX, finds the
  street group containing `Samanų g.` in `Didžioji Riešė`, and merges new dates in.
  If new packaging/glass PDFs are published, the workflow opens a GitHub issue
  (those tables are too irregular to parse reliably — update the JSON by hand).
- `scripts/build.mjs` — validates the data (dates must be real, mixed-waste dates
  must fall on the declared weekday) and generates `public/garbage.ics` + `public/index.html`.
- `.github/workflows/build.yml` — runs on push and every Monday, commits schedule
  updates, and deploys `public/` to GitHub Pages.

## Local development

```bash
npm install
npm run fetch   # optional: pull latest data from nemenkom.lt
npm run build   # writes public/garbage.ics + public/index.html
```

## Adapting to another street

Edit `data/schedule.json` (location + dates) and the `GROUP_RE` regex in
`scripts/fetch.mjs` to match your street's row in the operator's XLSX.
