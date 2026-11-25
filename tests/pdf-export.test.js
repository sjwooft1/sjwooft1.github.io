import { describe, expect, test } from "bun:test";
import {
  buildResultsPdf,
  buildResultsText,
  jpegFromDataUrl,
  jpegSize,
} from "../pdf-export.js";

/* A header-only JPEG: enough SOI/SOF bytes for the size reader and the
   DCTDecode stream, without dragging a binary fixture into the repo. */
function fakeJpeg(w = 960, h = 540) {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

function fakeDataUrl(w = 960, h = 540) {
  return `data:image/jpeg;base64,${Buffer.from(fakeJpeg(w, h)).toString("base64")}`;
}

const decode = (bytes) => Buffer.from(bytes).toString("latin1");

const NAMES = ["Ada Lovelace", "Grace Hopper (Jr)", "Alan Turing"];

function entries(n = 3, withPhoto = true) {
  return Array.from({ length: n }, (_, i) => ({
    place: i + 1,
    bib: String(1042 + i).padStart(4, "0"),
    name: NAMES[i % NAMES.length],
    division: ["F", "F", "M"][i % 3],
    ageGroup: ["35–39", "35–39", "40–44"][i % 3],
    timeMs: 1114120 + i * 7300,
    pace: "5:58",
    photo: withPhoto && i < 2 ? fakeDataUrl() : null,
  }));
}

describe("jpegSize", () => {
  test("reads the frame size out of the start-of-frame marker", () => {
    expect(jpegSize(fakeJpeg(960, 540))).toEqual({ w: 960, h: 540 });
    expect(jpegSize(fakeJpeg(1280, 720))).toEqual({ w: 1280, h: 720 });
  });

  test("rejects anything that is not a JPEG", () => {
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(null);
    expect(jpegSize(null)).toBe(null);
  });
});

describe("jpegFromDataUrl", () => {
  test("decodes a base64 JPEG data URL", () => {
    const bytes = jpegFromDataUrl(fakeDataUrl());
    expect(bytes.length).toBe(fakeJpeg().length);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  test("refuses a PNG or a plain string", () => {
    expect(jpegFromDataUrl("data:image/png;base64,AAAA")).toBe(null);
    expect(jpegFromDataUrl("nope")).toBe(null);
  });
});

describe("buildResultsPdf", () => {
  test("builds a branded results sheet plus a photo appendix", () => {
    const { bytes, pages, photos } = buildResultsPdf({
      title: "Brighton Oaks 5K",
      subtitle: "Thanksgiving Day Run",
      meta: { date: "Thursday, November 26, 2026", location: "Brighton Oaks, South Carolina" },
      entries: entries(3),
    });
    const text = decode(bytes);

    expect(pages).toBe(2); // one table page, one photo page
    expect(photos).toBe(2);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%EOF")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/Count 2");
    expect(text).toContain("OFFICIAL RESULTS");
    expect(text).toContain("Overall Results");
    expect(text).toContain("Finish Line Photos");
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("F 35-39"); // the en dash becomes PDF-safe ASCII
    expect(text.match(/\/Subtype \/Image/g).length).toBe(2);
    expect(text.match(/\/Filter \/DCTDecode/g).length).toBe(2);
  });

  test("summarises the field and lists non-finishers separately", () => {
    const rows = entries(3, false);
    rows.push({ place: null, bib: "1099", name: "DNF Runner", dnf: true, division: "M" });
    const text = decode(buildResultsPdf({ entries: rows }).bytes);

    expect(text).toContain("FINISHERS");
    expect(text).toContain("DID NOT FINISH");
    expect(text).toContain("DNF Runner");
    expect(text).toContain("DNF");
  });

  test("keeps a big field on several pages and repeats the column header", () => {
    const { bytes, pages } = buildResultsPdf({ entries: entries(40, false) });
    const text = decode(bytes);

    expect(pages).toBe(2); // 29 rows fit the first page, the rest continue
    expect(text.match(/\(NAME\) Tj/g).length).toBe(2);
    expect(text).toContain("Page 1 of 2");
    expect(text).toContain("Page 2 of 2");
    expect(text.match(/\/MediaBox/g).length).toBe(2);
  });

  test("the xref table points at the objects it claims", () => {
    const { bytes } = buildResultsPdf({ entries: entries(4) });
    const text = decode(bytes);
    const startxref = Number(/startxref\s+(\d+)/.exec(text)[1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");

    const rows = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)];
    expect(rows.length).toBeGreaterThan(4);
    rows.forEach((row, i) => {
      const at = Number(row[1]);
      expect(text.slice(at, at + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });

  test("escapes the brackets and slashes PDF strings care about", () => {
    const { bytes } = buildResultsPdf({
      entries: [{ place: 1, bib: "0001", name: "A (B) \\ C", timeMs: 1200000 }],
    });
    const text = decode(bytes);
    expect(text).toContain("A \\(B\\) \\\\ C");
  });

  test("an empty field still produces a readable single page", () => {
    const { bytes, pages, photos } = buildResultsPdf({ title: "Brighton Oaks 5K" });
    const text = decode(bytes);
    expect(pages).toBe(1);
    expect(photos).toBe(0);
    expect(text).toContain("/MediaBox [0 0 612 792]");
    expect(text).toContain("No athletes in the field yet.");
    expect(text).toContain("Page 1 of 1");
  });

  test("every declared stream length matches its bytes", () => {
    const { bytes } = buildResultsPdf({ entries: entries(2) });
    const text = decode(bytes);
    const lengths = [...text.matchAll(/\/Length (\d+) >>\nstream\n/g)];
    expect(lengths.length).toBeGreaterThan(1);
    lengths.forEach((m) => {
      const declared = Number(m[1]);
      const start = m.index + m[0].length;
      expect(text.slice(start + declared, start + declared + 10)).toBe("\nendstream");
    });
  });
});

describe("buildResultsText", () => {
  test("lists every athlete under an official header", () => {
    const text = buildResultsText({
      title: "Brighton Oaks 5K",
      subtitle: "Thanksgiving Day Run",
      meta: { date: "Thursday, November 26, 2026", location: "Brighton Oaks, SC" },
      entries: entries(3),
    });
    const lines = text.trimEnd().split("\n");

    expect(lines[0]).toBe("Brighton Oaks 5K");
    expect(lines[1]).toContain("Thanksgiving Day Run");
    expect(lines[2]).toBe("OFFICIAL RESULTS");
    expect(lines[3]).toBe("");
    expect(lines[4]).toContain("Place");
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("18:34.1");
    expect(text).toContain("F 35–39"); // plain text keeps the typographic dash
  });

  test("says so when the field is empty", () => {
    const text = buildResultsText({ title: "Brighton Oaks 5K" });
    expect(text).toContain("No athletes in the field yet.");
  });
});
