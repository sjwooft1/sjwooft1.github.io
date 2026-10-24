/* ============================================================
   Brighton Oaks 5K — Shared core module
   Firebase wiring + formatting + bib assignment helpers.

   Used by: registration.html, results.html, organizer.html
   Every page must derive bib numbers with computeBibs() so the
   registration list, results board and timing console agree.
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import {
  getDatabase, ref, set, push, update, get, remove, onValue
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

/* ---------- Event constants ---------- */
export const EVENT = {
  name: "Brighton Oaks 5K",
  edition: "Thanksgiving Day Run",
  distanceMiles: 3.10686,
  distanceKm: 5,
  raceDate: new Date("2026-11-26T08:30:00"),
  registrationCloses: new Date("2026-11-22T23:59:59"),
  location: "Brighton Oaks, South Carolina",
};

/* ---------- Firebase ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyDUnAV-DL-Saw2ByPY6GF8aDaZbVCXDIH4",
  authDomain: "the-race-organizer.firebaseapp.com",
  databaseURL: "https://the-race-organizer-default-rtdb.firebaseio.com",
  projectId: "the-race-organizer",
  storageBucket: "the-race-organizer.firebasestorage.app",
  messagingSenderId: "265977321479",
  appId: "1:265977321479:web:23d3f3077e8e766323b2a2",
  measurementId: "G-PKGPD78DYM",
};

let _app = null;
export function getDb() {
  if (!_app) _app = initializeApp(firebaseConfig);
  return getDatabase(_app);
}
export { ref, set, push, update, get, remove, onValue };

/** subscribe to a db path with a safe callback */
export function subscribe(path, cb) {
  return onValue(ref(getDb(), path), (snap) => cb(snap.val(), snap), (err) => {
    console.warn(`subscribe(${path}) failed`, err);
  });
}

