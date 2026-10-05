// 공용 저장소·인증 헬퍼 (파일명 '_' 접두사라 Vercel 라우트로 노출되지 않음)
//
// v12: Redis(Vercel Marketplace 통합)를 해제하고 Google Sheets를 백엔드로 쓴다(사용자 요청).
// 인증은 서비스 계정 JWT(RS256, node:crypto만 사용 — googleapis 패키지 불필요)로 OAuth2 액세스
// 토큰을 발급받아 Sheets REST API(v4)를 fetch로 직접 호출한다. auth.js·data.js는 기존과 똑같이
// kvGet/kvSet/kvSetNX/kvDel(key-value)만 호출하므로 이 파일 밖은 전혀 바뀌지 않는다.
//
// 필요한 Vercel 환경변수 3개:
//   GOOGLE_CLIENT_EMAIL  — 서비스 계정 이메일 (...@...iam.gserviceaccount.com)
//   GOOGLE_PRIVATE_KEY   — 서비스 계정 JSON 키의 private_key 값 (그대로 붙여넣기)
//   GOOGLE_SHEET_ID      — 스프레드시트 URL의 /d/ 뒤 긴 문자열
// (+ 그 스프레드시트를 GOOGLE_CLIENT_EMAIL 주소에 "편집자"로 공유해 둬야 한다)
//
// 시트 구성(처음 호출될 때 탭·헤더가 없으면 자동으로 만든다):
//   Users     — nickname | pin_hash | pin_salt | created_at
//   Sessions  — nickname | session_id | started_at | session_json | updated_at (세션마다 한 행)
// 성취기준(curriculum_standards.js)은 그대로 앱에 내장한다 — 매번 시트에서 1,491행을 읽어오면
// 느려지고 API 한도에도 더 민감해지는데, 정적 참고자료라 굳이 그럴 이유가 없다.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const SECRET = process.env.AUTH_SECRET || '';
// (v28) 저장소를 둘 중 하나로 쓸 수 있다. Google 시트 설정(3개 변수)이 있으면 시트, 없으면
// Upstash Redis(Vercel 대시보드 Storage → Upstash Redis 연결 시 KV_REST_API_URL/TOKEN 또는
// UPSTASH_REDIS_REST_URL/TOKEN이 자동 등록됨). 새로 배포하는 사람이 서비스 계정 없이도 쓸 수 있게 하려는 것.
const hasSheets = () => !!(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_SHEET_ID);
const redisUrl = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const redisToken = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const hasRedis = () => !!(redisUrl() && redisToken());
export function ready() {
  return {
    store: hasSheets() || hasRedis(),
    backend: hasSheets() ? 'sheets' : hasRedis() ? 'redis' : null,
    vision: hasSheets(),
    secret: !!SECRET
  };
}
async function redisCmd(args) {
  const resp = await fetch(redisUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error('Redis 오류: ' + (data.error || resp.status));
  return data.result;
}
export async function kvGet(key) { return hasSheets() ? sheets_kvGet(key) : redisCmd(['GET', key]); }
export async function kvSet(key, value) { return hasSheets() ? sheets_kvSet(key, value) : redisCmd(['SET', key, value]); }
export async function kvSetNX(key, value) {
  if (hasSheets()) return sheets_kvSetNX(key, value);
  const r = await redisCmd(['SET', key, value, 'NX']);
  return r === 'OK' ? 'OK' : null;
}
// 교사용: 저장된 키 목록(Redis 백엔드에서만). 시트 백엔드는 스프레드시트에서 직접 확인한다.
export async function kvKeys(pattern) {
  if (hasSheets()) throw new Error('Google 시트 저장소에서는 스프레드시트에서 직접 확인해 주세요.');
  const out = []; let cursor = '0';
  do { const r = await redisCmd(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '500']); cursor = String(r[0]); out.push(...r[1]); } while (cursor !== '0' && out.length < 20000);
  return out;
}
export async function kvDel(key) { return hasSheets() ? sheets_kvDel(key) : redisCmd(['DEL', key]); }
// 횟수 세기(로그인 잠금·AI 호출 한도용). 일정 시간(ttl초) 뒤 자동으로 사라진다. 시트 저장소에선 세지 않는다(0).
export async function kvIncr(key, ttl) {
  if (hasSheets()) return 0;
  const n = await redisCmd(['INCR', key]);
  if (n === 1 && ttl) await redisCmd(['EXPIRE', key, String(ttl)]);
  return n;
}
export async function kvClear(key) { if (!hasSheets()) await redisCmd(['DEL', key]); }

