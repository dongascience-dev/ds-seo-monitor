import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SERVICES, compact, nf, serviceHex, shortUrl } from '../lib/format.js';
import { Why } from './Why.jsx';

/**
 * 지금 화면이 어두운지 판정한다.
 *
 * CSS 는 `data-theme` 속성과 OS 설정을 함께 보는데, 차트 색은 CSS 변수를 못
 * 쓴다(Recharts 가 SVG 속성에 직접 넣는다). 그래서 같은 판정을 JS 로 한 번 더
 * 한다 — 둘이 어긋나면 배경만 어둡고 축은 밝은 화면이 된다.
 */
const isDarkNow = () => {
  if (typeof document === 'undefined') return false;
  const forced = document.documentElement.dataset.theme;
  if (forced === 'dark') return true;
  if (forced === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
};

/**
 * 움직임을 줄여달라고 해뒀는지 본다.
 *
 * theme.css 맨 아래 규칙이 CSS transition 은 전부 끄지만, Recharts 툴팁은
 * CSS 가 아니라 JS 타이머로 움직인다 — 그 선언이 닿지 않는다. 그래서 같은
 * 설정을 여기서 한 번 더 읽어 `motion` 을 0 으로 만든다.
 */
const calmNow = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

export function useChartTheme() {
  const [dark, setDark] = useState(isDarkNow);
  const [calm, setCalm] = useState(calmNow);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setCalm(mq.matches);
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  useEffect(() => {
    const sync = () => setDark(isDarkNow());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', sync);
    // 수동 토글은 data-theme 속성을 바꾸므로 그것도 지켜본다.
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      mq.removeEventListener('change', sync);
      observer.disconnect();
    };
  }, []);
  const palette = dark
    ? { grid: '#2a2839', axis: '#8a879f', tip: '#16151f', tipLine: '#2a2839', ink: '#fff', crit: '#ef6a6a',
        band: 'rgba(255,255,255,.05)' }
    : { grid: '#e5e2ef', axis: '#8a879f', tip: '#fffffe', tipLine: '#e5e2ef', ink: '#100f1a', crit: '#d03b3b',
        band: 'rgba(16,15,26,.045)' };
  // 120ms — "따라온다"는 느낌은 남기고 지연은 안 느껴지는 지점. 기본값 400ms 는
  // 막대 사이를 옮겨다닐 때 툴팁이 뒤늦게 미끄러져 와 어느 막대인지 헷갈린다.
  return { ...palette, motion: calm ? 0 : 120 };
}

const tooltipStyle = (t) => ({
  background: t.tip,
  border: `1px solid ${t.tipLine}`,
  borderRadius: 10,
  fontSize: 'var(--t-sm)',
  color: t.ink,
  boxShadow: '0 8px 24px -12px rgba(0,0,0,.4)',
});

/**
 * 툴팁 한 벌 — 겉모습 · 따라오는 속도 · 가리킨 곳 표시.
 *
 * 가리킨 곳 표시는 차트마다 모양이 달라야 한다. 막대는 그 구간을 덮는 띠,
 * 선은 그 지점의 세로 점선, 레이더는 덮을 구간 자체가 없으니 끈다.
 */
const CURSORS = {
  band: (t) => ({ fill: t.band }),
  line: (t) => ({ stroke: t.axis, strokeWidth: 1, strokeDasharray: '3 3' }),
  none: () => false,
};

export const tooltipProps = (t, cursor = 'band') => ({
  contentStyle: tooltipStyle(t),
  cursor: CURSORS[cursor](t),
  isAnimationActive: t.motion > 0,
  animationDuration: t.motion,
});

/*
 * 차트 축 라벨 크기.
 *
 * 본문 타입 스케일(--t-*)을 여기엔 못 쓴다. Recharts 가 이 값을 SVG 속성으로
 * 내보내는데 SVG 속성은 CSS 변수를 해석하지 못한다. 숫자로 두되 한 곳에 모아,
 * 차트마다 10.5 · 11 이 섞이지 않게 한다.
 */
