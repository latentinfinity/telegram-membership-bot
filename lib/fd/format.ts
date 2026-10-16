// PURE. Turns lists into Telegram messages (no percentages or labels shown).
import type { Lists, Pick } from './lists';

const LIMIT = 3500;

function stageText(s: string): string {
  if (s === 'LEAGUE_STAGE') return 'League phase';
  if (s === 'REGULAR_SEASON' || !s) return '';
  const t = s.replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function entry(p: Pick, mixed: boolean): string {
  const f = p.fixture;
  if (p.team) {
    const name = p.team === 'home' ? f.home : f.away;
    return `${name} (${f.home} - ${f.away})` + (mixed ? ` - ${f.compName}` : '');
  }
  const st = stageText(f.stage);
  return `${f.home} - ${f.away}` + (mixed ? ` (${f.compName}${st ? ' - ' + st : ''})` : '');
}

type Block = { title: string; picks: Pick[] };

export function formatPost(lists: Lists, premium: boolean): string[] {
  const blocks: Block[] = premium
    ? [
        { title: 'My Best Matches for Over 2.5', picks: lists.premium.over25 },
        { title: 'My Best Matches for Over 3.5', picks: lists.premium.over35 },
        { title: 'Possible Teams to score three or more goals', picks: lists.premium.teamO25 },
        { title: 'Possible Teams to score two or more goals', picks: lists.premium.teamO15 },
        { title: 'Possible Teams to score one or more goals', picks: lists.premium.teamO05 },
        { title: 'Both Teams to Score', picks: lists.premium.btts },
      ]
    : [
        { title: 'My Best Matches for Over 2.5', picks: lists.over25 },
        { title: 'My Best Matches for Over 3.5', picks: lists.over35 },
        { title: 'Possible Teams to score two or more goals', picks: lists.teamO15 },
        { title: 'Possible Teams to score one or more goals', picks: lists.teamO05 },
        { title: 'Both Teams to Score', picks: lists.btts },
      ];
  const used = blocks.filter((b) => b.picks.length > 0);
  if (used.length === 0) return [];
  const comps = new Set<string>();
  let single = '';
  for (const b of used) for (const p of b.picks) { comps.add(p.fixture.comp); single = p.fixture.compName; }
  const mixed = comps.size > 1;

  const chunks: string[] = [];
  let cur = '';
  const push = (text: string) => {
    if (cur && (cur + '\n\n' + text).length > LIMIT) { chunks.push(cur); cur = text; }
    else cur = cur ? cur + '\n\n' + text : text;
  };
  for (const b of used) {
    const title = (premium ? 'PREMIUM - ' : '') + (mixed ? '' : single + ' - ') + b.title;
    const lines = b.picks.map((p, i) => `${i + 1}) ${entry(p, mixed)}`);
    let part: string[] = [];
    let len = title.length;
    let first = true;
    for (const ln of lines) {
      if (part.length > 0 && len + ln.length + 1 > LIMIT) {
        push((first ? title : title + ' (continued)') + '\n' + part.join('\n'));
        part = []; len = title.length + 12; first = false;
      }
      part.push(ln); len += ln.length + 1;
    }
    push((first ? title : title + ' (continued)') + '\n' + part.join('\n'));
  }
  if (cur) chunks.push(cur);
  return chunks;
}
