import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { tooltipProps, useChartTheme } from './Charts.jsx';
import { SERVICES, change, compact, fmtDate, nf, signed } from '../lib/format.js';

const ax = (t) => ({ stroke: t.axis, tick: { fill: t.axis, fontSize: 11 }, tickLine: false });

/**
 * 확인 필요 국가를 **국가명**에 표시한다.
 *
 * 처음엔 막대를 반투명하게 칠했는데, 전주 막대도 회색이라 둘 다 "옅게" 보였다.
 * 한국은 플래그되지 않았는데도 전주 막대(336,306)가 길고 옅어서 확인 필요로
 * 읽혔다. 한 화면에서 두 가지가 같은 방식으로 흐려지면 안 된다.
 */
const CountryTick = ({ x, y, payload, flagged, t }) => {
  const hit = flagged.has(payload.value);
  return (
    <text
      x={x}
      y={y}
      dy={4}
      textAnchor="end"
      fontSize={11}
      fontWeight={hit ? 700 : 400}
      fill={hit ? t.crit : t.axis}
    >
      {hit ? '\u26a0 ' : ''}
      {payload.value}
    </text>
  );
};

/** 국가별 세션 — 이번 주 vs 전주. */
function CountryBars({ countries, color, limit = 12 }) {
  const t = useChartTheme();
  const rows = countries.slice(0, limit);
  const flagged = new Set(rows.filter((c) => c.suspicious).map((c) => c.country));
  const data = rows.map((c) => ({
    name: c.country,
    이번주: c.sessions,
    전주: c.prevSessions,
  }));
  if (!data.length) return <p className="p-note">데이터 없음</p>;

  return (
    <ResponsiveContainer width="100%" height={Math.max(220, data.length * 30 + 50)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }}>
        <CartesianGrid stroke={t.grid} horizontal={false} />
        <XAxis type="number" {...ax(t)} tickFormatter={compact} />
        <YAxis
          type="category"
          dataKey="name"
          stroke={t.axis}
          tickLine={false}
          width={124}
          tick={<CountryTick flagged={flagged} t={t} />}
        />
        <Tooltip {...tooltipProps(t)} formatter={(v) => nf(v)} />
        <Legend wrapperStyle={{ fontSize: 11.5, color: t.axis }} />
        <Bar dataKey="전주" fill={t.grid} radius={[0, 3, 3, 0]} isAnimationActive={false} />
        <Bar dataKey="이번주" fill={color} radius={[0, 3, 3, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function EngineBars({ engines, limit = 6 }) {
  const t = useChartTheme();
  const data = engines.slice(0, limit).map((e) => ({
    name: e.engine,
    이번주: e.sessions,
    전주: e.prevSessions,
  }));
  if (!data.length) return <p className="p-note">이번 주 AI 채널 유입 없음</p>;
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 30 + 50)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }}>
        <CartesianGrid stroke={t.grid} horizontal={false} />
        <XAxis type="number" {...ax(t)} tickFormatter={compact} />
        <YAxis type="category" dataKey="name" {...ax(t)} width={92} />
        <Tooltip {...tooltipProps(t)} formatter={(v) => nf(v)} />
        <Legend wrapperStyle={{ fontSize: 11.5, color: t.axis }} />
        <Bar dataKey="전주" fill={t.grid} radius={[0, 3, 3, 0]} isAnimationActive={false} />
        <Bar dataKey="이번주" fill="#6d3aff" radius={[0, 3, 3, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

const Delta = ({ cur, prev }) => {
  const d = change(cur, prev);
  if (d === null) return <span style={{ color: 'var(--muted)' }}>—</span>;
  const flat = Math.abs(d) < 3;
  return (
    <span style={{ color: flat ? 'var(--muted)' : d > 0 ? 'var(--good)' : 'var(--crit)' }}>
      {signed(d)}
    </span>
  );
};

export function CountrySection({ ga4 }) {
  const flagged = SERVICES.flatMap((s) =>
    (ga4.services[s.key]?.countries ?? [])
      .filter((c) => c.suspicious)
      .map((c) => ({ ...c, service: s.name, color: s.hex })),
  ).sort((a, b) => b.sessions - a.sessions);

  return (
    <>
      <section>
        <div className="sec-head">
          <span className="eyebrow">GA4</span>
          <h2>국가별 사이트 진입</h2>
        </div>
        <p className="sec-note">
          GA4 세션은 <b>전 채널 합계</b>입니다. 검색 클릭만 세는 GSC 와 다릅니다 — 같은 주
          싱가포르가 GSC 클릭 1건, GA4 세션 2만이었습니다. 해외 유입이 어디서 오는지와,
          수치를 오염시키는 유입이 있는지를 봅니다.
        </p>

        {flagged.length > 0 && (
          <div className="callout" style={{ marginTop: 0, marginBottom: 18 }}>
            <b>확인이 필요한 국가 {flagged.length}곳.</b> 재방문이 없고(같은 기기가 두 번
            오지 않음) 페이지도 거의 열지 않는 유입입니다. 봇일 수도, utm 없는 캠페인일
            수도 있어 <b>확인 대상 표시</b>입니다. 기준은 오른쪽 두 열에 있습니다.
            <div className="tw" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>서비스</th>
                    <th>국가</th>
                    <th className="n">세션</th>
                    <th className="n">전주</th>
                    <th className="n">증감</th>
                    <th className="n">사용자/세션</th>
                    <th className="n">조회/세션</th>
                  </tr>
                </thead>
                <tbody>
                  {flagged.map((c) => (
                    <tr key={`${c.service}-${c.country}`}>
                      <td>
                        <span
                          className="swatch"
                          style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            borderRadius: 2,
                            background: c.color,
                            marginRight: 6,
                          }}
                        />
                        {c.service}
                      </td>
                      <td style={{ fontWeight: 600 }}>{c.country}</td>
                      <td className="n">{nf(c.sessions)}</td>
                      <td className="n" style={{ color: 'var(--muted)' }}>
                        {nf(c.prevSessions)}
                      </td>
                      <td className="n" style={{ color: 'var(--crit)' }}>
                        {c.deltaSessions > 0 ? '+' : ''}
                        {nf(c.deltaSessions)}
                      </td>
                      <td className="n">{c.usersPerSession}</td>
                      <td className="n">{c.viewsPerSession}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="grid-3">
          {SERVICES.map((s) => {
            const svc = ga4.services[s.key];
            if (!svc) return null;
            return (
              <div className="panel" key={s.key}>
                <h3>{s.name}</h3>
                <p className="p-note">
                  세션 {nf(svc.sessions.current)} (전주 {nf(svc.sessions.previous)} ·{' '}
                  <Delta cur={svc.sessions.current} prev={svc.sessions.previous} />) ·{' '}
                  {svc.countryCount}개국 · 회색은 전주 · <b>⚠ 표시 = 확인 필요</b>
                  {svc.unknownCountry?.current > 0 && (
                    <> · 국가 미상 {nf(svc.unknownCountry.current)}세션 제외</>
                  )}
                </p>
                <CountryBars countries={svc.countries} color={s.hex} />
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <div className="sec-head">
          <span className="eyebrow">Channels</span>
          <h2>채널 구성</h2>
        </div>
        <p className="sec-note">
          기간 {fmtDate(ga4.periods.current.start)}~{fmtDate(ga4.periods.current.end)} (
          {ga4.periods.current.days}일
          {ga4.periods.current.days < 7 && ' · 주 진행 중이라 주간 합계가 아닙니다'}) · 속성{' '}
          <code>{ga4.property}</code>
        </p>
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>채널</th>
                {SERVICES.map((s) => (
                  <th className="n" key={s.key} style={{ color: s.hex }}>
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                ...new Set(
                  SERVICES.flatMap((s) =>
                    Object.keys(ga4.services[s.key]?.channels.current ?? {}),
                  ),
                ),
              ]
                .sort(
                  (a, b) =>
                    (ga4.services.donga?.channels.current[b] ?? 0) -
                    (ga4.services.donga?.channels.current[a] ?? 0),
                )
                .map((ch) => (
                  <tr key={ch}>
                    <td style={{ fontWeight: 600 }}>{ch}</td>
                    {SERVICES.map((s) => {
                      const cur = ga4.services[s.key]?.channels.current[ch] ?? 0;
                      const prev = ga4.services[s.key]?.channels.previous[ch] ?? 0;
                      return (
                        <td className="n" key={s.key}>
                          <div>{nf(cur)}</div>
                          <div style={{ fontSize: 10.5, fontWeight: 500 }}>
                            <Delta cur={cur} prev={prev} />
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/**
 * AI 채널 유입 — GEO 축의 **결과** 지표.
 *
 * 준비도 탭에 둔다. "봇을 열어뒀다(준비도 100점)"와 "그래서 몇 명 왔다"가
 * 떨어져 있으면 둘 다 반쪽이 된다. robots.txt 에서 ChatGPT-User 를 열고 닫는
 * 작업(진단 문서 G1)의 효과를 볼 수 있는 계기판이 이것뿐이다.
 */
export function AiSection({ ga4 }) {
  return (
    <>
      <section>
        <div className="sec-head">
          <span className="eyebrow">GEO · 결과</span>
          <h2>AI 채널 유입 — 실제로 몇 명 왔나</h2>
        </div>
        <p className="sec-note">
          위 GEO 점수가 <b>준비도</b>라면 이것은 <b>결과</b>입니다. GA4 가{' '}
          <code>AI Assistant</code> 로 분류한 세션이며, 인용 횟수는 알 수 없지만 인용을
          보고 넘어온 사람은 셀 수 있습니다. 2026년 6월부터 집계됩니다.
        </p>

        <div className="tw" style={{ marginBottom: 18 }}>
          <table>
            <thead>
              <tr>
                <th>서비스</th>
                <th className="n">AI 세션</th>
                <th className="n">전주</th>
                <th className="n">증감</th>
                <th className="n">자연검색</th>
                <th className="n">자연검색 대비</th>
              </tr>
            </thead>
            <tbody>
              {SERVICES.map((s) => {
                const a = ga4.services[s.key]?.ai;
                if (!a) return null;
                const ratio = a.organicCurrent > 0 ? (a.current / a.organicCurrent) * 100 : null;
                return (
                  <tr key={s.key}>
                    <td>
                      <span
                        className="swatch"
                        style={{
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: 2,
                          background: s.hex,
                          marginRight: 6,
                        }}
                      />
                      {s.name}
                    </td>
                    <td className="n">{nf(a.current)}</td>
                    <td className="n" style={{ color: 'var(--muted)' }}>
                      {nf(a.previous)}
                    </td>
                    <td className="n">
                      <Delta cur={a.current} prev={a.previous} />
                    </td>
                    <td className="n" style={{ color: 'var(--muted)' }}>
                      {nf(a.organicCurrent)}
                    </td>
                    <td className="n">{ratio === null ? '—' : `${ratio.toFixed(1)}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="grid-3">
          {SERVICES.map((s) => {
            const svc = ga4.services[s.key];
            if (!svc) return null;
            return (
              <div className="panel" key={s.key}>
                <h3>{s.name} — 엔진별</h3>
                <p className="p-note">
                  sessionSource 기준이라 채널 합계와 몇 % 어긋납니다.
                </p>
                <EngineBars engines={svc.ai.engines} />
              </div>
            );
          })}
        </div>

        <div className="sec-head" style={{ marginTop: 26 }}>
          <span className="eyebrow">Landing</span>
          <h2 style={{ fontSize: 15 }}>AI 가 많이 보낸 페이지</h2>
        </div>
        <p className="sec-note">
          인용된 전부가 아니라 <b>클릭까지 이어진 것</b>입니다. 어떤 주제가 AI 답변에
          잘 걸리는지 보는 용도입니다.
        </p>
        <div className="grid-3">
          {SERVICES.map((s) => {
            const svc = ga4.services[s.key];
            const pages = svc?.ai.landingPages ?? [];
            if (!svc) return null;
            return (
              <div className="panel" key={s.key}>
                <h3>{s.name}</h3>
                <p className="p-note">AI 세션 {nf(svc.ai.current)} 중 상위 {pages.length}건</p>
                {pages.length === 0 ? (
                  <p className="p-note">해당 없음</p>
                ) : (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12.5 }}>
                    {pages.map((p) => (
                      <li
                        key={p.path}
                        style={{
                          display: 'flex',
                          gap: 8,
                          alignItems: 'baseline',
                          padding: '6px 0',
                          borderBottom: '1px solid var(--grid)',
                        }}
                      >
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mono"
                          style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}
                        >
                          {p.path}
                        </a>
                        <span className="num" style={{ fontSize: 12 }}>
                          {nf(p.sessions)}
                        </span>
                        <span
                          className="num"
                          style={{ fontSize: 11, color: 'var(--muted)', minWidth: 44, textAlign: 'right' }}
                        >
                          전주 {nf(p.prevSessions)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
