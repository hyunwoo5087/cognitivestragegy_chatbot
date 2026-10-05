// Vercel Serverless Function: Upstage Solar Pro API 보안 프록시
//
// 목적(원리 3 관련 인프라 안전장치): API 키를 클라이언트(index.html)에 절대
// 내려보내지 않고, 서버 환경변수(UPSTAGE_API_KEY)에만 보관한 채로 학습자의
// 요청을 대신 Upstage API에 전달한다. 프론트엔드는 이 엔드포인트(/api/chat)만 호출한다.
//
// (개선) 예전엔 인증 없이 누구나 이 주소로 API 키를 쓸 수 있었다(비용·남용 위험).
// 이제 로그인 쿠키(sess)가 있는 요청만 통과시키고, 모델·temperature·메시지 크기를 제한한다.
import { ready, readToken, getCookie, kvIncr, readSession } from './_store.js';

// (개선) 로그인한 학생 한 명이 10분에 AI를 부를 수 있는 횟수. 보통 공부 한 번에 40번 안팎이라 넉넉하고,
// 키를 다른 용도로 마구 쓰는 것만 막는다.
const RATE_PER_10MIN = 150;

// Upstage 공지: solar-pro2·solar-pro3·solar-mini는 2026-10-30(KST) 종료 → solar-pro4·solar-mini4로 옮긴다.
// 예전 화면(캐시된 index.html)이 옛 이름을 보내도 끊기지 않게 새 이름으로 바꿔 보낸다.
const ALLOWED_MODELS = new Set(['solar-pro4', 'solar-mini4']);
const LEGACY_MODELS = { 'solar-pro':'solar-pro4', 'solar-pro2':'solar-pro4', 'solar-pro3':'solar-pro4', 'solar-mini':'solar-mini4' };
const MAX_MESSAGES = 60;
const MAX_CHARS = 60_000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const r = ready();
  if (!r.secret) { res.status(500).json({ error: "서버 인증 설정(AUTH_SECRET)이 없습니다." }); return; }
  const nick = await readSession(req);
  if (!nick) { res.status(401).json({ error: "먼저 공부방에 들어와 주세요." }); return; }

  try {
    const n = await kvIncr('rl:' + nick + ':' + Math.floor(Date.now() / 600000), 660);
    if (n > RATE_PER_10MIN) { res.status(429).json({ error: 'AI를 너무 자주 불렀어요. 잠깐 쉬었다가 다시 해 주세요.' }); return; }
  } catch (e) { /* 횟수 세기에 실패해도 공부는 계속되게 한다 */ }

  const apiKey = process.env.UPSTAGE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "서버에 UPSTAGE_API_KEY 환경변수가 설정되어 있지 않습니다." });
    return;
  }

  const { model, messages, temperature, response_format } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages 배열이 필요합니다." });
    return;
  }
  if (messages.length > MAX_MESSAGES || JSON.stringify(messages).length > MAX_CHARS) {
    res.status(413).json({ error: "요청이 너무 길어요." });
    return;
  }
  const useModel = ALLOWED_MODELS.has(model) ? model : (LEGACY_MODELS[model] || "solar-pro4");
  const body = { model: useModel, messages };
  if (typeof temperature === 'number' && temperature >= 0 && temperature <= 1.5) body.temperature = temperature;
  // JSON이 필요한 호출(채점·과업 명세·활동판)은 Upstage JSON 모드를 쓴다. 다른 형식은 받지 않는다.
  if (response_format && response_format.type === 'json_object') body.response_format = { type: 'json_object' };

  try {
    // (2026-10 사용성 검증 전 점검) 한 반이 동시에 쓰면 Upstage 호출 한도(429)에 걸릴 수 있다(가상 학생 4명 동시 실행에서
    // 실제로 발생). 429·5xx는 Retry-After를 따르거나 점점 길게(1.5→3→6초, 무작위 흔들기) 기다렸다가 최대 3번 다시 보낸다.
    let upstream, data;
    for (let attempt = 0; attempt < 4; attempt++) {
      upstream = await fetch("https://api.upstage.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      });
      if (!(upstream.status === 429 || upstream.status >= 500) || attempt === 3) break;
      const ra = Number(upstream.headers.get('retry-after'));
      const wait = Math.min(8000, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** attempt)) + Math.floor(Math.random() * 600);
      await new Promise(r => setTimeout(r, wait));
    }
    data = await upstream.json().catch(() => ({ error: 'bad upstream json' }));
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "Upstage API 호출 중 오류가 발생했습니다.", detail: String(err) });
  }
}
