#!/usr/bin/env node
// Generates public/garbage.ics and public/index.html from data/schedule.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schedule = JSON.parse(readFileSync(join(root, "data", "schedule.json"), "utf8"));

const CAL_NAME = `Atliekų išvežimas — ${schedule.location.street}, ${schedule.location.town}`;
const OPERATORS = [...new Set(Object.values(schedule.streams).map(s => s.operator))];
for (const [key, stream] of Object.entries(schedule.streams)) {
  if (!stream.operator) throw new Error(`stream ${key} has no operator`);
}
const WEEKDAYS_LT = {
  Pirmadienis: 1, Antradienis: 2, Trečiadienis: 3, Ketvirtadienis: 4,
  Penktadienis: 5, Šeštadienis: 6, Sekmadienis: 0,
};

function assertValidDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`Bad date: ${iso}`);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Invalid calendar date: ${iso}`);
  }
  return d;
}

// Sanity check: mixed-waste dates must fall on the weekday the operator declares.
for (const [key, stream] of Object.entries(schedule.streams)) {
  for (const iso of stream.dates) {
    const d = assertValidDate(iso);
    if (stream.weekday && WEEKDAYS_LT[stream.weekday] !== undefined && d.getUTCDay() !== WEEKDAYS_LT[stream.weekday]) {
      throw new Error(`${key} date ${iso} is not a ${stream.weekday}`);
    }
  }
}

function icsDate(iso) {
  return iso.replaceAll("-", "");
}

function nextDay(iso) {
  const d = assertValidDate(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function foldLine(line) {
  // RFC 5545: lines longer than 75 octets should be folded.
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  while (start < bytes.length) {
    let len = Math.min(start === 0 ? 75 : 74, bytes.length - start);
    // don't split a UTF-8 sequence
    while (len > 1 && (bytes[start + len] & 0xc0) === 0x80) len--;
    parts.push((start === 0 ? "" : " ") + bytes.subarray(start, start + len).toString("utf8"));
    start += len;
  }
  return parts.join("\r\n");
}

function escapeText(s) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

const dtstamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const lines = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//garbage-calendar//Didzioji Riese Samanu g//LT",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  `X-WR-CALNAME:${escapeText(CAL_NAME)}`,
  "X-WR-TIMEZONE:Europe/Vilnius",
  `X-WR-CALDESC:${escapeText(`Atliekų išvežimo grafikas. Vežėjai: ${OPERATORS.join(", ")}. Konteinerį išstumti iki 7:00 ryto.`)}`,
  "REFRESH-INTERVAL;VALUE=DURATION:P1D",
  "X-PUBLISHED-TTL:P1D",
];

const allEvents = [];
for (const [key, stream] of Object.entries(schedule.streams)) {
  for (const iso of stream.dates) {
    allEvents.push({ key, stream, iso });
  }
}
allEvents.sort((a, b) => a.iso.localeCompare(b.iso));

for (const { key, stream, iso } of allEvents) {
  lines.push(
    "BEGIN:VEVENT",
    `UID:${key}-${iso}@garbage-calendar.didzioji-riese.samanu`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${icsDate(iso)}`,
    `DTEND;VALUE=DATE:${icsDate(nextDay(iso))}`,
    `SUMMARY:${escapeText(`${stream.emoji} ${stream.label}`)}`,
    `DESCRIPTION:${escapeText(`Konteinerį išstumti iki 7:00 ryto.\nVežėjas: ${stream.operator}\nŠaltinis: ${stream.source}`)}`,
    `LOCATION:${escapeText(`${schedule.location.street}, ${schedule.location.town}, ${schedule.location.municipality}`)}`,
    "TRANSP:TRANSPARENT",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(`Rytoj išveža: ${stream.label}. Išstumkite konteinerį.`)}`,
    "TRIGGER:-PT5H",
    "END:VALARM",
    "END:VEVENT",
  );
}
lines.push("END:VCALENDAR");

const ics = lines.map(foldLine).join("\r\n") + "\r\n";
mkdirSync(join(root, "public"), { recursive: true });
writeFileSync(join(root, "public", "garbage.ics"), ics);

// ---------- index.html ----------
const MONTHS_LT = ["sausio", "vasario", "kovo", "balandžio", "gegužės", "birželio",
  "liepos", "rugpjūčio", "rugsėjo", "spalio", "lapkričio", "gruodžio"];
const WEEKDAY_LT = ["sekmadienis", "pirmadienis", "antradienis", "trečiadienis", "ketvirtadienis", "penktadienis", "šeštadienis"];

function humanDate(iso) {
  const d = assertValidDate(iso);
  return `${d.getUTCFullYear()} m. ${MONTHS_LT[d.getUTCMonth()]} ${d.getUTCDate()} d. (${WEEKDAY_LT[d.getUTCDay()]})`;
}

const todayIso = new Date().toISOString().slice(0, 10);
const upcoming = allEvents.filter(e => e.iso >= todayIso);
const rows = (upcoming.length ? upcoming : allEvents)
  .map(({ stream, iso }) => `<tr><td>${humanDate(iso)}</td><td>${stream.emoji} ${stream.label}</td></tr>`)
  .join("\n        ");

const html = `<!doctype html>
<html lang="lt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atliekų išvežimas — ${schedule.location.street}, ${schedule.location.town}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.55; }
  h1 { font-size: 1.5rem; }
  code, .url { background: rgba(127,127,127,.15); padding: .15em .4em; border-radius: 4px; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  td, th { border-bottom: 1px solid rgba(127,127,127,.35); padding: .4rem .6rem; text-align: left; }
  .btn { display: inline-block; margin: .25rem .5rem .25rem 0; padding: .5rem .9rem; border-radius: 8px;
         background: #2563eb; color: #fff; text-decoration: none; font-weight: 600; }
  footer { margin-top: 2rem; font-size: .85rem; opacity: .7; }
</style>
</head>
<body>
<h1>🗑️ Atliekų išvežimo kalendorius<br>${schedule.location.street}, ${schedule.location.town} (${schedule.location.municipality})</h1>
<p>Prenumeruojamas iCal kalendorius su buitinių, pakuočių, stiklo ir žaliųjų atliekų išvežimo dienomis.
Vežėjai — ${OPERATORS.join(" ir ")}. Konteinerį reikia išstumti iki <strong>7:00 ryto</strong>.</p>

<p>
  <a class="btn" id="webcal" href="#">📅 Prenumeruoti (Apple/Outlook)</a>
  <a class="btn" id="gcal" href="#" target="_blank" rel="noopener">📅 Google Calendar</a>
  <a class="btn" href="garbage.ics">⬇️ Atsisiųsti .ics</a>
</p>
<p>Prenumeratos adresas: <span class="url" id="icsurl">…</span></p>

<h2>Artimiausi išvežimai</h2>
<table>
  <thead><tr><th>Data</th><th>Atliekos</th></tr></thead>
  <tbody>
        ${rows}
  </tbody>
</table>

<footer>
  Duomenų šaltiniai: <a href="https://www.nemenkom.lt/buitiniu-ir-pakuociu-atlieku-surinkimo-grafikas/">UAB Nemenčinės komunalininkas</a>
  (buitinės, pakuočių, stiklo atliekos),
  <a href="https://ecoservice.lt/zaliuju-atlieku-isvezimo-grafikas/">UAB Ecoservice</a> (žaliosios atliekos)
  ir <a href="https://vrsa.lt/atlieku-tvarkymas/atlieku-surinkimo-grafikai/404">Vilniaus rajono savivaldybė</a>.
  Neoficialus puslapis; atnaujinta ${todayIso}.
</footer>

<script>
  const icsAbs = new URL("garbage.ics", location.href).href;
  document.getElementById("icsurl").textContent = icsAbs;
  document.getElementById("webcal").href = icsAbs.replace(/^https?:/, "webcal:");
  document.getElementById("gcal").href = "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(icsAbs.replace(/^https?:/, "webcal:"));
</script>
</body>
</html>
`;
writeFileSync(join(root, "public", "index.html"), html);

console.log(`Wrote public/garbage.ics (${allEvents.length} events) and public/index.html`);
