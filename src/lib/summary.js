/**
 * 전체 탭 맨 위 "검색 유입 현황" 의 계산.
 *
 * 화면(Summary.jsx)은 이 결과를 문장으로 옮기기만 한다. 판단 기준을 전부
 * 여기 상수로 모아 둔 이유가 있다 — 요약은 숫자를 늘어놓는 대신 "좋아졌다 ·
 * 나빠졌다" 를 단정하는 자리라, 기준이 코드 여기저기 흩어지면 왜 그렇게
 * 찍혔는지 나중에 아무도 못 센다. 회의에서 조정할 값이기도 하다.
 *
 * 수치는 전부 수집된 GSC 값에서 계산한다. 여기서 지어내는 값은 없고,
 * 데이터로 원인을 가릴 수 없으면 가리지 않았다고 적는다.
 */

/** 판단 기준. 전부 여기 있다. */
export const SUMMARY_RULES = {
  clicksMove: 10, // 방문 증감 ±% — 이 미만은 "큰 변화 없음"
  impressionsMove: 10, // 노출 증감 ±%
  ctrMove: 5, // 노출 대비 방문 비율 증감 ±%
  positionMove: 0.5, // 평균 노출 순위 변동 (위)
  minClicks: 50, // 이번 주·전주 모두 이 미만이면 방향을 말하지 않는다

  // "노출은 느는데 안 눌린다" 를 셀 때의 잡음 바닥.
  // 노출 수십 건짜리 페이지의 CTR 은 한두 클릭에 출렁여 세는 의미가 없다.
  watchMinImpressions: 100,
  watchImpressionsUp: 10, // 노출이 이만큼(%) 이상 늘었는데 비율이 빠진 경우
};

/**
 * 머리말 상태를 뒤집을 수 있는 인사이트 종류.
 *
 * 개별 기사의 등락(page-up · page-down)은 뺐다. 뉴스 사이트는 매주 기사가
 * 뜨고 지므로 그걸 넣으면 머리말이 영원히 "확인 필요" 에 고정된다. 서비스
 * 단위로 움직인 신호만 머리말을 바꾼다.
 */
const ATTENTION_KINDS = new Set([
  'clicks',
  'position',
  'imp-up-ctr-down',
  'off-baseline',
]);

/** 상태값. 색이 아니라 이 라벨이 뜻을 전한다. */
export const STATES = {
  up: { label: '검색 유입 증가', tone: 'good' },
  down: { label: '검색 유입 감소', tone: 'crit' },
  attention: { label: '확인 필요', tone: 'warn' },
  flat: { label: '검색 유입 안정적', tone: 'info' },
  unknown: { label: '판단 보류', tone: 'muted' },
};

const ratio = (cur, prev) =>
  Number.isFinite(cur) && Number.isFinite(prev) && prev > 0
    ? ((cur - prev) / prev) * 100
    : null;

/**
 * 3개 서비스 웹 검색을 합친다.
 *
 * CTR 과 평균 순위는 서비스별 값을 평균 내면 안 된다 — 규모가 1000배 차이라
 * 작은 서비스가 같은 무게를 갖는다. 클릭·노출을 먼저 더하고 거기서 다시
 * 낸다. 순위는 GSC 안에서도 노출 가중이라 같은 방식으로 가중한다.
 */
function totalWeb(services) {
  const acc = {
    clicks: 0,
    impressions: 0,
    prevClicks: 0,
    prevImpressions: 0,
    posWeighted: 0,
    posImpressions: 0,
    prevPosWeighted: 0,
    prevPosImpressions: 0,
  };

  for (const svc of Object.values(services)) {
    const w = svc?.web;
    if (!w) continue;
    acc.clicks += w.current.clicks;
    acc.impressions += w.current.impressions;
    acc.prevClicks += w.previous.clicks;
    acc.prevImpressions += w.previous.impressions;
    if (Number.isFinite(w.current.position)) {
      acc.posWeighted += w.current.position * w.current.impressions;
      acc.posImpressions += w.current.impressions;
    }
    if (Number.isFinite(w.previous.position)) {
      acc.prevPosWeighted += w.previous.position * w.previous.impressions;
      acc.prevPosImpressions += w.previous.impressions;
    }
  }

  return {
    clicks: acc.clicks,
    impressions: acc.impressions,
    ctr: acc.impressions > 0 ? acc.clicks / acc.impressions : null,
    position: acc.posImpressions > 0 ? acc.posWeighted / acc.posImpressions : null,
    prevClicks: acc.prevClicks,
    prevImpressions: acc.prevImpressions,
    prevCtr: acc.prevImpressions > 0 ? acc.prevClicks / acc.prevImpressions : null,
    prevPosition:
      acc.prevPosImpressions > 0 ? acc.prevPosWeighted / acc.prevPosImpressions : null,
  };
}

/** Discover 는 검색이 아니라 피드 추천이라 따로 센다. 섞으면 "검색 유입" 이 아니게 된다. */
function totalDiscover(services) {
  let clicks = 0;
  let prevClicks = 0;
  let has = false;
  for (const svc of Object.values(services)) {
    if (!svc?.discover) continue;
    has = true;
    clicks += svc.discover.current.clicks;
    prevClicks += svc.discover.previous.clicks;
  }
  return has ? { clicks, prevClicks, change: ratio(clicks, prevClicks) } : null;
}

/**
 * 노출은 늘었는데 비율은 빠진 콘텐츠를 센다.
 *
 * 상위 100행 안에서만 센다 — 수집이 페이지별 표에 그만큼만 싣기 때문이다.
 * 화면에 그 한계를 같이 적는다. 전부 센 것처럼 보이면 안 된다.
 */
