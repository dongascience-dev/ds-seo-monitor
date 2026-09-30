#!/usr/bin/env node
/**
 * GA4 주간 수집 — 국가별 진입 · AI 채널
 *
 * GSC 로는 답할 수 없는 두 가지를 맡는다.
 *
 *   1. **국가별 실제 진입.** GSC 의 country 차원은 page 와 조합하면 클릭의 62% 가
 *      익명화로 사라진다(닷컴 2026-09-21~27 실측: 29,301 → 11,004). 게다가 GSC 는
 *      검색 클릭만 세므로 검색을 거치지 않는 유입은 아예 안 잡힌다 — 같은 주
 *      싱가포르가 GSC 클릭 1건인데 GA4 세션은 약 2만이었다.
 *   2. **AI 채널.** GA4 가 자체 분류하는 `AI Assistant` 채널. AI 답변 안에서 몇 번
 *      인용됐는지는 여전히 알 수 없지만, 인용을 보고 실제로 넘어온 사람은 셀 수 있다.
 *
 * 인증은 GSC 와 같은 서비스 계정 키를 쓴다(스코프만 analytics.readonly).
 *
 * 사용법:
 *   GSC_SERVICE_ACCOUNT_KEY_FILE=~/.gcp/gsc-reader.json node scripts/collect-ga4.mjs
 *   node scripts/collect-ga4.mjs --through=2026-09-27   # 기준일 고정
 *
 * 의존성 없음 (Node 18+ 내장 fetch).
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getAccessToken, loadServiceAccountKey } from './lib/google.mjs';

const PROPERTY = process.env.GA4_PROPERTY || 'properties/528374870'; // 동아사이언스(통합)
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const outDir = String(args.out || 'public/data');

/**
 * 서비스 = 호스트 묶음.
 * 닷컴은 www · m · m2 · apex 가 한 서비스다 — 모바일 호스트를 빼면 국가 순위가
 * 뒤집힌다(싱가포르 유입이 대부분 m. 으로 들어온다).
 */
const SERVICES = [
  {
    key: 'donga',
    name: '동아사이언스',
    hosts: [
      'www.dongascience.com',
      'm.dongascience.com',
      'm2.dongascience.com',
      'dongascience.com',
    ],
  },
  { key: 'dl', name: 'd라이브러리', hosts: ['dl.dongascience.com'] },
  { key: 'store', name: 'DS스토어', hosts: ['dsstore.dongascience.com'] },
];

const AI_CHANNEL = 'AI Assistant';

/**
 * 사람이 아닌 것으로 보이는 국가를 표시하는 기준.
 *
 * 처음엔 세션당 조회수로 걸렀는데 오탐이 났다 — 뉴스 사이트는 한 기사만 읽고
 * 나가는 게 정상이라 조회/세션이 1.0 근처인 것 자체는 흔하다(영국 1.00,
 * 콜롬비아 0.98). 실제 변별력은 **사용자/세션**에 있다.
 *
 * 실측 (닷컴 2026-09-21~27):
 *   한국 0.824 · 일본 0.888 · 영국 0.948 · 미국 0.962  ← 재방문이 있다 = 사람
 *   싱가포르 1.002 · 콜롬비아 0.999 · 중국 0.996       ← 재방문이 0 이다
 *
 * 세션 하나가 곧 새 사용자 하나라는 것은 매번 다른 기기·쿠키로 한 번씩만
 * 들어온다는 뜻이다. 사람 집단에서는 잘 나오지 않는 모양이다.
 *
 * 다만 사용자/세션만으로도 오탐이 난다 — d라이브러리·DS스토어의 미국 유입은
 * 재방문이 없지만(0.989) 세션당 1.3~1.5 페이지를 본다. 첫 방문자일 뿐 사람이다.
 * 그래서 **재방문이 없고(users/session 높음) 페이지도 거의 안 여는(views/session
 * 낮음)** 경우에만 표시한다. 두 조건을 모두 만족해야 한다.
 *
 * 이것은 **표시일 뿐 판정이 아니다** — 앱푸시 일괄 발송처럼 사람이 만든
 * 단발 유입도 같은 모양이 될 수 있어, 화면에서도 "확인 필요"로만 쓴다.
 */
const SUSPICIOUS = {
  minUsersPerSession: 0.985,
  maxViewsPerSession: 1.1,
  minSessions: 500,
};

/**
 * AI 엔진 이름 정리. GA4 는 같은 엔진을 여러 source 로 쪼개 놓는다
 * (`gemini` 와 `gemini.google.com` 이 따로 잡힌다).
 */
