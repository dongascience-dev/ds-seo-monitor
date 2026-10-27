import { Fragment } from 'react';
import { SERVICES } from '../lib/format.js';

/**
 * robots.txt 현황 한 장.
 *
 * 준비도 탭과 데이터는 같은데 화면을 따로 둔다. 묻는 사람이 다르기 때문이다.
 * 준비도 탭은 "우리가 몇 점인가" 에 답하는 채점표라 배점·충족률이 앞에 선다.
 * 하지만 "봇 현황 알려 달라" 는 요청에 필요한 것은 점수가 아니라 **명단**이다 —
 * 누가 열려 있고 누가 막혀 있나, 그게 의도된 것인가, 호스트마다 왜 다른가.
 *
 * 그 명단을 점수표 안에 섞으면 두 가지가 동시에 망가진다. 점수를 매길 수 없는
 * 봇(카카오톡·다음·Claude-User)은 채점표에 자리가 없어 빠지고, 그렇게 빠진
 * 채로 보면 "AI 봇 중 하나만 막혀 있다" 로 읽힌다. 실제로는 "허용한 것 빼고
 * 전부 막혀 있다" 인데도. 그래서 이 탭은 **이름을 아는 봇 전부**를 싣고,
 * 점수에 들어가는 것에만 배점을 표시한다.
 *
 * 같은 이유로 집계 범위 밖 호스트(지사탐 등)도 **열로 올린다**. robots.txt 는
 * 호스트마다 따로라 닷컴의 허용 목록이 거기에는 적용되지 않는데, 빼 두면
 * "도메인 전체가 닷컴처럼 잠겨 있다" 로 읽힌다. 다만 점수는 매기지 않는다 —
 * 상세 페이지 구조가 제각각이라 같은 잣대로 채점하면 숫자가 거짓말을 한다.
 */

/** 그룹의 기대(열려야 / 막혀야)와 실제를 맞춰 본다. */
function verdict(allowed, expect) {
  if (allowed === null || allowed === undefined) return { label: '확인 못함', cls: 'info' };
  const asExpected = expect === 'block' ? !allowed : allowed;
  return {
    label: allowed ? '허용' : '차단',
    cls: asExpected ? 'good' : expect === 'block' ? 'warn' : 'crit',
  };
}

/**
 * 측정값에서 "짚어야 할 것" 을 뽑는다.
 *
 * 문장을 박아 두지 않고 매번 데이터에서 만든다. robots.txt 가 바뀌면 설명도
 * 같이 바뀌어야 하는데, 손으로 적어 두면 파일만 고쳐지고 설명은 옛말이 된다.
 */
