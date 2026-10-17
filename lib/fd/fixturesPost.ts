// PURE. "X League Fixtures for this week / for today" posts. No predictions involved.
export type FxRow = { id: number; comp: string; compName: string; matchDate: string; home: string; away: string };

const LIMIT = 3500;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Nigerian time = UTC+1, no daylight saving
export function nigeriaParts(iso: string): { date: string; dow: number; hhmm: string; label: string } {
  const d = new Date(Date.parse(iso) + 3600000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  return {
    date,
    dow: d.getUTCDay(),
    hhmm: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`,
    label: `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`,
  };
}

// start/end (UTC ISO) of a Nigerian calendar day
export function dayWindow(dateStr: string): { startIso: string; endIso: string } {
  const s = Date.parse(`${dateStr}T00:00:00+01:00`);
  return { startIso: new Date(s).toISOString(), endIso: new Date(s + 86400000).toISOString() };
}

// Monday 00:00 to next Monday 00:00 (Nigerian time) of the week containing dateStr
export function weekWindow(dateStr: string): { startIso: string; endIso: string } {
  const noon = Date.parse(`${dateStr}T12:00:00+01:00`);
  const dow = nigeriaParts(new Date(noon).toISOString()).dow;
  const back = (dow + 6) % 7;
  const monday = nigeriaParts(new Date(noon - back * 86400000).toISOString()).date;
  const s = Date.parse(`${monday}T00:00:00+01:00`);
  return { startIso: new Date(s).toISOString(), endIso: new Date(s + 7 * 86400000).toISOString() };
}

export function formatFixtures(
  rows: FxRow[], kind: 'week' | 'today', dateStr: string,
): { comp: string; messages: string[] }[] {
  const byComp: Record<string, FxRow[]> = {};
  for (const r of rows) (byComp[r.comp] = byComp[r.comp] || []).push(r);
  const comps = Object.keys(byComp).sort(
    (a, b) => Date.parse(byComp[a][0].matchDate) - Date.parse(byComp[b][0].matchDate) || (a < b ? -1 : 1));
  const out: { comp: string; messages: string[] }[] = [];
  for (const c of comps) {
    const list = byComp[c].sort((a, b) => Date.parse(a.matchDate) - Date.parse(b.matchDate) || a.id - b.id);
    const name = list[0].compName;
    const header =
      kind === 'week'
        ? `${name} Fixtures for this week`
        : `${name} Fixtures for today (${nigeriaParts(`${dateStr}T12:00:00+01:00`).label})`;
    const lines: string[] = [];
    let lastDay = '';
    for (const r of list) {
      const p = nigeriaParts(r.matchDate);
      if (kind === 'week' && p.date !== lastDay) {
        if (lines.length) lines.push('');
        lines.push(p.label);
        lastDay = p.date;
      }
      lines.push(`${p.hhmm} ${r.home} - ${r.away}`);
    }
    const msgs: string[] = [];
    let cur: string[] = [];
    let len = header.length;
    for (const ln of lines) {
      if (cur.length > 0 && len + ln.length + 1 > LIMIT) {
        msgs.push((msgs.length ? header + ' (continued)' : header) + '\n\n' + cur.join('\n'));
        cur = []; len = header.length + 12;
      }
      cur.push(ln); len += ln.length + 1;
    }
    msgs.push((msgs.length ? header + ' (continued)' : header) + '\n\n' + cur.join('\n'));
    out.push({ comp: c, messages: msgs });
  }
  return out;
}
