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
      // (개선) 예전엔 받은 내용으로 통째로 덮어써서, 오래 열어 둔 다른 탭·기기가 저장하면 그 사이 끝낸
      // 공부 기록이 사라질 수 있었다. 이제 서버에 있던 기록과 세션 id로 합친다(같은 id면 더 진행된 쪽).
      // 지우는 것은 화면이 removed 목록으로 분명히 알려 줄 때만 한다(예시 데이터 지우기).
      let prev = null; try { prev = JSON.parse(await kvGet(dKey)); } catch (e) { prev = null; }
      const removed = new Set(Array.isArray(body.removed) ? body.removed.map(String) : []);
      const progress = s => (s && s.residual && s.residual.result ? 4 : 0) + (s && !s.incomplete ? 2 : 0) + ((s && s.turns) || []).length / 1000;
      const byId = new Map();
      for (const s of ((prev && prev.sessions) || [])) if (s && s.id != null && !removed.has(String(s.id))) byId.set(String(s.id), s);
      for (const s of body.sessions) { if (!s || s.id == null || removed.has(String(s.id))) continue; const o = byId.get(String(s.id)); if (!o || progress(s) >= progress(o)) byId.set(String(s.id), s); }
      const sessions = [...byId.values()];
      // (사용성) 진행 중인 세션 임시 저장본 — 새로고침·탭 닫힘 뒤 이어서 하기. 이미 끝낸(또는 그만둔) 공부의 임시본은 버린다.
      let draft = body.draft && typeof body.draft === 'object' ? body.draft : null;
      if (draft && draft.session && byId.has(String(draft.session.id))) draft = null;
      const doc = JSON.stringify({
        nickname: nick,
        created: (prev && prev.created) || body.created || new Date().toISOString(),
        sessions,
        draft
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
