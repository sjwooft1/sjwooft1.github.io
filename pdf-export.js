/* ============================================================
   Results PDF — every athlete in the field, with the photo taken as
   their chest crossed the line.

   Written by hand instead of pulling in a library: race day is offline,
   the phone is already busy, and the document is only text plus one JPEG
   per athlete. The JPEGs are embedded untouched, so a bib stays exactly
   as sharp in the PDF as it was when it was recorded.

   `entries` are plain objects: { place, bib, name, line, photo } where
   `line` is a preformatted detail string and `photo` is a JPEG data URL
   (or null for an athlete with no photo on this device).
   ============================================================ */

const PAGE = { w: 612, h: 792 }; // US Letter, points
const MARGIN = 64;
const PHOTO_W = PAGE.w - MARGIN * 2; // 484
const PHOTO_H = 272; // 16:9 box; other shapes are letterboxed inside it
const TOP = PAGE.h - 72; // top of the first athlete block
const BLOCK_H = 34 + PHOTO_H;
const GAP = 16;
const PER_PAGE = 2;

/** Strings in a PDF are bytes; keep everything printable and escape syntax. */
function pdfText(value) {
  return String(value ?? "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e]/g, "")
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

/** A one-line text draw at an absolute position. */
function textOp(x, y, size, font, str) {
  return `BT /${font} ${size} Tf ${num(x)} ${num(y)} Td (${pdfText(str)}) Tj ET\n`;
}

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

/** Width/height from a JPEG's start-of-frame marker. */
export function jpegSize(bytes) {
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
      return w > 0 && h > 0 ? { w, h } : null;
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Build the PDF. Returns { bytes, pages, photos } — `bytes` is the whole
 * document as a Uint8Array, ready for a Blob.
 */
export function buildResultsPdf({ title = "Results", subtitle = "", entries = [] } = {}) {
  const rows = (entries || []).map((e) => {
    const bytes = jpegFromDataUrl(e && e.photo);
    const size = bytes ? jpegSize(bytes) : null;
    return { ...e, img: size ? { bytes, w: size.w, h: size.h } : null };
  });

  const groups = [];
  for (let i = 0; i < rows.length; i += PER_PAGE) groups.push(rows.slice(i, i + PER_PAGE));
  if (!groups.length) groups.push([]);

  const pageIds = groups.map((_, i) => 5 + i * 2);
  const contentIds = groups.map((_, i) => 6 + i * 2);
  const firstImageId = 5 + groups.length * 2;

  const images = []; // every embedded photo, in object order
  const pageImages = []; // per page: the image object ids it draws
  const photoCount = rows.filter((r) => r.img).length;

  const content = groups.map((pageRows, pi) => {
    const used = [];
    pageImages[pi] = used;
    let s = textOp(MARGIN, PAGE.h - 46, 15, "F2", title);
    if (subtitle) s += textOp(MARGIN, PAGE.h - 62, 9, "F1", subtitle);

    pageRows.forEach((row, k) => {
      const top = TOP - k * (BLOCK_H + GAP);
      const heading = [row.place ? `${row.place}.` : null, row.bib || null, row.name || null]
        .filter(Boolean)
        .join("  ");
      s += textOp(MARGIN, top - 13, 11, "F2", heading);
      if (row.line) s += textOp(MARGIN, top - 27, 9, "F1", row.line);

      const photoTop = top - 34;
      const photoBottom = photoTop - PHOTO_H;
      s += `q 0.75 G 0.5 w ${num(MARGIN)} ${num(photoBottom)} ${num(PHOTO_W)} ${num(PHOTO_H)} re S Q\n`;
      if (row.img) {
        const local = used.length;
        used.push(firstImageId + images.length);
        images.push({ id: firstImageId + images.length, ...row.img });
        const scale = Math.min(PHOTO_W / row.img.w, PHOTO_H / row.img.h);
        const w = row.img.w * scale;
        const h = row.img.h * scale;
        const x = MARGIN + (PHOTO_W - w) / 2;
        const y = photoBottom + (PHOTO_H - h) / 2;
        s += `q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /Im${local} Do Q\n`;
      } else {
        s += `q 0.95 0.95 0.95 rg ${num(MARGIN)} ${num(photoBottom)} ${num(PHOTO_W)} ${num(PHOTO_H)} re f Q\n`;
        s += textOp(
          MARGIN + 14,
          photoBottom + PHOTO_H / 2 - 4,
          10,
          "F1",
          "No finish photo on this device"
        );
      }
    });

    s += textOp(MARGIN, 40, 8, "F1", `Page ${pi + 1} of ${groups.length}`);
    return s;
  });

  /* ---- object table (1-based numbers, contiguous) ---- */
  const objects = [];
  objects[0] = { head: "<< /Type /Catalog /Pages 2 0 R >>" };
  objects[1] = {
    head: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${groups.length} >>`,
  };
  objects[2] = {
    head: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  };
  objects[3] = {
    head: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  };

  groups.forEach((_, i) => {
    const xobj = pageImages[i].map((id, k) => `/Im${k} ${id} 0 R`).join(" ");
    objects[pageIds[i] - 1] = {
      head:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xobj} >> >> ` +
        `/Contents ${contentIds[i]} 0 R >>`,
    };
    const stream = latin1(content[i]);
    objects[contentIds[i] - 1] = { head: `<< /Length ${stream.length} >>`, stream };
  });

  images.forEach((img) => {
    objects[img.id - 1] = {
      head:
        `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>`,
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

  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  parts.forEach((p) => {
    bytes.set(p, at);
    at += p.length;
  });

  return { bytes, pages: groups.length, photos: photoCount };
}

/** The same list as plain text — for the clipboard or a message. */
export function buildResultsText({ title = "Results", subtitle = "", entries = [] } = {}) {
  const lines = [];
  if (title) lines.push(title);
  if (subtitle) lines.push(subtitle);
  lines.push("");
  lines.push(["Place", "Bib", "Name", "Result"].join("\t"));
  (entries || []).forEach((e) => {
    lines.push([e.place ?? "-", e.bib || "", e.name || "", e.line || ""].join("\t"));
  });
  return `${lines.join("\n")}\n`;
}
