// Vercel Serverless Function: 수학 손글씨 인식(Google Cloud Vision OCR) 프록시
//
// 목적(요청사항: "진짜 손글씨 인식 원함"): 학습자가 캔버스에 손으로 쓴 풀이를 이미지(PNG)로
// 캡처해 이 엔드포인트로 보내면, Sheets 백엔드와 같은 서비스 계정 자격증명(api/_store.js의
// getAccessToken)으로 Google Cloud Vision의 DOCUMENT_TEXT_DETECTION을 호출해 텍스트로 바꿔
// 돌려준다. 별도의 Vision 전용 키를 새로 만들 필요 없이, GCP 콘솔에서 프로젝트에
// "Cloud Vision API"만 추가로 사용 설정하면 된다(README 참고).
import { ready, getAccessToken, readToken, getCookie } from './_store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const r = ready();
  if (!r.store) {
    res.status(500).json({ error: '지금 손글씨 인식을 쓸 수 없어요(서버에 Google 자격증명이 설정되어 있지 않아요).' });
    return;
  }
  // (개선) 로그인한 학습자만 쓸 수 있게 한다(유료 Vision API 남용 방지).
  if (!r.secret || !readToken(getCookie(req, 'sess'))) {
    res.status(401).json({ error: '먼저 공부방에 들어와 주세요.' });
    return;
  }

  const { imageBase64 } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ error: '이미지가 없어요.' });
    return;
  }
  if (imageBase64.length > 4_000_000) { // Vision 1장당 대략 이 정도면 충분히 큰 캔버스도 커버
    res.status(413).json({ error: '이미지가 너무 커요.' });
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
