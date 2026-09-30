#!/usr/bin/env node
/**
 * GSC 주간 수집 — 동아사이언스 3개 서비스
 *
 * Search Console API 를 직접 호출한다. MCP 를 쓰지 않는 이유가 두 가지다.
 *   1. MCP 도구에는 dimensionFilterGroups 가 없어 호스트별로 서비스를 못 가른다.
 *   2. GitHub Actions 러너에서는 MCP 자체를 띄울 수 없다.
 *
 * 인증은 서비스 계정 키만 쓴다. 키는 환경변수로만 읽으며 레포에 들어가지 않는다.
 *   GSC_SERVICE_ACCOUNT_KEY_FILE=/abs/path/key.json   (로컬)
 *   GSC_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}'  (CI · Actions secret)
 *
 * 사용법:
 *   node scripts/collect-gsc.mjs
 *   node scripts/collect-gsc.mjs --out=public/data
 *   node scripts/collect-gsc.mjs --through=2026-09-27   # 기준일 고정(재현용)
 *
 * 의존성 없음 (Node 18+ 내장 fetch · node:crypto).
 */

import { createSign } from 'node:crypto';
import { scrub } from './lib/privacy.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const SITE = process.env.GSC_SITE || 'sc-domain:dongascience.com';

/**
 * d라이브러리 전용 속성. sc-domain 을 호스트로 걸러 얻은 값과 크게 어긋나
 * (28일 환산 약 18,000 vs 120,359) 어느 쪽이 맞는지 판단이 필요해 함께 수집한다.
 * URL-prefix 속성이라 `/dl/` 경로 밖은 집계되지 않는 것으로 보이나 확인 전이다.
 */
const DL_PREFIX_SITE = 'https://dl.dongascience.com/dl/';

/**
 * 서비스 구분은 page 차원 정규식으로 한다.
 * 동아사이언스는 www · m · apex 세 호스트가 같은 서비스다.
 */
const SERVICES = [
  {
    key: 'donga',
    name: '동아사이언스',
    host: 'www.dongascience.com',
    regex: '^https?://(www\\.|m\\.)?dongascience\\.com/',
    // Discover 유입은 닷컴 기사에만 있다 (dl · dsstore 는 0건).
    discover: true,
  },
  {
    key: 'dl',
    name: 'd라이브러리',
    host: 'dl.dongascience.com',
    regex: '^https?://dl\\.dongascience\\.com/',
    discover: false,
  },
  {
    key: 'store',
    name: 'DS스토어',
    host: 'dsstore.dongascience.com',
    regex: '^https?://dsstore\\.dongascience\\.com/',
    discover: false,
  },
];

/**
 * 개발계가 검색에 잡혀 있는지 본다. 제거 진행 상황을 그대로 보여주는 지표다. (#12239)
 *
 * 처음엔 `ncdev-` 만 봤는데 `dev-science.dongascience.com` 이 빠졌다. 접두사 표기가
 * 한 가지가 아니라(`ncdev-`, `dev-`) 구분자도 `-` 와 `.` 가 섞여 있어 넓게 잡는다.
 * 운영 호스트(www · m · dl · dsstore · img …)에는 이 접두사가 없어 오탐은 없다.
 */
const DEV_HOST_REGEX =
  '^https?://(dev|ncdev|stg|staging|test)[.-][a-z0-9-]*\\.dongascience\\.com/';

const TOP_N = 100; // 표에 싣는 상위 행 수

/**
 * 증감 계산용으로 받아오는 행 수. 출력에는 상위 일부만 싣지만, 받는 행이 적으면
 * 지난주 1위가 이번 주 순위권 밖으로 밀렸을 때 "0 으로 떨어졌다"고 잘못 보고된다.
 *
 * 실측 (닷컴 2026-09-21~27): 실제 URL 14,101개 / 총 클릭 29,301.
 * 5,000행을 받으면 5,000번째 행의 클릭이 1 이고, 잘려나간 9,101개의 클릭 합은
 * 6,153 (전체의 21%) 이다. 즉 잘리는 것은 **페이지당 0~1클릭짜리 롱테일뿐**이고,
 * 상위·급상승·급하락 표에 오르는 값(수백~수천)은 컷보다 한참 위라 영향이 없다.
 *
 * 25,000(API 상한)으로 올리면 롱테일까지 받지만, 응답이 5배가 되면서 얻는 것이
 * "클릭 1짜리 페이지 목록"뿐이라 올리지 않았다. 잘린 사실은 truncated·floorClicks
 * 로 남기고 화면에 "N 미만"으로 표기한다.
 */
