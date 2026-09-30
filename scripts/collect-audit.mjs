#!/usr/bin/env node
/**
 * SEO · AEO · GEO 준비도 전수 측정
 *
 * readiness.json 을 손으로 채우던 것을 대체한다. 세 가지를 직접 받아서 센다.
 *   1. robots.txt  — 어느 봇이 열려 있나 (GEO 축 전부 + SEO 검색봇 항목)
 *   2. sitemap.xml — 무엇이 몇 개 들어 있나, 언제 갱신됐나
 *   3. 상세 페이지 — h1 · JSON-LD · canonical · meta description · dateModified
 *
 * 상세 페이지 URL 출처가 서비스마다 다르다. 닷컴은 사이트맵에 기사가 있지만,
 * d라이브러리·DS스토어는 사이트맵에 상세가 거의 없어(각각 3건·0건) 검색에
 * 실제로 노출된 URL 을 GSC 에서 받아 쓴다. 그 편이 "팔아야 할 페이지"에 가깝다.
 *
 * 사용법:
 *   GSC_SERVICE_ACCOUNT_KEY_FILE=~/.gcp/gsc-reader.json node scripts/collect-audit.mjs
 *   node scripts/collect-audit.mjs --max=300      # 서비스당 상세 크롤 상한
 *   node scripts/collect-audit.mjs --no-gsc       # GSC 없이 사이트맵만으로
 *
 * 의존성 없음 (Node 18+ 내장 fetch).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import {
  createQuery,
  getAccessToken,
  loadServiceAccountKey,
  pageFilter,
} from './lib/google.mjs';

const SITE = process.env.GSC_SITE || 'sc-domain:dongascience.com';
const UA = 'Mozilla/5.0 (compatible; ds-seo-monitor/1.0; +internal-audit)';
const TIMEOUT_MS = 20000;
const CONCURRENCY = 8;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const outDir = String(args.out || 'public/data');
const MAX_PAGES = Number(args.max || 300);
const useGsc = !args['no-gsc'];

const SERVICES = [
  {
    key: 'donga',
    name: '동아사이언스',
    origin: 'https://www.dongascience.com',
    gscRegex: '^https?://(www\\.|m\\.)?dongascience\\.com/',
    /**
     * 전체 콘텐츠 추정치. 이것만은 크롤로 못 센다 — 기사 ID 를 전수 조회해야
     * 하고 그건 주간 작업에 넣을 부하가 아니다. 출처를 함께 적어 둔다.
     */
    contentEstimate: { value: 80094, source: '기사 ID 무작위 400건 조회 (2026-09-29)' },
    classify: (path) => {
      if (/^\/(ko|en)\/news\/\d+/.test(path)) return 'detail';
      if (/^\/news\/\d+/.test(path)) return 'duplicate'; // 비언어 — canonical 이 /ko 를 가리킴
      if (/^\/(ko|en)?\/?(category|special)\//.test(path)) return 'list';
      return 'other';
    },
    // 상세 크롤 대상은 사이트맵의 정본(/ko/ · /en/)만 쓴다.
    detailFromSitemap: (path) => /^\/(ko|en)\/news\/\d+/.test(path),
  },
  {
    key: 'dl',
    name: 'd라이브러리',
    origin: 'https://dl.dongascience.com',
    gscRegex: '^https?://dl\\.dongascience\\.com/',
    contentEstimate: { value: 34700, source: '매체 4종 × 1986~2026 발행호 전수 961호 × 호당 평균 (2026-09-29)' },
    classify: (path) => {
      if (/^\/dl\/search/.test(path)) return 'search'; // 색인되면 안 되는 검색결과
      if (/\/detail\//.test(path)) return 'detail';
      return 'list';
    },
    detailFromSitemap: (path) => /\/detail\//.test(path),
  },
  {
    key: 'store',
    name: 'DS스토어',
    origin: 'https://dsstore.dongascience.com',
    gscRegex: '^https?://dsstore\\.dongascience\\.com/',
    contentEstimate: { value: 447, source: 'GSC 노출 상품 수 (하한)' },
    classify: (path) => {
      if (/^\/search/.test(path)) return 'search';
      if (/^\/product\//.test(path)) return 'detail';
      return 'list';
    },
    detailFromSitemap: (path) => /^\/product\//.test(path),
  },
];

/** 점수를 매기는 봇. 역할이 달라 축도 다르다. */
const BOTS = {
  search: ['Googlebot', 'Bingbot', 'Yeti'],
  geo: [
    { ua: 'OAI-SearchBot', max: 20, role: 'ChatGPT 검색 색인' },
    { ua: 'Claude-SearchBot', max: 20, role: 'Claude 검색 색인' },
    { ua: 'PerplexityBot', max: 20, role: 'Perplexity 색인' },
    { ua: 'ChatGPT-User', max: 40, role: 'ChatGPT 실시간 인용' },
  ],
};

// ── HTTP ────────────────────────────────────────────────────────────────────

async function get(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: ac.signal,
      redirect: 'follow',
    });
    return {
      ok: res.ok,
      status: res.status,
      redirected: res.redirected,
      body: res.ok ? await res.text() : '',
    };
  } catch (error) {
    return { ok: false, status: 0, body: '', error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** 동시 실행 상한을 두고 순서대로 흘려보낸다. 사이트에 부하를 주지 않기 위해서다. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ── robots.txt ──────────────────────────────────────────────────────────────

/**
 * robots.txt 를 그룹 단위로 파싱한다.
 *
 * 표준대로 **가장 구체적인 하나의 그룹만** 적용된다 — UA 이름이 정확히 맞는
 * 그룹이 있으면 그것만 보고, 없으면 `*` 그룹을 본다. 둘 다 없으면 허용이다.
 * "`*` 가 Disallow 여도 이름이 있으면 그쪽이 이긴다"는 점이 핵심이라,
 * 닷컴처럼 허용리스트로 운영하는 경우를 정확히 읽으려면 이 규칙이 필요하다.
 */
function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasUa = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasUa) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasUa = true;
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) continue;
      current.rules.push({ allow: field === 'allow', path: value });
      lastWasUa = false;
    } else {
      lastWasUa = false;
    }
  }
  return groups;
}

