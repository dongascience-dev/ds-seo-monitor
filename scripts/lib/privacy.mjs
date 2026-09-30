/**
 * 공개 저장소에 올라가는 JSON 에서 개인정보를 지운다.
 *
 * 이 페이지는 GitHub Pages 로 공개되고, `public/data/*.json` 은 누구나 읽는다.
 * GSC·GA4 가 돌려주는 URL 에는 개인정보가 섞여 들어온다 — 기자 페이지 경로가
 * `/reporter/{이메일}` 이라 사내 이메일이 URL 째로 들어온다. 실제로 검출됐다.
 *
 * 진단 문서 G4 가 지적한 문제(사내 이메일이 URL 에 노출)를 이 대시보드가
 * 증폭시키면 안 된다. 수집 단계에서 지운다 — 화면에서만 가리면 JSON 에는
 * 그대로 남아 아무 소용이 없다.
 */

// URL 인코딩(%40)과 원문(@) 둘 다 잡는다.
const EMAIL = /[A-Za-z0-9._%+-]+(?:%40|@)([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** 로컬 파트를 지우고 도메인만 남긴다 — 어느 조직인지는 보이되 누구인지는 가린다. */
export const maskEmails = (value) =>
  typeof value === 'string' ? value.replace(EMAIL, '***@$1') : value;

/** 객체 안의 모든 문자열에 적용한다. 필드가 늘어나도 빠뜨리지 않게. */
export function scrub(node) {
  if (typeof node === 'string') return maskEmails(node);
  if (Array.isArray(node)) return node.map(scrub);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, scrub(v)]));
  }
  return node;
}