const FETCH_N = 5000;

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const outDir = String(args.out || 'public/data');
const forcedThrough = args.through ? String(args.through) : null;

// ── 인증 ────────────────────────────────────────────────────────────────────

function loadServiceAccountKey() {
  const inline = process.env.GSC_SERVICE_ACCOUNT_KEY;
  if (inline && inline.trim()) return JSON.parse(inline);

  const file = process.env.GSC_SERVICE_ACCOUNT_KEY_FILE;
  if (file && file.trim()) return JSON.parse(readFileSync(file.trim(), 'utf8'));

  throw new Error(
    'GSC_SERVICE_ACCOUNT_KEY_FILE 또는 GSC_SERVICE_ACCOUNT_KEY 가 필요하다.',
  );
}

const b64url = (input) => Buffer.from(input).toString('base64url');

/**
 * 서비스 계정 JWT 로 액세스 토큰을 받는다.
 * google-auth-library 를 쓰지 않는 이유는 의존성 0 을 유지하기 위해서다
 * (sitemap-audit.mjs 와 같은 규약).
 */
async function getAccessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claim}`)
    .sign(key.private_key);
  const assertion = `${header}.${claim}.${b64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`토큰 발급 실패 ${res.status}: ${await res.text()}`);
  }
  return (await res.json()).access_token;
}

// ── API ─────────────────────────────────────────────────────────────────────

let token = null;
let apiCalls = 0;