function isAllowed(groups, userAgent, path = '/') {
  const ua = userAgent.toLowerCase();
  const exact = groups.find((g) => g.agents.includes(ua));
  const star = groups.find((g) => g.agents.includes('*'));
  const group = exact ?? star;
  if (!group) return true; // 해당 그룹이 없으면 허용이 기본값

  // 같은 경로에 규칙이 여럿이면 더 긴(구체적인) 쪽이 이긴다. 길이가 같으면 Allow.
  let best = null;
  for (const rule of group.rules) {
    if (rule.path === '') continue; // 빈 Disallow 는 "전부 허용"을 뜻한다
    if (!path.startsWith(rule.path.replace(/\*$/, ''))) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow)
    ) {
      best = rule;
    }
  }
  if (!best) return !group.rules.some((r) => r.path === '/' && !r.allow);
  return best.allow;
}

// ── sitemap ─────────────────────────────────────────────────────────────────

const tagAll = (xml, tag) =>
  [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map(
    (m) => m[1].trim(),
  );

/** sitemapindex 면 하위 사이트맵을 모두 따라간다. */
async function fetchSitemap(origin) {
  const root = `${origin}/sitemap.xml`;
  const res = await get(root);
  if (!res.ok) return { ok: false, status: res.status, url: root, urls: [], lastmods: [] };

  const collect = async (xml) => {
    if (/<sitemapindex/i.test(xml)) {
      const children = tagAll(xml, 'sitemap').map((block) => tagAll(block, 'loc')[0]);
      const parts = await mapLimit(children.filter(Boolean), 4, async (loc) => {
        const r = await get(loc);
        return r.ok ? r.body : '';
      });
      const merged = { urls: [], lastmods: [] };
      for (const part of parts) {
        const sub = await collect(part);
        merged.urls.push(...sub.urls);
        merged.lastmods.push(...sub.lastmods);
      }
      // 인덱스 자체의 lastmod 도 갱신 신호다.
      merged.lastmods.push(
        ...tagAll(xml, 'sitemap').flatMap((b) => tagAll(b, 'lastmod')),
      );
      return merged;
    }
    const blocks = tagAll(xml, 'url');
    return {
      urls: blocks.map((b) => tagAll(b, 'loc')[0]).filter(Boolean),
      lastmods: blocks.flatMap((b) => tagAll(b, 'lastmod')),
    };
  };

  const { urls, lastmods } = await collect(res.body);
  return { ok: true, status: 200, url: root, urls, lastmods };
}

// ── 상세 페이지 파싱 ─────────────────────────────────────────────────────────

function parseJsonLd(html) {
  const out = [];
  for (const m of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed = JSON.parse(m[1].trim().replace(/\\u003c/g, '<'));
      out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // 깨진 JSON-LD 는 검색엔진도 못 읽는다. 없는 것으로 센다.
    }
  }
  return out;
}

