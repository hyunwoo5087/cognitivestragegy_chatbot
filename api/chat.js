// Vercel Serverless Function: Upstage Solar Pro API 보안 프록시
//
// 목적(원리 3 관련 인프라 안전장치): API 키를 클라이언트(index.html)에 절대
// 내려보내지 않고, 서버 환경변수(UPSTAGE_API_KEY)에만 보관한 채로 학습자의
// 요청을 대신 Upstage API에 전달한다. 프론트엔드는 이 엔드포인트(/api/chat)만 호출한다.
//
// (개선) 예전엔 인증 없이 누구나 이 주소로 API 키를 쓸 수 있었다(비용·남용 위험).
// 이제 로그인 쿠키(sess)가 있는 요청만 통과시키고, 모델·temperature·메시지 크기를 제한한다.
import { ready, readToken, getCookie } from './_store.js';

const ALLOWED_MODELS = new Set(['solar-pro', 'solar-pro2', 'solar-mini']);
const MAX_MESSAGES = 60;
const MAX_CHARS = 60_000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const r = ready();
  if (!r.secret) { res.status(500).json({ error: "서버 인증 설정(AUTH_SECRET)이 없습니다." }); return; }
  const nick = readToken(getCookie(req, 'sess'));
  if (!nick) { res.status(401).json({ error: "먼저 공부방에 들어와 주세요." }); return; }

  const apiKey = process.env.UPSTAGE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "서버에 UPSTAGE_API_KEY 환경변수가 설정되어 있지 않습니다." });
    return;
  }

  const { model, messages, temperature } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages 배열이 필요합니다." });
    return;
  }
  if (messages.length > MAX_MESSAGES || JSON.stringify(messages).length > MAX_CHARS) {
    res.status(413).json({ error: "요청이 너무 길어요." });
    return;
  }
  const useModel = ALLOWED_MODELS.has(model) ? model : "solar-pro";
  const body = { model: useModel, messages };
  if (typeof temperature === 'number' && temperature >= 0 && temperature <= 1.5) body.temperature = temperature;

  try {
    const upstream = await fetch("https://api.upstage.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "Upstage API 호출 중 오류가 발생했습니다.", detail: String(err) });
  }
}