const ENGINE_ALIASES = [
  [/chatgpt|openai/i, 'ChatGPT'],
  [/perplexity/i, 'Perplexity'],
  [/gemini|bard/i, 'Gemini'],
  [/claude|anthropic/i, 'Claude'],
  [/copilot|bing.*chat/i, 'Copilot'],
  [/grok/i, 'Grok'],
];
const engineName = (source) =>
  ENGINE_ALIASES.find(([re]) => re.test(source))?.[1] ?? source;

// ── API ─────────────────────────────────────────────────────────────────────

let token = null;
let apiCalls = 0;

async function runReport(body) {
  const url = `https://analyticsdata.googleapis.com/v1beta/${PROPERTY}:runReport`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    apiCalls++;
    if (res.ok) return res.json();
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`GA4 ${res.status}: ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error('GA4 재시도 실패');
}

const hostFilter = (hosts) => ({
  filter: {
    fieldName: 'hostName',
    inListFilter: { values: hosts, caseSensitive: false },
  },
});

/** runReport 응답을 {키: {지표…}} 로 펴 준다. */
function rowsToObjects(res, dimNames, metricNames) {
  return (res.rows ?? []).map((row) => {
    const out = {};
    dimNames.forEach((d, i) => {
      out[d] = row.dimensionValues[i].value;
    });
    metricNames.forEach((m, i) => {
      out[m] = Number(row.metricValues[i].value);
    });
    return out;
  });
}

// ── 날짜 ────────────────────────────────────────────────────────────────────

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (isoDate, n) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
function mondayOf(isoDate) {
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return addDays(isoDate, dow === 0 ? -6 : 1 - dow);
}

/**
 * 기준일을 GSC 쪽과 맞춘다.
 *
 * GA4 는 하루 지연이라 더 최신까지 있지만, 두 화면이 다른 주를 보면 읽는 사람이
 * 혼란스럽다. gsc-weekly.json 이 있으면 그 dataThrough 를 그대로 쓴다.
 */
function resolveThrough() {
  if (args.through) return String(args.through);
  try {
    const gsc = JSON.parse(
      readFileSync(resolve(outDir, 'gsc-weekly.json'), 'utf8'),
    );
    if (gsc.dataThrough) return gsc.dataThrough;
  } catch {
    // gsc-weekly.json 이 없으면 GA4 자체 기준(어제)으로 간다.
  }
  return addDays(iso(new Date()), -1);
}

// ── 수집 ────────────────────────────────────────────────────────────────────

const RANGE = (p) => [{ startDate: p.start, endDate: p.end }];

async function countriesFor(hosts, period) {
  const res = await runReport({
    dateRanges: RANGE(period),
    dimensions: [{ name: 'country' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'screenPageViews' },
    ],
    dimensionFilter: hostFilter(hosts),
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 200,
  });
  return rowsToObjects(res, ['country'], [
    'sessions',
    'totalUsers',
    'screenPageViews',
  ]);
}

async function channelsFor(hosts, period) {
  const res = await runReport({
    dateRanges: RANGE(period),
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }],
    dimensionFilter: hostFilter(hosts),
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 50,
  });
  return Object.fromEntries(
    rowsToObjects(res, ['sessionDefaultChannelGroup'], ['sessions']).map((r) => [
      r.sessionDefaultChannelGroup,
      r.sessions,
    ]),
  );
}

async function aiEnginesFor(hosts, period) {
  const res = await runReport({
    dateRanges: RANGE(period),
    dimensions: [{ name: 'sessionSource' }],
    metrics: [{ name: 'sessions' }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          hostFilter(hosts),
          {
            filter: {
              fieldName: 'sessionDefaultChannelGroup',
              stringFilter: { matchType: 'EXACT', value: AI_CHANNEL },
            },
          },
        ],
      },
    },
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 30,
  });
  return rowsToObjects(res, ['sessionSource'], ['sessions']);
}

/** 두 기간의 국가 목록을 합치고 증감·이상 표시를 붙인다. */
function mergeCountries(cur, prev) {
  const p = new Map(prev.map((r) => [r.country, r]));
  return cur
    .map((r) => {
      const before = p.get(r.country);
      const vps = r.sessions > 0 ? r.screenPageViews / r.sessions : 0;
      return {
        country: r.country,
        sessions: r.sessions,
        users: r.totalUsers,
        views: r.screenPageViews,
        viewsPerSession: Math.round(vps * 100) / 100,
        prevSessions: before?.sessions ?? 0,
        deltaSessions: r.sessions - (before?.sessions ?? 0),
        usersPerSession:
          r.sessions > 0
            ? Math.round((r.totalUsers / r.sessions) * 1000) / 1000
            : 0,
        // 판정이 아니라 표시다. 위 주석(SUSPICIOUS) 참고.
        suspicious:
          r.sessions >= SUSPICIOUS.minSessions &&
          r.totalUsers / r.sessions >= SUSPICIOUS.minUsersPerSession &&
          vps <= SUSPICIOUS.maxViewsPerSession,
      };
    })
    .sort((a, b) => b.sessions - a.sessions);
}

/** source 행들을 엔진 단위로 합치고 전주와 붙인다. */
function mergeEngines(cur, prev) {
  const fold = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const name = engineName(r.sessionSource);
      m.set(name, (m.get(name) ?? 0) + r.sessions);
    }
    return m;
  };
  const c = fold(cur);
  const p = fold(prev);
  return [...new Set([...c.keys(), ...p.keys()])]
    .map((name) => ({
      engine: name,
      sessions: c.get(name) ?? 0,
      prevSessions: p.get(name) ?? 0,
    }))
    .sort((x, y) => y.sessions - x.sessions);
}

const sum = (rows, key) => rows.reduce((a, r) => a + (r[key] ?? 0), 0);

async function main() {
  token = await getAccessToken(loadServiceAccountKey(), SCOPE);

  const dataThrough = resolveThrough();
  const currentStart = mondayOf(dataThrough);
  const days =
    Math.round(
      (Date.parse(`${dataThrough}T00:00:00Z`) -
        Date.parse(`${currentStart}T00:00:00Z`)) /
        86400000,
    ) + 1;
  const periods = {
    current: { start: currentStart, end: dataThrough, days },
    previous: {
      start: addDays(currentStart, -7),
      end: addDays(currentStart, -7 + (days - 1)),
      days,
    },
  };

  console.error(
    `속성 ${PROPERTY} · 이번 주 ${periods.current.start}~${periods.current.end} (${days}일) vs 전주 ${periods.previous.start}~${periods.previous.end}`,
  );

  const services = {};
  for (const svc of SERVICES) {
    console.error(`  수집 ${svc.name}…`);
    const [curC, preC, curCh, preCh, curAi, preAi] = await Promise.all([
      countriesFor(svc.hosts, periods.current),
      countriesFor(svc.hosts, periods.previous),
      channelsFor(svc.hosts, periods.current),
      channelsFor(svc.hosts, periods.previous),
      aiEnginesFor(svc.hosts, periods.current),
      aiEnginesFor(svc.hosts, periods.previous),
    ]);

    const countries = mergeCountries(curC, preC);

    services[svc.key] = {
      name: svc.name,
      hosts: svc.hosts,
      sessions: {
        current: sum(curC, 'sessions'),
        previous: sum(preC, 'sessions'),
      },
      countries: countries.slice(0, 25),
      countryCount: countries.length,
      channels: { current: curCh, previous: preCh },
      ai: {
        channel: AI_CHANNEL,
        current: curCh[AI_CHANNEL] ?? 0,
        previous: preCh[AI_CHANNEL] ?? 0,
        organicCurrent: curCh['Organic Search'] ?? 0,
        organicPrevious: preCh['Organic Search'] ?? 0,
        engines: mergeEngines(curAi, preAi),
      },
    };

    const s = services[svc.key];
    const flagged = countries.filter((c) => c.suspicious);
    console.error(
      `    세션 ${s.sessions.current.toLocaleString('ko-KR')} · ${countries.length}개국 · AI ${s.ai.current.toLocaleString('ko-KR')} (자연검색 ${s.ai.organicCurrent.toLocaleString('ko-KR')})${flagged.length ? ` · 확인 필요 ${flagged.map((c) => c.country).join(', ')}` : ''}`,
    );
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    property: PROPERTY,
    dataThrough,
    periods,
    services,
    thresholds: SUSPICIOUS,
    notes: [
      'GA4 세션은 전 채널 합계다. GSC 클릭(검색만)과 직접 비교하면 안 된다.',
      'AI Assistant 는 GA4 가 자체 분류한 채널이며 2026년 6월부터 집계된다.',
      '엔진별 분해는 sessionSource 기준이라 채널 합계와 몇 % 어긋날 수 있다 — GA4 가 합계 행을 따로 계산하기 때문이며 보정하지 않았다.',
      '"확인 필요" 표시는 세션당 조회수가 낮고 규모가 큰 국가를 고른 것이다. 봇 판정이 아니라 사람이 확인할 대상 표시다.',
    ],
  };

  const outPath = resolve(outDir, 'ga4-weekly.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  console.error(`\nAPI 호출 ${apiCalls}회`);
  console.error(`기록 ${outPath}`);
}

main().catch((error) => {
  console.error(`실패: ${error.message}`);
  process.exit(1);
});
