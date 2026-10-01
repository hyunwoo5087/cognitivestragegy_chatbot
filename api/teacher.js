// 교사·연구자용 API — 학생 목록, 데이터 내려받기(CSV/JSON), 그림 비밀번호 초기화
// 인증: Vercel 환경변수 TEACHER_KEY 와 같은 값을 요청 본문 key 로 보내야 한다(POST만 허용, 주소에 키를 남기지 않음).
import crypto from 'node:crypto';
import { ready, kvGet, kvSet, kvKeys, kvClear, hashPin, loadUserData } from './_store.js';

const NICK_RE = /^[\p{L}\p{N} _.\-]{1,16}$/u;
function keyOk(k) {
  const want = process.env.TEACHER_KEY || '';
  if (!want || typeof k !== 'string') return false;
  const a = Buffer.from(k), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function loadAll() {
  const users = (await kvKeys('user:*')).map(k => k.slice(5)).sort();
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
    post_judge: rs.judge || '', journal: rs.journal || ''
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
  if (!process.env.TEACHER_KEY) { res.status(500).json({ error: '서버에 TEACHER_KEY 환경변수가 없습니다.' }); return; }
  const body = req.body || {};
  if (!keyOk(body.key)) { await new Promise(x => setTimeout(x, 600)); res.status(401).json({ error: '교사 키가 맞지 않아요.' }); return; }
  try {
    if (body.action === 'list') {
      const all = await loadAll();
      res.status(200).json({ students: all.map(a => ({ nickname: a.nickname, created: a.created, done: a.sessions.filter(s => !s.incomplete).length, incomplete: a.sessions.filter(s => s.incomplete).length + (a.draft ? 1 : 0), last: [...a.sessions.map(s => s.endedAt || s.startedAt), a.draft && a.draft.savedAt].filter(Boolean).sort().pop() || '' })) });
      return;
    }
    if (body.action === 'export') {
      const all = await loadAll();
      if (body.format === 'json') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.status(200).send(JSON.stringify({ exportedAt: new Date().toISOString(), students: all })); return; }
      const rows = [];
      for (const a of all) {
        for (const s of a.sessions) rows.push(row(a.nickname, s, s.incomplete ? 'incomplete' : 'completed'));
        if (a.draft && a.draft.session) rows.push(row(a.nickname, { ...a.draft.session, stoppedAt: a.draft.screen, endedAt: a.draft.savedAt }, 'in_progress'));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.status(200).send(toCSV(rows)); return;
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
