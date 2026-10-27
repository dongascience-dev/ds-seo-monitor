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
import { scrub } from './lib/privacy.mjs';

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

/**
 * robots.txt 만 보는 호스트.
 *
 * 집계 대상 세 서비스는 아니지만 같은 도메인이라 "봇 현황" 을 물으면 당연히
 * 들어가야 한다 — **robots.txt 는 호스트마다 따로**라서, 닷컴의 허용 목록은
 * 여기에 적용되지 않는다. 실제로 지사탐은 전체 허용이라 닷컴과 정반대다.
 *
 * 점수는 매기지 않는다. 상세 페이지 구조가 서비스마다 제각각이라 같은 잣대로
 * 채점하면 숫자가 거짓말을 한다. 여기 한 줄 더하면 봇 탭에 열이 하나 는다.
 */
const ROBOTS_ONLY = [
  { key: 'jisatam', name: '지구사랑탐사대', origin: 'https://jisatam.dongascience.com' },
];

/**
 * robots.txt 에서 확인하는 봇 목록. 점수용과 현황용이 한 곳에 있다.
 *
 * 점수에 못 넣는 봇도 이름은 알아야 한다. 닷컴처럼 **허용 목록**으로 운영하면
 * 목록에 없는 봇이 전부 막히는데, 이름을 아는 봇만 세면 화면이 "거의 다 열려
 * 있다"로 읽힌다. 실제로는 "허용한 것 빼고 전부 막혀 있다"이다.
 *
 * `seo` 는 SEO 축의 검색봇 항목(3종 묶어 10점), `geo` 는 GEO 축의 개별 배점이다.
 * 나머지는 점수가 없고 `#robots` 탭에서만 쓴다 — 배점을 줄 근거가 없을 뿐
 * 현황에서 빠지면 안 되는 봇들이다.
 */
const BOT_GROUPS = [
  {
    key: 'search',
    label: '검색 노출',
    why: '검색 결과에 실리려면 열려 있어야 한다. 막으면 그 검색엔진에서 사라진다.',
    expect: 'allow',
    bots: [
      { ua: 'Googlebot', role: '구글 검색', seo: true },
      { ua: 'Bingbot', role: '빙 검색 · 코파일럿', seo: true },
      { ua: 'Yeti', role: '네이버 검색', seo: true },
      { ua: 'Daumoa', role: '다음 검색' },
      { ua: 'Applebot', role: '시리 · 스포트라이트' },
    ],
  },
  {
    key: 'ai',
    label: 'AI 답변 인용',
    why:
      '생성형 엔진이 답변에 우리 기사를 인용하고 출처 링크를 달 수 있나. ' +
      '색인 봇과 실시간 조회 봇이 따로 있어 한쪽만 열면 반쪽이 된다.',
    expect: 'allow',
    bots: [
      { ua: 'OAI-SearchBot', role: 'ChatGPT 검색 색인', geo: 15 },
      { ua: 'ChatGPT-User', role: 'ChatGPT 실시간 조회', geo: 30 },
      { ua: 'Claude-SearchBot', role: 'Claude 검색 색인', geo: 15 },
      { ua: 'Claude-User', role: 'Claude 실시간 조회' },
      { ua: 'PerplexityBot', role: 'Perplexity 색인', geo: 15 },
      { ua: 'Perplexity-User', role: 'Perplexity 실시간 조회' },
    ],
  },
  {
    key: 'training',
    label: 'AI 학습 수집',
    why:
      '모델 학습에 콘텐츠를 가져가는 봇. 닷컴은 막는 것이 방침이라 ' +
      '여기서는 차단이 정상이다. 열려 있는 쪽이 확인 대상이다.',
    expect: 'block',
    bots: [
      { ua: 'GPTBot', role: 'OpenAI 학습' },
      { ua: 'ClaudeBot', role: 'Anthropic 학습' },
      { ua: 'Google-Extended', role: '구글 제미나이 학습' },
      { ua: 'Applebot-Extended', role: '애플 인텔리전스 학습' },
      { ua: 'Meta-ExternalAgent', role: '메타 AI 학습' },
      { ua: 'CCBot', role: 'Common Crawl 공개 말뭉치' },
      { ua: 'Bytespider', role: '바이트댄스 학습' },
    ],
  },
  {
    key: 'share',
    label: '공유 미리보기',
    why: 'SNS·메신저에 링크를 붙였을 때 제목·썸네일이 뜨는가. 막히면 맨 URL 만 간다.',
    expect: 'allow',
    bots: [
      { ua: 'facebookexternalhit', role: '페이스북 · 인스타그램' },
      { ua: 'Twitterbot', role: 'X(트위터)' },
      { ua: 'kakaotalk-scrap', role: '카카오톡' },
      { ua: 'Slackbot-LinkExpanding', role: '슬랙' },
    ],
  },
];