function countImpUpCtrDown(services) {
  const { watchMinImpressions, watchImpressionsUp } = SUMMARY_RULES;
  let count = 0;
  let scanned = 0;
  for (const svc of Object.values(services)) {
    for (const row of svc?.web?.pages?.top ?? []) {
      if (row.prevImpressions < watchMinImpressions) continue;
      scanned++;
      const impUp = ratio(row.impressions, row.prevImpressions);
      if (impUp !== null && impUp >= watchImpressionsUp && row.ctr < row.prevCtr) count++;
    }
  }
  return { count, scanned };
}

/**
 * 요약 한 벌을 만든다.
 *
 * 반환값은 전부 계산된 사실이다. 화면은 이걸 문장에 끼워 넣기만 한다.
 */
export function buildSummary(gsc) {
  const { periods, services, insights = [], devHosts } = gsc;
  const R = SUMMARY_RULES;

  // 수집기가 적어 주지만, 아직 갱신되지 않은 JSON 을 읽을 수도 있어 직접 센다.
  const partial = periods.current.partial ?? periods.current.days < 7;

  const web = totalWeb(services);
  const discover = totalDiscover(services);

  const change = {
    clicks: ratio(web.clicks, web.prevClicks),
    impressions: ratio(web.impressions, web.prevImpressions),
    ctr: ratio(web.ctr, web.prevCtr),
    // 평균 순위는 숫자가 작아져야 좋다. 양수를 "상승" 으로 읽도록 뒤집어 둔다.
    position:
      Number.isFinite(web.position) && Number.isFinite(web.prevPosition)
        ? web.prevPosition - web.position
        : null,
  };

  // ── 상태 ──────────────────────────────────────────────────────────────
  //
  // 순서가 곧 기준이다. 방문이 빠진 것을 먼저 보고, 그다음 서비스 단위
  // 경보, 그다음 증가를 본다. 경보가 증가를 덮지 않게 하되, 감소는 덮는다.
  const alerts = insights.filter(
    (i) => (i.severity === 'crit' || i.severity === 'warn') && ATTENTION_KINDS.has(i.kind),
  );

  let state;
  if (web.clicks < R.minClicks && web.prevClicks < R.minClicks) state = 'unknown';
  else if (change.clicks === null) state = 'unknown';
  else if (change.clicks <= -R.clicksMove) state = 'down';
  else if (alerts.length > 0) state = 'attention';
  else if (change.clicks >= R.clicksMove) state = 'up';
  else state = 'flat';

  // ── 주요 변화 ─────────────────────────────────────────────────────────
  //
  // 임계값을 넘은 것만, 요청받은 우선순위(방문 → 노출 → 비율 → 순위)대로.
  // 미미한 변화까지 다 실으면 중요한 줄이 묻힌다.
  const facts = [];
  const over = (v, t) => v !== null && Math.abs(v) >= t;

  if (over(change.clicks, R.clicksMove)) {
    facts.push({
      key: 'clicks',
      label: '검색을 통한 방문',
      change: change.clicks,
      detail: `${web.prevClicks.toLocaleString('ko-KR')} → ${web.clicks.toLocaleString('ko-KR')}회`,
      good: change.clicks > 0,
    });
  }
  if (over(change.impressions, R.impressionsMove)) {
    facts.push({
      key: 'impressions',
      label: '검색 결과 노출',
      change: change.impressions,
      detail: `${web.prevImpressions.toLocaleString('ko-KR')} → ${web.impressions.toLocaleString('ko-KR')}회`,
      good: change.impressions > 0,
    });
  }
  if (over(change.ctr, R.ctrMove)) {
    facts.push({
      key: 'ctr',
      label: '노출 대비 방문 비율',
      change: change.ctr,
      detail: `${(web.prevCtr * 100).toFixed(2)}% → ${(web.ctr * 100).toFixed(2)}%`,
      good: change.ctr > 0,
    });
  }
  if (over(change.position, R.positionMove)) {
    facts.push({
      key: 'position',
      label: '평균 노출 순위',
      change: change.position,
      detail: `${web.prevPosition.toFixed(1)}위 → ${web.position.toFixed(1)}위`,
      good: change.position > 0,
      isPosition: true,
    });
  }
  if (discover && over(discover.change, R.clicksMove)) {
    facts.push({
      key: 'discover',
      label: 'Discover 피드 방문',
      change: discover.change,
      detail: `${discover.prevClicks.toLocaleString('ko-KR')} → ${discover.clicks.toLocaleString('ko-KR')}회`,
      good: discover.change > 0,
      note: '검색이 아니라 구글 앱 피드 추천 유입',
    });
  }

  // ── 확인 필요 ─────────────────────────────────────────────────────────
  const watch = [];
  const impUpCtrDown = countImpUpCtrDown(services);

  if (impUpCtrDown.count > 0) {
    watch.push(
      `노출은 늘었는데 방문으로 이어지는 비율은 떨어진 콘텐츠가 ${impUpCtrDown.count}건입니다. ` +
        `검색 결과에 보이는 제목·요약이 경쟁력이 있는지 확인이 필요합니다. ` +
        `(서비스별 상위 ${impUpCtrDown.scanned}개 페이지 중)`,
    );
  }
  for (const a of alerts) {
    watch.push(a.text);
  }
  if (devHosts?.current?.impressions > 0) {
    watch.push(
      `운영과 같은 내용을 서빙하는 개발 서버가 검색에 노출되고 있습니다 — ` +
        `노출 ${devHosts.current.impressions.toLocaleString('ko-KR')}회. 중복 콘텐츠가 됩니다.`,
    );
  }

  return {
    state,
    partial,
    periods,
    web,
    discover,
    change,
    facts: facts.slice(0, 3),
    factsTotal: facts.length,
    watch,
    impUpCtrDown,
  };
}
