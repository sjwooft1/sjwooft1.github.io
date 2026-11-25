/* ============================================================
   Brighton Oaks 5K — Official results document.

   Written by hand instead of pulling in a library: race day is offline,
   the phone is already busy, and the document is text plus one JPEG per
   athlete. The JPEGs are embedded untouched, so a bib stays exactly as
   sharp in the PDF as it was when it was recorded.

   The document is built for posting and printing, not just for sharing:

     1. A branded cover band with the event, date and venue.
     2. A summary strip (finishers, winning time, average, DNFs).
     3. The full results table — every athlete, place-ordered, with
        division and pace. Continues over as many pages as the field needs,
        repeating the column header, and lists non-finishers last.
     4. A finish-line photo appendix, twelve frames to a page.

   `entries` are plain objects:
     { place, bib, name, division, ageGroup, timeMs, dnf, pace, photo }
   `timeMs` is milliseconds on the official race clock, `division` is the
   one-letter code (M/F/X/U), `photo` is a JPEG data URL (or null when the
   athlete has no photo on this device).
   ============================================================ */

const PAGE = { w: 612, h: 792 }; // US Letter, points
const M = 54; // side margin
const CW = PAGE.w - M * 2;
const BOTTOM = 64; // lowest baseline the table may use

const ROW_H = 18;
const PAGE1_ROWS_TOP = 586; // first row's top edge, after the cover + summary
const ROWS_TOP = 720; // every other page, under the slim header

const PHOTO_W = 160;
const PHOTO_H = 90;
const PHOTO_COLS = 3;
const PHOTO_ROWS = 4;
const PHOTO_GAP_X = 12;
const PHOTO_GAP_Y = 8;
const PHOTO_TOP = 694;

/* Palette (hex, converted to PDF rgb). */
const INK = "2b1c0c";
const PAPER = "fdfaf4";
const BAND = "241a0f";
const CREAM = "f1e6cf";
const GREEN = "4f6b2b";
const ORANGE = "b85f1e";
const MUTED = "6b5a45";
const RULE = "d8cfbe";
const ZEBRA = "f7f3ea";

/* Helvetica advance widths, thousandths of an em, for ASCII 32–126.
   Having them here means columns align and long names are truncated with a
   real ellipsis instead of spilling into the next column. */
const REG_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

function charWidth(ch, font) {
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) {
    return (font === "F2" ? BOLD_WIDTHS : REG_WIDTHS)[code - 32];
  }
  if (code >= 0xc0) return code >= 0xe0 ? 556 : 667; // accented letters
  return 556;
}

function textWidth(str, font, size) {
  let total = 0;
  for (const ch of String(str)) total += charWidth(ch, font);
  return (total / 1000) * size;
}