/* ---------- Google 서비스 계정 JWT → OAuth2 액세스 토큰 (웜 인스턴스 간 캐시) ---------- */
let _token = null, _tokenExp = 0;
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_token && _tokenExp > now + 60) return _token;
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/cloud-vision',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  };
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claim));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(key).toString('base64url');
  const jwt = unsigned + '.' + signature;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('Google 인증 실패: ' + (data.error_description || data.error || resp.status));
  _token = data.access_token;
  _tokenExp = now + (data.expires_in || 3600);
  return _token;
}
// Cloud Vision 등 다른 API(api/ocr.js)에서도 같은 토큰을 재사용할 수 있게 내보낸다.
export { getAccessToken };

/* ---------- Sheets REST 호출 ---------- */
const SHEET_ID = () => process.env.GOOGLE_SHEET_ID;
async function sheetsFetch(path, opts = {}) {
  const token = await getAccessToken();
  const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('Sheets API 오류: ' + (data.error?.message || resp.status));
  return data;
}
const range = (r) => `/values/${encodeURIComponent(r)}`;
const colLetter = (n) => String.fromCharCode(64 + n); // 1→A ... 26까지만(이 파일은 5열까지만 씀)

/* ---------- 탭·헤더 자동 생성(요청사항: "탭별 헤더를 알아서 만들어달라") ---------- */
let _ensured = false;
async function ensureHeader(sheet, headers) {
  const last = colLetter(headers.length);
  const r = await sheetsFetch(range(`${sheet}!A1:${last}1`));
  if (!r.values || !r.values.length || !r.values[0].length) {
    await sheetsFetch(range(`${sheet}!A1:${last}1`) + '?valueInputOption=RAW', {
      method: 'PUT', body: JSON.stringify({ values: [headers] })
    });
  }
}
async function ensureSheets() {
  if (_ensured) return;
  const meta = await sheetsFetch('?fields=sheets.properties.title');
  const titles = (meta.sheets || []).map(s => s.properties.title);
  const need = [];
  if (!titles.includes('Users')) need.push({ addSheet: { properties: { title: 'Users' } } });
  if (!titles.includes('Sessions')) need.push({ addSheet: { properties: { title: 'Sessions' } } });
  if (need.length) await sheetsFetch(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: need }) });
  await ensureHeader('Users', ['nickname', 'pin_hash', 'pin_salt', 'created_at']);
  await ensureHeader('Sessions', ['nickname', 'session_id', 'started_at', 'session_json', 'updated_at']);
  _ensured = true;
}

async function findUserRow(nickname) {
  const r = await sheetsFetch(range('Users!A:A'));
  const rows = r.values || [];
  for (let i = 1; i < rows.length; i++) if (rows[i][0] === nickname) return i + 1; // 1-indexed 시트 행
  return null;
}

/* ---------- kv 인터페이스: auth.js·data.js는 이 4개 함수만 쓴다(키 접두사로 라우팅) ---------- */
async function sheets_kvGet(key) {
  await ensureSheets();
  if (key.startsWith('user:')) {
    const nick = key.slice(5);
    const row = await findUserRow(nick);
    if (!row) return null;
    const r = await sheetsFetch(range(`Users!A${row}:D${row}`));
    const v = (r.values && r.values[0]) || [];
    if (!v[0]) return null;
    return JSON.stringify({ h: v[1] || '', s: v[2] || '', created: v[3] || '' });
  }
  if (key.startsWith('data:')) {
    const nick = key.slice(5);
    const r = await sheetsFetch(range('Sessions!A:D'));
    const rows = (r.values || []).slice(1);
    const sessions = rows
      .filter(row => row[0] === nick)
      .map(row => { try { return JSON.parse(row[3]); } catch (e) { return null; } })
      .filter(Boolean)
      .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
    const userRow = await findUserRow(nick);
    let created = new Date().toISOString();
    if (userRow) { const ur = await sheetsFetch(range(`Users!D${userRow}:D${userRow}`)); created = ur.values?.[0]?.[0] || created; }
    return JSON.stringify({ nickname: nick, created, sessions });
  }
  return null;
}

