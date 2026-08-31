// The day-bars sparkline: one bar per calendar day, newest on the right,
// heights scaled to the busiest day drawn. Grown inline in the admin Boards
// cell and promoted here when the Usage tab became its second caller —
// metering-plan.md's Stage 4 notes count three near-miss renderers already in
// the app, and a fourth copy was the wrong move. Returns an HTML string, the
// way its first caller always used it, so it drops into template markup.
//
// Shape-agnostic on purpose: the caller says how to read a day's magnitude
// (`value`) and how to phrase its tooltip (`title`, called with the date and
// the day's row — undefined for a day with no row). The only contract on a
// `days` row is a `day` key holding the YYYY-MM-DD its rollup is filed under.

// The same UTC day key server/db.js day() derives — how a client maps "now"
// onto the keys the server files rollups under.
export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

export function sparkline(days, {
  count = 14,   // calendar days drawn, ending today
  value,        // (row) => the magnitude a bar's height states
  title,        // (day, row | undefined) => the bar's tooltip
  height = 12,  // px of the tallest bar
  barWidth = 2,
  gap = 2,
  style = "",   // extra container style — placement is the caller's business
} = {}) {
  if (!days?.length) return "";
  const byDay = Object.fromEntries(days.map((d) => [d.day, d]));
  // Calendar positions first, THEN the scale: max is over the days drawn, so
  // a spike outside the window can't flatten the bars inside it (an all-time
  // series feeds more days than the chart shows).
  const drawn = [];
  for (let i = count - 1; i >= 0; i--) {
    const day = dayKey(Date.now() - i * 86400000);
    drawn.push({ day, d: byDay[day] });
  }
  const max = Math.max(...drawn.map(({ d }) => (d ? value(d) : 0)));
  if (max <= 0) return "";
  let bars = "";
  for (const { day, d } of drawn) {
    const v = d ? value(d) : 0;
    // Idle days keep a 1px baseline tick so the row reads as a timeline, not
    // a huddle of the active days; bottom-aligned flex puts the ticks on the
    // text baseline.
    const h = v ? Math.max(2, Math.round((v / max) * height)) : 1;
    bars += `<span title="${title(day, d)}" style="width:${barWidth}px;height:${h}px;background:#000"></span>`;
  }
  return `<span style="display:inline-flex;align-items:flex-end;gap:${gap}px;cursor:default${style ? ";" + style : ""}">${bars}</span>`;
}
