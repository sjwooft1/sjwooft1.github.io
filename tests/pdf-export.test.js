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

function entries(n = 3, withPhoto = true) {
  return Array.from({ length: n }, (_, i) => ({
    place: i + 1,
    bib: String(1042 + i).padStart(4, "0"),
    name: ["Ada Lovelace", "Grace Hopper (Jr)", "Alan Turing"][i % 3],
    line: "00:21:34  ·  6:57/mi  ·  F35-39",
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
  test("wraps the whole field into pages of two, photos and all", () => {
    const { bytes, pages, photos } = buildResultsPdf({
      title: "Brighton Oaks 5K — Finish photos",
      subtitle: "3 athletes",
      entries: entries(3),
    });
    const text = decode(bytes);

    expect(pages).toBe(2); // 3 athletes at two per page
    expect(photos).toBe(2);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/Count 2");
    expect(text.match(/\/Subtype \/Image/g).length).toBe(2);
    expect(text.match(/\/Filter \/DCTDecode/g).length).toBe(2);
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("No finish photo on this device");
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
      entries: [{ place: 1, bib: "0001", name: "A (B) \\ C", line: "00:20:00" }],
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
  test("lists every athlete under a header", () => {
    const text = buildResultsText({ title: "Brighton Oaks 5K", subtitle: "3 athletes", entries: entries(3) });
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("Brighton Oaks 5K");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("Place\tBib\tName\tResult");
    expect(lines[4]).toContain("1042");
    expect(lines[6]).toContain("Alan Turing");
  });
});