async function sheets_kvSet(key, value) {
  await ensureSheets();
  if (key.startsWith('user:')) {
    const nick = key.slice(5);
    const obj = JSON.parse(value); // {h,s,created}
    const row = await findUserRow(nick);
    const vals = [nick, obj.h, obj.s, obj.created];
    if (row) await sheetsFetch(range(`Users!A${row}:D${row}`) + '?valueInputOption=RAW', { method: 'PUT', body: JSON.stringify({ values: [vals] }) });
    else await sheetsFetch(range('Users!A:D') + ':append?valueInputOption=RAW', { method: 'POST', body: JSON.stringify({ values: [vals] }) });
    return;
  }
  if (key.startsWith('data:')) {
    const nick = key.slice(5);
    const obj = unpackDoc(value); // {nickname, created, sessions} — 압축(gz:)·일반 JSON 모두
    const idx = await sheetsFetch(range('Sessions!A:D'));
    const rows = idx.values || [];
    const bySession = new Map(); // "id" -> { rowNum, json }
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === nick) bySession.set(rows[i][1], { rowNum: i + 1, json: rows[i][3] });
    }
    const now = new Date().toISOString();
    // 프런트가 매 자동저장마다 세션 전체 배열을 통째로 보내오므로(디바운스 600ms), 내용이 실제로
    // 바뀐 세션만 시트에 다시 쓴다 — 안 그러면 활발히 대화할 때마다 세션 수만큼 쓰기 호출이 발생한다.
    for (const s of (obj.sessions || [])) {
      const json = JSON.stringify(s);
      const existing = bySession.get(s.id);
      if (existing && existing.json === json) continue;
      const vals = [nick, s.id, s.startedAt || '', json, now];
      if (existing) await sheetsFetch(range(`Sessions!A${existing.rowNum}:E${existing.rowNum}`) + '?valueInputOption=RAW', { method: 'PUT', body: JSON.stringify({ values: [vals] }) });
      else await sheetsFetch(range('Sessions!A:E') + ':append?valueInputOption=RAW', { method: 'POST', body: JSON.stringify({ values: [vals] }) });
    }
    return;
  }
}

// 닉네임 중복 가입 방지용 "없을 때만 생성". Sheets엔 진짜 원자적 연산이 없어 read-then-append로
// 흉내만 낸다 — 같은 닉네임으로 동시에 가입 요청이 오는 극히 드문 경우엔 경합이 있을 수 있다는
// 점을 인지하고 쓴다(이 프로토타입 규모에선 허용 가능한 트레이드오프).
async function sheets_kvSetNX(key, value) {
  await ensureSheets();
  if (!key.startsWith('user:')) { await kvSet(key, value); return 'OK'; }
  const nick = key.slice(5);
  const row = await findUserRow(nick);
  if (row) return null;
  const obj = JSON.parse(value);
  await sheetsFetch(range('Users!A:D') + ':append?valueInputOption=RAW', { method: 'POST', body: JSON.stringify({ values: [[nick, obj.h, obj.s, obj.created]] }) });
  return 'OK';
}

async function sheets_kvDel(key) {
  await ensureSheets();
  if (key.startsWith('user:')) {
    const row = await findUserRow(key.slice(5));
    if (row) await sheetsFetch(range(`Users!A${row}:D${row}`) + ':clear', { method: 'POST', body: JSON.stringify({}) });
    return;
  }
  if (key.startsWith('data:')) {
    const nick = key.slice(5);
    const r = await sheetsFetch(range('Sessions!A:A'));
    const rows = r.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === nick) await sheetsFetch(range(`Sessions!A${i + 1}:E${i + 1}`) + ':clear', { method: 'POST', body: JSON.stringify({}) });
    }
  }
}

