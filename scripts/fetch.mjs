#!/usr/bin/env node
// Fetches the latest schedules from the two operators serving our address and
// merges them into data/schedule.json:
//
//   * nemenkom.lt  — household (mixed) waste XLSX + packaging and glass PDFs
//                    (one table row per street group, one column per month).
//   * ecoservice.lt — green waste PDF, one row per address/container.
//
// Exit codes:
//   0 — success, schedule.json is up to date
//   2 — success parsing what we could, BUT some source files could not be
//       handled automatically (unknown file type, or our row was not found)
//       and need manual review
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
// The XLSX writes the town in nominative ("Didžioji Riešė"), the PDFs in
// genitive ("Didžiosios Riešės mstl."), so accept both.
const GROUP_RE = /Did[žz]io(?:ji|sios)\s+Rie[šs][ėe]s?[\s\S]*Saman[ųu]\s+g\./i;

// Replace dates in the years the new data covers, keep dates from other years.
function mergeDates(existing, fresh) {
  const years = new Set(fresh.map(d => d.slice(0, 4)));
  const kept = existing.filter(d => !years.has(d.slice(0, 4)));
  return [...new Set([...kept, ...fresh])].sort();
}

// Replace dates in the given "YYYY-MM" months (the period a quarterly PDF
// covers), keep dates from other months. A covered month with no fresh date
// legitimately ends up empty (e.g. glass is collected only every 3rd month).
function mergeMonths(existing, fresh, months) {
  const kept = existing.filter(d => !months.has(d.slice(0, 7)));
  return [...new Set([...kept, ...fresh])].sort();
}