const deepHas = (obj, key, depth = 0) => {
  if (!obj || typeof obj !== 'object' || depth > 4) return false;
  if (key in obj && obj[key]) return true;
  return Object.values(obj).some((v) => deepHas(v, key, depth + 1));
};

function inspect(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const desc = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i,
  )?.[1];
  const canonical = html.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
  )?.[1];
  const jsonLd = parseJsonLd(html);

  return {
    h1: (html.match(/<h1[\s>]/gi) ?? []).length,
    // 빈 description 은 없는 것과 같다. 공백만 있는 경우도 거른다.
    hasDescription: Boolean(desc && desc.trim().length > 0),
    hasCanonical: Boolean(canonical),
    jsonLdTypes: jsonLd.map((o) => o['@type']).filter(Boolean).flat(),
    hasJsonLd: jsonLd.length > 0,
    hasDateModified: jsonLd.some((o) => deepHas(o, 'dateModified')),
    // 없는 상품·호를 요청해도 200 을 주면서 title 에 undefined 가 박히는 패턴.
    softNotFound: /undefined/i.test(title),
  };
}

// ── 점수 ────────────────────────────────────────────────────────────────────

const round = (n) => Math.round(n * 10) / 10;
const share = (hit, total) => (total > 0 ? hit / total : 0);
const pctLabel = (hit, total) =>
  total > 0 ? `${hit}/${total} · ${(share(hit, total) * 100).toFixed(1)}%` : '측정 없음';

