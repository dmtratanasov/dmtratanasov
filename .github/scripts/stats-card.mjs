// Renders the GitHub stats card shown in the profile README.
//
// Numbers come from the contribution calendar, the same data as the heatmap
// on the profile page. It includes private contributions (the profile has
// "Include private contributions" turned on), so any token can read it,
// including the workflow's built-in GITHUB_TOKEN.
//
// Usage: GITHUB_TOKEN=... GH_LOGIN=... node stats-card.mjs <out.svg>

import {mkdir, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

const token = process.env.GITHUB_TOKEN;
const login = process.env.GH_LOGIN;
const outFile = process.argv[2] ?? 'github-stats.svg';

if (!token || !login) {
    console.error('GITHUB_TOKEN and GH_LOGIN must be set');
    process.exit(1);
}

async function graphql(query, variables) {
    const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
            Authorization: `bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'profile-stats-card'
        },
        body: JSON.stringify({query, variables})
    });
    const body = await res.json();
    if (!res.ok || body.errors || !body.data?.user) {
        throw new Error(`GitHub GraphQL request failed (${res.status}): ${JSON.stringify(body.errors ?? body)}`);
    }
    return body.data.user;
}

// ---- data ----

const DAYS = 'weeks { contributionDays { contributionCount date } }';

// Trailing 12 months (GitHub's default window) plus the list of active years.
const user = await graphql(
    `query ($login: String!) {
        user(login: $login) {
            createdAt
            contributionsCollection {
                contributionYears
                contributionCalendar { totalContributions }
            }
        }
    }`,
    {login}
);

// Every year on record, day by day (a single range can't exceed a year).
const {contributionYears} = user.contributionsCollection;
const yearFields = contributionYears
    .map(
        year => `y${year}: contributionsCollection(from: "${year}-01-01T00:00:00Z", to: "${year}-12-31T23:59:59Z") {
            contributionCalendar { totalContributions ${DAYS} }
        }`
    )
    .join('\n');
const byYear = await graphql(`query ($login: String!) { user(login: $login) { ${yearFields} } }`, {login});

const today = new Date().toISOString().slice(0, 10);
const perMonth = new Map();
for (const year of contributionYears) {
    for (const week of byYear[`y${year}`].contributionCalendar.weeks) {
        for (const day of week.contributionDays) {
            // Calendar weeks can spill into neighbouring years and the future.
            if (!day.date.startsWith(`${year}-`) || day.date > today) continue;
            const month = day.date.slice(0, 7);
            perMonth.set(month, (perMonth.get(month) ?? 0) + day.contributionCount);
        }
    }
}

const nextMonth = month => {
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 7);
};

// Contiguous months from the first activity (or account creation) to now.
const firstActive = [...perMonth].filter(([, n]) => n > 0).map(([m]) => m).sort()[0];
const startMonth = [user.createdAt.slice(0, 7), firstActive].filter(Boolean).sort()[0];
const months = [];
for (let m = startMonth; m <= today.slice(0, 7); m = nextMonth(m)) {
    months.push({month: m, count: perMonth.get(m) ?? 0});
}

let running = 0;
const cumulative = months.map(m => ({month: m.month, total: (running += m.count)}));
const allTime = running;
const lastYear = user.contributionsCollection.contributionCalendar.totalContributions;
const bestMonth = months.reduce((best, m) => (m.count > best.count ? m : best));

const monthYear = month =>
    new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', {month: 'short', year: 'numeric', timeZone: 'UTC'});
const format = n => n.toLocaleString('en-US');

const stats = [
    {value: format(allTime), label: 'TOTAL CONTRIBUTIONS', detail: `Since ${monthYear(startMonth)}`},
    {value: format(lastYear), label: 'PAST 12 MONTHS', detail: 'Contributions'},
    {value: format(bestMonth.count), label: 'BEST MONTH', detail: monthYear(bestMonth.month)}
];

// ---- design (matches banner.png: near-black, lime accent, purple glow) ----

const c = {
    bg: '#09090B',
    border: '#27272A',
    lime: '#CDF542',
    purple: '#6D4AFF',
    number: '#FAFAFA',
    label: '#A1A1AA',
    detail: '#71717A',
    faint: '#52525B'
};
const sans = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const mono = "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, Consolas, monospace";

const W = 720;
const H = 320;
const PAD = 36;
const inner = W - PAD * 2;

// Stats row: three left-aligned columns with hairline dividers.
const col = inner / 3;
const statsSvg = stats
    .map((stat, i) => {
        const x = PAD + col * i + (i === 0 ? 0 : 24);
        const divider =
            i === 0 ? '' : `<line x1="${PAD + col * i}" y1="84" x2="${PAD + col * i}" y2="166" stroke="${c.border}" />`;
        return `${divider}
  <g class="rise" style="animation-delay:${0.1 + i * 0.1}s">
    <text x="${x}" y="122" fill="${c.number}" font-family="${sans}" font-size="44" font-weight="700" letter-spacing="-1.5">${stat.value}</text>
    <text x="${x}" y="146" fill="${c.label}" font-family="${mono}" font-size="11" letter-spacing="1.6">${stat.label}</text>
    <text x="${x}" y="164" fill="${c.detail}" font-family="${sans}" font-size="12">${stat.detail}</text>
  </g>`;
    })
    .join('');

// Chart: cumulative contributions per month, smoothed with a monotone curve
// (never overshoots, so a rising series stays rising).
const top = 206;
const base = 274;
const max = Math.max(1, allTime);
const step = cumulative.length > 1 ? inner / (cumulative.length - 1) : 0;
const points = cumulative.map((m, i) => ({x: PAD + step * i, y: base - (m.total / max) * (base - top), month: m.month}));
const r1 = v => Math.round(v * 10) / 10;

function monotonePath(pts) {
    const n = pts.length;
    if (n < 2) return `M${r1(pts[0].x)},${r1(pts[0].y)}`;
    const dx = pts.slice(1).map((p, i) => p.x - pts[i].x);
    const slope = pts.slice(1).map((p, i) => (p.y - pts[i].y) / dx[i]);
    const t = pts.map((_, i) => {
        if (i === 0) return slope[0];
        if (i === n - 1) return slope[n - 2];
        if (slope[i - 1] * slope[i] <= 0) return 0;
        return (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / slope[i - 1] + (dx[i] + 2 * dx[i - 1]) / slope[i]);
    });
    let d = `M${r1(pts[0].x)},${r1(pts[0].y)}`;
    for (let i = 0; i < n - 1; i++) {
        const h = dx[i] / 3;
        d += ` C${r1(pts[i].x + h)},${r1(pts[i].y + t[i] * h)} ${r1(pts[i + 1].x - h)},${r1(pts[i + 1].y - t[i + 1] * h)} ${r1(pts[i + 1].x)},${r1(pts[i + 1].y)}`;
    }
    return d;
}

const line = monotonePath(points);
const area = `${line} L${r1(points.at(-1).x)},${base} L${r1(points[0].x)},${base} Z`;
const end = points.at(-1);

// X axis: a tick at each January, plus "NOW" at the end.
const axis = points
    .filter((p, i) => i > 0 && p.month.endsWith('-01') && end.x - p.x > 48)
    .map(
        p => `<line x1="${r1(p.x)}" y1="${top - 6}" x2="${r1(p.x)}" y2="${base}" stroke="${c.border}" stroke-dasharray="2 4" />
  <text x="${r1(p.x)}" y="298" text-anchor="middle" fill="${c.faint}" font-family="${mono}" font-size="10" letter-spacing="1">${p.month.slice(0, 4)}</text>`
    )
    .join('\n  ');

const summary = stats.map(s => `${s.value} ${s.label.toLowerCase()} (${s.detail})`).join(', ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title">
  <title id="title">GitHub activity: ${summary}</title>
  <style>
    .pulse { transform-box: fill-box; transform-origin: center; }
    @media (prefers-reduced-motion: no-preference) {
      .rise { animation: rise .7s cubic-bezier(.2,.7,.2,1) both; }
      .draw { animation: draw 1.8s cubic-bezier(.65,0,.35,1) .35s both; }
      .fade { animation: fade .9s ease-out 1.2s both; }
      .pop { animation: fade .4s ease-out 2s both; }
      .pulse { animation: pulse 2.4s ease-out 2.2s infinite both; }
    }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
    @keyframes draw { from { stroke-dashoffset: 1; } }
    @keyframes fade { from { opacity: 0; } }
    @keyframes pulse { from { transform: scale(.5); opacity: .9; } to { transform: scale(2.2); opacity: 0; } }
  </style>
  <defs>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="12" /></clipPath>
    <radialGradient id="glow-purple" cx="100%" cy="0%" r="70%">
      <stop offset="0" stop-color="${c.purple}" stop-opacity=".28" />
      <stop offset="1" stop-color="${c.purple}" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="glow-lime" cx="0%" cy="100%" r="60%">
      <stop offset="0" stop-color="${c.lime}" stop-opacity=".10" />
      <stop offset="1" stop-color="${c.lime}" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c.lime}" stop-opacity=".30" />
      <stop offset="1" stop-color="${c.lime}" stop-opacity="0" />
    </linearGradient>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0H0V32" fill="none" stroke="#FFFFFF" stroke-opacity=".035" />
    </pattern>
  </defs>

  <g clip-path="url(#card)">
    <rect width="${W}" height="${H}" fill="${c.bg}" />
    <rect width="${W}" height="${H}" fill="url(#grid)" />
    <rect width="${W}" height="${H}" fill="url(#glow-purple)" />
    <rect width="${W}" height="${H}" fill="url(#glow-lime)" />
  </g>
  <rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="11.5" fill="none" stroke="${c.border}" />

  <circle cx="${PAD + 4}" cy="40" r="8" fill="${c.lime}" fill-opacity=".22" />
  <circle cx="${PAD + 4}" cy="40" r="3.5" fill="${c.lime}" />
  <text x="${PAD + 20}" y="44" fill="#D4D4D8" font-family="${mono}" font-size="12" letter-spacing="3">GITHUB ACTIVITY</text>
  <text x="${W - PAD}" y="44" text-anchor="end" fill="${c.detail}" font-family="${mono}" font-size="10" letter-spacing="2">INCL. PRIVATE REPOS</text>
  ${statsSvg}

  <text x="${PAD}" y="${top - 12}" fill="${c.faint}" font-family="${mono}" font-size="10" letter-spacing="1.6">CONTRIBUTIONS OVER TIME</text>
  ${axis}
  <line x1="${PAD}" y1="${base}" x2="${W - PAD}" y2="${base}" stroke="${c.border}" />
  <path class="fade" d="${area}" fill="url(#area)" />
  <path class="draw" d="${line}" pathLength="1" stroke-dasharray="1" fill="none" stroke="${c.lime}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  <g class="pop">
    <circle class="pulse" cx="${r1(end.x)}" cy="${r1(end.y)}" r="5" fill="${c.lime}" fill-opacity=".35" />
    <circle cx="${r1(end.x)}" cy="${r1(end.y)}" r="4.5" fill="${c.lime}" stroke="${c.bg}" stroke-width="2" />
  </g>
  <text x="${W - PAD}" y="298" text-anchor="end" fill="${c.lime}" font-family="${mono}" font-size="10" letter-spacing="1">NOW</text>
</svg>
`;

await mkdir(dirname(outFile), {recursive: true});
await writeFile(outFile, svg);
console.log(`Wrote ${outFile}: ${summary}`);
