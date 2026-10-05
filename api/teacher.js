// 교사·연구자용 API — 학생 목록, 데이터 내려받기(CSV/JSON), 그림 비밀번호 초기화
// 인증(2026-10 개선): 교사 계정(아이디+비밀번호, 30일 로그인 유지 쿠키 tsess) 또는 교사 키(TEACHER_KEY).
// 교사 키는 맨 처음 계정을 만들 때(그리고 비상시) 쓰고, 평소에는 교사 계정으로 들어온다.
// 계정은 Redis 'tacct:<아이디>'에 비밀번호 해시로 저장한다(시트 저장소에서는 교사 키만 쓸 수 있다).
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { ready, kvGet, kvSet, kvDel, kvKeys, kvClear, kvIncr, hashPin, verifyPin, makeToken, readToken, getCookie, setCookie, loadUserData, sendJSON } from './_store.js';

const NICK_RE = /^[\p{L}\p{N} _.\-]{1,16}$/u;
function keyOk(k) {
  const want = process.env.TEACHER_KEY || '';
  if (!want || typeof k !== 'string') return false;
  const a = Buffer.from(k), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- 교사 계정 도우미 ----
const T_MAX_FAILS = 8;
const T_ID_RE = /^[a-z0-9_.\-가-힣]{2,20}$/;
const normId = v => { const t = String(v || '').trim().toLowerCase(); return T_ID_RE.test(t) ? t : null; };
const pwProblem = p => { p = String(p || ''); if (p.length < 8) return '비밀번호는 8자 이상이어야 해요.'; if (p.length > 100) return '비밀번호가 너무 길어요.'; if (!/[A-Za-z가-힣]/.test(p) || !/[0-9]/.test(p)) return '비밀번호에 글자와 숫자를 함께 넣어 주세요.'; return null; };
const hasAccountStore = () => !process.env.GOOGLE_SHEET_ID || !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL);
async function createTeacher(rawId, password, by) {
  if (!hasAccountStore()) return { status: 400, error: '이 저장소에서는 교사 계정을 만들 수 없어요(교사 키를 써 주세요).' };
  const id = normId(rawId); if (!id) return { status: 400, error: '아이디는 2~20자의 영문 소문자·숫자·한글·_.- 로 정해 주세요.' };
  const bad = pwProblem(password); if (bad) return { status: 400, error: bad };
  if (await kvGet('tacct:' + id)) return { status: 409, error: '이미 있는 아이디예요.' };
  const { h, s } = hashPin(String(password));
  await kvSet('tacct:' + id, JSON.stringify({ h, s, created: new Date().toISOString(), by }));
  return { id };
}
// 30일 로그인 쿠키 확인. 비밀번호를 바꾸면(changedAt) 그 전에 받은 쿠키는 더 쓸 수 없다.
async function teacherFromCookie(req) {
  const tok = getCookie(req, 'tsess'); const who = readToken(tok);
  if (!who || !who.startsWith('T:')) return null;
  const id = who.slice(2);
  let acct = null; try { acct = JSON.parse(await kvGet('tacct:' + id)); } catch (e) {}
  if (!acct) return null;
  if (acct.changedAt) { const issued = Number(String(tok).split('.')[1]) - 30 * 864e5; if (Date.parse(acct.changedAt) > issued) return null; }
  return id;
}
async function userList() { return (await kvKeys('user:*')).map(k => k.slice(5)).sort(); }
async function loadAll(users) {
  if (!users) users = await userList();
  // (개선) 학생을 한 명씩 차례로 읽어 학생이 많으면 목록이 느렸다. 10명씩 동시에 읽는다.
  const one = async nick => {
    let data = null; try { data = await loadUserData(nick); } catch (e) {}
    let rec = null; try { rec = JSON.parse(await kvGet('user:' + nick)); } catch (e) {}
    return { nickname: nick, created: rec && rec.created, sessions: (data && data.sessions) || [], draft: (data && data.draft) || null };
  };
  const out = [];
  for (let i = 0; i < users.length; i += 10) out.push(...await Promise.all(users.slice(i, i + 10).map(one)));
  return out;
}
const avg = a => { const v = a.filter(x => typeof x === 'number'); return v.length ? Math.round(v.reduce((p, c) => p + c, 0) / v.length * 10) / 10 : ''; };
// 메타 하위 지표 9개(이해·전략·연결 × 구체성 s·이유 r·조건 c). 구 기준(v1) 세션은 빈칸.
function metaInd(I) {
  const o = {};
  for (const [k, ab] of [['understand', 'u'], ['strategy', 's'], ['connect', 'c']]) for (const x of ['s', 'r', 'c']) o[`meta_${ab}_${x}`] = I && I[k] ? I[k][x] : '';
  return o;
}
function row(nick, s, status) {
  const turns = s.turns || [], evals = (s.tasks || []).flatMap(t => t.evals || []);
  const me = turns.filter(t => t.role === 'me'), ai = turns.filter(t => t.role === 'ai' && t.text);
  const pr = s.prior || {}, sub = pr.sub || {}, md = (s.meta && s.meta.scoreDetail) || {}, rs = s.residual || {}, rsub = rs.sub || {}, rr = rs.result || {};
  return {
    nickname: nick, session_id: s.id, status, stopped_at: s.stoppedAt || '', started_at: s.startedAt || '', ended_at: s.endedAt || '',
    grade: s.ctx && s.ctx.grade, subject: s.ctx && s.ctx.subject, standard_code: s.ctx && s.ctx.code, standard: s.ctx && s.ctx.std, goal: s.goal || '',
    content_type: s.ctx && s.ctx.kType || '', strategies: (s.strategies || []).join('|'), strategy_reason: s.strategyReason || '', strategy_changes: (s.strategyChangeLog || []).length,
    pre_score: pr.diagScore ?? '', pre_activate: sub.activate ?? '', pre_understand: sub.understand ?? '', pre_apply: sub.apply ?? '', pre_confidence_1to5: pr.score ?? '', calibration_gap: pr.calib ? pr.calib.gap : '',
    meta_understand: md.understand ?? '', meta_strategy: md.strategy ?? '', meta_connect: md.connect ?? '', usual_method: s.meta && s.meta.usualMethod || '',
    student_msgs: me.length, ai_msgs: ai.length, delegated_msgs: me.filter(t => t.delegate).length, stuck_count: s.stuckCount || 0,
    tasks: (s.tasks || []).length, eval_levels: evals.map(e => e.level).join('|'), eval_level_avg: avg(evals.map(e => e.level)),
    checkpoints: (s.checkpoints || []).map(c => c.score).join('|'), support_final: s.support || '',
    judge_accept: ai.filter(t => t.judge === 'accept').length, judge_hold: ai.filter(t => t.judge === 'hold').length, judge_comment: ai.filter(t => t.judge === 'comment').length,
    tagged_self: Object.values((s.reflect && s.reflect.tags) || {}).filter(v => v === 'self').length, tagged_ai: Object.values((s.reflect && s.reflect.tags) || {}).filter(v => v === 'ai').length,
    reflect_role: s.reflect && s.reflect.noteA || '', reflect_prompt: s.reflect && s.reflect.note || '',
    prompt_ratings: ((s.reflect && s.reflect.promptRatings) || []).map(r => [r.specificity, r.logic, r.clarity].join('/')).join('|'),
    post_score: rs.postScore ?? '', post_activate: rsub.activate ?? '', post_understand: rsub.understand ?? '', post_apply: rsub.apply ?? '',
    self_explain: rr.selfExplain ? rr.selfExplain.level : '', strategy_transfer: rr.transfer ? rr.transfer.applied : '', brier: typeof rr.metacogBrier === 'number' ? Math.round(rr.metacogBrier * 1000) / 1000 : '',
    post_judge: rs.judge || '', journal: rs.journal || '',
    // (2026-10 사용성 검증용 추가 변수) 설계 결정(답 요청 단계 공개·난이도 사다리·메타 하위 지표)을 분석할 수 있게 한다.
    duration_min: (s.startedAt && s.endedAt) ? Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 60000) : '',
    pre_version: (pr.items || []).some(i => i && i.ladder === 'v2') ? 'ladder-v2' : 'v1',
    pre_items: (pr.items || []).map(i => i && i.score != null ? i.score : '').join('|'),
    post_items: (rs.items || []).map(i => i && i.score != null ? i.score : '').join('|'),
    meta_version: (s.meta && s.meta.scoreVersion) || 'v1',
    ...metaInd(s.meta && s.meta.indicators),
    ans_hint1: ai.filter(t => /이 과업에서 처음/.test(t.instr || '')).length,
    ans_hint2: ai.filter(t => /두 번째로 답을 달라고/.test(t.instr || '')).length,
    ans_reveal: ai.filter(t => /\[풀이 공개 턴\]/.test(t.instr || '')).length,
    ans_after_reveal: ai.filter(t => /이미 AI가 보여 준 풀이를 받은 뒤/.test(t.instr || '')).length,
    fade_proposed: turns.filter(t => t.kind === 'fade-propose').length,
    fade_accepted: turns.filter(t => t.kind === 'fade-propose' && t.accepted).length,
    // 원리 5: 과업 분담(유동 블록 0~100, 50 이상=AI 쪽) · AI 고정 과업의 '먼저 나서기' 토글
    ...['define_problem', 'explain_result', 'summarize_key', 'draft_first', 'structure_complex'].reduce((o, k) => (o['task_' + k] = (s.taskBlocks || {})[k] ?? '', o), {}),
    ...['find_ref', 'scaffold_help', 'grade_feedback'].reduce((o, k) => (o['ai_' + k] = (s.fixedToggle || {})[k] == null ? '' : ((s.fixedToggle || {})[k] ? 1 : 0), o), {})
  };
}
function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const q = v => { const t = v == null ? '' : String(v); return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  return '﻿' + cols.join(',') + '\n' + rows.map(r => cols.map(c => q(r[c])).join(',')).join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const r = ready();
  if (!r.store) { res.status(500).json({ error: '저장소 설정이 없습니다.' }); return; }
  const body = req.body || {};
  // ---- 교사 계정: 로그인·처음 설정·로그아웃·내 정보 ----
  if (body.action === 't_login') {
    const id = normId(body.id), pw = String(body.password || '');
    if (!id) { res.status(400).json({ error: '아이디를 확인해 주세요.' }); return; }
    const failKey = 'tfail:' + id;
    if ((Number(await kvGet(failKey)) || 0) >= T_MAX_FAILS) { res.status(429).json({ error: '비밀번호를 여러 번 틀려서 15분 동안 잠겼어요.' }); return; }
    let acct = null; try { acct = JSON.parse(await kvGet('tacct:' + id)); } catch (e) {}
    if (!acct || !verifyPin(pw, acct.s, acct.h)) {
      await kvIncr(failKey, 900); await new Promise(x => setTimeout(x, 600));
      res.status(401).json({ error: '아이디 또는 비밀번호가 맞지 않아요.' }); return;
    }
    await kvClear(failKey);
    res.setHeader('Set-Cookie', setCookie('tsess', makeToken('T:' + id, 30), 30 * 86400));
    res.status(200).json({ ok: true, id }); return;
  }
  if (body.action === 't_logout') { res.setHeader('Set-Cookie', setCookie('tsess', '', 0)); res.status(200).json({ ok: true }); return; }
  if (body.action === 't_setup') { // 교사 키로 교사 계정 만들기(첫 계정 또는 비상시)
    if (!keyOk(body.key)) { await new Promise(x => setTimeout(x, 600)); res.status(401).json({ error: '교사 키가 맞지 않아요.' }); return; }
    const made = await createTeacher(body.id, body.password, 'teacher-key');
    if (made.error) { res.status(made.status).json({ error: made.error }); return; }
    res.setHeader('Set-Cookie', setCookie('tsess', makeToken('T:' + made.id, 30), 30 * 86400));
    res.status(200).json({ ok: true, id: made.id }); return;
  }
  const me = await teacherFromCookie(req);
  if (body.action === 't_me') { res.status(200).json({ id: me || null, accounts: hasAccountStore() }); return; }
  // 그 밖의 모든 요청: 교사 계정 로그인 또는 교사 키가 있어야 한다.
  if (!me && !keyOk(body.key)) { await new Promise(x => setTimeout(x, 600)); res.status(401).json({ error: '먼저 교사 계정으로 로그인해 주세요.' }); return; }
  try {
    if (body.action === 't_passwd') {
      if (!me) { res.status(400).json({ error: '교사 계정으로 로그인한 뒤 바꿀 수 있어요.' }); return; }
      let acct = null; try { acct = JSON.parse(await kvGet('tacct:' + me)); } catch (e) {}
      if (!acct || !verifyPin(String(body.old || ''), acct.s, acct.h)) { res.status(401).json({ error: '지금 비밀번호가 맞지 않아요.' }); return; }
      const bad = pwProblem(body.password); if (bad) { res.status(400).json({ error: bad }); return; }
      const { h, s: salt } = hashPin(String(body.password));
      await kvSet('tacct:' + me, JSON.stringify({ ...acct, h, s: salt, changedAt: new Date().toISOString() }));
      res.setHeader('Set-Cookie', setCookie('tsess', makeToken('T:' + me, 30), 30 * 86400)); // 다른 기기의 로그인은 풀린다
      res.status(200).json({ ok: true }); return;
    }
    if (body.action === 't_add') {
      const made = await createTeacher(body.id, body.password, me || 'teacher-key');
      if (made.error) { res.status(made.status).json({ error: made.error }); return; }
      res.status(200).json({ ok: true, id: made.id }); return;
    }
    if (body.action === 't_list') {
      const ids = (await kvKeys('tacct:*')).map(k => k.slice(6)).sort();
      res.status(200).json({ teachers: ids, me }); return;
    }
    if (body.action === 't_remove') {
      const id = normId(body.id);
      if (!id) { res.status(400).json({ error: '아이디를 확인해 주세요.' }); return; }
      if (id === me) { res.status(400).json({ error: '지금 로그인한 내 계정은 지울 수 없어요.' }); return; }
      await kvDel('tacct:' + id); res.status(200).json({ ok: true }); return;
    }
    if (body.action === 'list') {
      const all = await loadAll();
      sendJSON(req, res, 200, { students: all.map(a => ({ nickname: a.nickname, created: a.created, done: a.sessions.filter(s => !s.incomplete).length, incomplete: a.sessions.filter(s => s.incomplete).length + (a.draft ? 1 : 0), last: [...a.sessions.map(s => s.endedAt || s.startedAt), a.draft && a.draft.savedAt].filter(Boolean).sort().pop() || '' })) });
      return;
    }
    if (body.action === 'export') {
      // (개선) 전체 대화가 담긴 JSON은 반 전체를 한 번에 보내면 Vercel 응답 한도(4.5MB)를 금방 넘는다
      // (세션 약 67KB → 반 전체 약 65회). 학생 몇 명씩 나눠 보내고 화면이 하나로 합친다(offset/limit).
      if (body.format === 'json' && body.limit) {
        const users = await userList();
        const off = Math.max(0, Number(body.offset) || 0), lim = Math.min(20, Math.max(1, Number(body.limit) || 5));
        const part = await loadAll(users.slice(off, off + lim));
        sendJSON(req, res, 200, { exportedAt: new Date().toISOString(), total: users.length, offset: off, students: part });
        return;
      }
      const all = await loadAll();
      if (body.format === 'json') { sendJSON(req, res, 200, { exportedAt: new Date().toISOString(), students: all }); return; }
      const rows = [];
      for (const a of all) {
        for (const s of a.sessions) rows.push(row(a.nickname, s, s.incomplete ? 'incomplete' : 'completed'));
        if (a.draft && a.draft.session) rows.push(row(a.nickname, { ...a.draft.session, stoppedAt: a.draft.screen, endedAt: a.draft.savedAt }, 'in_progress'));
      }
      const csv = toCSV(rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      if (csv.length > 16384 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) { res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding'); res.statusCode = 200; res.end(zlib.gzipSync(Buffer.from(csv))); return; }
      res.status(200).send(csv); return;
    }
    if (body.action === 'reset') {
      const nick = String(body.nickname || '').trim(), pin = String(body.pin || '');
      if (!NICK_RE.test(nick)) { res.status(400).json({ error: '이름 형식이 맞지 않아요.' }); return; }
      if (pin.length < 2 || pin.length > 64) { res.status(400).json({ error: '그림 4개를 골라 주세요.' }); return; }
      const raw = await kvGet('user:' + nick);
      if (!raw) { res.status(404).json({ error: '그런 이름의 학생이 없어요.' }); return; }
      const rec = JSON.parse(raw); const { h, s } = hashPin(pin);
      await kvSet('user:' + nick, JSON.stringify({ ...rec, h, s, resetAt: new Date().toISOString() }));
      await kvClear('fail:' + nick); // 로그인 잠금도 함께 푼다
      res.status(200).json({ ok: true }); return;
    }
    res.status(400).json({ error: '알 수 없는 요청이에요.' });
  } catch (e) {
    console.error('[teacher]', e && e.message);
    res.status(502).json({ error: String(e && e.message || e) });
  }
}