function findings(e, catalog) {
  const out = [];
  const bots = e.robots.bots ?? {};
  const named = e.robots.namedAgents?.length ?? 0;

  if (e.robots.valid === false) {
    out.push({
      level: 'warn',
      text: (
        <>
          <b>robots.txt 가 없습니다</b> — <code>/robots.txt</code> 를 요청하면 규칙이 아니라
          HTML 이나 오류 페이지가 돌아옵니다(HTTP {e.robots.status}). 봇에게는 "규칙 없음",
          즉 전체 허용과 같게 보입니다. 열어 두기로 정한 것과 결과는 같지만{' '}
          <b>정한 적이 없다는 뜻</b>입니다.
        </>
      ),
    });
  } else if (e.robots.defaultAllow === false) {
    out.push({
      level: 'crit',
      text: (
        <>
          <b>허용 목록 밖은 전부 차단</b>입니다. 이름을 적어 둔 {named}종만 통과하고,{' '}
          <b>앞으로 나올 봇은 전부 막힌 채로 시작</b>합니다. 봇을 하나씩 열어 주는
          방식이라 새 서비스가 뜰 때마다 사람이 알아채서 손을 대야 합니다.
        </>
      ),
    });
  }

  for (const g of catalog) {
    const mismatched = g.bots.filter((b) =>
      g.expect === 'block' ? bots[b.ua] === true : bots[b.ua] === false,
    );
    if (mismatched.length === 0) continue;
    const names = mismatched.map((b) => `${b.ua}(${b.role})`).join(' · ');
    out.push(
      g.expect === 'block'
        ? {
            level: 'warn',
            text: (
              <>
                <b>{g.label}</b> 봇이 열려 있습니다 — {names}. 학습 수집은 막는 것이 방침인데
                이 봇들은 통과합니다. 방침이 바뀐 것인지 빠뜨린 것인지 확인이 필요합니다.
              </>
            ),
          }
        : {
            level: g.key === 'search' ? 'crit' : 'warn',
            text: (
              <>
                <b>{g.label}</b> 봇이 막혀 있습니다 — {names}.{' '}
                {g.key === 'search'
                  ? '해당 검색엔진 결과에서 빠집니다.'
                  : g.key === 'share'
                    ? '메신저·SNS 에 링크를 붙여도 제목과 썸네일이 뜨지 않습니다.'
                    : '해당 엔진이 답변에 인용하고 출처를 달 수 없습니다.'}
              </>
            ),
          },
    );
  }

  if (e.renderAssets?.blocked > 0) {
    out.push({
      level: 'crit',
      text: (
        <>
          <b>Googlebot 에게 CSS·JS 가 막혀 있습니다</b> — 크롤한 페이지가 부르는 자원{' '}
          {e.renderAssets.total}건 중 {e.renderAssets.blocked}건 (
          {e.renderAssets.prefixes.map((p, i) => (
            <Fragment key={p}>
              {i > 0 && ' · '}
              <code>{p}</code>
            </Fragment>
          ))}
          ). 본문 HTML 은 열려 있어 색인 자체는 되지만, 구글은 스타일도 스크립트도 없는
          상태로 그 페이지를 평가합니다. 구글이 "CSS·JS 를 막지 말라" 고 명시한 항목입니다.
        </>
      ),
    });
  }

  if (e.robots.valid !== false && (e.robots.sitemaps?.length ?? 0) === 0) {
    out.push({
      level: 'info',
      text: (
        <>
          robots.txt 에 <code>Sitemap:</code> 선언이 없습니다. Search Console 에 직접
          제출해 뒀다면 당장 문제는 아니지만, 그 등록을 모르는 봇은 사이트맵을 찾지
          못합니다.
        </>
      ),
    });
  }

  if (out.length === 0) {
    out.push({ level: 'good', text: 'robots.txt 때문에 막히는 것이 없습니다.' });
  }
  return out;
}

const LEVEL_LABEL = { crit: '확인 필요', warn: '주의', info: '참고', good: '이상 없음' };
const LEVEL_COLOR = {
  crit: 'var(--crit)',
  warn: 'var(--warn)',
  info: 'var(--info)',
  good: 'var(--good)',
};