const ALL_BOTS = BOT_GROUPS.flatMap((g) => g.bots.map((b) => ({ ...b, group: g.key })));

/** 어느 그룹에도 이름이 없는 봇. `User-agent: *` 의 처분을 읽으려고 쓴다. */
const UNLISTED_UA = 'ds-seo-monitor-unlisted-probe';

const BOTS = {
  search: ALL_BOTS.filter((b) => b.seo).map((b) => b.ua),
  geo: ALL_BOTS.filter((b) => b.geo),
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

/**
 * 받아 온 것이 정말 robots.txt 인가.
 *
 * 형제 호스트 몇 곳은 `/robots.txt` 에 200 으로 **HTML** 을 돌려준다(about ·
 * school · alive 실측). 그대로 파싱하면 규칙이 하나도 안 잡혀 "전부 허용" 으로
 * 읽히는데, 봇에게 실제로 그렇게 보이는 것은 맞다. 다만 "열어 두기로 정했다" 와
 * "robots.txt 가 없다" 는 다른 사실이라 구분해서 적는다.
 */
const looksLikeRobots = (body) =>
  !/^\s*[<{]/.test(body) && /^[ \t]*(user-agent|sitemap|allow|disallow)[ \t]*:/im.test(body);

/**
 * 봇 정책을 손대지 않은 기본 템플릿인가.
 *
 * 프레임워크가 프로젝트를 만들 때 깔아 주는 파일이 있다 — robotstxt.org 주석
 * 한 줄에 `User-agent: *` 와 **값이 빈** `Disallow:`. 빈 Disallow 는 "아무것도
 * 막지 않는다" 라서 결과는 전체 허용이지만, `Allow: /` 를 직접 적어 둔 곳과는
 * 뜻이 다르다. 전자는 **손대지 않아서 열려 있는** 것이고 후자는 열기로 정한
 * 것이다. 둘을 같은 "전체 허용" 으로 보여 주면 없는 정책이 있는 것처럼 읽힌다.
 *
 * 실측(2026-10-27): 지사탐 · edu · air 가 토씨까지 같은 파일을 쓴다.
 * `Sitemap:` 줄은 봇 정책이 아니므로 있어도 템플릿으로 센다.
 */
function isBoilerplate(body, groups) {
  if (!/^[ \t]*#[ \t]*https?:\/\/(www\.)?robotstxt\.org\//im.test(body)) return false;
  // 이름을 적은 봇이 하나라도 있으면 손을 댄 것이다.
  if (groups.some((g) => g.agents.length !== 1 || !g.agents.includes('*'))) return false;
  // 값이 있는 규칙이 하나라도 있으면 막든 열든 정한 것이다.
  return groups.every((g) => g.rules.every((r) => r.path === ''));
}

/** robots.txt 응답 하나를 화면이 쓸 모양으로 푼다. */
function readRobots(res) {
  const valid = res.ok && looksLikeRobots(res.body);
  const groups = valid ? parseRobots(res.body) : [];
  const bots = {};
  for (const b of ALL_BOTS) bots[b.ua] = res.ok ? isAllowed(groups, b.ua) : null;
  return {
    groups,
    robots: {
      status: res.status,
      // 규칙이 없으면 봇은 전부 통과한다. 이유만 다르고 결과는 같다.
      valid,
      boilerplate: valid && isBoilerplate(res.body, groups),
      bots,
      defaultAllow: res.ok ? isAllowed(groups, UNLISTED_UA) : null,
      hasCatchAll: groups.some((g) => g.agents.includes('*')),
      namedAgents: [...new Set(groups.flatMap((g) => g.agents))].filter((a) => a !== '*'),
      // `Sitemap:` 은 그룹에 속하지 않는 독립 지시어라 파서가 버린다. 원문에서 센다.
      // 필드 이름은 대소문자를 가리지 않으므로 소문자 표기도 유효하다.
      sitemaps: valid
        ? [...res.body.matchAll(/^[ \t]*sitemap[ \t]*:[ \t]*(\S+)/gim)].map((m) => m[1])
        : [],
      raw: res.body.slice(0, 2000),
    },
  };
}

/** 세 서비스 밖 호스트 — robots.txt 만 받아 본다. 크롤도 채점도 하지 않는다. */
async function auditRobotsOnly(host) {
  const res = await get(`${host.origin}/robots.txt`);
  const { robots } = readRobots(res);
  const allowed = ALL_BOTS.filter((b) => robots.bots[b.ua]).length;
  console.error(
    `\n── ${host.name} (robots.txt 만)\n  ${res.status} · ${
      robots.valid
        ? robots.boilerplate
          ? '전체 허용(기본 템플릿 그대로)'
          : robots.defaultAllow
            ? '전체 허용'
            : '허용 목록 외 차단'
        : 'robots.txt 없음(규칙 없음과 같다)'
    } · ${ALL_BOTS.length}종 중 ${allowed} 허용`,
  );
  return { ...host, robots };
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

/**
 * 제목·설명이 페이지마다 다른가.
 *
 * "있다" 만 세면 전 페이지가 같은 문구를 쓰는 사이트가 만점을 받는다. 실측
 * (DS스토어 2026-10-02): meta description 충족률이 76% 인데 크롤한 페이지가
 * 전부 같은 한 문장을 쓰고 있었다. 검색엔진 입장에서는 그 페이지들이 서로
 * 구별되지 않는다 — 이벤트 랜딩은 "무슨 이벤트인지" 적힌 곳이 없어 검색
 * 유입이 0 이었다.
 *
 * 채움값은 "자기만의 값을 가진 페이지 비율" 이다. 같은 문구를 N개가 나눠
 * 쓰면 그 N개를 전부 못 센다 — 둘이 같으면 둘 다 변별력이 없기 때문이다.
 */
function uniqueness(values) {
  const counts = new Map();
  for (const v of values) {
    const key = (v ?? '').trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let unique = 0;
  let topDup = 0;
  for (const n of counts.values()) {
    if (n === 1) unique += 1;
    if (n > topDup) topDup = n;
  }
  return { unique, distinct: counts.size, topDup };
}

/**
 * 페이지가 그려지는 데 필요한 같은 호스트 자원(CSS · JS)의 경로.
 *
 * 본문 HTML 이 열려 있어도 이 자원이 robots.txt 로 막히면 구글은 스타일도
 * 스크립트도 없는 페이지를 평가한다. 구글이 "CSS·JS 를 막지 말라"고 못 박은
 * 항목이라, 봇 허용 여부와 따로 센다.
 */
function renderAssetPaths(html, baseUrl) {
  const refs = [];
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) refs.push(m[1]);
  for (const m of html.matchAll(/<link[^>]*>/gi)) {
    if (!/rel=["']stylesheet["']/i.test(m[0])) continue;
    const href = m[0].match(/href=["']([^"']+)["']/i)?.[1];
    if (href) refs.push(href);
  }

  const origin = new URL(baseUrl).origin;
  const paths = [];
  for (const ref of refs) {
    try {
      const u = new URL(ref, baseUrl);
      // 외부 CDN 은 우리 robots.txt 가 관여하지 못한다. 같은 호스트만 센다.
      if (u.origin === origin) paths.push(u.pathname);
    } catch {
      /* data: URI 등 경로가 아닌 참조는 버린다. */
    }
  }
  return [...new Set(paths)];
}

function inspect(html, url) {
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
    // 고유성을 재려면 원문이 필요하다. 길면 앞부분만으로 충분히 갈린다.
    title: title.slice(0, 300),
    description: (desc ?? '').trim().slice(0, 300),
    // 빈 description 은 없는 것과 같다. 공백만 있는 경우도 거른다.
    hasDescription: Boolean(desc && desc.trim().length > 0),
    hasCanonical: Boolean(canonical),
    jsonLdTypes: jsonLd.map((o) => o['@type']).filter(Boolean).flat(),
    hasJsonLd: jsonLd.length > 0,
    hasDateModified: jsonLd.some((o) => deepHas(o, 'dateModified')),
    assets: renderAssetPaths(html, url),
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
  // 이름이 어디에도 없는 봇을 흉내 내 `*` 그룹의 처분까지 읽는다. 앞으로 나올
  // 봇이 받게 될 대우가 그것이고, 봇을 하나씩 세서는 보이지 않는 값이다.
  const robotsRes = await get(`${svc.origin}/robots.txt`);
  const { groups, robots } = readRobots(robotsRes);
  console.error(
    `  robots.txt ${robots.status} · 기본 정책 ${robots.defaultAllow === null ? '?' : robots.defaultAllow ? '허용' : '차단'}` +
      ` · 이름 있는 봇 ${robots.namedAgents.length}종 · 확인한 ${ALL_BOTS.length}종 중 ${ALL_BOTS.filter((b) => robots.bots[b.ua]).length} 허용`,
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
    return { url, ok: true, status: res.status, ...inspect(res.body, url) };
  });

  const ok = results.filter((r) => r.ok);

  // 4. 렌더링 자원이 Googlebot 에게 열려 있나.
  // 크롤한 페이지들이 부르는 자원을 모아 robots.txt 에 그대로 물어본다.
  const assetPaths = [...new Set(ok.flatMap((r) => r.assets ?? []))];
  const blockedAssets = assetPaths.filter((path) => !isAllowed(groups, 'Googlebot', path));
  const renderAssets = {
    total: assetPaths.length,
    blocked: blockedAssets.length,
    // 어느 경로가 막혔는지 한눈에 보이면 고칠 규칙이 특정된다.
    prefixes: [...new Set(blockedAssets.map((p) => p.split('/').slice(0, 3).join('/') + '/'))].slice(0, 5),
    samples: blockedAssets.slice(0, 5),
  };
  if (renderAssets.blocked > 0) {
    console.error(
      `  ! 렌더링 자원 ${renderAssets.blocked}/${renderAssets.total} 건이 Googlebot 에게 차단됨 — ${renderAssets.prefixes.join(' · ')}`,
    );
  }

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
    titleUnique: uniqueness(ok.map((r) => r.title)),
    descUnique: uniqueness(ok.map((r) => r.description)),
    softNotFound: ok.filter((r) => r.softNotFound).length,
    jsonLdTypes: [...new Set(ok.flatMap((r) => r.jsonLdTypes))].slice(0, 8),
  };
  console.error(
    `    h1 ${pctLabel(detail.h1, ok.length)} · JSON-LD ${pctLabel(detail.jsonLd, ok.length)} · canonical ${pctLabel(detail.canonical, ok.length)} · desc ${pctLabel(detail.description, ok.length)}` +
      ` · 고유 title ${pctLabel(detail.titleUnique.unique, ok.length)} · 고유 desc ${pctLabel(detail.descUnique.unique, ok.length)}` +
      `${detail.softNotFound ? ` · soft-404 ${detail.softNotFound}건` : ''}`,
  );

  return {
    robots,
    renderAssets,
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
          20,
          true,
          (m) =>
            !m.sitemap.ok ? 0 : m.sitemap.dynamic ? 20 : m.sitemap.staleDays <= 365 ? 10 : 0,
          (m) =>
            !m.sitemap.ok
              ? '사이트맵 없음'
              : `${m.sitemap.newestLastmod ?? 'lastmod 없음'}${m.sitemap.staleDays !== null ? ` · ${m.sitemap.staleDays}일 전` : ''}`,
          '7일 내 갱신 20 / 1년 내 10 / 그 이상·없음 0',
        ),
        item(
          '핵심 상세 수록',
          20,
          false,
          (m) => {
            const n = m.sitemap.buckets.detail ?? 0;
            const r = share(n, m.contentEstimate.value);
            // 뉴스 사이트가 카테고리당 최신 N건만 롤링으로 제출하는 것은 흔한
            // 방식이라 그 자체는 실패가 아니다. 비율만 보면(닷컴 0.45%) 정상
            // 운영을 0점으로 찍게 되므로, "전량 / 롤링 수록 / 흔적만 / 없음"
            // 네 단계로 나눈다.
            if (r >= 0.9) return 20;
            if (r >= 0.001) return 10; // 0.1% 이상 — 최신분 롤링으로 볼 만한 규모
            if (n > 0) return 3; // 몇 건 남아 있을 뿐 수록 체계가 없음
            return 0;
          },
          (m) =>
            `${m.sitemap.buckets.detail ?? 0}/${m.contentEstimate.value.toLocaleString('ko-KR')} · ${(share(m.sitemap.buckets.detail ?? 0, m.contentEstimate.value) * 100).toFixed(2)}%`,
          '전량(90%+) 20 / 롤링 수록(0.1%+) 10 / 흔적만 3 / 0건 0 — 분모는 추정치이고 단계 경계는 판단이다',
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
          '제목 고유성',
          15,
          true,
          (m) => round(share(d(m).titleUnique.unique, okCount(m)) * 15),
          (m) =>
            `${pctLabel(d(m).titleUnique.unique, okCount(m))}${
              d(m).titleUnique.topDup > 1 ? ` · 같은 제목 최다 ${d(m).titleUnique.topDup}건` : ''
            }`,
          '자기만의 <title> 을 가진 페이지 비율 × 15 — 같은 제목을 나눠 쓰면 그 페이지들은 세지 않는다',
        ),
        item(
          'meta description',
          5,
          true,
          (m) => round(share(d(m).description, okCount(m)) * 5),
          (m) => pctLabel(d(m).description, okCount(m)),
          '있기만 하면 되는 항목이라 배점을 낮췄다. 내용이 갈리는지는 AEO 의 설명 고유성에서 본다',
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
          30,
          true,
          (m) => round(share(d(m).jsonLd, okCount(m)) * 30),
          (m) =>
            `${pctLabel(d(m).jsonLd, okCount(m))}${d(m).jsonLdTypes.length ? ` · ${d(m).jsonLdTypes.join(', ')}` : ''}`,
          '충족률 × 30 (연속값)',
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
          15,
          true,
          (m) => round(share(d(m).description, okCount(m)) * 15),
          (m) => pctLabel(d(m).description, okCount(m)),
          'meta description 충족률 × 15',
        ),
        item(
          '설명 고유성',
          10,
          true,
          (m) => round(share(d(m).descUnique.unique, okCount(m)) * 10),
          (m) =>
            `${pctLabel(d(m).descUnique.unique, okCount(m))}${
              d(m).descUnique.topDup > 1 ? ` · 같은 설명 최다 ${d(m).descUnique.topDup}건` : ''
            }`,
          '자기만의 설명을 가진 페이지 비율 × 10 — 답변 엔진이 페이지를 구별하려면 요약문이 갈려야 한다',
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
      items: [
        ...BOTS.geo.map((b) =>
          item(
            b.ua,
            b.geo,
            true,
            (m) => (m.robots.bots[b.ua] ? b.geo : 0),
            (m) => `${b.role} · ${m.robots.bots[b.ua] ? '허용' : '차단'}`,
            `허용 ${b.geo} / 차단 0`,
          ),
        ),
        /*
          이름을 아는 봇만 세면 "앞으로 나올 봇"이 점수에서 빠진다.
          닷컴은 허용 목록 운영이라 ChatGPT-User 하나만 열어도 나머지 항목이
          만점이 되는데, 구조는 그대로다 — Claude-User · Perplexity-User ·
          다음 · 카카오톡, 그리고 내년에 나올 봇이 전부 막혀 있다.
          그 구조를 점수에 넣어야 G1 과제("robots.txt 를 허용 목록에서
          차단 목록으로 뒤집기")와 숫자가 어긋나지 않는다.
        */
        item(
          '기본 정책',
          25,
          true,
          (m) => (m.robots.defaultAllow ? 25 : 0),
          (m) =>
            m.robots.defaultAllow
              ? `목록에 없는 봇도 통과${m.robots.hasCatchAll ? '' : ' · User-agent: * 그룹 없음'}`
              : `허용 목록 밖 전부 차단 · 이름 적힌 ${m.robots.namedAgents.length}종만 통과`,
          'User-agent: * 가 Allow 면 25 / Disallow 면 0 — 허용 목록으로 운영하면 새 봇은 기본 차단된다',
        ),
      ],
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

  const extraHosts = [];
  for (const host of ROBOTS_ONLY) extraHosts.push(await auditRobotsOnly(host));

  const payload = {
    measuredAt: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    source: `자동 측정 — robots.txt · sitemap.xml · 상세 페이지 크롤 (서비스당 최대 ${MAX_PAGES}건)`,
    caveat:
      '배점(가중치)은 업계 표준이 아니라 이 문서의 선택이다. 충족률은 실측이므로 서비스 간 순서는 신뢰할 수 있으나, 절대 점수는 배점을 바꾸면 달라진다. "핵심 상세 수록" 항목의 분모(전체 콘텐츠 수)만 추정치이며 auto:false 로 표시했다.',
    services: SERVICES.map((s) => s.key),
    serviceNames: Object.fromEntries(SERVICES.map((s) => [s.key, s.name])),
    serviceOrigins: Object.fromEntries(SERVICES.map((s) => [s.key, s.origin])),
    axes: buildRubric(measured),
    botCatalog: BOT_GROUPS,
    extraHosts,
    measurements: measured,
    unmeasurable: [
      'AI 개요·AI 모드 내 인용 점유율 — GSC searchAppearance 에 해당 표면이 없어 측정 수단이 없다.',
      '프롬프트 테스트 인용률 — 수동 측정만 가능하며 아직 미실시.',
    ],
  };

  const outPath = resolve(outDir, 'readiness.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(scrub(payload), null, 2)}\n`);

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