// ---------- 그림 비밀번호 해시 (Node 내장 crypto만 사용) ----------
export function hashPin(pin, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.pbkdf2Sync(String(pin), s, 120000, 32, 'sha256').toString('hex');
  return { h, s };
}
export function verifyPin(pin, salt, hash) {
  const { h } = hashPin(pin, salt);
  const a = Buffer.from(h);
  const b = Buffer.from(String(hash || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 세션 토큰 (상태 없는 HMAC 서명) ----------
const TOKEN_DAYS_DEFAULT = 90;
const b64u = (s) => Buffer.from(s).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url').toString('utf8');

export function makeToken(nickname, days = TOKEN_DAYS_DEFAULT) {
  const exp = Date.now() + days * 864e5;
  const head = b64u(nickname) + '.' + exp;
  const sig = crypto.createHmac('sha256', SECRET).update(head).digest('base64url');
  return head + '.' + sig;
}
export function readToken(tok) {
  if (!tok || !SECRET) return null;
  const p = String(tok).split('.');
  if (p.length !== 3) return null;
  const head = p[0] + '.' + p[1];
  const expect = crypto.createHmac('sha256', SECRET).update(head).digest('base64url');
  const a = Buffer.from(p[2]);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(p[1])) return null;
  try { return unb64u(p[0]); } catch (e) { return null; }
}

// (개선) 진행 중인 공부의 임시 저장본(draft)은 몇 초마다 바뀌므로 학습 기록(data:)과 따로 'draft:' 키에 둔다.
// 예전엔 임시 저장 때마다 전체 기록(세션이 쌓이면 수 MB)을 읽고 다시 써서 Upstash 무료 한도(월 10GB 전송)를 빨리 썼다.
// (개선) 학습 기록은 한국어 대화라 gzip으로 약 4~5배 줄어든다. 'gz:'+base64로 저장해 Upstash 저장 용량(무료 256MB)과
// 전송량(월 10GB)을 아낀다. 예전 형식(그냥 JSON)도 그대로 읽는다.
export function packDoc(obj) { return 'gz:' + zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 6 }).toString('base64'); }
export function unpackDoc(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  if (s.startsWith('gz:')) return JSON.parse(zlib.gunzipSync(Buffer.from(s.slice(3), 'base64')).toString('utf8'));
  return JSON.parse(s);
}
// (개선) 큰 응답은 gzip으로 보낸다(Vercel 함수 응답 한도 4.5MB를 압축 크기 기준으로 쓰게 됨).
export function sendJSON(req, res, status, obj) {
  const body = JSON.stringify(obj);
  const ae = String((req.headers && req.headers['accept-encoding']) || '');
  if (body.length > 16384 && /\bgzip\b/.test(ae)) {
    const gz = zlib.gzipSync(Buffer.from(body), { level: 6 });
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.end(gz);
    return;
  }
  res.status(status).json(obj);
}
export async function loadUserData(nick, fallbackCreated) {
  let data = null;
  try { data = unpackDoc(await kvGet('data:' + nick)); } catch (e) { data = null; }
  if (!data || !Array.isArray(data.sessions)) data = { nickname: nick, created: fallbackCreated || new Date().toISOString(), sessions: [] };
  let draft = null;
  try { draft = unpackDoc(await kvGet('draft:' + nick)); } catch (e) { draft = null; }
  if (!draft) draft = data.draft || null; // 예전 형식(기록 안에 draft)도 읽는다
  if (draft && draft.session && data.sessions.some(s => s && String(s.id) === String(draft.session.id) && !s.incomplete)) draft = null; // 이미 끝낸 공부(미완료 기록을 이어서 하는 중이면 살린다)
  data.draft = draft;
  return data;
}
export async function saveDraftKey(nick, draft) {
  if (draft && typeof draft === 'object') await kvSet('draft:' + nick, packDoc(draft));
  else await kvDel('draft:' + nick);
}

// (개선) 선생님이 PIN을 초기화하면 그 전에 받은 로그인(최대 90일)은 더 이상 통하지 않게 한다.
// 토큰은 상태가 없어서, 사용자 기록의 resetAt보다 먼저 발급된 토큰을 거절하는 방식으로 막는다.
// (기록을 못 읽는 일시 장애 때는 공부가 끊기지 않도록 통과시킨다.)
const TOKEN_DAYS = 90;
export async function readSession(req) {
  const tok = getCookie(req, 'sess');
  const nick = readToken(tok);
  if (!nick) return null;
  try {
    const raw = await kvGet('user:' + nick);
    if (!raw) return null; // 지워진 계정
    const rec = JSON.parse(raw);
    if (rec.resetAt) {
      const issued = Number(String(tok).split('.')[1]) - TOKEN_DAYS * 864e5;
      if (Date.parse(rec.resetAt) > issued) return null;
    }
  } catch (e) { /* 일시 장애는 통과 */ }
  return nick;
}

// ---------- 쿠키 ----------
export function setCookie(name, val, maxAge) {
  const parts = [`${name}=${val}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
  parts.push(maxAge === 0 ? 'Max-Age=0' : `Max-Age=${maxAge || 7776000}`);
  return parts.join('; ');
}
export function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
