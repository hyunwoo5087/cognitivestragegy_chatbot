// 회원가입 / 로그인 / 로그아웃 — 그림 비밀번호 잠금 계정
import {
  ready, kvGet, kvSet, kvSetNX, kvIncr, kvClear,
  hashPin, verifyPin, makeToken, setCookie, loadUserData, packDoc, sendJSON
} from './_store.js';

// (개선) 그림 비밀번호는 24개 그림 중 4개 순서라 경우의 수가 약 25만 개뿐이다. 같은 이름으로 10번 연속
// 틀리면 10분 동안 로그인을 막아, 친구 공부방을 마구 맞혀 들어가는 것을 막는다. 선생님 초기화로 풀린다.
const MAX_FAILS = 10, LOCK_SEC = 600;

const NICK_RE = /^[\p{L}\p{N} _.\-]{1,16}$/u;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const r = ready();
  if (!r.store || !r.secret) {
    res.status(500).json({ error: '지금 서버에 연결이 안 돼요. 잠시 뒤 다시 해 주세요.' });
    return;
  }

  const body = req.body || {};
  const mode = body.mode;

  if (mode === 'logout') {
    res.setHeader('Set-Cookie', setCookie('sess', '', 0));
    res.status(200).json({ ok: true });
    return;
  }

  const nickname = String(body.nickname || '').trim();
  const pin = String(body.pin || '');
  if (!NICK_RE.test(nickname)) { res.status(400).json({ error: '이름은 1~16글자로 정해 주세요.' }); return; }
  if (pin.length < 2 || pin.length > 64) { res.status(400).json({ error: '그림 4개를 다시 골라 주세요.' }); return; }

  const uKey = 'user:' + nickname;
  const dKey = 'data:' + nickname;

  try {
    if (mode === 'signup') {
      const { h, s } = hashPin(pin);
      const rec = JSON.stringify({ h, s, created: new Date().toISOString() });
      const ok = await kvSetNX(uKey, rec); // 원자적: 닉네임이 비어 있을 때만
      if (ok !== 'OK') { res.status(409).json({ error: '이미 있는 이름이에요. [이미 만들었어요]로 들어가거나 다른 이름을 골라 주세요.' }); return; }
      const data = { nickname, created: new Date().toISOString(), sessions: [] };
      await kvSet(dKey, packDoc(data));
      res.setHeader('Set-Cookie', setCookie('sess', makeToken(nickname)));
      res.status(200).json({ nickname, data });
      return;
    }

    if (mode === 'login') {
      const raw = await kvGet(uKey);
      if (!raw) { res.status(404).json({ error: '아직 없는 이름이에요. [처음이에요]에서 공부방을 먼저 만들어 주세요.' }); return; }
      const rec = JSON.parse(raw);
      const failKey = 'fail:' + nickname;
      const prevFails = Number(await kvGet(failKey)) || 0;
      if (prevFails >= MAX_FAILS) { res.status(429).json({ error: '그림 비밀번호를 여러 번 틀려서 10분 동안 잠겼어요. 잠시 뒤 다시 하거나 선생님께 말해 주세요.' }); return; }
      if (!verifyPin(pin, rec.s, rec.h)) {
        const n = await kvIncr(failKey, LOCK_SEC);
        const left = MAX_FAILS - n;
        res.status(401).json({ error: '그림 비밀번호가 달라요. 그림 4개를 고른 순서까지 같아야 해요. 잊었으면 선생님께 말해 주세요.' + (n && left <= 3 && left > 0 ? ` (${left}번 더 틀리면 10분 동안 잠겨요)` : '') });
        return;
      }
      if (prevFails) await kvClear(failKey);
      const data = await loadUserData(nickname, rec.created);
      res.setHeader('Set-Cookie', setCookie('sess', makeToken(nickname)));
      sendJSON(req, res, 200, { nickname, data });
      return;
    }

    res.status(400).json({ error: '잘못된 요청이에요.' });
  } catch (e) {
    console.error('[auth]', e && e.message);
    res.status(502).json({ error: '지금 서버에 연결이 안 돼요. 잠시 뒤 다시 해 주세요.' });
  }
}