function daysSince(isoDate) {
  if (!isoDate) return null;
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// ── main ────────────────────────────────────────────────────────────────────

async function auditService(svc, query) {
  console.error(`\n── ${svc.name}`);

  // 1. robots.txt
  const robotsRes = await get(`${svc.origin}/robots.txt`);
  const groups = robotsRes.ok ? parseRobots(robotsRes.body) : [];
  const bots = {};
  for (const ua of BOTS.search) bots[ua] = robotsRes.ok ? isAllowed(groups, ua) : null;
  for (const b of BOTS.geo) bots[b.ua] = robotsRes.ok ? isAllowed(groups, b.ua) : null;
  console.error(
    `  robots.txt ${robotsRes.status} · 검색봇 ${BOTS.search.filter((u) => bots[u]).length}/${BOTS.search.length} 허용 · AI ${BOTS.geo.filter((b) => bots[b.ua]).length}/${BOTS.geo.length} 허용`,
  );

  // 2. sitemap
  const sm = await fetchSitemap(svc.origin);
  const buckets = { detail: 0, duplicate: 0, search: 0, list: 0, other: 0 };
  const detailFromSitemap = [];
  for (const loc of sm.urls) {
    let path;
    try {
      path = new URL(loc).pathname;
    } catch {
      continue;
    }
    buckets[svc.classify(path)] = (buckets[svc.classify(path)] ?? 0) + 1;
    if (svc.detailFromSitemap(path)) detailFromSitemap.push(loc);
  }
  const newestLastmod = sm.lastmods.sort().at(-1) ?? null;
  const staleDays = daysSince(newestLastmod);
  console.error(
    `  sitemap ${sm.ok ? sm.urls.length + '건' : '실패 ' + sm.status} · 최신 lastmod ${newestLastmod ?? '없음'}${staleDays !== null ? ` (${staleDays}일 전)` : ''}`,
  );

  // 3. 상세 페이지 목록 — 사이트맵에 상세가 부족하면 GSC 노출 URL 로 채운다.
  let detailUrls = [...new Set(detailFromSitemap)];
  let detailSource = '사이트맵';
  if (detailUrls.length < MAX_PAGES && query) {
    const rows = await query({
      startDate: new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10),
      endDate: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10),
      ...pageFilter(svc.gscRegex),
      dimensions: ['page'],
      rowLimit: 5000,
    });
    const fromGsc = rows
      .map((r) => r.keys[0])
      .filter((u) => {
        try {
          return svc.detailFromSitemap(new URL(u).pathname);
        } catch {
          return false;
        }
      });
    const before = detailUrls.length;
    detailUrls = [...new Set([...detailUrls, ...fromGsc])];
    if (detailUrls.length > before) {
      detailSource = before > 0 ? '사이트맵 + GSC 노출' : 'GSC 노출';
    }
  }
  detailUrls = detailUrls.slice(0, MAX_PAGES);

  console.error(`  상세 ${detailUrls.length}건 크롤 (${detailSource})…`);
  const results = await mapLimit(detailUrls, CONCURRENCY, async (url) => {
    const res = await get(url);
    if (!res.ok) return { url, ok: false, status: res.status };
    return { url, ok: true, status: res.status, ...inspect(res.body) };
  });

  const ok = results.filter((r) => r.ok);
  const detail = {
    requested: detailUrls.length,
    ok: ok.length,
    failed: results.length - ok.length,
    source: detailSource,
    h1: ok.filter((r) => r.h1 > 0).length,
    jsonLd: ok.filter((r) => r.hasJsonLd).length,
    dateModified: ok.filter((r) => r.hasDateModified).length,
    canonical: ok.filter((r) => r.hasCanonical).length,
    description: ok.filter((r) => r.hasDescription).length,
    softNotFound: ok.filter((r) => r.softNotFound).length,
    jsonLdTypes: [...new Set(ok.flatMap((r) => r.jsonLdTypes))].slice(0, 8),
  };
  console.error(
    `    h1 ${pctLabel(detail.h1, ok.length)} · JSON-LD ${pctLabel(detail.jsonLd, ok.length)} · canonical ${pctLabel(detail.canonical, ok.length)} · desc ${pctLabel(detail.description, ok.length)}${detail.softNotFound ? ` · soft-404 ${detail.softNotFound}건` : ''}`,
  );

  return {
    robots: { status: robotsRes.status, bots, raw: robotsRes.body.slice(0, 2000) },
    sitemap: {
      ok: sm.ok,
      status: sm.status,
      total: sm.urls.length,
      buckets,
      newestLastmod,
      staleDays,
      dynamic: staleDays !== null && staleDays <= 7,
    },
    detail,
    contentEstimate: svc.contentEstimate,
  };
}