export const TICK_PX = 11;

const axisProps = (t) => ({
  stroke: t.axis,
  tick: { fill: t.axis, fontSize: TICK_PX },
  tickLine: false,
});

/**
 * URL 축 라벨을 실제 링크로 만든다.
 *
 * 막대 옆에 경로가 적혀 있는데 누를 수 없으면, 그 페이지를 확인하려고 주소를
 * 손으로 옮겨 적게 된다. 표에서는 이미 링크인데 차트에서만 아니었다.
 * SVG 안에서도 <a> 는 동작한다. 색과 밑줄은 CSS 에 맡긴다 — CSS 는 SVG 표현
 * 속성을 이기므로 fill 을 덮을 수 있고, 다크 모드도 그대로 따라온다.
 */
const UrlTick = ({ x, y, payload, fill, hrefOf }) => {
  const label = (
    <text x={x} y={y} dy={4} textAnchor="end" fontSize={TICK_PX} fill={fill}>
      {payload.value}
    </text>
  );
  const href = hrefOf?.(payload.value);
  if (!href) return label;
  return (
    <a className="tick-link" href={href} target="_blank" rel="noreferrer">
      {/* 경로만 보이므로, 어디로 가는지는 기본 툴팁으로 알려 준다. */}
      <title>{href}</title>
      {label}
    </a>
  );
};

/* ────────────────────────────────────────────────────────────────────────
 * 1. 다중 선 — 주간 추세
 *
 * 서비스 간 규모가 1000배 차이라 한 축에 못 겹친다 (닷컴 Discover 8만 vs
 * d라이브러리 200). 패널을 나눠 각자의 축으로 그린다. 한 축에 억지로 겹치면
 * 작은 서비스가 바닥에 붙은 직선이 되어 추세를 읽을 수 없다.
 * ──────────────────────────────────────────────────────────────────────── */