export function RobotsSection({ readiness }) {
  const catalog = readiness.botCatalog ?? [];
  const origins = readiness.serviceOrigins ?? {};
  const checked = catalog.reduce((a, g) => a + g.bots.length, 0);

  // 집계 대상 세 서비스 + robots.txt 만 보는 호스트. 뒤쪽은 색을 주지 않는다 —
  // 다른 탭의 서비스 색과 나란히 두면 "집계에도 들어간다" 로 읽히기 때문이다.
  const entries = [
    ...SERVICES.filter((s) => readiness.measurements?.[s.key]).map((s) => ({
      key: s.key,
      name: s.name,
      hex: s.hex,
      color: s.color,
      origin: origins[s.key] ?? '',
      robots: readiness.measurements[s.key].robots,
      renderAssets: readiness.measurements[s.key].renderAssets,
      scored: true,
    })),
    ...(readiness.extraHosts ?? []).map((h) => ({
      key: h.key,
      name: h.name,
      hex: 'var(--muted)',
      color: 'var(--muted)',
      origin: h.origin,
      robots: h.robots,
      renderAssets: null,
      scored: false,
    })),
  ];
  const extraCount = entries.filter((e) => !e.scored).length;

  // 점수와 이어 붙는다 — 이 탭에서 "막혔다" 가 저 탭에서 몇 점인지 보이게.
  const geoAxis = readiness.axes?.find((a) => a.key === 'geo');
  const weightOf = (ua) => geoAxis?.items.find((i) => i.name === ua)?.max ?? null;

  return (
    <section>
      <div className="sec-head">
        <span className="eyebrow">Bots</span>
        <h2>robots.txt 현황</h2>
      </div>
      <p className="sec-note">
        {readiness.measuredAt} 측정 · 호스트 {entries.length}곳의 <code>/robots.txt</code> 를
        직접 받아 봇 {checked}종을 하나씩 대조한 결과입니다. 규칙은 표준대로 읽습니다 —
        이름이 정확히 적힌 그룹이 있으면 그 그룹만 보고, 없을 때만{' '}
        <code>User-agent: *</code> 를 봅니다.
      </p>
      {extraCount > 0 && (
        <p className="sec-note">
          <b>robots.txt 는 호스트마다 따로입니다.</b> 닷컴의 허용 목록은 같은 도메인의 다른
          호스트에 적용되지 않습니다. 그래서 집계 범위 밖이라도 이 탭에는 올립니다 — 다만
          상세 페이지 구조가 제각각이라 <b>점수는 매기지 않습니다</b>.
        </p>
      )}

      <div className="grid-3">
        {entries.map((e) => {
          const allowed = catalog.reduce(
            (a, g) => a + g.bots.filter((b) => e.robots.bots[b.ua]).length,
            0,
          );
          const none = e.robots.valid === false;
          const open = e.robots.defaultAllow;
          return (
            <article className="card" style={{ '--c': e.color }} key={e.key}>
              <h3>
                {e.name}
                {!e.scored && (
                  <span className="pill info" style={{ marginLeft: 6 }}>
                    집계 범위 밖
                  </span>
                )}
              </h3>
              <div className="host">
                <a href={`${e.origin}/robots.txt`} target="_blank" rel="noreferrer">
                  {e.origin.replace(/^https?:\/\//, '')}/robots.txt
                </a>
              </div>
              <div className="policy">
                <span className={`pill ${none ? 'warn' : open ? 'info' : 'crit'}`}>
                  {none ? 'robots.txt 없음' : open ? '전체 허용' : '허용 목록 외 차단'}
                </span>
                <p>
                  {none ? (
                    <>
                      규칙 파일 대신 HTML 이 돌아옵니다. 봇에게는 <b>규칙 없음</b>, 즉 전체
                      허용과 같게 보입니다.
                    </>
                  ) : open ? (
                    <>
                      <code>User-agent: *</code> 가 <code>Allow: /</code> 입니다. 학습봇을
                      포함해 <b>모든 봇</b>이 통과합니다.
                    </>
                  ) : (
                    <>
                      <code>User-agent: *</code> 가 <code>Disallow: /</code> 입니다. 이름이
                      적힌 <b>{e.robots.namedAgents.length}종</b>만 통과하고 나머지는 전부
                      막힙니다.
                    </>
                  )}
                </p>
              </div>
              <div className="card-stats">
                <div className="stat">
                  <span className="k">허용된 봇</span>
                  <span className="v num">
                    {allowed}
                    <small>/{checked}</small>
                  </span>
                </div>
                <div className="stat">
                  <span className="k">Sitemap 선언</span>
                  <span className="v num" style={{ fontSize: 'var(--t-lg)' }}>
                    {e.robots.sitemaps?.length ? '있음' : '없음'}
                  </span>
                </div>
                <div className="stat">
                  <span className="k">렌더링 자원</span>
                  <span className="v num" style={{ fontSize: 'var(--t-lg)' }}>
                    {!e.renderAssets
                      ? '측정 안 함'
                      : e.renderAssets.blocked > 0
                        ? `${e.renderAssets.blocked}건 차단`
                        : '전부 열림'}
                  </span>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div className="sec-head" style={{ marginTop: 'var(--s-6)' }}>
        <span className="eyebrow">Findings</span>
        <h2>짚어야 할 것</h2>
      </div>
      <p className="sec-note">
        "열려 있어야 하는데 막힌 것" 과 "막아야 하는데 열린 것" 을 양쪽 다 봅니다. 학습
        수집봇은 <b>차단이 정상</b>이라 막혀 있는 것을 문제로 세지 않습니다.
      </p>
      <div className="grid-3">
        {entries.map((e) => (
          <div className="panel" key={e.key}>
            <div className="panel-head">
              <h3 style={{ color: e.hex }}>{e.name}</h3>
            </div>
            <div className="ins">
              {findings(e, catalog).map((f, i) => (
                <div className="ins-row" style={{ '--c': LEVEL_COLOR[f.level] }} key={i}>
                  <span className={`pill ${f.level === 'good' ? 'good' : f.level}`}>
                    {LEVEL_LABEL[f.level]}
                  </span>
                  <span className="txt">{f.text}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="sec-head" style={{ marginTop: 'var(--s-6)' }}>
        <span className="eyebrow">Bot by bot</span>
        <h2>봇별 허용 · 차단</h2>
      </div>
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>봇 · 역할</th>
              {entries.map((e) => (
                <th className="n" key={e.key} style={{ color: e.hex }}>
                  {e.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {catalog.map((g) => (
              <Fragment key={g.key}>
                <tr style={{ background: 'var(--surface-2)' }}>
                  <td colSpan={entries.length + 1}>
                    <div style={{ fontWeight: 800 }}>
                      {g.label}
                      <span
                        className={`pill ${g.expect === 'block' ? 'warn' : 'good'}`}
                        style={{ marginLeft: 8 }}
                      >
                        {g.expect === 'block' ? '차단이 정상' : '허용이 정상'}
                      </span>
                    </div>
                    <div style={{ fontSize: 'var(--t-sm)', color: 'var(--muted)', fontWeight: 500 }}>
                      {g.why}
                    </div>
                  </td>
                </tr>
                {g.bots.map((b) => {
                  const w = weightOf(b.ua);
                  return (
                    <tr key={b.ua}>
                      <td style={{ paddingLeft: 22 }}>
                        <div className="mono" style={{ fontWeight: 700 }}>
                          {b.ua}
                          {w !== null && (
                            <span className="pill info" style={{ marginLeft: 6 }}>
                              GEO {w}점
                            </span>
                          )}
                          {b.seo && (
                            <span className="pill info" style={{ marginLeft: 6 }}>
                              SEO 배점
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 'var(--t-sm)', color: 'var(--muted)' }}>
                          {b.role}
                        </div>
                      </td>
                      {entries.map((e) => {
                        const v = verdict(e.robots.bots[b.ua], g.expect);
                        return (
                          <td className="n" key={e.key}>
                            <span className={`pill ${v.cls}`}>{v.label}</span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="p-note">
        이 표는 robots.txt 가 <b>허락하는지</b>만 봅니다. 봇이 실제로 와서 가져갔는지는
        서버 로그를 봐야 알고, 규칙을 무시하는 수집기도 있습니다. 반대로 열어 뒀다고
        반드시 오는 것도 아닙니다.
      </p>

      <div className="sec-head" style={{ marginTop: 'var(--s-6)' }}>
        <span className="eyebrow">Source</span>
        <h2>원문</h2>
      </div>
      <div className="grid-3">
        {entries.map((e) => (
          <div className="panel" key={e.key}>
            <div className="panel-head">
              <h3 style={{ color: e.hex }}>{e.name}</h3>
              <span style={{ fontSize: 'var(--t-xs)', color: 'var(--muted)', fontWeight: 700 }}>
                HTTP {e.robots.status}
              </span>
            </div>
            <pre className="raw">
              {e.robots.valid === false
                ? `${e.robots.raw.slice(0, 300)}\n\n— robots.txt 가 아닙니다 —`
                : e.robots.raw}
            </pre>
          </div>
        ))}
      </div>
    </section>
  );
}
