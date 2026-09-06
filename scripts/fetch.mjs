#!/usr/bin/env node
// Fetches the latest schedules from the two operators serving our address and
// merges them into data/schedule.json:
//
//   * nemenkom.lt  — household (mixed) waste XLSX; packaging/glass PDFs are
//                    too irregular to parse and are only detected as "new".
//   * ecoservice.lt — green waste PDF, one row per address/container.
//
// Exit codes:
//   0 — success, schedule.json is up to date
//   2 — success parsing what we could, BUT new source files (e.g. new
//       packaging/glass PDFs) appeared that need manual review
//   1 — hard failure in at least one source (page/file unreachable or our
//       row not found). schedule.json is still written with whatever the
//       other source produced.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as XLSX from "xlsx";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schedulePath = join(root, "data", "schedule.json");
const schedule = JSON.parse(readFileSync(schedulePath, "utf8"));

const UA = { "user-agent": "garbage-calendar-bot" };

const MONTHS_LT = {
  sausis: 1, vasaris: 2, kovas: 3, balandis: 4, gegužė: 5, birželis: 6,
  liepa: 7, rugpjūtis: 8, rugsėjis: 9, spalis: 10, lapkritis: 11, gruodis: 12,
};

// Matches our address: Didžioji Riešė group that lists Samanų g.
const GROUP_RE = /Did[žz]ioji\s+Rie[šs][ėe][\s\S]*Saman[ųu]\s+g\./i;

// Replace dates in the years the new data covers, keep dates from other years.
function mergeDates(existing, fresh) {
  const years = new Set(fresh.map(d => d.slice(0, 4)));
  const kept = existing.filter(d => !years.has(d.slice(0, 4)));
  return [...new Set([...kept, ...fresh])].sort();
}

// ---------------------------------------------------------------------------
// nemenkom.lt — mixed waste (XLSX) + detection of new packaging/glass PDFs
// ---------------------------------------------------------------------------
async function fetchNemenkom() {
  const PAGE = "https://www.nemenkom.lt/buitiniu-ir-pakuociu-atlieku-surinkimo-grafikas/";
  const ORIGIN = "https://www.nemenkom.lt";

  const res = await fetch(PAGE, { headers: UA });
  if (!res.ok) throw new Error(`Failed to fetch ${PAGE}: HTTP ${res.status}`);
  const html = await res.text();

  const fileLinks = [...html.matchAll(/href="([^"]+\.(?:xlsx|xls|pdf))"/gi)].map(m => m[1]);
  const xlsxLinks = fileLinks.filter(l => /\.xlsx?$/i.test(l));
  if (xlsxLinks.length === 0) {
    throw new Error("No XLSX links found on the nemenkom.lt schedule page — page layout may have changed.");
  }

  let parsedAny = false;
  for (const link of xlsxLinks) {
    const url = link.startsWith("http") ? link : ORIGIN + link;
    console.log(`Downloading ${url}`);
    const fileRes = await fetch(url, { headers: UA });
    if (!fileRes.ok) {
      console.error(`  HTTP ${fileRes.status}, skipping`);
      continue;
    }
    const buf = Buffer.from(await fileRes.arrayBuffer());
    const wb = XLSX.read(buf, { type: "buffer" });

    const yearMatch = (decodeURIComponent(link) + " " + wb.SheetNames.join(" ")).match(/20\d\d/);
    if (!yearMatch) {
      console.error("  Could not determine year, skipping");
      continue;
    }
    const year = Number(yearMatch[0]);

    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: "" });
      const header = rows.find(r => r.some(c => String(c).toLowerCase().includes("seniūnija")));
      if (!header) continue;
      const monthCols = new Map(); // column index -> month number
      header.forEach((cell, i) => {
        const m = MONTHS_LT[String(cell).trim().toLowerCase()];
        if (m) monthCols.set(i, m);
      });
      if (monthCols.size === 0) continue;

      const row = rows.find(r => GROUP_RE.test(r.join(" ")));
      if (!row) continue;

      const weekday = row.find(c => /dienis$|sekmadienis$/i.test(String(c).trim())) || schedule.streams.mixed.weekday;
      const dates = [];
      for (const [col, month] of monthCols) {
        for (const m of String(row[col]).matchAll(/(\d{1,2})\s*d/g)) {
          const day = Number(m[1]);
          dates.push(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
        }
      }
      if (dates.length === 0) continue;

      const before = schedule.streams.mixed.dates.length;
      // The XLSX covers only part of a year, so union rather than replace.
      schedule.streams.mixed.dates = [...new Set([...schedule.streams.mixed.dates, ...dates])].sort();
      schedule.streams.mixed.weekday = String(weekday).trim();
      schedule.streams.mixed.source = url;
      parsedAny = true;
      console.log(`  Parsed ${dates.length} mixed-waste dates (${schedule.streams.mixed.dates.length - before} new) from sheet "${sheetName}"`);
    }
  }

  if (!parsedAny) {
    throw new Error("Found XLSX file(s) but could not locate our street group row — check GROUP_RE / file format.");
  }

  // Detect newly published source files (typically quarterly packaging/glass
  // PDFs) that we cannot parse automatically and must be reviewed by hand.
  const known = new Set(schedule.knownSourceFiles);
  const newFiles = fileLinks.filter(l => !known.has(l));
  schedule.knownSourceFiles = fileLinks;
  return newFiles.map(f => ORIGIN + f);
}

