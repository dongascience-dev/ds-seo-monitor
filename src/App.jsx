import { Fragment, useEffect, useMemo, useState } from 'react';
import { ReadinessRadar, SurfaceStack, TrendLines } from './components/Charts.jsx';
import {
  Insights,
  OverviewChange,
  OtherHosts,
  ServiceCards,
  SurfaceBlock,
} from './components/Sections.jsx';
import { Why } from './components/Why.jsx';
import { AiSection, CountrySection } from './components/Ga4.jsx';
import { Summary } from './components/Summary.jsx';
import { SERVICES, fmtDate, fmtDateTime, nf } from './lib/format.js';

/** 캐시 우회 — 수집 워크플로가 JSON 만 갈아끼우므로 빌드 해시가 바뀌지 않는다. */
const load = (name) =>
  fetch(`./data/${name}.json?t=${Date.now()}`).then((r) => {
    if (!r.ok) throw new Error(`${name}.json ${r.status}`);
    return r.json();
  });

const TABS = [
  { key: 'overview', label: '전체', hint: '요약 · 인사이트' },
  ...SERVICES.map((s) => ({ key: s.key, label: s.name, hint: '콘텐츠 · 검색어', color: s.hex })),
  { key: 'others', label: '그 외 호스트', hint: '집계 범위 밖' },
  { key: 'traffic', label: '국가별 유입', hint: 'GA4 세션' },
  { key: 'readiness', label: 'SEO · AEO · GEO', hint: '사이트 점검' },
];

const TAB_KEYS = new Set(TABS.map((t) => t.key));

/**
 * 화면 밝기. 기본은 OS 설정을 따라가고, 고정하고 싶으면 고를 수 있다.
 * 공유 URL 이라 보는 사람마다 OS 설정이 다르다.
 */
const THEMES = [
  { key: 'auto', label: '자동', icon: '◐' },
  { key: 'light', label: '밝게', icon: '☀' },
  { key: 'dark', label: '어둡게', icon: '☾' },
];

/**
 * 수집이 멈춘 것을 화면에서 알아채게 한다.
 *
 * 워크플로가 깨져도 페이지는 옛 데이터를 그대로 보여준다. `Last updated` 를
 * 들여다봐야만 알 수 있는데, 매일 여는 화면이 아니면 몇 주 뒤에야 눈치챈다.
 *
 * 기준은 `generatedAt`(수집이 돈 시각)이지 `dataThrough`(GSC 최신일)가 아니다.
 * 후자는 GSC 자체 지연으로 늘 2~3일 뒤쳐져 있어 신호가 되지 못한다.
 * 하루 1회 도는데 주말·지연을 감안해 3일부터 경고한다.
 */
const STALE_WARN_DAYS = 3;
const STALE_CRIT_DAYS = 7;

function staleness(isoDateTime) {
  const t = Date.parse(isoDateTime ?? '');
  if (Number.isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days < STALE_WARN_DAYS) return null;
  return { days, level: days >= STALE_CRIT_DAYS ? 'crit' : 'warn' };
}

function applyTheme(key) {
  const root = document.documentElement;
  if (key === 'auto') delete root.dataset.theme;
  else root.dataset.theme = key;
}

