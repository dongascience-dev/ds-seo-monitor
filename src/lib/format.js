export const SERVICES = [
  { key: 'donga', name: '동아사이언스', color: 'var(--s-donga)', hex: '#2a78d6' },
  { key: 'dl', name: 'd라이브러리', color: 'var(--s-dl)', hex: '#eb6834' },
  { key: 'store', name: 'DS스토어', color: 'var(--s-store)', hex: '#1baf7a' },
];

export const serviceName = (key) =>
  SERVICES.find((s) => s.key === key)?.name ?? key;
export const serviceHex = (key) =>
  SERVICES.find((s) => s.key === key)?.hex ?? '#8a879f';

export const nf = (n) =>
  typeof n === 'number' && Number.isFinite(n)
    ? Math.round(n).toLocaleString('ko-KR')
    : '—';

/** 큰 수를 축 라벨용으로 줄인다. 28,600 → 28.6k */
export const compact = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
};

export const pctText = (ratio) =>
  Number.isFinite(ratio) ? `${(ratio * 100).toFixed(2)}%` : '—';

/** 증감률. 이전 값이 0이면 비율을 낼 수 없으므로 null 을 준다. */
export const change = (cur, prev) =>
  Number.isFinite(cur) && Number.isFinite(prev) && prev > 0
    ? ((cur - prev) / prev) * 100
    : null;

/**
 * 지표별 "좋아진 방향".
 * 평균 순위는 숫자가 작아져야 좋으므로 부호를 뒤집어 읽는다.
 */
export const isImprovement = (metric, delta) =>
  metric === 'position' ? delta < 0 : delta > 0;

export const signed = (v, digits = 1) =>
  v === null || !Number.isFinite(v)
    ? '—'
    : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;

export const shortUrl = (url) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

export const fmtDate = (iso) => (iso ? iso.replaceAll('-', '.').slice(2) : '—');

export const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(d);
};
