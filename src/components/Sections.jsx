import { useState } from 'react';
import { ChangeBars, TopBars } from './Charts.jsx';
import { Why } from './Why.jsx';
import {
  SERVICES,
  change,
  fmtDate,
  isImprovement,
  nf,
  pctText,
  shortUrl,
  signed,
} from '../lib/format.js';

const Delta = ({ cur, prev, metric = 'clicks' }) => {
  const d = change(cur, prev);
  if (d === null) return <div className="d flat">전주 없음</div>;
  const good = isImprovement(metric, d);
  const flat = Math.abs(d) < 3;
  return (
    <div className={`d ${flat ? 'flat' : good ? 'up' : 'down'}`}>
      {flat ? '—' : good ? '▲' : '▼'} {signed(d)}
    </div>
  );
};

const Stat = ({ k, v, cur, prev, metric, suffix }) => (
  <div className="stat">
    <span className="k">{k}</span>
    <span className="v num">
      {v}
      {suffix && <small>{suffix}</small>}
    </span>
    <Delta cur={cur} prev={prev} metric={metric} />
  </div>
);

export function ServiceCards({ services }) {
  return (
    <div className="cards">
      {SERVICES.map((s) => {
        const svc = services[s.key];
        if (!svc) return null;
        const w = svc.web;
        return (
          <article className="card" style={{ '--c': s.color }} key={s.key}>
            <h3>{s.name}</h3>
            <div className="host">{svc.host}</div>
            <div className="card-stats">
              <Stat k="클릭" v={nf(w.current.clicks)} cur={w.current.clicks} prev={w.previous.clicks} />
              <Stat
                k="노출"
                v={nf(w.current.impressions)}
                cur={w.current.impressions}
                prev={w.previous.impressions}
              />
              <Stat
                k="CTR"
                v={(w.current.ctr * 100).toFixed(2)}
                suffix="%"
                cur={w.current.ctr}
                prev={w.previous.ctr}
              />
              <Stat
                k="평균 순위"
                v={w.current.position?.toFixed(1) ?? '—'}
                cur={w.current.position}
                prev={w.previous.position}
                metric="position"
              />
            </div>
            {svc.discover && (
              <div className="card-stats" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <Stat
                  k="Discover 클릭"
                  v={nf(svc.discover.current.clicks)}
                  cur={svc.discover.current.clicks}
                  prev={svc.discover.previous.clicks}
                />
                <Stat
                  k="Discover 노출"
                  v={nf(svc.discover.current.impressions)}
                  cur={svc.discover.current.impressions}
                  prev={svc.discover.previous.impressions}
                />
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

/**
 * 세 서비스 어디에도 안 걸리는 호스트.
 *
 * 화면은 세 서비스만 그리는데 Search Console 속성은 도메인 전체다. 전체 탭에
 * 한 줄로만 적고 "12곳" 으로 접어 두니, 결국 "그 12곳이 어디냐" 를 만든 사람에게
 * 물어보게 된다. 물어봐야 알 수 있는 화면은 공유 URL 로서 실패한다.
 *
 * 호스트가 무슨 서비스인지는 적지 않는다. 우리가 모르기 때문이다 — 추측해서
 * 붙이면 틀린 설명이 사실처럼 남는다. 이름과 수치만 두고 해석은 넘긴다.
 */
export function OtherHosts({ otherHosts, periods, serviceClicks }) {
  const o = otherHosts;
  if (!o?.hosts?.length) {
    return (
      <p className="sec-note">
        이번 기간에는 세 서비스 밖 호스트에서 들어온 유입이 없습니다.
      </p>
    );
  }

  const whole = serviceClicks + o.current.clicks;
  const hasPrev = Boolean(o.previous);

  return (
    <>
      <div className="range">
        <span>
          이번 기간{' '}
          <b>
            {fmtDate(periods.current.start)}~{fmtDate(periods.current.end)}
          </b>
          <small>{periods.current.days}일</small>
        </span>
        {hasPrev && (
          <>
            <span className="vs">vs</span>
            <span>
              전주{' '}
              <b>
                {fmtDate(periods.previous.start)}~{fmtDate(periods.previous.end)}
              </b>
            </span>
          </>
        )}
      </div>

      <p className="sec-note">
        <b>대시보드가 세는 세 서비스(닷컴 · d라이브러리 · DS스토어) 밖</b>에서 들어온
        검색 유입입니다. Search Console 속성은 <code>dongascience.com</code> 도메인
        전체라 이 호스트들도 같이 잡히는데, 서비스 탭에는 나타나지 않습니다. 전체
        클릭의 {((o.current.clicks / whole) * 100).toFixed(1)}% 입니다.
      </p>

      <div className="panel">
        <div className="card-stats" style={{ borderTop: 0, paddingTop: 0 }}>
          <Stat
            k="클릭"
            v={nf(o.current.clicks)}
            cur={o.current.clicks}
            prev={o.previous?.clicks}
          />
          <Stat
            k="노출"
            v={nf(o.current.impressions)}
            cur={o.current.impressions}
            prev={o.previous?.impressions}
          />
          <div className="stat">
            <span className="k">호스트</span>
            <span className="v num">{nf(o.hosts.length)}</span>
          </div>
          <div className="stat">
            <span className="k">노출된 URL</span>
            <span className="v num">{nf(o.urlCount ?? 0)}</span>
          </div>
        </div>
      </div>

      <div className="tw" style={{ marginTop: 'var(--s-3)' }}>
        <table>
          <thead>
            <tr>
              <th>호스트</th>
              <th className="n">노출 URL</th>
              <th className="n">노출</th>
              <th className="n">클릭</th>
              <th className="n">CTR</th>
            </tr>
          </thead>
          <tbody>
            {o.hosts.map((h) => (
              <tr key={h.host}>
                <td className="mono">{h.host}</td>
                <td className="n">{nf(h.urls)}</td>
                <td className="n">{nf(h.impressions)}</td>
                <td className="n">{nf(h.clicks)}</td>
                <td className="n">{h.impressions > 0 ? pctText(h.clicks / h.impressions) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="p-note" style={{ marginTop: 'var(--s-2)' }}>
        어느 호스트가 어떤 서비스인지는 적지 않았습니다 — 수집이 알 수 있는 것은
        주소와 수치뿐이고, 추측해서 붙이면 틀린 설명이 사실처럼 남습니다.
      </p>

      <Why label="이 표를 어떻게 읽나">
        <p style={{ margin: '0 0 8px' }}>
          <b>별도 Search Console 속성이 있는 곳도 있습니다.</b>{' '}
          <code>search.dongascience.com</code> 과{' '}
          <code>jisatam.dongascience.com</code> 은 전용 속성이 따로 있지만, 둘 다
          도메인 속성에 포함되므로 <b>위 수치에 이미 들어 있습니다</b>. 두 번 세지
          않습니다.
        </p>
        <p style={{ margin: 0 }}>
          <b>여기 수치를 세 서비스에 더해도 속성 총계가 되지 않습니다.</b> GSC 는
          page 차원으로 쪼갤 때 희소 항목을 익명화로 빼기 때문입니다 — 실측
          (2026-09-28~29) 속성 총계 노출 905,547 중 페이지를 전부 더하면 536,841 로
          40.7% 가 사라집니다. 빠진 호스트 탓이 아닙니다.
        </p>
      </Why>
    </>
  );
}

export function OverviewChange({ services }) {
  const rows = [];
  for (const s of SERVICES) {
    const svc = services[s.key];
    if (!svc) continue;
    for (const [surface, label] of [
      ['web', '웹 검색'],
      ['discover', 'Discover'],
    ]) {
      const data = surface === 'web' ? svc.web : svc.discover;
      if (!data) continue;
      const d = change(data.current.clicks, data.previous.clicks);
      if (d === null) continue;
      rows.push({
        label: `${s.name} · ${label}`,
        service: s.key,
        value: Number(d.toFixed(1)),
        cur: data.current.clicks,
        prev: data.previous.clicks,
        good: d > 0,
      });
    }
  }
  if (!rows.length) return null;
  return (
    <div className="panel" style={{ marginTop: 'var(--s-4)' }}>
      <h3>클릭 증감률 — 전주 대비</h3>
      <Why label="왜 증감률만 있나">
        규모가 서비스 간 1000배까지 차이 나 같은 축에 못 놓습니다. 한 축에 억지로
        겹치면 작은 서비스가 바닥에 붙은 직선이 됩니다. 증감률만 비교 가능하고,
        절대값은 위 카드에서 봅니다.
      </Why>
      <ChangeBars rows={rows} />
    </div>
  );
}

const SEV = { crit: 'crit', warn: 'warn', good: 'good', info: 'info', ok: 'info' };
const SEV_COLOR = {
  crit: 'var(--crit)',
  warn: 'var(--warn)',
  good: 'var(--good)',
  info: 'var(--info)',
  ok: 'var(--muted)',
};
const SEV_LABEL = {
  crit: '확인 필요',
  warn: '주의',
  good: '개선',
  info: '참고',
  ok: '이상 없음',
};

/**
 * 서비스별로 묶어서 보여준다.
 *
 * 한 줄로 늘어놓으면 변동이 큰 닷컴이 화면을 덮어 "나머지 둘은 안 봤나?" 로
 * 읽힌다. 실제로는 봤고 조용했던 것이다. 서비스마다 블록을 두고 건수를 적어,
 * 조용한 것과 빠뜨린 것을 구분한다.
 */
export function Insights({ insights }) {
  if (!insights?.length) return <p className="sec-note">이번 주 임계값을 넘은 변화가 없다.</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {SERVICES.map((s) => {
        const rows = insights.filter((i) => i.service === s.key);
        const alerts = rows.filter((i) => i.severity === 'crit' || i.severity === 'warn').length;
        return (
          <div key={s.key}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 'var(--s-2)',
                fontSize: 'var(--t-md)',
                fontWeight: 800,
              }}
            >
              <span
                className="swatch"
                style={{ width: 10, height: 10, borderRadius: 3, background: s.hex }}
              />
              {s.name}
              <span style={{ fontWeight: 600, fontSize: 'var(--t-sm)', color: 'var(--muted)' }}>
                {rows.length}건{alerts > 0 && ` · 확인 필요 ${alerts}`}
              </span>
            </div>
            <div className="ins">
              {rows.length === 0 && (
                <div className="ins-row" style={{ '--c': 'var(--muted)' }}>
                  <span className="pill info">이상 없음</span>
                  <span className="txt">임계값을 넘은 변화가 없다.</span>
                </div>
              )}
              {rows.map((i, idx) => (
                <div
                  className="ins-row"
                  style={{ '--c': SEV_COLOR[i.severity] ?? 'var(--muted)' }}
                  key={`${i.kind}-${idx}`}
                >
                  <span className={`pill ${SEV[i.severity] ?? 'info'}`}>
                    {SEV_LABEL[i.severity] ?? i.severity}
                  </span>
                  <span className="txt">{i.text}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 검색어 한 줄의 성격을 표시한다.
 *
 * 같은 "클릭 감소"라도 원인이 둘이고 대응이 다르다.
 *   - 순위는 그대로인데 노출이 사라졌다 → 그 키워드를 찾는 사람이 준 것. 할 일 없음
 *   - 순위가 밀렸다 → 경쟁에서 진 것. 볼 일이 있음
 * 해석은 붙이지 않고 사실만 라벨로 적어 읽는 사람이 판단하게 한다.
 */
const QueryTag = ({ q }) => {
  if (q.clicks >= q.prevClicks) return null;
  const moved =
    q.prevPosition !== null && q.position !== null ? q.position - q.prevPosition : null;
  if (moved !== null && moved > 2) {
    return <span className="pill crit" style={{ fontSize: 'var(--t-xs)' }}>순위 하락</span>;
  }
  const impDrop =
    q.prevImpressions > 0 ? 1 - q.impressions / q.prevImpressions : 0;
  if (impDrop > 0.5) {
    return <span className="pill info" style={{ fontSize: 'var(--t-xs)' }}>노출만 감소</span>;
  }
  return null;
};

/** 기사 하나를 펼쳤을 때 나오는 검색어 내역. */
const QueryDetail = ({ r }) => (
  <details style={{ marginTop: 'var(--s-1)' }}>
    <summary style={{ cursor: 'pointer', fontSize: 'var(--t-sm)', color: 'var(--muted)' }}>
      검색어 {r.queries.length}개
      {/*
        page+query 조합은 희소 검색어가 익명화로 빠진다. 커버리지가 낮은데
        그대로 두면 "숫자가 안 맞는다"로 읽히므로 얼마나 보이는지 밝힌다.
      */}
      {r.queryCoverage === 0 && (
        <> · 이번 주 클릭은 어느 검색어에서 왔는지 확인되지 않음 (노출·전주 값은 아래 그대로)</>
      )}
      {r.queryCoverage > 0 && r.queryCoverage < 100 && (
        <> · 이번 주 클릭의 {r.queryCoverage}%가 확인됨</>
      )}
    </summary>
    <table style={{ minWidth: 0, marginTop: 'var(--s-2)', fontSize: 'var(--t-sm)' }}>
      <thead>
        <tr>
          <th>검색어</th>
          <th className="n">클릭</th>
          <th className="n">전주</th>
          <th className="n">노출</th>
          <th className="n">전주</th>
          <th className="n">순위</th>
          <th className="n">전주</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {r.queries.map((q) => (
          <tr key={q.key}>
            <td>{q.key}</td>
            <td className="n">{nf(q.clicks)}</td>
            <td className="n" style={{ color: 'var(--muted)', fontWeight: 500 }}>
              {nf(q.prevClicks)}
            </td>
            <td className="n">{nf(q.impressions)}</td>
            <td className="n" style={{ color: 'var(--muted)', fontWeight: 500 }}>
              {nf(q.prevImpressions)}
            </td>
            <td className="n">{q.position?.toFixed(1) ?? '—'}</td>
            <td className="n" style={{ color: 'var(--muted)', fontWeight: 500 }}>
              {q.prevPosition?.toFixed(1) ?? '—'}
            </td>
            <td>
              <QueryTag q={q} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </details>
);

const Row = ({ r, isUrl }) => {
  const d = change(r.clicks, r.prevClicks);
  const from =
    r.belowPrevFloor !== null && r.belowPrevFloor !== undefined
      ? `${nf(r.belowPrevFloor)} 미만`
      : nf(r.prevClicks);
  return (
    <tr>
      <td>
        {isUrl ? (
          <a href={r.key} target="_blank" rel="noreferrer" className="mono">
            {shortUrl(r.key)}
          </a>
        ) : (
          r.key
        )}
        {r.queries?.length > 0 && <QueryDetail r={r} />}
      </td>
      <td className="n">{nf(r.clicks)}</td>
      <td className="n" style={{ color: 'var(--muted)', fontWeight: 500 }}>
        {from}
      </td>
      <td className="n" style={{ color: d === null ? 'var(--muted)' : d > 0 ? 'var(--good)' : 'var(--crit)' }}>
        {r.deltaClicks > 0 ? '+' : ''}
        {nf(r.deltaClicks)}
      </td>
      <td className="n">{nf(r.impressions)}</td>
      <td className="n">{pctText(r.ctr)}</td>
      <td className="n">{r.position?.toFixed(1) ?? '—'}</td>
    </tr>
  );
};

export function RankTable({ title, note, rows, isUrl, limit = 15, color, chart = false }) {
  return (
    <div style={{ marginTop: 'var(--s-5)' }}>
      <h3>{title}</h3>
      <p className="p-note">{note}</p>
      {/* 증감은 숫자보다 두 막대의 길이 차이로 읽는 쪽이 빠르다. 회색이 전주다. */}
      {chart && rows.length > 0 && (
        <div className="panel" style={{ marginBottom: 'var(--s-3)' }}>
          <TopBars rows={rows} color={color} isUrl={isUrl} limit={10} />
        </div>
      )}
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>{isUrl ? '페이지' : '검색어'}</th>
              <th className="n">클릭</th>
              <th className="n">전주</th>
              <th className="n">증감</th>
              <th className="n">노출</th>
              <th className="n">CTR</th>
              <th className="n">순위</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((r) => (
              <Row r={r} isUrl={isUrl} key={r.key} />
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={7} style={{ color: 'var(--muted)' }}>
                  해당 없음
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * 이번 주 급상승 / 전주 급상승을 나란히 놓는다.
 *
 * 한쪽만 보면 "이번 주에 뭐가 떴나"까지만 알 수 있다. 두 주를 붙여 놓으면
 * 지난주에 뜬 것이 이어지는지 한 주로 끝났는지가 보이고, 그게 대응을 가른다 —
 * 이어지는 주제는 후속 기사를 붙이고, 단발은 그냥 지나간 이슈다.
 */
function RiserPair({ now, prevWeek, periods, isUrl }) {
  const list = (d) => d?.risers ?? [];
  const nowRows = list(now).slice(0, 10);
  const prevRows = list(prevWeek).slice(0, 10);

  const Item = ({ r, showSustained }) => (
    <li
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'baseline',
        padding: '7px 0',
        borderBottom: '1px solid var(--grid)',
      }}
    >
      <span style={{ flex: 1, minWidth: 0, wordBreak: 'keep-all', overflowWrap: 'anywhere' }}>
        {isUrl ? (
          <a href={r.key} target="_blank" rel="noreferrer" className="mono">
            {shortUrl(r.key)}
          </a>
        ) : (
          r.key
        )}
        {showSustained && r.sustained && (
          <span className="pill info" style={{ marginLeft: 6, fontSize: 'var(--t-xs)' }}>
            2주 연속
          </span>
        )}
      </span>
      <span className="num" style={{ fontSize: 'var(--t-sm)', color: 'var(--good)' }}>
        {r.deltaClicks > 0 ? '+' : ''}
        {nf(r.deltaClicks)}
      </span>
      <span className="num" style={{ fontSize: 'var(--t-sm)', color: 'var(--muted)', minWidth: 78, textAlign: 'right' }}>
        {r.belowPrevFloor != null ? `${nf(r.belowPrevFloor)}↓` : nf(r.prevClicks)} → {nf(r.clicks)}
      </span>
    </li>
  );

  const Col = ({ title, range, rows, showSustained }) => (
    <div className="panel">
      <h3>{title}</h3>
      <p className="p-note">{range}</p>
      {rows.length ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 'var(--t-sm)' }}>
          {rows.map((r) => (
            <Item r={r} showSustained={showSustained} key={r.key} />
          ))}
        </ul>
      ) : (
        <p className="p-note">해당 없음</p>
      )}
    </div>
  );

  const fmt = (p) => `${fmtDate(p.start)}~${fmtDate(p.end)}`;

  return (
    <div className="grid-2" style={{ marginTop: 'var(--s-4)' }}>
      <Col
        title="이번 주 급상승"
        range={`${fmt(periods.previous)} → ${fmt(periods.current)}`}
        rows={nowRows}
        showSustained
      />
      <Col
        title="전주 급상승"
        range={`${fmt(periods.beforePrevious)} → ${fmt(periods.previous)}`}
        rows={prevRows}
      />
    </div>
  );
}

/**
 * 상위 N 패널 — 클릭순 · 노출순 전환.
 *
 * 클릭 기준만 두면 "노출은 많은데 아무도 안 누르는" 항목이 목록에서 통째로
 * 빠진다. 손볼 대상이 정확히 그것인데도 안 보인다.
 *
 * 실측 (DS스토어 2026-09-21~27): 브랜드 표기가 일곱 가지로 쪼개져 있는데
 * (ds스토어 · ds 스토어 · dsstore · ds · ds store …) 클릭이 붙은 셋만 상위
 * 100에 들었다. 노출 30회에 클릭 0인 표기는 목록에서 사라졌다.
 *
 * 수집이 노출 기준 상위를 담기 전 JSON 을 읽을 수도 있다. 그때는 전환을
 * 띄우지 않는다 — 누를 수 있는데 아무 일도 안 일어나는 쪽이 더 나쁘다.
 */
function TopPanel({ title, note, data, color, isUrl, totalClicks }) {
  const [metric, setMetric] = useState('clicks');
  const canSort = Array.isArray(data.topByImpressions);
  const rows = metric === 'impressions' && canSort ? data.topByImpressions : data.top;

  // 노출순으로 볼 때 "이 중 몇 건이 한 번도 안 눌렸나" 가 핵심이다.
  const shown = rows.slice(0, 10);
  const zeroClick = shown.filter((r) => r.clicks === 0).length;

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
        {canSort && (
          <div className="seg" role="group" aria-label={`${title} 정렬 기준`}>
            {[
              ['clicks', '클릭순'],
              ['impressions', '노출순'],
            ].map(([key, text]) => (
              <button
                key={key}
                type="button"
                aria-pressed={metric === key}
                onClick={() => setMetric(key)}
              >
                {text}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="p-note">
        {metric === 'impressions' ? (
          <>
            검색 결과에 많이 보인 상위 10건 · 회색이 전주.
            {zeroClick > 0 && (
              <>
                {' '}
                이 중 <b>{zeroClick}건은 이번 기간 클릭이 0</b> 입니다 — 보이기는 하는데
                눌리지 않습니다.
              </>
            )}
          </>
        ) : (
          note
        )}
      </p>
      <TopBars rows={rows} color={color} isUrl={isUrl} metric={metric} />
    </div>
  );
}

export function SurfaceBlock({ surface, label, color, periods }) {
  const { pages, queries, pagesPrevWeek, queriesPrevWeek } = surface;

  /*
   * 두 패널의 합이 안 맞는다 — 페이지를 다 더하면 총 클릭이 되는데 검색어를 다
   * 더하면 그보다 한참 작다. 구글이 개인 식별 우려가 있는 희소 검색어를 응답에서
   * 빼기 때문이다. DS스토어는 보이는 검색어가 클릭의 28% 뿐이다.
   *
   * 적어 두지 않으면 "숫자가 틀렸다" 로 읽히고, 한 번 그렇게 읽히면 맞는 수치까지
   * 같이 의심받는다. 얼마나 보이는지를 그 자리에서 밝힌다.
   */
  const queryClicks = queries ? queries.top.reduce((a, r) => a + r.clicks, 0) : 0;
  const queryCoverage =
    queries && surface.current.clicks > 0
      ? Math.round((queryClicks / surface.current.clicks) * 100)
      : null;

  /*
   * 주가 끝나기 전에는 급상승·급하락 표를 접는다.
   *
   * 상위 콘텐츠·검색어는 "지금 얼마나 들어오나" 라 하루치여도 읽을 게 있다.
   * 반면 급상승·급하락은 전주 같은 요일과의 차이인데, 하루치에서는 그 차이가
   * ±2~3클릭이다. 월요일에 기사 하나가 2클릭 더 받은 것이 "급상승" 으로
   * 올라오고, 표 전체가 isNew · isGone 딱지로 덮인다 — 하루만 보면 당연한
   * 일인데 신호처럼 읽힌다.
   *
   * 지우지는 않는다. 볼 사람은 펼쳐서 보면 된다. 기본값만 바꾼다.
   */
  const partial = periods.current.partial ?? periods.current.days < 7;
  const biggestMove = Math.max(
    pages.risers[0]?.deltaClicks ?? 0,
    Math.abs(pages.fallers[0]?.deltaClicks ?? 0),
    queries?.risers?.[0]?.deltaClicks ?? 0,
    Math.abs(queries?.fallers?.[0]?.deltaClicks ?? 0),
  );

  /*
   * Discover 에는 검색어 패널을 두지 않는다.
   *
   * 「검색어가 없습니다」 만 적힌 빈 패널이 절반 폭을 차지하고 있었다. 이건
   * 이번 주 데이터가 비었다는 뜻이 아니라 GSC 가 Discover 에 query · position
   * 차원을 아예 주지 않는다는 구조적 사실이라 영원히 그 상태다. 같은 말이 바로
   * 위 섹션 설명과 푸터에도 이미 있다 — 세 번 적을 일이 아니다. 패널을 빼고
   * 상위 콘텐츠가 그 폭을 쓴다.
   */
  const topPanels = (
    <div className={queries ? 'grid-2' : ''} style={{ marginTop: 'var(--s-5)' }}>
      <TopPanel
        title={`상위 콘텐츠 — ${label}`}
        note="클릭 기준 상위 10건 · 회색이 전주"
        data={pages}
        color={color}
        isUrl
      />
      {queries && (
        <TopPanel
          title="상위 검색어"
          note={
            <>
              클릭 기준 상위 10건. 회색이 전주.
              {queryCoverage !== null && (
                <>
                  {' '}
                  이번 기간 클릭 {nf(surface.current.clicks)} 중 <b>{nf(queryClicks)}</b>(
                  {queryCoverage}%)만 검색어가 확인됩니다 — 나머지는 구글이 희소 검색어를
                  익명화해 응답에서 뺀 몫이라 <b>검색어를 다 더해도 총 클릭이 되지 않습니다</b>.
                </>
              )}
            </>
          }
          data={queries}
          color={color}
        />
      )}
    </div>
  );

  const deltaBlocks = (
    <>
      <div className="sec-head" style={{ marginTop: partial ? 0 : 34 }}>
        <span className="eyebrow">2주 비교</span>
        <h2 style={{ fontSize: 'var(--t-lg)' }}>급상승 콘텐츠 — {label}</h2>
      </div>
      <RiserPair now={pages} prevWeek={pagesPrevWeek} periods={periods} color={color} isUrl />

      <RankTable
        title={`급상승 콘텐츠 상세 — ${label}`}
        note="전주 대비 클릭 증가분 상위. 회색이 전주다."
        rows={pages.risers}
        color={color}
        chart
        isUrl
      />
      <RankTable
        title={`급하락 콘텐츠 — ${label}`}
        note={
          pages.truncated?.current
            ? `전주 대비 클릭 감소분 상위. 이번 주 응답이 ${nf(pages.rowsFetched.current)}행에서 잘려, 그 아래 값은 "${nf(pages.floorClicks.current)} 미만"으로 표기한다.`
            : '전주 대비 클릭 감소분 상위. 회색이 전주다.'
        }
        rows={pages.fallers}
        color={color}
        chart
        isUrl
      />
      {queries && (
        <>
          <div className="sec-head" style={{ marginTop: 'var(--s-6)' }}>
            <span className="eyebrow">2주 비교</span>
            <h2 style={{ fontSize: 'var(--t-lg)' }}>급상승 검색어</h2>
          </div>
          <RiserPair
            now={queries}
            prevWeek={queriesPrevWeek}
            periods={periods}
            color={color}
          />

          <RankTable
            title="급상승 검색어 상세"
            note="전주 대비 클릭 증가분 상위. 회색이 전주다."
            rows={queries.risers}
            color={color}
            chart
          />
          <RankTable
            title="급하락 검색어"
            note="전주 대비 클릭 감소분 상위. 회색이 전주다."
            rows={queries.fallers}
            color={color}
            chart
          />
        </>
      )}
    </>
  );

  return (
    <>
      {topPanels}
      {partial ? (
        <details className="fold">
          <summary>
            <b>급상승 · 급하락 표</b>
            <span>
              주가 끝나면 펼칩니다 — 지금은 {periods.current.days}일치라 가장 큰 변동도{' '}
              {nf(biggestMove)}클릭입니다. 눌러서 볼 수 있습니다.
            </span>
          </summary>
          <div className="fold-body">{deltaBlocks}</div>
        </details>
      ) : (
        deltaBlocks
      )}
    </>
  );
}
