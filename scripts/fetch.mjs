#!/usr/bin/env node
// Fetches the latest household-waste XLSX from nemenkom.lt, re-parses the
// dates for our street group, and merges them into data/schedule.json.
//
// Exit codes:
//   0 — success, schedule.json is up to date
//   2 — success parsing what we could, BUT new source files (e.g. new
//       packaging/glass PDFs) appeared that need manual review
//   1 — hard failure (page/xlsx unreachable or our row not found)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as XLSX from "xlsx";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schedulePath = join(root, "data", "schedule.json");
const schedule = JSON.parse(readFileSync(schedulePath, "utf8"));

const PAGE = "https://www.nemenkom.lt/buitiniu-ir-pakuociu-atlieku-surinkimo-grafikas/";
const ORIGIN = "https://www.nemenkom.lt";

const MONTHS_LT = {
  sausis: 1, vasaris: 2, kovas: 3, balandis: 4, gegužė: 5, birželis: 6,
  liepa: 7, rugpjūtis: 8, rugsėjis: 9, spalis: 10, lapkritis: 11, gruodis: 12,
};

// Matches our address: Didžioji Riešė group that lists Samanų g.
const GROUP_RE = /Did[žz]ioji\s+Rie[šs][ėe][\s\S]*Saman[ųu]\s+g\./i;

const res = await fetch(PAGE, { headers: { "user-agent": "garbage-calendar-bot" } });
if (!res.ok) {
  console.error(`Failed to fetch ${PAGE}: HTTP ${res.status}`);
  process.exit(1);
}
const html = await res.text();

const fileLinks = [...html.matchAll(/href="([^"]+\.(?:xlsx|xls|pdf))"/gi)].map(m => m[1]);
const xlsxLinks = fileLinks.filter(l => /\.xlsx?$/i.test(l));
if (xlsxLinks.length === 0) {
  console.error("No XLSX links found on the schedule page — page layout may have changed.");
  process.exit(1);
}

let parsedAny = false;
for (const link of xlsxLinks) {
  const url = link.startsWith("http") ? link : ORIGIN + link;
  console.log(`Downloading ${url}`);
  const fileRes = await fetch(url, { headers: { "user-agent": "garbage-calendar-bot" } });
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

    const merged = new Set([...schedule.streams.mixed.dates, ...dates]);
    const before = schedule.streams.mixed.dates.length;
    schedule.streams.mixed.dates = [...merged].sort();
    schedule.streams.mixed.weekday = String(weekday).trim();
    schedule.streams.mixed.source = url;
    parsedAny = true;
    console.log(`  Parsed ${dates.length} mixed-waste dates (${schedule.streams.mixed.dates.length - before} new) from sheet "${sheetName}"`);
  }
}

if (!parsedAny) {
  console.error("Found XLSX file(s) but could not locate our street group row — check GROUP_RE / file format.");
  process.exit(1);
}

// Detect newly published source files (typically quarterly packaging/glass
// PDFs) that we cannot parse automatically and must be reviewed by hand.
const known = new Set(schedule.knownSourceFiles);
const newFiles = fileLinks.filter(l => !known.has(l));
schedule.knownSourceFiles = fileLinks;
writeFileSync(schedulePath, JSON.stringify(schedule, null, 2) + "\n");
console.log("data/schedule.json updated.");

if (newFiles.length > 0) {
  console.error("NEW SOURCE FILES detected — update packaging/glass dates in data/schedule.json manually:");
  for (const f of newFiles) console.error("  " + ORIGIN + f);
  process.exit(2);
}
