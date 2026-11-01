// Regenerates assets/heatmap.svg and the "most starred repositories" table in README.md.
// Runs in GitHub Actions (see .github/workflows/update-profile.yml) or locally: `node scripts/update-profile.mjs`.
// Reads live data from GitHub at build time only; the generated SVG itself makes no network requests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER = process.env.PROFILE_USER || process.env.GITHUB_REPOSITORY_OWNER || 'imhamiddev';
const TOKEN = process.env.GITHUB_TOKEN || '';
const TOP_N = 6;
const NAVY = '#070b16', PANEL = '#0d1424', BLUE = '#247bff', RED = '#ff354f', INK = '#eef1f8', MUTE = '#9aa4bd';
const DISP = "'BarlowCond','Barlow Condensed','Arial Narrow',Impact,sans-serif";
const MONO = "'JBMono','JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const LEVEL_COLORS = ['#121b33', '#163a73', '#1f5fc2', '#247bff', '#9cc9ff'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f2 = (n) => String(Math.round(n * 100) / 100);
const headers = { 'User-Agent': 'profile-readme-updater', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };

// ---------- data ----------
async function contributionsGraphQL() {
  const q = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount contributionLevel}}}}}}`;
  const r = await fetch('https://api.github.com/graphql', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, variables: { login: USER } }) });
  if (!r.ok) throw new Error(`GraphQL ${r.status}`);
  const j = await r.json();
  const cal = j.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) throw new Error('GraphQL returned no calendar');
  const lv = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
  const days = cal.weeks.flatMap((w) => w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount, level: lv[d.contributionLevel] ?? 0 })));
  return { days, total: cal.totalContributions };
}
async function contributionsScrape() {
  const r = await fetch(`https://github.com/users/${USER}/contributions`, { headers });
  if (!r.ok) throw new Error(`contributions page ${r.status}`);
  const html = await r.text();
  const counts = new Map();
  for (const m of html.matchAll(/<tool-tip[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const n = /^No contributions/.test(m[2].trim()) ? 0 : parseInt((m[2].match(/^([\d,]+)\s+contribution/) || [0, '0'])[1].replace(/,/g, ''), 10);
    counts.set(m[1], n);
  }
  const days = [];
  for (const m of html.matchAll(/<td[^>]*data-date="([^"]+)"[^>]*id="([^"]+)"[^>]*data-level="(\d)"[^>]*>/g)) days.push({ date: m[1], count: counts.get(m[2]) ?? 0, level: +m[3] });
  if (!days.length) throw new Error('no contribution cells found');
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days, total: days.reduce((s, d) => s + d.count, 0) };
}
async function getContributions() {
  if (TOKEN) { try { return await contributionsGraphQL(); } catch (e) { console.warn('GraphQL failed, falling back:', e.message); } }
  return contributionsScrape();
}
async function reposREST() {
  const r = await fetch(`https://api.github.com/users/${USER}/repos?per_page=100&type=owner`, { headers });
  if (!r.ok) throw new Error(`repos ${r.status}`);
  return (await r.json()).map((x) => ({ name: x.name, url: x.html_url, desc: x.description || '', lang: x.language || '', stars: x.stargazers_count, fork: x.fork, pushed: x.pushed_at || '' }));
}
async function reposScrape() {
  const r = await fetch(`https://github.com/${USER}?tab=repositories&type=source`, { headers });
  if (!r.ok) throw new Error(`repos page ${r.status}`);
  const html = await r.text();
  const out = [];
  for (const it of html.split(/<li[^>]*itemprop="owns"/).slice(1)) {
    const name = it.match(new RegExp(`href="/${USER}/([^"]+)"`))?.[1]; if (!name) continue;
    const lang = it.match(/itemprop="programmingLanguage">([^<]+)</)?.[1] || '';
    const desc = (it.match(/itemprop="description"[^>]*>\s*([\s\S]*?)\s*<\/p>/)?.[1] || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    const st = it.match(new RegExp(`href="/${USER}/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/stargazers"[^>]*>([\\s\\S]*?)</a>`))?.[1] || '0';
    out.push({ name, url: `https://github.com/${USER}/${name}`, desc, lang, stars: parseInt(st.replace(/<[^>]+>/g, '').replace(/[^\d]/g, '') || '0', 10), fork: false, pushed: '' });
  }
  if (!out.length) throw new Error('no repos found');
  return out;
}
async function getTopRepos() {
  let repos;
  try { repos = await reposREST(); } catch (e) { console.warn('REST failed, scraping instead:', e.message); repos = await reposScrape(); }
  return repos.filter((r) => !r.fork && r.name.toLowerCase() !== USER.toLowerCase())
    .sort((a, b) => b.stars - a.stars || b.pushed.localeCompare(a.pushed) || a.name.localeCompare(b.name)).slice(0, TOP_N);
}

// ---------- stats ----------
function stats(days) {
  let best = days[0], run = 0, longest = 0, longestEnd = '';
  for (const d of days) { if (d.count > best.count) best = d; if (d.count > 0) { run++; if (run > longest) { longest = run; longestEnd = d.date; } } else run = 0; }
  return { best, longest, active: days.filter((d) => d.count > 0).length };
}

// ---------- heatmap svg ----------
const font = (file, family, weight) => `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:block;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(ROOT, 'scripts/fonts', file)).toString('base64')}) format('woff2')}`;
function heatmapSVG({ days, total }, updated) {
  const W = 830, H = 318, GX = 74, GY = 138;
  const toDate = (s) => new Date(s + 'T00:00:00Z');
  const first = toDate(days[0].date); const startWeek = new Date(first.getTime() - first.getUTCDay() * 86400000);
  const weekOf = (d) => Math.floor((toDate(d.date) - startWeek) / (7 * 86400000));
  const weeks = weekOf(days[days.length - 1]) + 1;
  const pitch = (W - GX - 40) / weeks, cell = pitch - 2.6;
  const st = stats(days);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let cols = '', monthLabels = '', lastMonth = -1, lastX = -99;
  for (let w = 0; w < weeks; w++) {
    const wd = days.filter((d) => weekOf(d) === w); if (!wd.length) continue;
    let rects = '';
    for (const d of wd) {
      const row = toDate(d.date).getUTCDay(); const isBest = d === st.best && d.count > 0;
      rects += `<rect x="${f2(GX + w * pitch)}" y="${f2(GY + row * pitch)}" width="${f2(cell)}" height="${f2(cell)}" rx="2.6" fill="${LEVEL_COLORS[d.level]}"${isBest ? ` stroke="${RED}" stroke-width="1.6" class="hm-best"` : ''}><title>${d.count} contribution${d.count === 1 ? '' : 's'} on ${d.date}</title></rect>`;
    }
    cols += `<g class="hm-c" style="animation-delay:${f2(w * 0.016)}s">${rects}</g>`;
    const m = toDate(wd[0].date).getUTCMonth(); const x = GX + w * pitch;
    if (m !== lastMonth && x - lastX > 34) { monthLabels += `<text class="m" x="${f2(x)}" y="${GY - 10}" font-size="10.5" fill="${MUTE}">${MONTHS[m]}</text>`; lastMonth = m; lastX = x; }
  }
  const wl = [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']].map(([r, t]) => `<text class="m" x="${GX - 8}" y="${f2(GY + r * pitch + cell - 1.5)}" text-anchor="end" font-size="10" fill="${MUTE}">${t}</text>`).join('');
  const statBox = (x, big, small, col) => `<g class="hm-in"><text class="d" x="${x}" y="64" font-size="46" fill="${col}">${esc(big)}</text><text class="m" x="${x}" y="84" font-size="11" fill="${MUTE}">${esc(small)}</text></g>`;
  const stats3 = statBox(436, String(total), 'contributions', INK) + statBox(566, `${st.longest}d`, 'longest streak', BLUE) + statBox(706, String(st.best.count), 'best day', RED);
  const legX = W - 40 - (5 * 15 + 80);
  const legend = `<text class="m" x="${legX}" y="${GY + 7 * pitch + 26}" font-size="10.5" fill="${MUTE}">Less</text>` + LEVEL_COLORS.map((c, i) => `<rect x="${legX + 32 + i * 15}" y="${GY + 7 * pitch + 16}" width="11" height="11" rx="2.6" fill="${c}"/>`).join('') + `<text class="m" x="${legX + 32 + 5 * 15 + 4}" y="${GY + 7 * pitch + 26}" font-size="10.5" fill="${MUTE}">More</text>`;
  const css = font('disp800.woff2', 'BarlowCond', 800) + font('mono500.woff2', 'JBMono', 500)
    + `.d{font-family:${DISP};font-weight:800}.m{font-family:${MONO};font-weight:500}`
    + `@keyframes hm-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@keyframes hm-pulse{0%,100%{stroke-opacity:1}50%{stroke-opacity:.25}}`
    + `.hm-c{animation:hm-in .6s cubic-bezier(.2,.8,.2,1) both}.hm-in{animation:hm-in .8s cubic-bezier(.2,.8,.2,1) both}.hm-best{animation:hm-pulse 2.4s ease-in-out infinite}`
    + `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="hm-t hm-d">`
    + `<title id="hm-t">Contribution heatmap for ${esc(USER)}</title><desc id="hm-d">${total} contributions in the last year, longest streak ${st.longest} days, best day ${st.best.count} contributions on ${st.best.date}. Updated ${esc(updated)}.</desc>`
    + `<!-- Fonts: Barlow Condensed and JetBrains Mono, SIL OFL 1.1, subsetted. Generated by scripts/update-profile.mjs. -->`
    + `<defs><style>${css}</style><linearGradient id="hm-hair" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BLUE}"/><stop offset="1" stop-color="${RED}"/></linearGradient>`
    + `<pattern id="hm-dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#18233f"/></pattern>`
    + `<radialGradient id="hm-gb" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${BLUE}" stop-opacity=".28"/><stop offset="1" stop-color="${BLUE}" stop-opacity="0"/></radialGradient>`
    + `<clipPath id="hm-clip"><rect width="${W}" height="${H}" rx="24"/></clipPath></defs>`
    + `<g clip-path="url(#hm-clip)"><rect width="${W}" height="${H}" fill="${NAVY}"/><rect width="${W}" height="${H}" fill="url(#hm-dots)"/><circle cx="130" cy="40" r="300" fill="url(#hm-gb)"/></g>`
    + `<text class="d" x="44" y="68" font-size="52" fill="${INK}">ACTIVITY</text><text class="m" x="46" y="90" font-size="11.5" fill="${MUTE}">github.com/${esc(USER)} · updated ${esc(updated)}</text>`
    + stats3 + monthLabels + wl + cols + legend
    + `<text class="m" x="46" y="${GY + 7 * pitch + 26}" font-size="10.5" fill="${MUTE}">Refreshed automatically every day.</text>`
    + `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="23" fill="none" stroke="url(#hm-hair)" stroke-opacity=".8" stroke-width="1.5"/></svg>`;
}

// ---------- README ----------
function reposTable(repos) {
  const rows = repos.map((r) => {
    const d = (r.desc || 'No description yet.').replace(/\s+/g, ' ').replace(/\|/g, '\\|'); const short = d.length > 150 ? d.slice(0, 147).trimEnd() + '…' : d;
    return `| [${r.name}](${r.url}) | ${short} | ${r.lang || '—'} | ★ ${r.stars} |`;
  });
  return ['| Project | What it does | Language | Stars |', '| --- | --- | --- | --- |', ...rows].join('\n');
}
function updateReadme(repos, stamp) {
  const p = path.join(ROOT, 'README.md'); let md = fs.readFileSync(p, 'utf8');
  md = md.replace(/(<!-- TOP-REPOS:START -->)[\s\S]*?(<!-- TOP-REPOS:END -->)/, `$1\n${reposTable(repos)}\n$2`);
  md = md.replace(/(\.\/assets\/heatmap\.svg\?v=)[^)\s]*/, `$1${stamp}`);
  fs.writeFileSync(p, md);
}

const now = new Date(); const updated = now.toISOString().slice(0, 10); const stamp = updated.replace(/-/g, '');
const [contrib, repos] = await Promise.all([getContributions(), getTopRepos()]);
fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'assets/heatmap.svg'), heatmapSVG(contrib, updated));
updateReadme(repos, stamp);
console.log(`heatmap: ${contrib.total} contributions, ${contrib.days.length} days; top repos: ${repos.map((r) => `${r.name}(${r.stars})`).join(', ')}`);