function buildRubric(measured) {
  const keys = Object.keys(measured);
  const scoreOf = (fn) => Object.fromEntries(keys.map((k) => [k, fn(measured[k])]));
  const noteOf = (fn) => Object.fromEntries(keys.map((k) => [k, fn(measured[k])]));

  const item = (name, max, auto, scoreFn, noteFn, rule) => ({
    name,
    max,
    auto,
    rule,
    scores: scoreOf(scoreFn),
    notes: noteOf(noteFn),
  });

  const d = (m) => m.detail;
  const okCount = (m) => m.detail.ok;

  return [
    {
      key: 'seo',
      label: 'SEO',
      full: '검색엔진이 찾고 색인할 수 있는가',
      items: [
        item(
          '사이트맵 갱신',
          25,
          true,
          (m) =>
            !m.sitemap.ok ? 0 : m.sitemap.dynamic ? 25 : m.sitemap.staleDays <= 365 ? 12 : 0,
          (m) =>
            !m.sitemap.ok
              ? '사이트맵 없음'
              : `${m.sitemap.newestLastmod ?? 'lastmod 없음'}${m.sitemap.staleDays !== null ? ` · ${m.sitemap.staleDays}일 전` : ''}`,
          '7일 내 갱신 25 / 1년 내 12 / 그 이상·없음 0',
        ),
        item(
          '핵심 상세 수록',
          25,
          false,
          (m) => {
            const n = m.sitemap.buckets.detail ?? 0;
            const r = share(n, m.contentEstimate.value);
            // 뉴스 사이트가 카테고리당 최신 N건만 롤링으로 제출하는 것은 흔한
            // 방식이라 그 자체는 실패가 아니다. 비율만 보면(닷컴 0.45%) 정상
            // 운영을 0점으로 찍게 되므로, "전량 / 롤링 수록 / 흔적만 / 없음"
            // 네 단계로 나눈다.
            if (r >= 0.9) return 25;
            if (r >= 0.001) return 12; // 0.1% 이상 — 최신분 롤링으로 볼 만한 규모
            if (n > 0) return 4; // 몇 건 남아 있을 뿐 수록 체계가 없음
            return 0;
          },
          (m) =>
            `${m.sitemap.buckets.detail ?? 0}/${m.contentEstimate.value.toLocaleString('ko-KR')} · ${(share(m.sitemap.buckets.detail ?? 0, m.contentEstimate.value) * 100).toFixed(2)}%`,
          '전량(90%+) 25 / 롤링 수록(0.1%+) 12 / 흔적만 4 / 0건 0 — 분모는 추정치이고 단계 경계는 판단이다',
        ),
        item(
          '색인 낭비 없음',
          15,
          true,
          (m) => {
            const waste =
              (m.sitemap.buckets.duplicate ?? 0) + (m.sitemap.buckets.search ?? 0);
            const r = share(waste, m.sitemap.total);
            return r < 0.1 ? 15 : r < 0.3 ? 8 : 0;
          },
          (m) => {
            const waste =
              (m.sitemap.buckets.duplicate ?? 0) + (m.sitemap.buckets.search ?? 0);
            return `중복·검색결과 ${waste}/${m.sitemap.total} · ${(share(waste, m.sitemap.total) * 100).toFixed(1)}%`;
          },
          '10% 미만 15 / 30% 미만 8 / 그 이상 0',
        ),
        item(
          'canonical',
          15,
          true,
          (m) => round(share(d(m).canonical, okCount(m)) * 15),
          (m) => pctLabel(d(m).canonical, okCount(m)),
          '충족률 × 15 (연속값)',
        ),
        item(
          'meta description',
          10,
          true,
          (m) => round(share(d(m).description, okCount(m)) * 10),
          (m) => pctLabel(d(m).description, okCount(m)),
          '충족률 × 10 (연속값)',
        ),
        item(
          '검색봇 허용',
          10,
          true,
          (m) => (BOTS.search.every((ua) => m.robots.bots[ua]) ? 10 : 0),
          (m) =>
            BOTS.search.map((ua) => `${ua} ${m.robots.bots[ua] ? '허용' : '차단'}`).join(' · '),
          'Googlebot · Bingbot · Yeti 전부 허용 10',
        ),
      ],
    },
    {
      key: 'aeo',
      label: 'AEO',
      full: '답변 엔진이 발췌할 수 있는가',
      items: [
        item(
          '구조화 데이터',
          35,
          true,
          (m) => round(share(d(m).jsonLd, okCount(m)) * 35),
          (m) =>
            `${pctLabel(d(m).jsonLd, okCount(m))}${d(m).jsonLdTypes.length ? ` · ${d(m).jsonLdTypes.join(', ')}` : ''}`,
          '충족률 × 35 (연속값)',
        ),
        item(
          'h1',
          25,
          true,
          (m) => round(share(d(m).h1, okCount(m)) * 25),
          (m) => pctLabel(d(m).h1, okCount(m)),
          '충족률 × 25 (연속값)',
        ),
        item(
          '발췌 후보 요약문',
          20,
          true,
          (m) => round(share(d(m).description, okCount(m)) * 20),
          (m) => pctLabel(d(m).description, okCount(m)),
          'meta description 충족률 × 20',
        ),
        item(
          'dateModified',
          10,
          true,
          (m) => round(share(d(m).dateModified, okCount(m)) * 10),
          (m) => pctLabel(d(m).dateModified, okCount(m)),
          '충족률 × 10 (연속값)',
        ),
        item(
          'canonical',
          10,
          true,
          (m) => round(share(d(m).canonical, okCount(m)) * 10),
          (m) => pctLabel(d(m).canonical, okCount(m)),
          '충족률 × 10 (연속값)',
        ),
      ],
    },
    {
      key: 'geo',
      label: 'GEO',
      full: '생성 엔진이 가져갈 수 있는가',
      items: BOTS.geo.map((b) =>
        item(
          b.ua,
          b.max,
          true,
          (m) => (m.robots.bots[b.ua] ? b.max : 0),
          (m) => `${b.role} · ${m.robots.bots[b.ua] ? '허용' : '차단'}`,
          `허용 ${b.max} / 차단 0`,
        ),
      ),
    },
  ];
}

