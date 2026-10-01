// Vercel Serverless Function: 수학 손글씨 인식(Google Cloud Vision OCR) 프록시
//
// 목적(요청사항: "진짜 손글씨 인식 원함"): 학습자가 캔버스에 손으로 쓴 풀이를 이미지(PNG)로
// 캡처해 이 엔드포인트로 보내면, Sheets 백엔드와 같은 서비스 계정 자격증명(api/_store.js의
// getAccessToken)으로 Google Cloud Vision의 DOCUMENT_TEXT_DETECTION을 호출해 텍스트로 바꿔
// 돌려준다. 별도의 Vision 전용 키를 새로 만들 필요 없이, GCP 콘솔에서 프로젝트에
// "Cloud Vision API"만 추가로 사용 설정하면 된다(README 참고).
import { ready, getAccessToken, readToken, getCookie, kvIncr, readSession } from './_store.js';

// (개선) Google 자격증명이 없는 배포(Redis 백엔드)에서도 손글씨가 되도록, 대화에 쓰는 Upstage 키로
// Upstage Document OCR을 부른다. Google Vision이 설정돼 있으면 그쪽을 먼저 쓴다.
const OCR_PER_10MIN = 40;
const hasUpstage = () => !!process.env.UPSTAGE_API_KEY;

async function upstageOcr(imageBase64) {
  const form = new FormData();
  form.append('document', new Blob([Buffer.from(imageBase64, 'base64')], { type: 'image/png' }), 'handwriting.png');
  form.append('model', 'ocr');
  const up = await fetch('https://api.upstage.ai/v1/document-digitization', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTAGE_API_KEY}` },
    body: form
  });
  const data = await up.json().catch(() => ({}));
  if (!up.ok) { const e = new Error(data?.error?.message || data?.message || String(up.status)); e.status = up.status; throw e; }
  if (typeof data.text === 'string') return data.text;
  return (data.pages || []).map(p => p.text || '').join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const r = ready();
  // 화면이 손글씨 버튼을 보여 줄지 정하려고 먼저 물어본다(인식 서비스가 설정돼 있는지만 알려 줌).
  const canOcr = !!r.vision || hasUpstage();
  if ((req.body || {}).probe) { res.status(200).json({ available: canOcr }); return; }
  if (!canOcr) {
    res.status(500).json({ error: '지금 손글씨 인식을 쓸 수 없어요(서버에 인식 서비스가 설정되어 있지 않아요).' });
    return;
  }
  // (개선) 로그인한 학습자만 쓸 수 있게 한다(유료 Vision API 남용 방지).
  const nick = r.secret ? await readSession(req) : null;
  if (!nick) {
    res.status(401).json({ error: '먼저 공부방에 들어와 주세요.' });
    return;
  }
  try {
    const n = await kvIncr('ocr:' + nick + ':' + Math.floor(Date.now() / 600000), 660);
    if (n > OCR_PER_10MIN) { res.status(429).json({ error: '손글씨 인식을 너무 자주 했어요. 잠깐 쉬었다가 다시 해 주세요.' }); return; }
  } catch (e) { /* 횟수 세기 실패는 무시 */ }

  const { imageBase64 } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ error: '이미지가 없어요.' });
    return;
  }
  if (imageBase64.length > 4_000_000) { // Vision 1장당 대략 이 정도면 충분히 큰 캔버스도 커버
    res.status(413).json({ error: '이미지가 너무 커요.' });
    return;
  }

  if (!r.vision) {
    try {
      const text = await upstageOcr(imageBase64);
      res.status(200).json({ text: String(text || '') });
    } catch (err) {
      res.status(502).json({ error: '손글씨 인식 중 문제가 생겼어요.', detail: String(err.message || err) });
    }
    return;
  }

  try {
    const token = await getAccessToken();
    const upstream = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: imageBase64 },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
        }]
      })
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'Vision API 오류', detail: data?.error?.message || String(upstream.status) });
      return;
    }
    const resp0 = data?.responses?.[0];
    if (resp0?.error) { res.status(200).json({ text: '' }); return; }
    const text = resp0?.fullTextAnnotation?.text || '';
    res.status(200).json({ text });
  } catch (err) {
    res.status(502).json({ error: '손글씨 인식 중 문제가 생겼어요.', detail: String(err) });
  }
}
