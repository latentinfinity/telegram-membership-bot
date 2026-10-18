// PURE. Runs the Team Over rules on matches the admin stored by hand.
// Same rules, same layout as the automatic posts. Nothing is sent from here.
import { buildLists } from './lists';
import type { FixtureIn } from './lists';
import { formatPost } from './format';
import { calibratedScores } from '../correctScore';

export type ManualRow = { name: string; dataLine: string; league: string | null };
export type ManualResult = { checked: number; unreadable: string[]; normal: string[]; premium: string[] };

function splitName(name: string): [string, string] {
  for (const sep of [' - ', ' vs ', ' v ']) {
    const i = name.indexOf(sep);
    if (i > 0) return [name.slice(0, i).trim(), name.slice(i + sep.length).trim()];
  }
  return ['Home team of ' + name, 'Away team of ' + name];
}

export function runManual(rows: ManualRow[]): ManualResult {
  const unreadable: string[] = [];
  const fixtures: FixtureIn[] = [];
  rows.forEach((r, i) => {
    const parts = r.dataLine.split(',').map((x) => x.trim());
    const nums = (parts.length === 6 ? parts.slice(2) : parts).map((x) => Number(x));
    if ((parts.length !== 4 && parts.length !== 6) || nums.length !== 4 || nums.some((n) => !isFinite(n) || n < 0)) {
      unreadable.push(r.name);
      return;
    }
    const s = nums.map((n) => n.toFixed(2)); // same rounding as the automatic pipeline
    const sc = calibratedScores(s[0], s[1], s[2], s[3]);
    const [home, away] = splitName(r.name);
    fixtures.push({
      id: i + 1,
      comp: r.league ? r.league : 'MANUAL',
      compName: r.league ? r.league : '',
      stage: '',
      // stored order is the order shown: fake, increasing kickoff times
      matchDate: new Date(Date.UTC(2000, 0, 1) + i * 1000).toISOString(),
      home, away,
      hs: s[0], hc: s[1], asc: s[2], ac: s[3],
      f1h: sc ? sc.prod.home : null, f1a: sc ? sc.prod.away : null,
      f2h: sc ? sc.exp.home : null, f2a: sc ? sc.exp.away : null,
    });
  });
  const { lists } = buildLists(fixtures);
  return { checked: fixtures.length, unreadable, normal: formatPost(lists, false), premium: formatPost(lists, true) };
}
