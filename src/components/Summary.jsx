import { STATES, SUMMARY_RULES, buildSummary } from '../lib/summary.js';
import { fmtDate, fmtDateTime, nf } from '../lib/format.js';

/**
 * 전체 탭 맨 위 "검색 유입 현황".
 *
 * 이 화면을 여는 사람 대부분은 개발자가 아니다 — 기획·마케팅·팀장·경영진이
 * 섞여 있다. 그 사람들이 10초 안에 "좋아지고 있나 · 얼마나 · 무엇이 · 뭘
 * 봐야 하나" 를 집고 나갈 수 있어야 한다. 그래서 숫자를 늘어놓기 전에
 * 결론부터 쓴다.
 *
 * 문장은 전부 buildSummary() 가 계산한 사실에서 조립한다. 여기서 수치를
 * 만들거나 원인을 추측하지 않는다 — 데이터로 원인이 안 잡히면 안 잡혔다고
 * 적는다. 임계값은 lib/summary.js 의 SUMMARY_RULES 한 곳에 있다.
 */

/** 상태 점. 색만으로 구분하면 색각 이상·흑백 출력에서 뜻이 사라진다. 라벨이 본문이고 점은 거드는 것. */
const DOT = { good: '▲', crit: '▼', warn: '!', info: '—', muted: '?' };

