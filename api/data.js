// 로그인한 사용자의 학습 데이터 읽기(GET) / 통째로 저장(PUT)
// 인증은 HttpOnly 쿠키 'sess' (HMAC 서명 토큰) 로만 확인한다.
import { ready, kvGet, kvSet, readToken, getCookie } from './_store.js';

export default async function handler(req, res) {
  const r = ready();
  if (!r.store || !r.secret) {
    res.status(500).json({ error: '지금 서버에 연결이 안 돼요. 잠시 뒤 다시 해 주세요.' });
    return;
  }

  const nick = readToken(getCookie(req, 'sess'));
  if (!nick) { res.status(401).json({ error: '먼저 공부방에 들어와 주세요.' }); return; }
  const dKey = 'data:' + nick;

  try {
    if (req.method === 'GET') {
      let data = null;
      try { data = JSON.parse(await kvGet(dKey)); } catch (e) { data = null; }
      if (!data || !Array.isArray(data.sessions)) {
        data = { nickname: nick, created: new Date().toISOString(), sessions: [] };
      }
      res.status(200).json({ nickname: nick, data });
      return;
    }

    if (req.method === 'PUT' || req.method === 'POST') { // POST 는 navigator.sendBeacon 용
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body !== 'object' || !Array.isArray(body.sessions)) {
        res.status(400).json({ error: '저장할 내용의 형식이 올바르지 않아요.' });
        return;
      }
      const doc = JSON.stringify({
        nickname: nick,
        created: body.created || new Date().toISOString(),
        sessions: body.sessions,
        // (사용성) 진행 중인 세션 임시 저장본 — 새로고침·탭 닫힘 뒤 이어서 하기
        draft: body.draft && typeof body.draft === 'object' ? body.draft : null
      });
      if (doc.length > 1_500_000) { res.status(413).json({ error: '저장할 내용이 너무 많아요.' }); return; }
      await kvSet(dKey, doc);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[data]', e && e.message);
    res.status(502).json({ error: '지금 서버에 연결이 안 돼요. 잠시 뒤 다시 해 주세요.' });
  }
}