export function TrendLines({ history, metric = 'clicks', surface = 'web' }) {
  const t = useChartTheme();
  const series = SERVICES.filter((s) =>
    history.some((h) => h.services?.[s.key]?.[surface]),
  );
  if (!series.length) return null;

  return (
    <div className="grid-3">
      {series.map((s) => {
        const rows = history.map((h) => ({
          week: h.weekEnd.slice(5).replace('-', '/'),
          value: h.services?.[s.key]?.[surface]?.[metric] ?? null,
        }));
        const values = rows.map((r) => r.value).filter(Number.isFinite);
        const max = Math.max(...values);
        return (
          <div className="panel" key={s.key}>
            <h3>
              {s.name}{' '}
              <span style={{ fontWeight: 500, color: 'var(--muted)', fontSize: 'var(--t-sm)' }}>
                — {surface === 'discover' ? 'Discover' : '웹 검색'}
              </span>
            </h3>
            <p className="p-note">
              최고 {nf(max)} · {rows.length}주 · 세로축은 패널마다 다름
            </p>
            <ResponsiveContainer width="100%" height={170}>
              <LineChart data={rows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={t.grid} vertical={false} />
                <XAxis dataKey="week" {...axisProps(t)} interval="preserveStartEnd" minTickGap={24} />
                <YAxis {...axisProps(t)} tickFormatter={compact} width={48} />
                <Tooltip
                  {...tooltipProps(t, 'line')}
                  formatter={(v) => [nf(v), metric === 'clicks' ? '클릭' : '노출']}
                  labelFormatter={(l) => `주 종료 ${l}`}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={s.hex}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4.5, strokeWidth: 2, stroke: t.tip }}
                  connectNulls isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        );
      })}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 2. 누적 막대 — 표면별 클릭 구성
 *
 * 누적은 부분들이 하나의 합을 이룰 때만 정직하다. 웹 검색과 Discover 는
 * 같은 도구(GSC)의 같은 단위(클릭)이고 합이 GSC 총 클릭이 되므로 쌓아도 된다.
 * 반면 GSC 클릭 + GA4 세션 + AI 인용률처럼 측정 도구가 다른 값을 쌓으면
 * 하나의 전체인 척하게 되므로 쓰지 않는다.
 * ──────────────────────────────────────────────────────────────────────── */
export function SurfaceStack({ history, serviceKey = 'donga' }) {
  const t = useChartTheme();
  const name = SERVICES.find((s) => s.key === serviceKey)?.name ?? serviceKey;
  const rows = history.map((h) => ({
    week: h.weekEnd.slice(5).replace('-', '/'),
    web: h.services?.[serviceKey]?.web?.clicks ?? 0,
    discover: h.services?.[serviceKey]?.discover?.clicks ?? 0,
  }));

  return (
    <div className="panel">
      <h3>
        {name} — 표면별 클릭 구성{' '}
        <span style={{ fontWeight: 500, color: 'var(--muted)', fontSize: 'var(--t-sm)' }}>
          — 웹 검색 + Discover
        </span>
      </h3>
      <Why label="왜 이 둘만 쌓나">
        누적 막대는 부분들이 하나의 합을 이룰 때만 정직합니다. 웹 검색과 Discover 는
        같은 도구(GSC)의 같은 단위(클릭)이고 합이 GSC 총 클릭이 되므로 쌓아도 됩니다.
        GA4 세션이나 AI 인용률처럼 측정 도구가 다른 값은 쌓지 않습니다 — 하나의 전체인
        척하게 됩니다.
      </Why>
      <ResponsiveContainer width="100%" height={230}>
        <BarChart data={rows} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid stroke={t.grid} vertical={false} />
          <XAxis dataKey="week" {...axisProps(t)} interval="preserveStartEnd" minTickGap={24} />
          <YAxis {...axisProps(t)} tickFormatter={compact} width={52} />
          <Tooltip
            {...tooltipProps(t, 'band')}
            formatter={(v, n) => [nf(v), n === 'web' ? '웹 검색' : 'Discover']}
            labelFormatter={(l) => `주 종료 ${l}`}
          />
          <Legend
            wrapperStyle={{ fontSize: 'var(--t-sm)', color: t.axis }}
            formatter={(v) => (v === 'web' ? '웹 검색' : 'Discover')}
          />
          <Bar dataKey="web" stackId="s" fill="#2a78d6" radius={[0, 0, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="discover" stackId="s" fill="#6d3aff" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 3. 레이더 — SEO·AEO·GEO 준비도
 *
 * 축이 3개뿐이면 삼각형이라 읽을 게 없다. 축 묶음별로 나눠, 채점 항목을
 * 축으로 두고 서비스를 겹친다. 값은 배점 대비 충족률(%)로 정규화한다 —
 * 배점이 다른 항목을 같은 반지름에 두면 큰 배점 항목만 도형을 지배한다.
 * ──────────────────────────────────────────────────────────────────────── */
export function ReadinessRadar({ axis }) {
  const t = useChartTheme();
  const rows = axis.items.map((item) => {
    const row = { item: item.name, max: item.max };
    for (const s of SERVICES) {
      row[s.key] = Math.round(((item.scores[s.key] ?? 0) / item.max) * 100);
    }
    return row;
  });

  return (
    <div className="panel">
      <h3>
        {axis.label}{' '}
        <span style={{ fontWeight: 500, color: 'var(--muted)', fontSize: 'var(--t-sm)' }}>
          — {axis.full}
        </span>
      </h3>
      <p className="p-note">배점 대비 충족률 (%) · 배점은 툴팁에</p>
      <ResponsiveContainer width="100%" height={260}>
        <RadarChart data={rows} outerRadius="72%">
          <PolarGrid stroke={t.grid} />
          <PolarAngleAxis dataKey="item" tick={{ fill: t.axis, fontSize: TICK_PX }} />
          <PolarRadiusAxis
            domain={[0, 100]}
            tick={{ fill: t.axis, fontSize: TICK_PX }}
            tickCount={5}
            axisLine={false}
          />
          <Tooltip
            {...tooltipProps(t, 'none')}
            formatter={(v, key, entry) => [
              `${v}% (배점 ${entry?.payload?.max})`,
              SERVICES.find((s) => s.key === key)?.name ?? key,
            ]}
          />
          {SERVICES.map((s) => (
            <Radar
              key={s.key}
              name={s.key}
              dataKey={s.key}
              stroke={s.hex}
              fill={s.hex}
              fillOpacity={0.12}
              strokeWidth={2} isAnimationActive={false} />
          ))}
        </RadarChart>
      </ResponsiveContainer>
      <div className="legend">
        {SERVICES.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.hex }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 4. 가로 막대 — 상위 콘텐츠 · 검색어 (이번 주 vs 전주)
 * ──────────────────────────────────────────────────────────────────────── */
export function TopBars({ rows, color, label, isUrl = false, limit = 10 }) {
  const t = useChartTheme();
  const data = rows.slice(0, limit).map((r) => ({
    name: isUrl ? shortUrl(r.key) : r.key,
    full: r.key,
    이번주: r.clicks,
    전주: r.prevClicks,
  }));
  if (!data.length) return <p className="p-note">데이터 없음</p>;

  const hrefOf = (name) => data.find((d) => d.name === name)?.full;

  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 34 + 48)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }}>
        <CartesianGrid stroke={t.grid} horizontal={false} />
        <XAxis type="number" {...axisProps(t)} tickFormatter={compact} />
        <YAxis
          type="category"
          dataKey="name"
          {...axisProps(t)}
          width={190}
          tick={isUrl ? <UrlTick fill={t.axis} hrefOf={hrefOf} /> : { fill: t.axis, fontSize: TICK_PX }}
        />
        <Tooltip
          {...tooltipProps(t, 'band')}
          formatter={(v) => nf(v)}
          labelFormatter={(_, p) => p?.[0]?.payload?.full ?? ''}
        />
        <Legend wrapperStyle={{ fontSize: 'var(--t-sm)', color: t.axis }} />
        <Bar dataKey="전주" fill={t.grid} radius={[0, 3, 3, 0]} isAnimationActive={false} />
        <Bar dataKey="이번주" fill={color} radius={[0, 3, 3, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 5. 증감률 막대 — 서비스 비교용
 *
 * 절대값은 규모 차이가 커서 같은 축에 못 놓지만 증감률은 놓을 수 있다.
 * 0 기준선 양옆으로 뻗는 형태라 방향이 바로 보인다.
 * ──────────────────────────────────────────────────────────────────────── */
export function ChangeBars({ rows }) {
  const t = useChartTheme();
  if (!rows.length) return null;
  return (
    <ResponsiveContainer width="100%" height={Math.max(180, rows.length * 32 + 40)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, left: 4, bottom: 0 }}>
        <CartesianGrid stroke={t.grid} horizontal={false} />
        <XAxis type="number" {...axisProps(t)} tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`} />
        <YAxis type="category" dataKey="label" {...axisProps(t)} width={150} />
        <Tooltip
          {...tooltipProps(t, 'band')}
          formatter={(v, _n, p) => [
            `${v > 0 ? '+' : ''}${v.toFixed(1)}%  (${nf(p.payload.prev)} → ${nf(p.payload.cur)})`,
            '전주 대비',
          ]}
        />
        <ReferenceLine x={0} stroke={t.axis} />
        <Bar dataKey="value" radius={[0, 3, 3, 0]} isAnimationActive={false}>
          {rows.map((r) => (
            <Cell key={r.label} fill={serviceHex(r.service)} fillOpacity={r.good ? 1 : 0.45} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