const pct = (v, digits = 1) => `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;

/** "검색 노출" 같은 말을 먼저 쓰고 전문 용어는 괄호로 거든다. */
const FACT_TERM = {
  clicks: 'Clicks',
  impressions: 'Impressions',
  ctr: 'CTR',
  position: 'Average Position',
  discover: 'Discover Clicks',
};

/**
 * 현재 상태를 1~2문장으로 적는다.
 *
 * 방향 한 문장, 그 방향이 어떻게 만들어졌는지 한 문장. 노출과 방문이 같이
 * 움직였는지 엇갈렸는지가 대응을 가르기 때문에 그 조합을 문장으로 푼다.
 */
function narrate(s) {
  const R = SUMMARY_RULES;
  const { change } = s;
  const out = [];

  const dir =
    change.clicks === null
      ? '비교할 수 있는 전주 값이 없습니다'
      : change.clicks >= R.clicksMove
        ? '전주 같은 기간보다 증가했습니다'
        : change.clicks <= -R.clicksMove
          ? '전주 같은 기간보다 감소했습니다'
          : '전주 같은 기간과 큰 차이가 없습니다';
  out.push(`검색을 통한 사이트 방문은 ${dir}.`);

  const impUp = change.impressions !== null && change.impressions >= R.impressionsMove;
  const impDown = change.impressions !== null && change.impressions <= -R.impressionsMove;
  const clickUp = change.clicks !== null && change.clicks > 0;
  const ctrDown = change.ctr !== null && change.ctr <= -R.ctrMove;

  if (impUp && clickUp) {
    out.push(
      change.clicks > change.impressions
        ? '검색 결과에 노출된 횟수가 늘었고 실제 방문은 그보다 더 크게 늘어, 노출 증가가 사이트 유입으로 이어지고 있습니다.'
        : '검색 결과 노출과 실제 방문이 함께 늘었습니다.',
    );
  } else if (impUp && !clickUp) {
    out.push(
      '검색 결과에는 더 많이 노출됐지만 실제 방문으로 이어지는 비율은 떨어졌습니다.',
    );
  } else if (impDown && clickUp) {
    out.push(
      '검색 결과 노출은 줄었지만 방문은 늘어, 노출 대비 방문 효율은 오히려 좋아졌습니다.',
    );
  } else if (impDown && !clickUp) {
    out.push('검색 결과 노출과 실제 방문이 함께 줄었습니다.');
  }

  /*
   * 원인은 데이터가 가리키는 데까지만 적는다.
   *
   * 방문이 빠졌는데 노출도 순위도 그대로면, 줄어든 건 "같은 노출에서 덜
   * 눌린 것" 이다. 그 자체는 증상이지 원인이 아니다 — 제목이 약했는지,
   * 경쟁 결과가 바뀌었는지, 검색 결과 화면이 달라졌는지는 이 데이터에
   * 없다. 있는 것과 없는 것을 갈라 적고, 없는 쪽은 없다고 쓴다.
   */
  const quietImp = change.impressions === null || Math.abs(change.impressions) < R.impressionsMove;
  const quietPos = change.position === null || Math.abs(change.position) < R.positionMove;
  const quietCtr = change.ctr === null || Math.abs(change.ctr) < R.ctrMove;

  if (s.state === 'down' && quietImp && quietPos && !quietCtr) {
    out.push(
      '노출 횟수와 평균 노출 순위는 거의 그대로인데 방문으로 이어지는 비율만 떨어졌습니다. 왜 덜 눌렸는지는 이 데이터에 없습니다 — 원인 확인이 필요합니다.',
    );
  } else if (s.state === 'down' && quietImp && quietPos && quietCtr) {
    out.push(
      '노출 횟수 · 평균 노출 순위 · 방문 비율 모두 뚜렷한 변화가 없어, 현재 데이터만으로는 감소 원인이 확인되지 않습니다. 원인 확인이 필요합니다.',
    );
  } else if (ctrDown && !impUp && !impDown) {
    out.push('노출 규모는 비슷한데 방문으로 이어지는 비율이 떨어졌습니다.');
  }

  return out;
}

export function Summary({ gsc }) {
  const s = buildSummary(gsc);
  const meta = STATES[s.state];
  const { current, previous } = s.periods;
  const span = (p) => (p.start === p.end ? fmtDate(p.start) : `${fmtDate(p.start)}~${fmtDate(p.end)}`);

  return (
    <section>
      <div className="sec-head">
        <span className="eyebrow">Summary</span>
        <h2>검색 유입 현황</h2>
      </div>

      <div className="panel summary">
        <div className="summary-head">
          <span className={`summary-state ${meta.tone}`} role="status">
            <span aria-hidden="true">{DOT[meta.tone]}</span>
            {meta.label}
          </span>
          <span className="p-note" style={{ margin: 0 }}>
            3개 서비스 웹 검색 합계 · 전주 같은 기간과 비교
          </span>
        </div>

        {s.partial && (
          <p className="summary-partial">
            <b>이번 주는 아직 진행 중입니다.</b> 아래 수치는 {span(current)} {current.days}일치
            합계이며, 전주도 같은 {current.days}일({span(previous)})로 잘라 비교했습니다.{' '}
            <b>주간 합계가 아닙니다.</b>
          </p>
        )}

        {narrate(s).map((line) => (
          <p className="summary-line" key={line}>
            {line}
          </p>
        ))}

        <div className="grid-2" style={{ marginTop: 16 }}>
          <div>
            <h3 className="summary-h">주요 변화</h3>
            {s.facts.length ? (
              <ul className="summary-list">
                {s.facts.map((f) => (
                  <li key={f.key}>
                    <span className="summary-term">
                      {f.label}
                      <small>{FACT_TERM[f.key]}</small>
                    </span>
                    <b className={f.good ? 'up' : 'down'}>
                      {f.isPosition ? `${f.change > 0 ? '▲' : '▼'} ${Math.abs(f.change).toFixed(1)}위` : pct(f.change)}
                    </b>
                    <span className="summary-detail">{f.detail}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-note">
                방문·노출·비율·순위 모두 기준치(각각 {SUMMARY_RULES.clicksMove}% ·{' '}
                {SUMMARY_RULES.impressionsMove}% · {SUMMARY_RULES.ctrMove}% ·{' '}
                {SUMMARY_RULES.positionMove}위) 미만으로 움직였습니다.
              </p>
            )}
            {s.factsTotal > s.facts.length && (
              <p className="p-note">
                기준치를 넘은 변화 {s.factsTotal}건 중 {s.facts.length}건만 적었습니다 —
                방문 → 노출 → 비율 → 순위 순으로 중요한 것부터입니다. 나머지는 아래 카드와
                인사이트에 있습니다.
              </p>
            )}
          </div>

          <div>
            <h3 className="summary-h">확인 필요</h3>
            {s.watch.length ? (
              <ul className="summary-list watch">
                {s.watch.slice(0, 3).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : (
              <p className="p-note">현재 주요 검색 지표에서 큰 이상 징후는 확인되지 않습니다.</p>
            )}
            {s.watch.length > 3 && (
              <p className="p-note">
                그 외 {s.watch.length - 3}건은 아래 <b>주요 변화와 이상 징후</b> 에 있습니다.
              </p>
            )}
          </div>
        </div>

        <div className="summary-foot">
          <span>
            <span className="k">비교 기간</span>
            <b>
              {span(current)} vs {span(previous)}
            </b>
            <small>{current.days}일</small>
          </span>
          <span>
            <span className="k">데이터 기준</span>
            <b>{gsc.dataThrough}</b>
            <small>까지 · 마지막 수집 {fmtDateTime(gsc.generatedAt)}</small>
          </span>
          <span>
            <span className="k">집계</span>
            <b>웹 검색 {nf(s.web.clicks)}회 방문</b>
            <small>
              노출 {nf(s.web.impressions)} · Discover 는 검색이 아니라 따로 셉니다
            </small>
          </span>
        </div>
      </div>
    </section>
  );
}