/** Shorten to fit a column, with a real ellipsis. */
function fitText(str, font, size, maxWidth) {
  const text = String(str ?? "");
  if (textWidth(text, font, size) <= maxWidth) return text;
  const dots = "...";
  let cut = text;
  while (cut.length && textWidth(cut + dots, font, size) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}${dots}`;
}

/** Strings in a PDF are bytes; keep everything printable and escape syntax.
    WinAnsi matches Latin-1 for accented letters, so José and Zoë survive. */
function pdfText(value) {
  return String(value ?? "")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a0/g, " ")
    .replace(/[^\x20-\xff]/g, "")
    .replace(/[\\()]/g, (m) => "\\" + m);
}

function latin1(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function num(n) {
  const r = Math.round(n * 100) / 100;
  return String(r);
}

function rgb(hex) {
  const n = parseInt(hex, 16);
  return `${num(((n >> 16) & 255) / 255)} ${num(((n >> 8) & 255) / 255)} ${num((n & 255) / 255)}`;
}

function rect(x, y, w, h, hex) {
  return `${rgb(hex)} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f\n`;
}

function rule(x1, x2, y, hex = RULE, width = 0.6) {
  return `${rgb(hex)} RG ${num(width)} w ${num(x1)} ${num(y)} m ${num(x2)} ${num(y)} l S\n`;
}

function text(x, y, size, font, hex, str, { align = "left", maxWidth } = {}) {
  let value = String(str ?? "");
  if (maxWidth) value = fitText(value, font, size, maxWidth);
  const w = textWidth(value, font, size);
  const tx = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  return `${rgb(hex)} rg BT /${font} ${size} Tf ${num(tx)} ${num(y)} Td (${pdfText(value)}) Tj ET\n`;
}

/* ---------- numeric formatting ---------- */

/** 18:32.4 — official finish time, tenths */
function finishTime(ms) {
  if (ms == null || isNaN(ms)) return "--:--.-";
  const t = Math.max(0, Math.round(ms));
  const tenths = Math.floor((t % 1000) / 100);
  const s = Math.floor((t % 60000) / 1000);
  const m = Math.floor(t / 60000);
  return `${m}:${String(s).padStart(2, "0")}.${tenths}`;
}

/** 5:58 — pace per mile for a 5K */
function paceFor(ms) {
  if (ms == null || isNaN(ms) || ms <= 0) return "--:--";
  const pace = ms / 3.10686;
  const m = Math.floor(pace / 60000);
  const s = Math.floor((pace % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clockShort(ms) {
  if (ms == null || isNaN(ms)) return "--:--";
  const t = Math.max(0, Math.round(ms));
  const s = Math.floor((t % 60000) / 1000);
  const m = Math.floor(t / 60000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ---------- images ---------- */

/** base64 JPEG data URL -> raw bytes, or null when it isn't one. */
export function jpegFromDataUrl(dataUrl) {
  const m = /^data:image\/jpe?g;base64,([\s\S]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Width/height/components from a JPEG's start-of-frame marker. */
function jpegMeta(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const h = (bytes[i + 5] << 8) | bytes[i + 6];
      const w = (bytes[i + 7] << 8) | bytes[i + 8];
      const comps = bytes[i + 9] ?? 3;
      return w > 0 && h > 0 ? { w, h, comps } : null;
    }
    i += 2 + len;
  }
  return null;
}

/** Width/height from a JPEG's start-of-frame marker. */
export function jpegSize(bytes) {
  const meta = jpegMeta(bytes);
  return meta ? { w: meta.w, h: meta.h } : null;
}

/* ---------- entry normalisation ---------- */

function normalizeEntry(entry) {
  const e = entry || {};
  const bytes = jpegFromDataUrl(e.photo);
  const meta = bytes ? jpegMeta(bytes) : null;
  return {
    place: e.place ?? null,
    bib: String(e.bib ?? ""),
    name: String(e.name ?? "Unknown runner"),
    division: String(e.division ?? ""),
    ageGroup: String(e.ageGroup ?? ""),
    timeMs: e.timeMs ?? null,
    dnf: !!e.dnf,
    pace: e.pace || (e.timeMs != null ? paceFor(e.timeMs) : ""),
    img: meta ? { bytes, w: meta.w, h: meta.h, comps: meta.comps } : null,
  };
}

function divisionText(entry) {
  const code = entry.division && entry.division !== "U" ? entry.division : "";
  const age = entry.ageGroup && entry.ageGroup !== "—" ? entry.ageGroup : "";
  return [code, age].filter(Boolean).join(" ") || "--";
}

/* ---------- page furniture ---------- */

function coverBand(meta, title, subtitle) {
  let s = "";
  s += rect(0, 700, PAGE.w, 92, BAND);
  s += rect(0, 700, PAGE.w, 5, ORANGE);
  s += text(M, 754, 23, "F2", CREAM, title.toUpperCase(), { maxWidth: 300 });
  if (subtitle) s += text(M, 736, 9.5, "F1", "d9c9a8", subtitle, { maxWidth: 300 });
  s += text(PAGE.w - M, 758, 10.5, "F2", "e5a469", "OFFICIAL RESULTS", { align: "right" });
  if (meta.date) s += text(PAGE.w - M, 742, 8.4, "F1", CREAM, meta.date, { align: "right", maxWidth: 250 });
  if (meta.location) s += text(PAGE.w - M, 729, 8.4, "F1", "c9b591", meta.location, { align: "right", maxWidth: 250 });
  return s;
}

function slimHeader(title, meta) {
  let s = "";
  s += text(M, 758, 10, "F2", INK, title, { maxWidth: 300 });
  s += text(PAGE.w - M, 758, 8, "F1", MUTED, meta.short || "Official results", { align: "right" });
  s += rule(M, PAGE.w - M, 748, RULE, 0.7);
  return s;
}

function tableHeader(bottom) {
  let s = rect(M, bottom, CW, 14, BAND);
  const base = bottom + 4;
  s += text(88, base, 7, "F2", CREAM, "POS", { align: "right" });
  s += text(138, base, 7, "F2", CREAM, "BIB", { align: "right" });
  s += text(150, base, 7, "F2", CREAM, "NAME");
  s += text(366, base, 7, "F2", CREAM, "DIV");
  s += text(500, base, 7, "F2", CREAM, "TIME", { align: "right" });
  s += text(558, base, 7, "F2", CREAM, "PACE", { align: "right" });
  return s;
}

function footer(title, page, total, note) {
  let s = "";
  s += rule(M, PAGE.w - M, 46, RULE, 0.6);
  s += text(M, 32, 7.4, "F1", MUTED, `${title} — Official results`, { maxWidth: 240 });
  if (note) s += text(PAGE.w / 2, 32, 7.4, "F1", MUTED, note, { align: "center", maxWidth: 230 });
  s += text(PAGE.w - M, 32, 7.4, "F1", MUTED, `Page ${page + 1} of ${total}`, { align: "right" });
  return s;
}

function summaryStrip(stats) {
  const gap = 8;
  const w = (CW - gap * 3) / 4;
  const y = 632;
  const boxes = [
    { label: "FINISHERS", value: String(stats.finished), sub: `of ${stats.field} athletes` },
    { label: "WINNING TIME", value: stats.winnerMs != null ? finishTime(stats.winnerMs) : "--", sub: stats.winnerName || "no finishers yet" },
    { label: "AVERAGE TIME", value: stats.avgMs != null ? clockShort(stats.avgMs) : "--", sub: "finishers only" },
    { label: "DID NOT FINISH", value: String(stats.dnf), sub: "listed at the end" },
  ];
  let s = "";
  boxes.forEach((box, i) => {
    const x = M + i * (w + gap);
    s += rect(x, y, w, 52, PAPER);
    s += rule(x, x + w, y + 52, RULE, 0.5);
    s += text(x + 10, y + 42, 6.4, "F2", MUTED, box.label, { maxWidth: w - 20 });
    s += text(x + 10, y + 23, 14, "F2", i === 0 ? GREEN : INK, box.value, { maxWidth: w - 20 });
    s += text(x + 10, y + 9, 6.4, "F1", MUTED, box.sub, { maxWidth: w - 20 });
  });
  return s;
}

function drawRow(entry, yTop, zebra) {
  const y = yTop - 13;
  let s = "";
  if (zebra) s += rect(M, yTop - ROW_H, CW, ROW_H, ZEBRA);
  const pos = entry.place != null ? String(entry.place) : "-";
  s += text(88, y, 9, "F2", INK, pos, { align: "right" });
  s += text(138, y, 9, "F1", MUTED, entry.bib || "--", { align: "right", maxWidth: 48 });
  s += text(150, y, 9, "F2", INK, entry.name, { maxWidth: 208 });
  s += text(366, y, 8.4, "F1", MUTED, divisionText(entry), { maxWidth: 74 });
  const time = entry.timeMs != null ? finishTime(entry.timeMs) : entry.dnf ? "DNF" : "--";
  s += text(500, y, 9.5, "F2", entry.dnf ? ORANGE : INK, time, { align: "right" });
  s += text(558, y, 8.4, "F1", MUTED, entry.timeMs != null ? entry.pace : "", { align: "right" });
  return s;
}

/* ---------- the document ---------- */

/**
 * Build the PDF. Returns { bytes, pages, photos } — `bytes` is the whole
 * document as a Uint8Array, ready for a Blob.
 */
export function buildResultsPdf({
  title = "Brighton Oaks 5K",
  subtitle = "",
  meta = {},
  entries = [],
} = {}) {
  const all = (entries || []).map(normalizeEntry);

  const finished = all
    .filter((r) => r.timeMs != null && !r.dnf)
    .sort((a, b) => a.timeMs - b.timeMs || (a.place ?? 0) - (b.place ?? 0));
  finished.forEach((r, i) => {
    if (r.place == null) r.place = i + 1;
  });
  const finishedSet = new Set(finished);
  const rest = all.filter((r) => !finishedSet.has(r));

  const stats = {
    field: all.length,
    finished: finished.length,
    dnf: rest.filter((r) => r.dnf).length,
    winnerMs: finished.length ? finished[0].timeMs : null,
    winnerName: finished.length ? finished[0].name : "",
    avgMs: finished.length ? finished.reduce((sum, r) => sum + r.timeMs, 0) / finished.length : null,
  };

  /* ---- table rows, paginated ---- */
  const items = [];
  if (!all.length) items.push({ kind: "empty" });
  finished.forEach((entry) => items.push({ kind: "row", entry }));
  if (rest.length) {
    items.push({
      kind: "divider",
      label: rest.every((r) => r.dnf) ? "DID NOT FINISH" : "NOT YET FINISHED / DNF",
    });
    rest.forEach((entry) => items.push({ kind: "row", entry }));
  }

  const tablePages = [];
  let current = { items: [], top: PAGE1_ROWS_TOP, startTop: PAGE1_ROWS_TOP };
  for (const item of items) {
    const h = item.kind === "divider" ? 26 : item.kind === "empty" ? 44 : ROW_H;
    if (current.items.length && current.top - h < BOTTOM) {
      tablePages.push(current);
      current = { items: [], top: ROWS_TOP, startTop: ROWS_TOP };
    }
    current.items.push(item);
    current.top -= h;
  }
  tablePages.push(current);

  /* ---- photo appendix ---- */
  const photoEntries = all.filter((r) => r.img);
  const perPage = PHOTO_COLS * PHOTO_ROWS;
  const photoPages = [];
  for (let i = 0; i < photoEntries.length; i += perPage) {
    photoPages.push(photoEntries.slice(i, i + perPage));
  }

  const total = tablePages.length + photoPages.length;
  const firstImageId = 5 + total * 2;
  const images = [];

  /* ---- table page content ---- */
  const contents = [];
  const pageImages = [];

  tablePages.forEach((page, pi) => {
    let s = pi === 0 ? coverBand(meta, title, subtitle) + summaryStrip(stats) : slimHeader(title, meta);
    if (pi === 0) {
      s += text(M, 606, 12, "F2", INK, "Overall Results");
      s += text(PAGE.w - M, 606, 8, "F1", MUTED, meta.distance || "", { align: "right" });
    }
    s += tableHeader(page.startTop);
    let rowIndex = 0;
    let yTop = page.startTop;
    page.items.forEach((item) => {
      if (item.kind === "row") {
        s += drawRow(item.entry, yTop, rowIndex % 2 === 1);
        rowIndex += 1;
        yTop -= ROW_H;
      } else if (item.kind === "divider") {
        s += rect(M, yTop - 20, CW, 20, PAPER);
        s += text(M + 10, yTop - 14, 7.6, "F2", ORANGE, item.label);
        yTop -= 26;
      } else {
        s += text(PAGE.w / 2, yTop - 30, 13, "F2", INK, "No athletes in the field yet.", { align: "center" });
        s += text(PAGE.w / 2, yTop - 48, 9, "F1", MUTED, "Results will appear here once the race starts.", { align: "center" });
      }
    });
    s += footer(title, pi, total, meta.note || "Official gun times");
    contents.push(s);
    pageImages.push([]);
  });

  /* ---- photo page content ---- */
  photoPages.forEach((pageEntries, pj) => {
    const pageIndex = tablePages.length + pj;
    let s = slimHeader(title, meta);
    s += text(M, 722, 12, "F2", INK, "Finish Line Photos");
    s += text(M, 708, 8, "F1", MUTED, "One frame per athlete, taken as their chest met the line.");
    const used = [];
    pageEntries.forEach((entry, i) => {
      const col = i % PHOTO_COLS;
      const row = Math.floor(i / PHOTO_COLS);
      const x = M + col * (PHOTO_W + PHOTO_GAP_X);
      const top = PHOTO_TOP - row * (PHOTO_H + 26 + PHOTO_GAP_Y);
      const bottom = top - PHOTO_H;

      const local = used.length;
      used.push(firstImageId + images.length);
      images.push({ id: firstImageId + images.length, ...entry.img });

      s += rect(x, bottom, PHOTO_W, PHOTO_H, "e8e2d6");
      const scale = Math.min(PHOTO_W / entry.img.w, PHOTO_H / entry.img.h);
      const w = entry.img.w * scale;
      const h = entry.img.h * scale;
      s += `q ${num(w)} 0 0 ${num(h)} ${num(x + (PHOTO_W - w) / 2)} ${num(bottom + (PHOTO_H - h) / 2)} cm /Im${local} Do Q\n`;
      const caption = `${entry.place != null ? `${entry.place}. ` : ""}${entry.name}`;
      s += text(x, top - PHOTO_H - 11, 7.8, "F2", INK, caption, { maxWidth: PHOTO_W });
      const sub = [entry.bib ? `Bib ${entry.bib}` : "", entry.timeMs != null ? finishTime(entry.timeMs) : entry.dnf ? "DNF" : ""]
        .filter(Boolean)
        .join("  ·  ");
      if (sub) s += text(x, top - PHOTO_H - 21, 7, "F1", MUTED, sub, { maxWidth: PHOTO_W });
    });
    s += footer(title, pageIndex, total, `${photoEntries.length} finish photos`);
    contents.push(s);
    pageImages.push(used);
  });

  /* ---- object table (1-based numbers, contiguous) ---- */
  const objects = [];
  objects[0] = { head: "<< /Type /Catalog /Pages 2 0 R >>" };
  objects[1] = {
    head: `<< /Type /Pages /Kids [${contents.map((_, i) => `${5 + i * 2} 0 R`).join(" ")}] /Count ${total} >>`,
  };
  objects[2] = { head: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" };
  objects[3] = { head: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>" };

  contents.forEach((content, i) => {
    const pageId = 5 + i * 2;
    const contentId = pageId + 1;
    const xobj = pageImages[i].map((id, k) => `/Im${k} ${id} 0 R`).join(" ");
    objects[pageId - 1] = {
      head:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xobj} >> >> ` +
        `/Contents ${contentId} 0 R >>`,
    };
    const stream = latin1(content);
    objects[contentId - 1] = { head: `<< /Length ${stream.length} >>`, stream };
  });

  images.forEach((img) => {
    const space = img.comps === 1 ? "/DeviceGray" : img.comps === 4 ? "/DeviceCMYK" : "/DeviceRGB";
    objects[img.id - 1] = {
      head:
        `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} ` +
        `/ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>`,
      stream: img.bytes,
    };
  });

  /* ---- serialise with a real xref table ---- */
  const parts = [latin1("%PDF-1.4\n")];
  let length = parts[0].length;
  const offsets = [];
  objects.forEach((o, i) => {
    offsets[i] = length;
    const head = latin1(`${i + 1} 0 obj\n${o.head}\n`);
    parts.push(head);
    length += head.length;
    if (o.stream) {
      const open = latin1("stream\n");
      parts.push(open);
      length += open.length;
      parts.push(o.stream);
      length += o.stream.length;
      const close = latin1("\nendstream\nendobj\n");
      parts.push(close);
      length += close.length;
    } else {
      const close = latin1("endobj\n");
      parts.push(close);
      length += close.length;
    }
  });

  const xrefAt = length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  });
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  parts.push(latin1(xref));

  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  parts.forEach((p) => {
    bytes.set(p, at);
    at += p.length;
  });

  return { bytes, pages: total, photos: photoEntries.length };
}