async function main() {
  let query = null;
  if (useGsc) {
    const token = await getAccessToken(loadServiceAccountKey());
    ({ query } = createQuery(token, SITE));
  } else {
    console.error('--no-gsc: 사이트맵에 있는 상세만 크롤한다.');
  }

  const measured = {};
  for (const svc of SERVICES) {
    measured[svc.key] = await auditService(svc, query);
  }

  const payload = {
    measuredAt: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    source: `자동 측정 — robots.txt · sitemap.xml · 상세 페이지 크롤 (서비스당 최대 ${MAX_PAGES}건)`,
    caveat:
      '배점(가중치)은 업계 표준이 아니라 이 문서의 선택이다. 충족률은 실측이므로 서비스 간 순서는 신뢰할 수 있으나, 절대 점수는 배점을 바꾸면 달라진다. "핵심 상세 수록" 항목의 분모(전체 콘텐츠 수)만 추정치이며 auto:false 로 표시했다.',
    services: SERVICES.map((s) => s.key),
    serviceNames: Object.fromEntries(SERVICES.map((s) => [s.key, s.name])),
    axes: buildRubric(measured),
    measurements: measured,
    unmeasurable: [
      'AI 개요·AI 모드 내 인용 점유율 — GSC searchAppearance 에 해당 표면이 없어 측정 수단이 없다.',
      '프롬프트 테스트 인용률 — 수동 측정만 가능하며 아직 미실시.',
    ],
  };

  const outPath = resolve(outDir, 'readiness.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  console.error('\n── 총점');
  for (const axis of payload.axes) {
    const line = SERVICES.map((s) => {
      const sum = axis.items.reduce((a, i) => a + i.scores[s.key], 0);
      return `${s.name} ${round(sum)}`;
    }).join(' · ');
    console.error(`  ${axis.label.padEnd(4)} ${line}`);
  }
  console.error(`\n기록 ${outPath}`);
}

main().catch((error) => {
  console.error(`실패: ${error.message}`);
  process.exit(1);
});