export default function App() {
  const [gsc, setGsc] = useState(null);
  const [history, setHistory] = useState([]);
  const [readiness, setReadiness] = useState(null);
  const [ga4, setGa4] = useState(null);
  const [error, setError] = useState(null);
  // 탭은 URL 해시에 둔다. "이 화면 보세요" 하고 링크를 던질 수 있어야 하기 때문이다.
  // 해시가 없을 때만 지난번 탭을 복원한다.
  const [tab, setTab] = useState(() => {
    const fromHash = typeof location !== 'undefined' && location.hash.slice(1);
    if (fromHash && TAB_KEYS.has(fromHash)) return fromHash;
    try {
      const saved = localStorage.getItem('ds-seo-tab');
      return saved && TAB_KEYS.has(saved) ? saved : 'overview';
    } catch {
      return 'overview';
    }
  });

  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('ds-seo-theme');
      return THEMES.some((t) => t.key === saved) ? saved : 'auto';
    } catch {
      return 'auto';
    }
  });

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem('ds-seo-theme', theme);
    } catch {
      /* 시크릿 창 등에서 막힐 수 있다. 저장 실패가 화면을 막으면 안 된다. */
    }
  }, [theme]);

  // 뒤로가기 · 링크 직접 입력에도 따라간다.
  useEffect(() => {
    const on = () => {
      const h = location.hash.slice(1);
      if (h && TAB_KEYS.has(h)) setTab(h);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    Promise.all([
      load('gsc-weekly'),
      load('gsc-history').catch(() => []),
      load('readiness').catch(() => null),
      load('ga4-weekly').catch(() => null),
    ])
      .then(([g, h, r, a]) => {
        setGsc(g);
        // 진행 중인 주(N일 합계)가 섞여 있으면 추세선이 절벽처럼 꺾인다.
        // 수집기가 더는 넣지 않지만, 예전에 쌓인 JSON 을 읽을 수 있어 여기서도 거른다.
        setHistory(Array.isArray(h) ? h.filter((w) => w.days === 7) : []);
        setReadiness(r);
        setGa4(a);
      })
      .catch((e) => setError(e.message));
  }, []);

  const pick = (key) => {
    setTab(key);
    if (typeof location !== 'undefined') location.hash = key;
    try {
      localStorage.setItem('ds-seo-tab', key);
    } catch {
      /* 시크릿 창 등에서 막힐 수 있다. 저장 실패가 화면을 막으면 안 된다. */
    }
  };

  const totals = useMemo(() => {
    if (!gsc) return null;
    return Object.values(gsc.services).reduce(
      (a, s) => ({
        web: a.web + s.web.current.clicks,
        discover: a.discover + (s.discover?.current.clicks ?? 0),
      }),
      { web: 0, discover: 0 },
    );
  }, [gsc]);

  if (error) {
    return (
      <div className="state">
        데이터를 불러오지 못했다 — {error}
        <br />
        <span style={{ fontSize: 'var(--t-sm)' }}>
          <code>npm run collect</code> 를 먼저 실행해 <code>public/data/</code> 를 채운다.
        </span>
      </div>
    );
  }
  if (!gsc) return <div className="state">불러오는 중…</div>;

  const { periods } = gsc;
  const stale = staleness(gsc.generatedAt);
  // 주가 아직 안 끝났으면 화면 어디서도 "주간 합계" 로 읽히면 안 된다.
  // GSC 2~3일 지연 + 매일 1회 수집이라 주 초에는 늘 이 상태가 된다.
  const partial = periods.current.partial ?? periods.current.days < 7;

  return (
    <>
      <header className="top">
        <div className="top-in">
          <div className="brand">
            <div className="dot" />
            <div>
              <h1>동아사이언스 SEO 모니터</h1>
              <p className="sub">3개 서비스 · 주간 검색 유입과 사이트 점검</p>
            </div>
          </div>
          <div className="chips">
            <span className="chip">
              조회 기간 <b>{fmtDate(periods.current.start)}~{fmtDate(periods.current.end)}</b> (
              {periods.current.days}일{partial && ' · 진행 중'})
            </span>
            <span className="chip">
              Data through <b>{gsc.dataThrough}</b>
            </span>
            <span className="chip">
              Last updated <b>{fmtDateTime(gsc.generatedAt)}</b>
            </span>
            <div className="theme-switch" role="group" aria-label="화면 밝기">
              {THEMES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={theme === t.key}
                  title={t.label}
                  onClick={() => setTheme(t.key)}
                >
                  {t.icon}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <div className="wrap">
        {stale && (
          <div className={`banner ${stale.level}`} role="status">
            <b>수집이 {stale.days}일째 돌지 않았습니다.</b> 화면의 모든 수치가 그만큼
            오래된 값입니다. 마지막 수집 {fmtDateTime(gsc.generatedAt)} · GitHub Actions
            의 <code>update</code> 워크플로가 실패하고 있는지 확인하세요. 서비스 계정 키
            만료나 권한 회수가 흔한 원인입니다.
          </div>
        )}

        <div className="tabs" role="tablist" aria-label="보기 전환">
          {TABS.map((t) => (
            <button
              className="tab"
              role="tab"
              key={t.key}
              aria-selected={tab === t.key}
              onClick={() => pick(t.key)}
            >
              {t.color && <span className="swatch" style={{ background: t.color }} />}
              {t.label}
              <small style={{ fontWeight: 600, fontSize: 'var(--t-xs)', color: 'var(--muted)' }}>
                {t.hint}
              </small>
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <>
            <Summary gsc={gsc} />

            <section>
              <div className="sec-head">
                <span className="eyebrow">Overview</span>
                <h2>{partial ? '이번 주(진행 중) vs 전주' : '이번 주 vs 전주'}</h2>
              </div>
              {/*
                기간을 문장에 묻으면 "이번 주가 언제까지인지"를 매번 헤더에서
                찾아야 한다. 두 구간을 나란히 드러낸다.
              */}
              <div className="range">
                <span>
                  이번 주{' '}
                  <b>
                    {fmtDate(periods.current.start)}~{fmtDate(periods.current.end)}
                  </b>
                  <small>
                    {periods.current.days}일{partial && ' · 진행 중'}
                  </small>
                </span>
                <span className="vs">vs</span>
                <span>
                  전주{' '}
                  <b>
                    {fmtDate(periods.previous.start)}~{fmtDate(periods.previous.end)}
                  </b>
                  <small>{periods.previous.days}일</small>
                </span>
              </div>
              <p className="sec-note">
                전주는 <b>같은 요일 수</b>로 잘라 비교합니다. 기간이 다르면 증감이
                왜곡됩니다.{' '}
                {partial ? (
                  <>
                    아래 수치는 <b>{periods.current.days}일치 합계</b>(주간 합계가 아닙니다) —
                    웹 검색 {nf(totals.web)} · Discover {nf(totals.discover)} 클릭입니다.
                  </>
                ) : (
                  <>
                    이번 주 전체 클릭은 웹 검색 {nf(totals.web)} · Discover{' '}
                    {nf(totals.discover)} 입니다.
                  </>
                )}
              </p>
              <ServiceCards services={gsc.services} />

              {/*
                합계가 왜 안 맞는지 그 자리에서 밝힌다.
                화면은 세 서비스만 그리는데 Search Console 속성은 도메인 전체라,
                카드 셋을 더해도 속성 총계가 되지 않는다. 모르면 "수치가 틀렸다"
                로 읽히고, 알면 "저건 범위 밖" 이 된다.
              */}
              {gsc.otherHosts?.current?.clicks > 0 && (
                <p className="other-hosts">
                  이 화면은 <b>세 서비스만</b> 집계합니다. 같은 도메인의 그 외 호스트{' '}
                  <b>{gsc.otherHosts.hosts.length}곳</b>에서 클릭{' '}
                  <b>{nf(gsc.otherHosts.current.clicks)}</b> · 노출{' '}
                  {nf(gsc.otherHosts.current.impressions)} 가 더 잡힙니다 — 전체의{' '}
                  {(
                    (gsc.otherHosts.current.clicks /
                      (totals.web + gsc.otherHosts.current.clicks)) *
                    100
                  ).toFixed(1)}
                  %. 어느 호스트인지는{' '}
                  <button type="button" className="linkish" onClick={() => pick('others')}>
                    그 외 호스트
                  </button>{' '}
                  탭에 있습니다.
                </p>
              )}

              <OverviewChange services={gsc.services} />
            </section>

            <section>
              <div className="sec-head">
                <span className="eyebrow">Insights</span>
                <h2>주요 변화와 이상 징후</h2>
              </div>
              <Why label="왜 전주 대비만 안 보나">
                전주 대비만 보면 오판합니다. 닷컴 Discover 는 주간 클릭이 7만~29만을
                오가서, 전주가 최고치였으면 이번 주는 정상 범위인데도 -72% 로 찍힙니다.
                그래서 <b>최근 12주 범위</b>를 함께 봅니다 — 평소 범위 안이면 증감이 커도
                "참고"로 낮추고, 전주 대비가 잠잠해도 범위 밖이면 "주의"로 올립니다.
              </Why>
              <Insights insights={gsc.insights} />
            </section>

            {history.length > 1 && (
              <>
                <section>
                  <div className="sec-head">
                    <span className="eyebrow">Trend</span>
                    <h2>주간 클릭 추세</h2>
                  </div>
                  <p className="sec-note">
                    {history.length}주 · {fmtDate(history[0].weekStart)} 이후.
                  </p>
                  <TrendLines history={history} surface="web" metric="clicks" />
                  <div style={{ marginTop: 'var(--s-4)' }}>
                    <TrendLines history={history} surface="discover" metric="clicks" />
                  </div>
                  <div style={{ marginTop: 'var(--s-4)' }}>
                    <SurfaceStack history={history} serviceKey="donga" />
                  </div>
                </section>
              </>
            )}

            <section>
              <div className="sec-head">
                <span className="eyebrow">Hygiene</span>
                <h2>개발계 색인 잔존</h2>
              </div>
              <Why label="이 숫자가 0 이어야 하는 이유">
                개발 서버(<code>ncdev-*</code> · <code>dev-*</code> 등)가 운영과 같은
                내용을 서빙한 채 검색에 잡히면 중복 콘텐츠가 됩니다. <b>0 이 되면</b>{' '}
                robots.txt 로 크롤을 막을 수 있습니다 — 그 전에 막으면 크롤러가 noindex
                를 못 읽어 색인이 그대로 남습니다. (#12239)
              </Why>
              <div className="panel">
                <div className="card-stats" style={{ borderTop: 0, paddingTop: 0 }}>
                  <div className="stat">
                    <span className="k">이번 주 노출</span>
                    <span className="v num">{nf(gsc.devHosts.current.impressions)}</span>
                  </div>
                  <div className="stat">
                    <span className="k">전주 노출</span>
                    <span className="v num">{nf(gsc.devHosts.previous.impressions)}</span>
                  </div>
                  <div className="stat">
                    <span className="k">이번 주 클릭</span>
                    <span className="v num">{nf(gsc.devHosts.current.clicks)}</span>
                  </div>
                  <div className="stat">
                    <span className="k">전주 클릭</span>
                    <span className="v num">{nf(gsc.devHosts.previous.clicks)}</span>
                  </div>
                </div>
              </div>

              {gsc.devHosts.hosts?.some((h) => h.impressions > 0) && (
                <div className="tw" style={{ marginTop: 'var(--s-4)' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>개발계 호스트</th>
                        <th className="n">노출 URL</th>
                        <th className="n">노출</th>
                        <th className="n">클릭</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gsc.devHosts.hosts
                        .filter((h) => h.impressions > 0)
                        .map((h) => (
                          <tr key={h.host}>
                            <td className="mono">{h.host}</td>
                            <td className="n">{nf(h.urls)}</td>
                            <td className="n">{nf(h.impressions)}</td>
                            <td className="n">{nf(h.clicks)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}

              <p className="p-note" style={{ marginTop: 'var(--s-3)' }}>
                노출된 URL 목록은 싣지 않습니다 — 이 데이터는 공개되고, 운영과 같은
                내용을 서빙하는 개발 서버의 살아 있는 주소를 모아 주는 셈이 됩니다.
                {gsc.devHosts.urlCount > 0 && <> 이번 주 {gsc.devHosts.urlCount}개 URL 이 잡혔으며,</>}{' '}
                어느 URL 인지는 Search Console 에서 확인합니다.
              </p>
            </section>
          </>
        )}

        {SERVICES.map(
          (s) =>
            tab === s.key && (
              <section key={s.key}>
                <div className="sec-head">
                  <span className="eyebrow">{s.name}</span>
                  <h2>콘텐츠 · 검색어</h2>
                </div>
                <div className="range">
                  <span>
                    이번 주{' '}
                    <b>
                      {fmtDate(periods.current.start)}~{fmtDate(periods.current.end)}
                    </b>
                    <small>
                      {periods.current.days}일{partial && ' · 진행 중'}
                    </small>
                  </span>
                  <span className="vs">vs</span>
                  <span>
                    전주{' '}
                    <b>
                      {fmtDate(periods.previous.start)}~{fmtDate(periods.previous.end)}
                    </b>
                  </span>
                  <span className="vs">·</span>
                  <span className="mono">{gsc.services[s.key].host}</span>
                </div>
                <SurfaceBlock
                  surface={gsc.services[s.key].web}
                  label="웹 검색"
                  color={s.hex}
                  periods={periods}
                />
                {gsc.services[s.key].discover && (
                  <>
                    <div className="sec-head" style={{ marginTop: 'var(--s-6)' }}>
                      <span className="eyebrow">Discover</span>
                      <h2>구글 앱 피드</h2>
                    </div>
                    <p className="sec-note">
                      이 서비스는 Discover 클릭이 웹 검색보다 많습니다. 검색어·순위는 없습니다.
                    </p>
                    <SurfaceBlock
                      surface={gsc.services[s.key].discover}
                      label="Discover"
                      color="#6d3aff"
                      periods={periods}
                      isDiscover
                    />
                  </>
                )}
              </section>
            ),
        )}

        {tab === 'others' && (
          <section>
            <div className="sec-head">
              <span className="eyebrow">Out of scope</span>
              <h2>그 외 호스트</h2>
            </div>
            <OtherHosts
              otherHosts={gsc.otherHosts}
              periods={periods}
              serviceClicks={totals.web}
            />
          </section>
        )}

        {tab === 'traffic' &&
          (ga4 ? (
            <CountrySection ga4={ga4} />
          ) : (
            <section>
              <p className="sec-note">
                <code>public/data/ga4-weekly.json</code> 이 없다.{' '}
                <code>node scripts/collect-ga4.mjs</code> 를 실행한다.
              </p>
            </section>
          ))}

        {tab === 'readiness' && (
          <section>
            <div className="sec-head">
              <span className="eyebrow">Readiness</span>
              <h2>SEO · AEO · GEO 준비도</h2>
            </div>
            {readiness ? (
              <>
                <p className="sec-note">
                  {readiness.measuredAt} 측정 · 서비스당 최대 300건 크롤
                </p>
                <div className="callout" style={{ marginTop: 0, marginBottom: 'var(--s-4)' }}>
                  <b>결과가 아니라 준비도입니다.</b> 충족률은 실측이지만 <b>배점은 선택</b>
                  이라, 서비스 간 순서는 믿을 수 있어도 절대 점수는 배점을 바꾸면
                  달라집니다.
                </div>
                <div className="grid-3">
                  {readiness.axes.map((axis) => (
                    <ReadinessRadar axis={axis} key={axis.key} />
                  ))}
                </div>
                <div className="tw" style={{ marginTop: 'var(--s-4)' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>축 · 항목</th>
                        <th className="n">배점</th>
                        {SERVICES.map((s) => (
                          <th className="n" key={s.key} style={{ color: s.hex }}>
                            {s.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {readiness.axes.map((axis) => (
                        <Fragment key={axis.key}>
                          <tr style={{ background: 'var(--surface-2)' }}>
                            <td style={{ fontWeight: 800 }}>{axis.label}</td>
                            <td className="n">100</td>
                            {SERVICES.map((s) => (
                              <td className="n" key={s.key} style={{ color: s.hex, fontWeight: 800 }}>
                                {Math.round(
                                  axis.items.reduce((a, i) => a + i.scores[s.key], 0) * 10,
                                ) / 10}
                              </td>
                            ))}
                          </tr>
                          {axis.items.map((i) => (
                            <tr key={`${axis.key}-${i.name}`}>
                              <td style={{ paddingLeft: 22 }}>
                                <div style={{ fontWeight: 600 }}>
                                  {i.name}
                                  {i.auto === false && (
                                    <span className="pill warn" style={{ marginLeft: 6, fontSize: 'var(--t-xs)' }}>
                                      분모 추정
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize: 'var(--t-sm)', color: 'var(--muted)' }}>{i.rule}</div>
                              </td>
                              <td className="n">{i.max}</td>
                              {SERVICES.map((s) => (
                                <td className="n" key={s.key}>
                                  <div>{i.scores[s.key]}</div>
                                  <div
                                    style={{
                                      fontSize: 'var(--t-xs)',
                                      color: 'var(--muted)',
                                      fontWeight: 500,
                                    }}
                                  >
                                    {i.notes?.[s.key] ?? ''}
                                  </div>
                                </td>
                              ))}
                            </tr>
                          ))}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="callout">
                  <b>못 세는 것은 비워 뒀습니다.</b>
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                    {readiness.unmeasurable.map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                </div>

                {/* GEO 축만 결과를 잴 수 있다. 준비도 바로 옆에 둔다. */}
                {ga4 && <AiSection ga4={ga4} />}
              </>
            ) : (
              <p className="sec-note">
                <code>public/data/readiness.json</code> 이 없다.
              </p>
            )}
          </section>
        )}

        <footer>
          <strong style={{ color: 'var(--ink-2)' }}>측정 방법과 한계</strong>
          <ul>
            <li>
              Search Console <code>{gsc.site}</code> 도메인 속성. 서비스는 page 차원 정규식으로
              가른다 (닷컴은 www · m · apex 세 호스트 합산).
            </li>
            <li>
              <b>데이터는 2~3일 지연된다.</b> "어제까지"를 가정하지 않고, 실제로 행이 돌아온
              마지막 날(<code>{gsc.dataThrough}</code>)을 기준일로 씁니다.
            </li>
            <li>
              <b>주가 끝나기 전에는 N일치 합계다.</b> GSC 가 2~3일 지연되므로 주 초에
              열면 이번 주 구간이 1~3일로 잡힙니다. 전주도 같은 요일 수로 잘라 비교하니
              증감 자체는 공정하지만 <b>주간 합계는 아닙니다</b>. 그런 주는 추세선과 12주
              기준선에도 넣지 않습니다 — 7일 합계 사이에 섞이면 둘 다 틀어집니다.
            </li>
            <li>
              <b>페이지별 합계는 속성 총계보다 작습니다.</b> 같은 이유(희소 항목
              익명화)로 page 차원에서도 노출이 빠집니다. 실측(2026-09-28~29): 속성
              총계 노출 905,547 인데 페이지를 전부 더하면 536,841 로,{' '}
              <b>40.7%가 page 차원에서 사라집니다</b>. 그래서 서비스 카드를 다 더해도
              Search Console 속성 총계가 되지 않습니다 — 빠진 호스트 때문이 아니라
              대부분 이 손실입니다.
            </li>
            <li>
              <b>검색어 합계는 페이지 합계보다 작습니다.</b> 구글이 개인 식별 우려가 있는
              희소 검색어를 응답에서 빼기 때문입니다. 서비스마다 손실 폭이 달라 각
              "상위 검색어" 패널에 이번 주 커버리지를 적어 뒀습니다. 페이지 쪽 수치가
              총계와 맞는 쪽이고, 검색어는 보이는 만큼만입니다.
            </li>
            <li>
              페이지·검색어는 기간별 상위 5,000행까지 받는다. 잘린 경우 반대쪽 기간에 없는
              항목의 값은 0 이 아니라 "그 응답의 최저 클릭수 미만"이므로 그렇게 표기한다 —
              순위권 밖으로 밀린 것을 소멸로 보고하지 않기 위해서다.
            </li>
            <li>
              Discover 는 <code>query</code>·<code>position</code> 차원이 없다. 검색이 아니라
              피드 추천 유입이라 API 가 제공하지 않습니다.
            </li>
            {gsc.crossCheck?.dlPrefixProperty && (
              <li>
                <b>확인 필요 — d라이브러리 속성 간 차이.</b> 도메인 속성을 호스트로 거른 값이
                노출 {nf(gsc.services.dl.web.current.impressions)} 인데, 전용 URL-prefix 속성(
                <code>{gsc.crossCheck.dlPrefixProperty.site}</code>)은{' '}
                {nf(gsc.crossCheck.dlPrefixProperty.current.impressions)} 이다. 접두사 속성이{' '}
                <code>/dl/</code> 경로 밖을 집계하지 않는 것으로 보이나 확인 전이다. 화면
                수치는 도메인 속성 기준입니다.
              </li>
            )}
            <li>
              인사이트 임계값은 <code>scripts/collect-gsc.mjs</code> 의 <code>RULES</code> 에
              모아 뒀다. 기준선은 직전 12주 10~90분위다.
            </li>
          </ul>
        </footer>
      </div>
    </>
  );
}