async function query(body, site = SITE) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
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
    if (res.ok) return (await res.json()).rows ?? [];
    // 429 · 5xx 는 잠깐 쉬고 다시 시도한다. 그 외는 바로 던진다.
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`GSC ${res.status} (${site}): ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`GSC 재시도 실패 (${site})`);
}

const pageFilter = (regex) => ({
  dimensionFilterGroups: [
    {
      filters: [
        { dimension: 'page', operator: 'includingRegex', expression: regex },
      ],
    },
  ],
});

// ── 날짜 ────────────────────────────────────────────────────────────────────

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (isoDate, n) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** 해당 날짜가 속한 주의 월요일. 일요일(getUTCDay()===0)은 그 주의 마지막 날이다. */
function mondayOf(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=일 … 6=토
  return addDays(isoDate, dow === 0 ? -6 : 1 - dow);
}

/**
 * 실제로 조회 가능한 최신 날짜를 찾는다.
 *
 * GSC 는 2~3일 지연되는데 그 폭이 날마다 다르다. "어제까지 집계됐다"고 가정하면
 * 빈 날이 이번 주에 섞여 들어와 전주 대비가 그만큼 낮게 나온다. 날짜 차원으로
 * 최근 구간을 받아 실제로 행이 돌아온 마지막 날을 쓴다.
 */
async function detectDataThrough() {
  const today = iso(new Date());
  const rows = await query({
    startDate: addDays(today, -14),
    endDate: today,
    dimensions: ['date'],
    rowLimit: 30,
  });
  if (!rows.length) throw new Error('최근 14일 데이터가 비어 있다.');
  return rows.map((r) => r.keys[0]).sort().at(-1);
}

// ── 집계 ────────────────────────────────────────────────────────────────────

const EMPTY = { clicks: 0, impressions: 0, ctr: 0, position: null };

const totalsFrom = (rows, withPosition = true) => {
  if (!rows.length) return { ...EMPTY };
  const r = rows[0];
  return {
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: withPosition ? (r.position ?? null) : null,
  };
};

const rowsToMap = (rows) =>
  new Map(
    rows.map((r) => [
      r.keys[0],
      {
        key: r.keys[0],
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        ctr: r.ctr ?? 0,
        position: r.position ?? null,
      },
    ]),
  );

/**
 * 두 기간을 합쳐 항목별 증감을 낸다.
 *
 * 전주에 없던 항목(prev=0)은 증가율이 무한대가 되므로 비율 대신 절대 증가분으로
 * 정렬하고 `isNew` 로 표시한다. 비율만 쓰면 클릭 1 → 3 같은 잡음이 상위를 덮는다.
 *
 * 응답이 FETCH_N 에서 잘리면 한쪽에만 있는 항목이 생긴다. 이때 반대쪽 값은 0 이
 * 아니라 "그 응답의 최저 클릭수 미만"이다 — 그대로 0 으로 쓰면 순위권 밖으로
 * 밀린 것을 실제 소멸로 보고하게 된다. floorClicks 로 구분해 둔다.
 */
function diff(currentRows, previousRows) {
  const prev = rowsToMap(previousRows);
  const cur = rowsToMap(currentRows);
  const keys = new Set([...cur.keys(), ...prev.keys()]);

  const curTruncated = currentRows.length >= FETCH_N;
  const prevTruncated = previousRows.length >= FETCH_N;
  // 잘린 응답의 마지막 행 클릭수 = 이 아래는 보이지 않는 구간.
  const curFloor = curTruncated ? (currentRows.at(-1).clicks ?? 0) : 0;
  const prevFloor = prevTruncated ? (previousRows.at(-1).clicks ?? 0) : 0;

  const merged = [];
  for (const key of keys) {
    const c = cur.get(key);
    const p = prev.get(key);
    const cv = c ?? { ...EMPTY, key };
    const pv = p ?? { ...EMPTY, key };
    merged.push({
      key,
      clicks: cv.clicks,
      impressions: cv.impressions,
      ctr: cv.ctr,
      position: cv.position,
      prevClicks: pv.clicks,
      prevImpressions: pv.impressions,
      prevCtr: pv.ctr,
      prevPosition: pv.position,
      deltaClicks: cv.clicks - pv.clicks,
      deltaImpressions: cv.impressions - pv.impressions,
      // 전주 응답에 없었다 — 응답이 잘렸다면 "신규"가 아니라 "안 보이는 구간"일 수 있다.
      isNew: !p && !prevTruncated,
      belowPrevFloor: !p && prevTruncated ? prevFloor : null,
      // 이번 주 응답에 없다 — 마찬가지로 0 이라고 단정할 수 없다.
      isGone: !c && !curTruncated,
      belowCurrentFloor: !c && curTruncated ? curFloor : null,
    });
  }

  const byClicks = [...merged].sort((a, b) => b.clicks - a.clicks);
  const byDelta = [...merged].sort((a, b) => b.deltaClicks - a.deltaClicks);

  return {
    truncated: { current: curTruncated, previous: prevTruncated },
    floorClicks: { current: curFloor, previous: prevFloor },
    rowsFetched: { current: currentRows.length, previous: previousRows.length },
    top: byClicks.slice(0, TOP_N),
    risers: byDelta.filter((r) => r.deltaClicks > 0).slice(0, 20),
    fallers: byDelta
      .filter((r) => r.deltaClicks < 0)
      .reverse()
      .slice(0, 20),
  };
}

/** 표에 검색어를 붙일 페이지 수. 이 만큼만 붙여 JSON 이 커지는 것을 막는다. */
const QUERY_PAGES = 25;
const QUERIES_PER_PAGE = 8;

/**
 * page+query 응답을 페이지별로 묶는다.
 *
 * 페이지마다 따로 조회하면 표에 올리는 60여 건에 대해 수백 번을 불러야 한다.
 * `dimensions: ['page','query']` 한 번이면 같은 정보를 얻는다.
 *
 * 주의 — 이 조합은 **클릭의 상당수가 익명화로 사라진다**. 실측(닷컴
 * 2026-09-21~27): page 단독 29,301 클릭인데 page+query 는 11,004 (62% 손실).
 * 구글이 개인 식별 우려가 있는 희소 검색어를 빼기 때문이다. 다만 클릭이 몰린
 * 기사일수록 손실이 작다 — /ko/news/79903 은 2,501 중 2,495(99.8%)가 보였다.
 * 그래서 커버리지를 함께 기록해 화면에서 밝힌다.
 */
function groupByPage(rows) {
  const map = new Map();
  for (const r of rows) {
    const [page, q] = r.keys;
    if (!map.has(page)) map.set(page, []);
    map.get(page).push({
      key: q,
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? null,
    });
  }
  for (const list of map.values()) list.sort((a, b) => b.clicks - a.clicks);
  return map;
}

/**
 * 표에 올릴 페이지들에 그 페이지의 검색어를 붙인다.
 *
 * 전주 값도 같이 붙여야 "순위가 밀린 것"과 "그 검색어를 찾는 사람이 사라진 것"을
 * 가를 수 있다. 둘은 같은 클릭 감소로 보이지만 대응이 전혀 다르다.
 */
function attachQueries(buckets, curMap, prevMap) {
  const targets = new Map();
  for (const list of [
    buckets.top.slice(0, QUERY_PAGES),
    buckets.risers,
    buckets.fallers,
  ]) {
    for (const row of list) targets.set(row.key, row);
  }

  for (const [page, row] of targets) {
    const cur = curMap.get(page) ?? [];
    const prev = new Map((prevMap.get(page) ?? []).map((q) => [q.key, q]));
    const keys = new Set([...cur.map((q) => q.key), ...prev.keys()]);

    const merged = [...keys]
      .map((k) => {
        const c = cur.find((q) => q.key === k);
        const p = prev.get(k);
        return {
          key: k,
          clicks: c?.clicks ?? 0,
          impressions: c?.impressions ?? 0,
          position: c?.position ?? null,
          prevClicks: p?.clicks ?? 0,
          prevImpressions: p?.impressions ?? 0,
          prevPosition: p?.position ?? null,
        };
      })
      .sort((a, b) => Math.max(b.clicks, b.prevClicks) - Math.max(a.clicks, a.prevClicks))
      .slice(0, QUERIES_PER_PAGE);

    const seenClicks = cur.reduce((a, q) => a + q.clicks, 0);
    row.queries = merged;
    // 검색어로 확인되는 클릭 비율. 100% 가 아니면 화면에 그대로 적는다.
    row.queryCoverage = row.clicks > 0 ? Math.round((seenClicks / row.clicks) * 100) : null;
  }
}

// ── 수집 ────────────────────────────────────────────────────────────────────

async function collectSurface({ type, regex, periods, withQueries, site }) {
  const base = regex ? pageFilter(regex) : {};
  const range = (p) => ({ startDate: p.start, endDate: p.end });
  const rows = (p, dim) =>
    query(
      { ...range(p), ...base, type, dimensions: [dim], rowLimit: FETCH_N },
      site,
    );

  // 전전주(W-2)까지 받는다. "전주에 급상승했던 항목이 이번 주에도 오르고 있나"를
  // 보려면 전주의 증감(W-2 → W-1)을 따로 계산해야 하기 때문이다.
  const [curTotal, prevTotal, curPages, prevPages, beforePages] = await Promise.all([
    query({ ...range(periods.current), ...base, type }, site),
    query({ ...range(periods.previous), ...base, type }, site),
    rows(periods.current, 'page'),
    rows(periods.previous, 'page'),
    rows(periods.beforePrevious, 'page'),
  ]);

  // Discover 는 순위·검색어 차원이 없다.
  const hasPosition = type !== 'discover';
  const surface = {
    current: totalsFrom(curTotal, hasPosition),
    previous: totalsFrom(prevTotal, hasPosition),
    pages: diff(curPages, prevPages),
    pagesPrevWeek: diff(prevPages, beforePages),
  };

  if (withQueries && hasPosition) {
    const [curQ, prevQ, beforeQ] = await Promise.all([
      rows(periods.current, 'query'),
      rows(periods.previous, 'query'),
      rows(periods.beforePrevious, 'query'),
    ]);
    surface.queries = diff(curQ, prevQ);
    surface.queriesPrevWeek = diff(prevQ, beforeQ);

    // 페이지별 검색어. 표에서 기사를 펼치면 "왜 빠졌나"를 볼 수 있다.
    const [curPQ, prevPQ] = await Promise.all([
      query(
        {
          ...range(periods.current),
          ...base,
          type,
          dimensions: ['page', 'query'],
          rowLimit: FETCH_N,
        },
        site,
      ),
      query(
        {
          ...range(periods.previous),
          ...base,
          type,
          dimensions: ['page', 'query'],
          rowLimit: FETCH_N,
        },
        site,
      ),
    ]);
    attachQueries(surface.pages, groupByPage(curPQ), groupByPage(prevPQ));
  }

  // 이번 주 급상승 항목이 전주에도 오르고 있었는지 표시한다.
  // 두 주 연속 오르면 추세고, 이번 주만 오르면 단발이다 — 대응이 다르다.
  const markSustained = (now, before) => {
    if (!now || !before) return;
    const rising = new Set(before.risers.map((r) => r.key));
    for (const r of now.risers) r.sustained = rising.has(r.key);
    const falling = new Set(before.fallers.map((r) => r.key));
    for (const r of now.fallers) r.sustained = falling.has(r.key);
  };
  markSustained(surface.pages, surface.pagesPrevWeek);
  markSustained(surface.queries, surface.queriesPrevWeek);

  return surface;
}

// ── 인사이트 규칙 ───────────────────────────────────────────────────────────

const pct = (cur, prev) => (prev > 0 ? ((cur - prev) / prev) * 100 : null);
const nf = (n) => Math.round(n).toLocaleString('ko-KR');

/**
 * 규칙 기반 인사이트. 임계값은 전부 여기 모아 둔다 — 회의에서 조정할 값이라
 * 코드 여기저기 흩어 두면 못 찾는다.
 */
const RULES = {
  clicksSwing: 20, // 서비스 클릭 증감 ±%
  positionSwing: 1.0, // 평균 순위 변동 (단위: 위)
  impUpCtrDown: { imp: 15, ctr: -10 }, // 노출은 늘었는데 CTR 은 빠진 경우

  /**
   * 개별 페이지 변동은 **그 서비스 자기 규모 대비**로 본다.
   *
   * 절대값(예: 200클릭)을 쓰면 주간 총 클릭이 212인 d라이브러리는 어떤 일이
   * 일어나도 임계값을 넘을 수 없어 영원히 조용하다. 규모가 100배 차이나는
   * 서비스에 같은 자를 대면 큰 서비스만 보인다.
   *
   * floor 는 잡음 차단용이다 — 클릭 1~4 의 출렁임까지 올리면 표가 쓰레기가 된다.
   */
  itemSwingShare: 0.03, // 서비스 주간 클릭의 3%
  itemSwingFloor: 5, // 다만 최소 5클릭은 움직여야 한다

  minBaseClicks: 50, // 이 미만은 잡음으로 보고 인사이트에서 제외
};

const BASELINE_WEEKS = 12;

/** 정렬된 배열의 분위수. 보간 없이 가장 가까운 값을 쓴다 (표본이 12개뿐이라 충분). */
const quantile = (sorted, q) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))] : null;

/**
 * 직전 N주 클릭 분포. 이번 주는 제외한다.
 *
 * 전주 대비만 보면 오판한다 — 닷컴 Discover 는 주간 클릭이 7만~29만을 오가고,
 * 전주가 27주 최고치였으면 이번 주는 정상 범위인데도 -72% 로 찍힌다. 기준선을
 * 함께 줘서 "전주보다 빠졌지만 평소 범위 안"을 구분한다.
 */
function baselineFrom(history, currentWeekEnd, pick) {
  const values = history
    .filter((h) => h.weekEnd < currentWeekEnd)
    .slice(-BASELINE_WEEKS)
    .map(pick)
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (values.length < 4) return null; // 표본이 너무 적으면 기준선을 말하지 않는다
  return {
    weeks: values.length,
    median: quantile(values, 0.5),
    low: quantile(values, 0.1),
    high: quantile(values, 0.9),
  };
}

function buildInsights(services, devHosts, history = [], currentWeekEnd = '') {
  const out = [];
  const push = (severity, service, kind, text, extra = {}) =>
    out.push({ severity, service, kind, text, ...extra });

  for (const [key, svc] of Object.entries(services)) {
    const surfaces = [['web', svc.web]];
    if (svc.discover) surfaces.push(['discover', svc.discover]);

    for (const [surface, s] of surfaces) {
      const label = surface === 'discover' ? 'Discover' : '웹 검색';
      const c = s.current;
      const p = s.previous;
      if (p.clicks < RULES.minBaseClicks && c.clicks < RULES.minBaseClicks) continue;

      const dClicks = pct(c.clicks, p.clicks);
      if (dClicks !== null && Math.abs(dClicks) >= RULES.clicksSwing) {
        const base = baselineFrom(
          history,
          currentWeekEnd,
          (h) => h.services?.[key]?.[surface]?.clicks,
        );
        // 평소 범위(최근 12주 10~90분위) 안이면 전주 대비가 커도 경보가 아니다.
        const inBand =
          base && c.clicks >= base.low && c.clicks <= base.high;
        const bandNote = base
          ? ` · 최근 ${base.weeks}주 중앙값 ${nf(base.median)} (${nf(base.low)}~${nf(base.high)}) — ${inBand ? '평소 범위 안' : '평소 범위 밖'}`
          : '';
        push(
          inBand ? 'info' : dClicks > 0 ? 'good' : 'crit',
          key,
          'clicks',
          `${label} 클릭이 전주 대비 ${dClicks > 0 ? '+' : ''}${dClicks.toFixed(1)}% (${nf(p.clicks)} → ${nf(c.clicks)})${bandNote}`,
          { baseline: base, inBand: Boolean(inBand) },
        );
      }

      const dImp = pct(c.impressions, p.impressions);
      const dCtr = pct(c.ctr, p.ctr);
      if (
        dImp !== null &&
        dCtr !== null &&
        dImp >= RULES.impUpCtrDown.imp &&
        dCtr <= RULES.impUpCtrDown.ctr
      ) {
        push(
          'warn',
          key,
          'imp-up-ctr-down',
          `${label} 노출은 ${dImp.toFixed(1)}% 늘었는데 CTR 은 ${dCtr.toFixed(1)}% 빠졌다 — 더 많이 보이지만 덜 눌린다`,
        );
      }

      if (c.position !== null && p.position !== null) {
        const move = p.position - c.position; // 양수 = 순위 상승
        if (Math.abs(move) >= RULES.positionSwing) {
          push(
            move > 0 ? 'good' : 'crit',
            key,
            'position',
            `${label} 평균 순위가 ${p.position.toFixed(1)} → ${c.position.toFixed(1)} 로 ${move > 0 ? '상승' : '하락'}`,
          );
        }
      }

      // 응답이 잘린 구간의 값은 0 이 아니라 "그 아래"다. 단정하지 않고 표기를 나눈다.
      const from = (r) =>
        r.belowPrevFloor !== null ? `${nf(r.belowPrevFloor)} 미만` : nf(r.prevClicks);
      const to = (r) =>
        r.belowCurrentFloor !== null
          ? `${nf(r.belowCurrentFloor)} 미만`
          : nf(r.clicks);

      // 자기 규모 대비 임계값. 닷컴은 약 880클릭, d라이브러리는 약 6클릭이 된다.
      const itemThreshold = Math.max(
        RULES.itemSwingFloor,
        c.clicks * RULES.itemSwingShare,
      );

      for (const r of s.pages.risers.slice(0, 3)) {
        if (r.deltaClicks < itemThreshold) break;
        push(
          'good',
          key,
          'page-up',
          `${label} — ${r.key} 클릭 +${nf(r.deltaClicks)} (${from(r)} → ${to(r)})${r.isNew ? ' · 전주에 없던 페이지' : ''}`,
        );
      }
      for (const r of s.pages.fallers.slice(0, 3)) {
        if (-r.deltaClicks < itemThreshold) break;
        push(
          'crit',
          key,
          'page-down',
          `${label} — ${r.key} 클릭 ${nf(r.deltaClicks)} (${from(r)} → ${to(r)})${r.isGone ? ' · 이번 주 노출 없음' : ''}`,
        );
      }
    }
  }

  // 조용한 서비스도 한 줄은 남긴다.
  //
  // 아무 행도 없으면 화면에서 "그 서비스를 빠뜨렸나?" 로 읽힌다. 실제로는
  // "볼 만한 변화가 없었다" 인데 둘은 전혀 다른 말이다. 기준선을 같이 적어
  // 조용한 것이 정상인지 확인할 수 있게 한다.
  for (const [key, svc] of Object.entries(services)) {
    if (out.some((i) => i.service === key)) continue;
    const c = svc.web.current;
    const base = baselineFrom(
      history,
      currentWeekEnd,
      (h) => h.services?.[key]?.web?.clicks,
    );
    const range = base
      ? ` · 최근 ${base.weeks}주 범위 ${nf(base.low)}~${nf(base.high)} 안`
      : '';
    push(
      'ok',
      key,
      'quiet',
      `임계값을 넘은 변화 없음 — 웹 검색 클릭 ${nf(c.clicks)}${range}`,
      { baseline: base, inBand: true },
    );
  }

  if (devHosts.current.impressions > 0) {
    // 어느 개발계가 걸렸는지까지 적는다. 패턴만 적으면 확인하러 GSC 를 다시
    // 뒤져야 하는데, 그러면 대시보드에 둔 의미가 없다.
    // 이번 주 노출이 0 인 호스트는 적지 않는다. 지난주 잔재라 문구만 길어진다.
    const seen = (devHosts.hosts ?? []).filter((h) => h.impressions > 0);
    // 공통 도메인은 떼고 앞부분만 적는다 — 한 줄에 여러 호스트가 들어가는데
    // `.dongascience.com` 이 반복되면 정작 다른 부분이 안 읽힌다.
    const short = (host) => host.replace(/\.dongascience\.com$/, '');
    const where = seen.length
      ? ` (${seen.map((h) => `${short(h.host)} ${nf(h.impressions)}`).join(' · ')})`
      : '';
    push(
      'crit',
      'donga',
      'dev-indexed',
      `개발계가 검색에 노출 중 — 노출 ${nf(devHosts.current.impressions)} · 클릭 ${nf(devHosts.current.clicks)}${where}. 0 이 되어야 robots.txt 로 크롤을 막을 수 있다 (#12239)`,
      { hosts: devHosts.hosts ?? [] },
    );
  }

  const order = { crit: 0, warn: 1, good: 2, info: 3, ok: 4 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ── 과거 주차 backfill ──────────────────────────────────────────────────────

/**
 * 지난 N개 주의 합계만 받아 히스토리를 채운다.
 *
 * 추세선을 0주부터 쌓으면 몇 달 뒤에야 선이 생긴다. GSC 는 16개월을 보관하므로
 * 과거를 한 번 긁어두면 첫 배포부터 추세를 볼 수 있다. 합계만 받기 때문에
 * 주당 5회 호출로 끝난다 (전체 스냅샷은 주당 31회).
 *
 * 마지막 완결 주까지만 넣는다 — 진행 중인 주는 본 수집이 따로 기록한다.
 */
async function backfill(weeks, lastCompleteWeekEnd) {
  const entries = [];
  for (let i = 0; i < weeks; i++) {
    const end = addDays(lastCompleteWeekEnd, -7 * i);
    const start = addDays(end, -6);
    const range = { startDate: start, endDate: end };
    process.stderr.write(`  backfill ${start}~${end} …`);

    const services = {};
    for (const svc of SERVICES) {
      const [web, discover] = await Promise.all([
        query({ ...range, ...pageFilter(svc.regex), type: 'web' }),
        svc.discover
          ? query({ ...range, ...pageFilter(svc.regex), type: 'discover' })
          : Promise.resolve([]),
      ]);
      services[svc.key] = {
        web: totalsFrom(web),
        discover: svc.discover ? totalsFrom(discover, false) : null,
      };
    }
    const dev = await query({
      ...range,
      ...pageFilter(DEV_HOST_REGEX),
      type: 'web',
    });

    entries.push({
      weekStart: start,
      weekEnd: end,
      days: 7,
      collectedAt: new Date().toISOString(),
      backfilled: true,
      services,
      devHosts: totalsFrom(dev),
    });
    process.stderr.write(' 완료\n');
  }
  return entries;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  token = await getAccessToken(loadServiceAccountKey());

  const dataThrough = forcedThrough || (await detectDataThrough());
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
    // 전주의 증감을 내려면 그 앞주도 필요하다. 세 구간 모두 같은 요일 수로 자른다.
    beforePrevious: {
      start: addDays(currentStart, -14),
      end: addDays(currentStart, -14 + (days - 1)),
      days,
    },
  };

  console.error(
    `기준일 ${dataThrough} · 이번 주 ${periods.current.start}~${periods.current.end} (${days}일) vs 전주 ${periods.previous.start}~${periods.previous.end} · 전전주 ${periods.beforePrevious.start}~${periods.beforePrevious.end}`,
  );

  const services = {};
  for (const svc of SERVICES) {
    console.error(`  수집 ${svc.name}…`);
    services[svc.key] = {
      name: svc.name,
      host: svc.host,
      web: await collectSurface({
        type: 'web',
        regex: svc.regex,
        periods,
        withQueries: true,
      }),
      discover: svc.discover
        ? await collectSurface({ type: 'discover', regex: svc.regex, periods })
        : null,
    };
  }

  console.error('  수집 개발계 색인 잔존…');
  const devWeb = await collectSurface({
    type: 'web',
    regex: DEV_HOST_REGEX,
    periods,
  });

  // 호스트별로 갈라 둔다. "개발계가 걸렸다"보다 "ncdev-dsstore 가 33회"가
  // 조치 가능한 정보다.
  //
  // collectSurface 가 돌려주는 pages.top 은 TOP_N(100)에서 잘려 있어, 개발계
  // URL 이 100개를 넘으면 합계와 어긋난다. 집계 전용으로 따로 받아 그 결합을
  // 끊는다. 지금은 20건 안팎이지만 수가 늘 때 조용히 틀리는 쪽이 더 나쁘다.
  const devRows = await query({
    startDate: periods.current.start,
    endDate: periods.current.end,
    ...pageFilter(DEV_HOST_REGEX),
    dimensions: ['page'],
    rowLimit: 1000,
  });

  const devByHost = new Map();
  for (const row of devRows.map((r) => ({
    key: r.keys[0],
    impressions: r.impressions ?? 0,
    clicks: r.clicks ?? 0,
  }))) {
    let host;
    try {
      host = new URL(row.key).host;
    } catch {
      continue; // 파싱 안 되는 URL 은 건너뛴다
    }
    const acc = devByHost.get(host) ?? { host, urls: 0, impressions: 0, clicks: 0 };
    acc.urls++;
    acc.impressions += row.impressions;
    acc.clicks += row.clicks;
    devByHost.set(host, acc);
  }
  const devHostList = [...devByHost.values()].sort(
    (a, b) => b.impressions - a.impressions,
  );

  console.error('  수집 d라이브러리 전용 속성 (교차검증)…');
  let dlPrefix = null;
  try {
    dlPrefix = await collectSurface({
      type: 'web',
      regex: null,
      periods,
      site: DL_PREFIX_SITE,
    });
  } catch (error) {
    // 권한이나 속성 변경으로 실패해도 본 수집을 막지 않는다.
    console.error(`    건너뜀: ${error.message}`);
  }

  // ── 주간 히스토리 ─────────────────────────────────────────────────────────
  //
  // GSC 는 16개월치를 조회할 수 있지만 "이 시점에 우리가 무엇을 봤는가"는 남지
  // 않는다. 추세선을 그리려면 매주 요약을 쌓아야 한다. 전체 스냅샷은 매주
  // 덮어쓰고(561KB), 여기에는 합계만 남긴다 — 수십 년 쌓여도 작다.
  //
  // 인사이트가 기준선(최근 12주 분포)을 쓰므로 payload 보다 먼저 읽는다.
  const historyPath = resolve(outDir, 'gsc-history.json');
  let history = [];
  try {
    history = JSON.parse(readFileSync(historyPath, 'utf8'));
    if (!Array.isArray(history)) history = [];
  } catch {
    // 파일이 없는 첫 실행. 빈 배열로 시작한다.
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    site: SITE,
    dataThrough,
    periods,
    services,
    devHosts: {
      current: devWeb.current,
      previous: devWeb.previous,
      hosts: devHostList,
      // 실제 URL 목록은 싣지 않는다. 이 JSON 은 공개되는데, 운영과 같은 내용을
      // 서빙하는 개발 서버의 살아 있는 주소 목록을 모아 주는 셈이 된다. 호스트와
      // 건수만 있으면 "제거가 끝났나"는 알 수 있고, 어느 URL 인지는 GSC 에서 본다.
      urlCount: devRows.length,
    },
    crossCheck: dlPrefix
      ? {
          dlPrefixProperty: {
            site: DL_PREFIX_SITE,
            note: 'URL-prefix 속성. sc-domain 을 호스트로 거른 값과 차이가 있어 함께 싣는다.',
            current: dlPrefix.current,
            previous: dlPrefix.previous,
          },
        }
      : {},
    insights: buildInsights(
      services,
      { current: devWeb.current, hosts: devHostList },
      history,
      periods.current.end,
    ),
  };

  const outPath = resolve(outDir, 'gsc-weekly.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(scrub(payload), null, 2)}\n`);

  const entry = {
    weekStart: periods.current.start,
    weekEnd: periods.current.end,
    days: periods.current.days,
    collectedAt: payload.generatedAt,
    services: Object.fromEntries(
      Object.entries(services).map(([key, svc]) => [
        key,
        {
          web: svc.web.current,
          discover: svc.discover ? svc.discover.current : null,
        },
      ]),
    ),
    devHosts: devWeb.current,
  };

  const fresh = [entry];

  if (args.backfill) {
    const weeks = Number(args.backfill);
    // 진행 중인 주는 본 수집이 기록하므로, 그 직전 일요일까지만 채운다.
    const lastComplete = addDays(periods.current.start, -1);
    console.error(`\n과거 ${weeks}주 backfill (기준 ${lastComplete} 이전)…`);
    fresh.push(...(await backfill(weeks, lastComplete)));
  }

  // 같은 주를 다시 수집하면 덮어쓴다. 주중에 여러 번 돌리면 날짜가 늘어난
  // 최신값이 맞기 때문이다. backfill 은 기존 값을 건드리지 않는다.
  const freshEnds = new Set(fresh.map((h) => h.weekEnd));
  history = history.filter((h) => !freshEnds.has(h.weekEnd));
  history.push(...fresh);
  history.sort((a, b) => a.weekEnd.localeCompare(b.weekEnd));
  writeFileSync(historyPath, `${JSON.stringify(scrub(history), null, 2)}\n`);

  console.error(`\nAPI 호출 ${apiCalls}회 · 인사이트 ${payload.insights.length}건`);
  console.error(`기록 ${outPath}`);
  console.error(`히스토리 ${historyPath} (${history.length}주)`);
}

main().catch((error) => {
  console.error(`실패: ${error.message}`);
  process.exit(1);
});
