/**
 * 구글 API 공용 인증 · Search Console 쿼리.
 *
 * 세 수집기(collect-gsc · collect-ga4 · collect-audit)가 같이 쓴다. GSC 와 GA4 가
 * 같은 서비스 계정이라 키는 하나이고 스코프만 호출 시점에 갈린다.
 * 의존성 0 을 유지하려고 google-auth-library 대신 서비스 계정 JWT 를 직접
 * 서명한다 (node:crypto).
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * 서비스 계정 키를 읽는다.
 *
 * GSC 와 GA4 가 같은 서비스 계정을 쓰므로(ga4-reader@…) 키도 하나다.
 * 변수명은 GSC_ 가 먼저 생겨서 그대로 두고, GA4_ 도 받아준다.
 */
export function loadServiceAccountKey() {
  const inline =
    process.env.GSC_SERVICE_ACCOUNT_KEY || process.env.GA4_SERVICE_ACCOUNT_KEY;
  if (inline && inline.trim()) return JSON.parse(inline);

  const file =
    process.env.GSC_SERVICE_ACCOUNT_KEY_FILE ||
    process.env.GA4_SERVICE_ACCOUNT_KEY_FILE;
  if (file && file.trim()) return JSON.parse(readFileSync(file.trim(), 'utf8'));

  throw new Error(
    'GSC_SERVICE_ACCOUNT_KEY_FILE 또는 GSC_SERVICE_ACCOUNT_KEY 가 필요하다.',
  );
}

const b64url = (input) => Buffer.from(input).toString('base64url');

/** scope 를 바꿔 같은 키로 GA4(analytics.readonly)에도 쓴다. */
export async function getAccessToken(
  key,
  scope = 'https://www.googleapis.com/auth/webmasters.readonly',
) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claim}`)
    .sign(key.private_key);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${b64url(signature)}`,
    }),
  });
  if (!res.ok) throw new Error(`토큰 발급 실패 ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

/**
 * 호출 횟수를 세는 쿼리 함수를 만들어 준다.
 * 429 · 5xx 는 물러섰다 재시도하고, 그 외 오류는 바로 던진다.
 */
export function createQuery(token, defaultSite) {
  const state = { calls: 0 };

  const query = async (body, site = defaultSite) => {
    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      state.calls++;
      if (res.ok) return (await res.json()).rows ?? [];
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`GSC ${res.status} (${site}): ${await res.text()}`);
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    throw new Error(`GSC 재시도 실패 (${site})`);
  };

  return { query, state };
}

export const pageFilter = (regex) => ({
  dimensionFilterGroups: [
    {
      filters: [
        { dimension: 'page', operator: 'includingRegex', expression: regex },
      ],
    },
  ],
});
