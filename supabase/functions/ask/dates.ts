const TZ = "America/Toronto";

/* ----------------------------------------------------------- dates ---- */
const dfmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const todayISO = () => dfmt.format(new Date());
export const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dow = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
const mondayOf = (iso: string) => addDays(iso, ((dow(iso) + 6) % 7) * -1);
export const pretty = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA",
    { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
};

export type Win = { from: string; to: string; label: string } | null;

// Deterministic. Anything it cannot parse falls through to a null window,
// which means "no date filter" rather than a wrong one.
export function resolveWindow(qRaw: string, today: string): Win {
  const q = qRaw.toLowerCase();
  const mon = mondayOf(today);

  if (/\b(today|tonight)\b/.test(q)) return { from: today, to: today, label: "today" };
  if (/\btomorrow\b/.test(q)) return { from: addDays(today, 1), to: addDays(today, 1), label: "tomorrow" };
  if (/\b(day after tomorrow)\b/.test(q)) return { from: addDays(today, 2), to: addDays(today, 2), label: "the day after tomorrow" };
  if (/\bnext week\b/.test(q)) return { from: addDays(mon, 7), to: addDays(mon, 11), label: "next week" };
  if (/\bfirst week\b/.test(q)) return { from: "2026-09-08", to: "2026-09-11", label: "the first week of school" };
  if (/\b(this|the rest of (the|this)) week\b/.test(q)) return { from: today, to: addDays(mon, 6), label: "the rest of this week" };
  if (/\bthis weekend\b/.test(q)) return { from: addDays(mon, 5), to: addDays(mon, 6), label: "this weekend" };
  if (/\bnext month\b/.test(q)) return { from: today, to: addDays(today, 45), label: "the next several weeks" };

  const nDays = q.match(/\bnext (\d{1,2}) days\b/);
  if (nDays) return { from: today, to: addDays(today, Number(nDays[1])), label: `the next ${nDays[1]} days` };

  const nWeeks = q.match(/\bnext (\d{1,2}) weeks\b/);
  if (nWeeks) return { from: today, to: addDays(today, Number(nWeeks[1]) * 7), label: `the next ${nWeeks[1]} weeks` };

  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${days[i]}\\b`).test(q)) {
      let d = today;
      for (let k = 0; k < 8; k++) { d = addDays(today, k); if (dow(d) === i && k > 0) break; }
      return { from: d, to: d, label: days[i] };
    }
  }

  if (/\b(bring|prepare|pack|need|upcoming|coming up|ahead|get ready|buy|supplies|stationery|stationary)\b/.test(q)) {
    return { from: today, to: addDays(today, 14), label: "the next two weeks" };
  }
  return null;
}