// ---------------------------------------------------------------------------
// nemenkom.lt — mixed waste (XLSX) + packaging and glass (PDF)
// ---------------------------------------------------------------------------
async function fetchNemenkom() {
  const PAGE = "https://www.nemenkom.lt/buitiniu-ir-pakuociu-atlieku-surinkimo-grafikas/";
  const ORIGIN = "https://www.nemenkom.lt";

  const res = await fetch(PAGE, { headers: UA });
  if (!res.ok) throw new Error(`Failed to fetch ${PAGE}: HTTP ${res.status}`);
  const html = await res.text();

  const fileLinks = [...new Set([...html.matchAll(/href="([^"]+\.(?:xlsx|xls|pdf))"/gi)].map(m => m[1]))];
  if (fileLinks.length === 0) {
    throw new Error("No XLSX/PDF links found on the nemenkom.lt schedule page — page layout may have changed.");
  }

  const needsReview = [];
  let parsedMixed = false;
  const parsedPdf = { packaging: false, glass: false };

  for (const link of fileLinks) {
    const url = link.startsWith("http") ? link : ORIGIN + link;
    const name = decodeURIComponent(link);
    if (/\.xlsx?$/i.test(name)) {
      parsedMixed = (await fetchMixedXlsx(url, name)) || parsedMixed;
      continue;
    }
    // PDF: packaging ("Pakuočių ...") or glass ("Stiklo pakuočių ...").
    const kind = /stikl/i.test(name) ? "glass" : /pakuo/i.test(name) ? "packaging" : null;
    if (!kind) {
      console.error(`Unknown file type, needs manual review: ${url}`);
      needsReview.push(url);
      continue;
    }
    if (await fetchStreamPdf(url, name, kind)) parsedPdf[kind] = true;
    else needsReview.push(url);
  }

  if (!parsedMixed) {
    throw new Error("Could not parse mixed-waste dates from any XLSX — check GROUP_RE / file format.");
  }
  for (const kind of ["packaging", "glass"]) {
    if (!parsedPdf[kind]) console.error(`No ${kind} PDF parsed this run — keeping committed dates.`);
  }
  return needsReview;
}

// Household (mixed) waste XLSX: one sheet per period, one row per street
// group, one column per month with cells like "10 d., 24 d.".
async function fetchMixedXlsx(url, name) {
  console.log(`Downloading ${url}`);
  const fileRes = await fetch(url, { headers: UA });
  if (!fileRes.ok) {
    console.error(`  HTTP ${fileRes.status}, skipping`);
    return false;
  }
  const buf = Buffer.from(await fileRes.arrayBuffer());
  const wb = XLSX.read(buf, { type: "buffer" });

  const yearMatch = (name + " " + wb.SheetNames.join(" ")).match(/20\d\d/);
  if (!yearMatch) {
    console.error("  Could not determine year, skipping");
    return false;
  }
  const year = Number(yearMatch[0]);

  let parsedAny = false;
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
  if (!parsedAny) console.error("  Our street group row not found in this XLSX");
  return parsedAny;
}

// Packaging / glass PDF. Returns true when our row was found and merged.
async function fetchStreamPdf(url, name, kind) {
  console.log(`Downloading ${url}`);
  const fileRes = await fetch(url, { headers: UA });
  if (!fileRes.ok) {
    console.error(`  HTTP ${fileRes.status}, skipping`);
    return false;
  }
  const data = new Uint8Array(await fileRes.arrayBuffer());
  const yearFromName = name.match(/20\d\d/)?.[0];
  const parsed = await parseNemenkomPdf(data, yearFromName && Number(yearFromName));
  if (!parsed) {
    console.error(`  Our street group row not found in this ${kind} PDF`);
    return false;
  }
  const stream = schedule.streams[kind];
  const before = stream.dates.length;
  stream.dates = mergeMonths(stream.dates, parsed.dates, parsed.months);
  stream.source = url;
  console.log(`  Parsed ${parsed.dates.length} ${kind} dates for ${[...parsed.months].join(", ")} (${stream.dates.length - before} net new)`);
  return true;
}

// The packaging/glass PDFs are tables: the left column is a multi-line list
// of street groups (one table row spans several text lines and rows are
// separated by a visibly larger vertical gap), then an "Atliekos" column
// holding "Pakuotė"/"Stiklas", then one column per month with cells like
// "3 d." aligned to the row's vertical centre. We cluster the description
// lines into rows by vertical gap, find the row mentioning our street, and
// read the day numbers to the right of its "Pakuotė"/"Stiklas" cell, mapping
// each to the nearest month header column.
async function parseNemenkomPdf(data, fallbackYear) {
  const doc = await getDocument({ data, useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
  let year = fallbackYear;
  let monthCols = []; // [{ x, month }] from the most recent header row
  let atliekosX = null;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { items } = await page.getTextContent();
      const cells = items
        .filter(i => i.str.trim())
        .map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], h: i.height || 10 }));

      year = Number(cells.find(c => /^20\d\d\s*m\.?$/.test(c.s))?.s.match(/20\d\d/)[0]) || year;
      const headerMonths = cells.filter(c => MONTHS_LT[c.s.toLowerCase()]);
      if (headerMonths.length > 0) {
        // Several header rows per page repeat the same columns; keep one x per month.
        const byMonth = new Map();
        for (const c of headerMonths) byMonth.set(MONTHS_LT[c.s.toLowerCase()], c.x);
        monthCols = [...byMonth].map(([month, x]) => ({ month, x }));
        atliekosX = cells.find(c => /^Atliekos$/i.test(c.s))?.x ?? atliekosX;
      }
      if (monthCols.length === 0 || atliekosX == null) continue;

      const typeCells = cells.filter(c => /^(Pakuot|Stikl)/i.test(c.s));
      const descCells = cells
        .filter(c => c.x < atliekosX - 5 && !/Seniūnijos pavadinimas/i.test(c.s))
        .sort((a, b) => b.y - a.y || a.x - b.x);

      // Cluster description lines into table rows by vertical gap.
      const rows = [];
      for (const c of descCells) {
        const cur = rows[rows.length - 1];
        if (cur && cur.minY - c.y < cur.h * 2) {
          cur.cells.push(c);
          cur.minY = Math.min(cur.minY, c.y);
        } else {
          rows.push({ cells: [c], minY: c.y, maxY: c.y, h: c.h });
        }
      }

      for (const row of rows) {
        if (!GROUP_RE.test(row.cells.map(c => c.s).join(" "))) continue;
        const type = typeCells.find(t => t.y >= row.minY - row.h && t.y <= row.maxY + row.h);
        if (!type) {
          console.error("  Our row found but no Pakuotė/Stiklas cell aligned with it");
          continue;
        }
        const dates = [];
        for (const c of cells) {
          if (Math.abs(c.y - type.y) > c.h || c.x <= type.x) continue;
          const col = monthCols.reduce((best, m) => Math.abs(m.x - c.x) < Math.abs(best.x - c.x) ? m : best);
          for (const m of c.s.matchAll(/\b(\d{1,2})\s*d\b/g)) {
            const day = Number(m[1]);
            if (day >= 1 && day <= 31) dates.push(`${year}-${String(col.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
          }
        }
        if (!year) throw new Error("Could not determine the year of the PDF");
        const months = new Set(monthCols.map(m => `${year}-${String(m.month).padStart(2, "0")}`));
        return { dates: [...new Set(dates)].sort(), months };
      }
    }
  } finally {
    await doc.destroy();
  }
  return null;
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
let needsReview = [];

try {
  needsReview = await fetchNemenkom();
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
if (needsReview.length > 0) {
  console.error("SOURCE FILES NEED MANUAL REVIEW — could not parse automatically; update data/schedule.json by hand:");
  for (const f of needsReview) console.error("  " + f);
  process.exit(2);
}