/** The same list as plain text — for the clipboard or a message. */
export function buildResultsText({
  title = "Brighton Oaks 5K",
  subtitle = "",
  meta = {},
  entries = [],
} = {}) {
  const rows = (entries || []).map(normalizeEntry);
  const finished = rows
    .filter((r) => r.timeMs != null && !r.dnf)
    .sort((a, b) => a.timeMs - b.timeMs);
  const finishedSet = new Set(finished);
  const rest = rows.filter((r) => !finishedSet.has(r));

  const lines = [title];
  const sub = [subtitle, meta.date, meta.location].filter(Boolean).join("  ·  ");
  if (sub) lines.push(sub);
  lines.push("OFFICIAL RESULTS", "");

  const head = ["Place", "Bib", "Name", "Div", "Time", "Pace"];
  const widths = [5, 5, 26, 10, 10, 6];
  const pad = (cells) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? String(cell) : String(cell).padEnd(widths[i])))
      .join(" ")
      .trimEnd();

  lines.push(pad(head));
  finished.forEach((r, i) => {
    lines.push(pad([i + 1, r.bib || "--", r.name, divisionText(r), finishTime(r.timeMs), r.pace || ""]));
  });
  if (rest.length) {
    lines.push("", "NOT YET FINISHED / DNF");
    rest.forEach((r) => {
      lines.push(pad(["-", r.bib || "--", r.name, divisionText(r), r.dnf ? "DNF" : "--", ""]));
    });
  }
  if (!rows.length) lines.push("No athletes in the field yet.");
  lines.push("", `${rows.length} athletes · Brighton Oaks 5K timing team`);
  return `${lines.join("\n")}\n`;
}