// ---------------------------------------------------------------------------
// ecoservice.lt — green waste (PDF, one row per address)
// ---------------------------------------------------------------------------
const ECO_TOWN_RE = /Did[žz]iosios\s+Rie[šs][ėe]s/i;
const ECO_STREET_RE = /Saman[ųu]\s+g\./i;

async function fetchEcoservice() {
  const PAGE = "https://ecoservice.lt/zaliuju-atlieku-isvezimo-grafikas/";
  const res = await fetch(PAGE, { headers: UA });
  if (!res.ok) throw new Error(`Failed to fetch ${PAGE}: HTTP ${res.status}`);
  const html = await res.text();

  const pdfLinks = [...new Set([...html.matchAll(/href="([^"]+\.pdf)"/gi)].map(m => m[1]))]
    .filter(l => /zali/i.test(decodeURIComponent(l)));
  if (pdfLinks.length === 0) {
    throw new Error("No green-waste PDF link found on the ecoservice.lt page — page layout may have changed.");
  }

  let parsedAny = false;
  for (const link of pdfLinks) {
    const url = link.startsWith("http") ? link : new URL(link, PAGE).href;
    console.log(`Downloading ${url}`);
    const fileRes = await fetch(url, { headers: UA });
    if (!fileRes.ok) {
      console.error(`  HTTP ${fileRes.status}, skipping`);
      continue;
    }
    const data = new Uint8Array(await fileRes.arrayBuffer());
    const dates = await parseEcoservicePdf(data);
    if (!dates) {
      console.error("  Our address row not found in this PDF, skipping");
      continue;
    }
    const before = schedule.streams.green.dates.length;
    schedule.streams.green.dates = mergeDates(schedule.streams.green.dates, dates);
    schedule.streams.green.source = url;
    parsedAny = true;
    console.log(`  Parsed ${dates.length} green-waste dates (${schedule.streams.green.dates.length - before} new)`);
  }

  if (!parsedAny) {
    throw new Error("Found green-waste PDF(s) but could not locate our address row — check ECO_*_RE / file format.");
  }
}

// Every address in Didžioji Riešė shares the same green-waste dates, so we
// look for our street first and fall back to any row in our town.
async function parseEcoservicePdf(data) {
  const doc = await getDocument({ data, useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
  let fallback = null;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { items } = await page.getTextContent();
      const cells = items
        .filter(i => i.str.trim())
        .map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5] }));

      const towns = cells.filter(c => ECO_TOWN_RE.test(c.s));
      for (const town of towns) {
        const rowCells = cells.filter(c => Math.abs(c.y - town.y) < 12);
        // The rightmost column holds a comma-separated date list that may wrap
        // onto a second line mid-date ("...,2026-09-" / "09,2026-09-23,...").
        // Keep only cells that look like (partial) dates so the container
        // number "13-Z-003069" in the neighbouring column is not glued in.
        const DATE_FRAGMENT_RE = /^(\d{4}(-\d{2}(-\d{2})?)?|\d{2}(-\d{2})?|\d{1,2})(,|$)/;
        const dateText = rowCells
          .filter(c => c.x > town.x + 300 && DATE_FRAGMENT_RE.test(c.s))
          .sort((a, b) => b.y - a.y || a.x - b.x)
          .map(c => c.s)
          .join(""); // a date can be split across two lines: "2026-09-" + "09,..."
        const dates = [...new Set(dateText.match(/\d{4}-\d{2}-\d{2}/g) ?? [])].sort();
        if (dates.length === 0) continue;

        const onOurStreet = rowCells.some(c => ECO_STREET_RE.test(c.s));
        if (onOurStreet) return dates;
        fallback ??= dates;
      }
    }
  } finally {
    await doc.destroy();
  }
  if (fallback) console.error("  Samanų g. row not found; using dates of another Didžioji Riešė address");
  return fallback;
}

// ---------------------------------------------------------------------------
const failures = [];
let newFiles = [];

try {
  newFiles = await fetchNemenkom();
} catch (err) {
  console.error(`nemenkom.lt: ${err.message}`);
  failures.push("nemenkom.lt");
}

try {
  await fetchEcoservice();
} catch (err) {
  console.error(`ecoservice.lt: ${err.message}`);
  failures.push("ecoservice.lt");
}

writeFileSync(schedulePath, JSON.stringify(schedule, null, 2) + "\n");
console.log("data/schedule.json updated.");

if (failures.length > 0) {
  console.error(`Hard failure for: ${failures.join(", ")}`);
  process.exit(1);
}
if (newFiles.length > 0) {
  console.error("NEW SOURCE FILES detected — update packaging/glass dates in data/schedule.json manually:");
  for (const f of newFiles) console.error("  " + f);
  process.exit(2);
}