/* ---------- Time formatting ---------- */
/** mm:ss.mmm — the official race-clock format */
export function formatClock(ms) {
  if (ms == null || isNaN(ms)) return "--:--.---";
  const t = Math.max(0, Math.floor(ms));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const mm = t % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(mm).padStart(3, "0")}`;
}

/** m:ss (or mm:ss) for pace / estimates */
export function formatShort(ms) {
  if (ms == null || isNaN(ms)) return "—";
  const t = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** clock split into parts for stylized display */
export function clockParts(ms) {
  const t = Math.max(0, Math.floor(ms || 0));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const mm = t % 1000;
  return {
    main: `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`,
    ms: `.${String(mm).padStart(3, "0")}`,
  };
}

/** pace per mile for a 5K finish time */
export function pacePerMile(ms, miles = EVENT.distanceMiles) {
  if (ms == null || isNaN(ms) || ms <= 0) return "—";
  const paceMs = ms / miles;
  const m = Math.floor(paceMs / 60000);
  const s = Math.floor((paceMs % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** parse "25:45", "25:45.3", "25m45s", "1545" -> ms (null when unparseable) */
export function parseTimeInput(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m1 = s.match(/^(\d{1,3})\s*[:.]\s*(\d{1,2})(?:[.:](\d{1,3}))?$/);
  if (m1) {
    const min = parseInt(m1[1], 10);
    const sec = parseInt(m1[2], 10);
    if (sec > 59) return null;
    const frac = m1[3] ? parseInt(m1[3].padEnd(3, "0").slice(0, 3), 10) : 0;
    return (min * 60 + sec) * 1000 + frac;
  }
  const m2 = s.match(/^(\d{1,3})\s*m(?:in)?\s*(\d{1,2})\s*s?$/i);
  if (m2) return (parseInt(m2[1], 10) * 60 + parseInt(m2[2], 10)) * 1000;
  if (/^\d{3,4}$/.test(s)) {
    const min = Math.floor(parseInt(s, 10) / 100);
    const sec = parseInt(s, 10) % 100;
    if (sec < 60) return (min * 60 + sec) * 1000;
  }
  return null;
}

/* ---------- Bib numbers ----------
 * Bibs are assigned by predicted finish time (fastest first),
 * zero-padded to 4 digits: 0001, 0002, ...
 * Comparator must stay identical across every page.
 */
export function sortRunners(list) {
  return [...list].sort((a, b) =>
    ((a.estimatedTime || 0) - (b.estimatedTime || 0)) ||
    ((a.registeredAt || 0) - (b.registeredAt || 0)) ||
    String(a.name || "").localeCompare(String(b.name || ""))
  );
}

export function bibNumber(index) {
  return String(index + 1).padStart(4, "0");
}

/** Normalize a custom bib number request to "0007" form, or null if invalid. */
export function normalizeCustomBib(raw) {
  const clean = String(raw ?? "").replace(/\D/g, "");
  if (!clean || clean.length > 4) return null;
  const n = parseInt(clean, 10);
  if (!n || n < 1 || n > 9999) return null;
  return String(n).padStart(4, "0");
}

/**
 * returns { [id]: "0001" } for a list of { id, name, estimatedTime, registeredAt, customBib? }.
 * When allowCustom is true (organizer said yes), runners with a valid customBib
 * request keep that number (earliest registration wins conflicts); everyone else
 * is seeded by predicted time and skips the reserved numbers.
 */
export function computeBibs(list, allowCustom = true) {
  const map = {};
  const taken = new Set();

  if (allowCustom) {
    [...list]
      .sort((a, b) => (a.registeredAt || 0) - (b.registeredAt || 0))
      .forEach((r) => {
        const want = normalizeCustomBib(r.customBib);
        if (want && !taken.has(want)) {
          map[r.id] = want;
          taken.add(want);
        }
      });
  }

  let next = 1;
  sortRunners(list).forEach((r) => {
    if (map[r.id]) return;
    while (taken.has(bibNumber(next - 1))) next++;
    map[r.id] = bibNumber(next - 1);
    taken.add(map[r.id]);
    next++;
  });
  return map;
}

/** find a runner entry by bib or name fragment */
export function findByBibOrName(list, bibMap, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  return list.find((r) => bibMap[r.id] === String(query).trim().padStart(4, "0")) ||
         list.find((r) => bibMap[r.id] === String(query).trim()) ||
         list.find((r) => String(r.name || "").toLowerCase().includes(q)) ||
         null;
}

/* ---------- Divisions & age groups ---------- */
export const DIVISIONS = {
  M: "Men",
  F: "Women",
  X: "Non-binary",
  U: "Unspecified",
};

export function divisionLabel(code) {
  return DIVISIONS[code] || DIVISIONS.U;
}

export function ageGroup(age) {
  const a = parseInt(age, 10);
  if (!a || a < 1) return "—";
  if (a < 14) return "Under 14";
  if (a < 20) return "14–19";
  const base = Math.floor(a / 10) * 10;
  return `${base}–${base + 9}`;
}

/* ---------- Misc helpers ---------- */
export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function fmtDateTime(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch { return "—"; }
}

/** countdown pieces to a target date */
export function countdownTo(target) {
  const diff = target - new Date();
  if (diff <= 0) return null;
  return {
    days: Math.floor(diff / 86400000),
    hours: Math.floor((diff / 3600000) % 24),
    minutes: Math.floor((diff / 60000) % 60),
    seconds: Math.floor((diff / 1000) % 60),
  };
}

/** trigger a CSV download in the browser */
export function downloadCsv(filename, rows) {
  const csv = rows.map((r) =>
    r.map((cell) => {
      const s = String(cell ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")
  ).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
}

/* ---------- Toasts (shared UI) ---------- */
let toastWrap = null;
export function toast(message, kind = "info", ms = 2600) {
  if (!toastWrap) {
    toastWrap = document.createElement("div");
    toastWrap.className = "toast-wrap";
    document.body.appendChild(toastWrap);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  toastWrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s, transform .25s";
    el.style.opacity = "0";
    el.style.transform = "translateX(12px)";
    setTimeout(() => el.remove(), 280);
  }, ms);
}

/** live sync indicator: keeps a dot + label honest about connection state */
export function watchConnection(statusEl) {
  const setState = (online) => {
    if (!statusEl) return;
    statusEl.className = `badge ${online ? "green" : "red"}`;
    statusEl.textContent = online ? "Live sync" : "Offline";
  };
  setState(navigator.onLine);
  window.addEventListener("online", () => setState(true));
  window.addEventListener("offline", () => setState(false));
}
