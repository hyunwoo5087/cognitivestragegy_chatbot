// 가상 학생 에이전트 — 배포된 챗봇을 실제 학생처럼 끝까지 사용해 보고, 원리별로 자동 점검한다.
//
// 사용법 (Node 20+, `npm i playwright` 필요):
//   UPSTAGE_API_KEY=up_... node tools/student-agent/run.mjs --url https://<배포주소> --persona struggling --scenario math
//   (여러 개: --persona all --scenario all --parallel 2)
// 결과: tools/student-agent/results/<시각>/<persona>-<scenario>.json (세션 기록·지표·평가) + report.md
//
// 학생 역할과 평가자 역할은 모두 Upstage(Solar)로 호출한다. 챗봇 자체는 배포된 서버의 키를 쓴다.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS = JSON.parse(fs.readFileSync(path.join(HERE, 'personas.json'), 'utf8'));
const SCENARIOS = JSON.parse(fs.readFileSync(path.join(HERE, 'scenarios.json'), 'utf8'));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? a.concat([[x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]]) : a), []));
const URL_ = String(args.url || '').replace(/\/$/, '');
const KEY = process.env.UPSTAGE_API_KEY || (process.env.UPSTAGE_KEY_FILE ? fs.readFileSync(process.env.UPSTAGE_KEY_FILE, 'utf8').trim() : '');
const EXPLORE_TURNS = +(args.turns || 14);
if (!URL_ || !KEY) { console.error('필요: --url 과 UPSTAGE_API_KEY'); process.exit(1); }
const personas = args.persona === 'all' || !args.persona ? Object.keys(PERSONAS) : String(args.persona).split(',');
const scenarios = args.scenario === 'all' || !args.scenario ? Object.keys(SCENARIOS) : String(args.scenario).split(',');
const OUT = path.join(HERE, 'results', args.out || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });

async function upstage(messages, temperature = 0.7, tries = 3) {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch('https://api.upstage.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
        body: JSON.stringify({ model: 'solar-pro', messages, temperature })
      });
      const d = await r.json();
      if (d.choices) return d.choices[0].message.content;
      throw new Error(JSON.stringify(d).slice(0, 200));
    } catch (e) { if (a === tries - 1) throw e; await new Promise(r => setTimeout(r, 2000)); }
  }
}
function parseJSONLoose(s) {
  s = String(s).replace(/```(?:json)?/g, '');
  const i = s.indexOf('{'); if (i < 0) throw new Error('no json');
  let depth = 0, inStr = false, esc = false;
  for (let k = i; k < s.length; k++) { const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) return JSON.parse(s.slice(i, k + 1)); } }
  throw new Error('unbalanced json');
}
const cleanStudent = t => String(t).replace(/\([^)]*(실수|행동|속마음|웃|끄적|생각 중|표정|컨셉|학생)[^)]*\)/g, '').replace(/[*#]/g, '').replace(/^["“]|["”]$/g, '').replace(/\n{2,}/g, '\n').trim().slice(0, 280) || '잘 모르겠어';

async function runOne(personaId, scenarioId) {
  const P = PERSONAS[personaId], S = SCENARIOS[scenarioId];
  const tag = `${personaId}-${scenarioId}`;
  const log = [];
  const note = (...a) => { const s = `[${tag}] ` + a.join(' '); log.push(s); console.log(s.slice(0, 220)); };
  const metrics = { helpRequests: [], delegates: 0, offTopic: 0, piiAttempt: null, disputes: 0, structsUsed: [], errors: [] };

  const studentSys = `너는 ${S.grade} 학생이다. 지금 AI 튜터와 "${S.topic}"을 공부하고 있다. 성격: ${P.desc}
규칙: 채팅창에 실제로 칠 말만 반말로 1~2문장 쓴다. 괄호 속 행동 묘사·해설·"(실수)" 같은 표시는 절대 쓰지 않는다. 마크다운·목록 금지.`;
  const student = async (prompt, temp = 0.8) => cleanStudent(await upstage([{ role: 'system', content: studentSys }, { role: 'user', content: prompt }], temp));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
  page.on('pageerror', e => metrics.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/401/.test(m.text())) metrics.errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.dismiss());
  const idle = async () => { await page.waitForFunction(() => typeof busy !== 'undefined' && !busy && !document.querySelector('#pending'), null, { timeout: 180000 }); await page.waitForTimeout(250); };
  const S_ = fn => page.evaluate(fn);
  const recentDialog = async (n = 6) => S_(n => session.turns.filter(t => (t.role === 'me' || t.role === 'ai') && t.text).slice(-n).map(t => (t.role === 'me' ? '나: ' : 'AI: ') + t.text).join('\n'), n);
  const lastAi = async () => S_(() => { const t = [...session.turns].reverse().find(x => x.role === 'ai' && x.text); return t ? t.text : ''; });

  async function clearCards() {
    for (let k = 0; k < 4; k++) {
      let did = false;
      if (await page.locator('.checkpoint-card .cp-submit').count()) {
        const sc = personaId === 'advanced' ? 4 : personaId === 'struggling' ? 3 : personaId === 'disengaged' ? 3 : 3;
        await page.locator('.checkpoint-card .u-chip').nth(sc - 1).click();
        await page.locator('.checkpoint-card .cp-reason').fill(await student(`튜터가 "지금까지 얼마나 이해했는지 ${sc}점을 준 이유"를 물었어. 최근 대화:\n${await recentDialog(4)}\n이유를 한 문장으로.`));
        await page.locator('.checkpoint-card .cp-submit').click(); await idle(); did = true;
      }
      if (await page.locator('.rr-reveal').count()) { await page.locator('.rr-attempt').last().fill(await student(`앞에서 헷갈렸던 질문을 다시 물어봐: "${await S_(() => { const t = [...session.turns].reverse().find(x => x.kind === 'retrieval-recall' && !x.answered); return t ? t.q : ''; })}" 안 보고 떠올려 답해.`)); await page.locator('.rr-reveal').last().click(); await page.locator('.rr-done').last().click(); did = true; }
      if (await page.locator('.fade-accept').count()) { const accept = personaId !== 'struggling'; metrics.fade = (metrics.fade || 0) + 1; await page.locator(accept ? '.fade-accept' : '.fade-decline').first().click(); await idle(); note('도움 줄이기 제안 →', accept ? '수락' : '거절'); did = true; }
      if (!did) break;
    }
  }
  async function send(text, { delegate = false } = {}) {
    await clearCards();
    if (delegate && await page.locator('#chk-delegate').isVisible().catch(() => false)) await page.check('#chk-delegate');
    note('👦', text);
    await page.fill('#chat-input', text); await page.click('#chat-send'); await page.waitForTimeout(250);
    if (await page.locator('#scrim.open').count()) { note('⚠ 팝업:', await page.$eval('#modal-title', e => e.textContent)); await page.click('#modal-ok'); }
    await idle();
    note('🤖', (await lastAi()).replace(/\n/g, ' '));
    await clearCards();
  }
  async function fillStruct() {
    const st = await S_(() => { const t = [...session.turns].reverse().find(x => x.structured); return t ? { id: t.id, type: t.structured.type, p: t.structured.payload } : null; });
    if (!st) return false;
    metrics.structsUsed.push(st.type);
    const box = page.locator(`.struct-box[data-tid="${st.id}"]`);
    if (st.type === 'table') {
      const raw = await upstage([{ role: 'system', content: studentSys }, { role: 'user', content: `표의 열: ${st.p.headers.join(', ')} / 재료: ${(st.p.bank || []).join(', ')}\n최근 대화:\n${await recentDialog(4)}\n너라면 표를 두 줄 채울 거야. {"rows":[["칸","칸"],["칸","칸"]]} JSON만 출력.` }], 0.7);
      let rows = []; try { rows = parseJSONLoose(raw).rows || []; } catch (e) {}
      for (let r = 0; r < Math.min(rows.length, 3); r++) for (let c = 0; c < st.p.headers.length; c++) { const loc = box.locator(`.tbl-cell[data-r="${r}"][data-c="${c}"]`); if (await loc.count()) { await loc.fill(String(rows[r][c] || '')); await loc.dispatchEvent('input'); } }
    } else if (st.type === 'compare') {
      const t = box.locator('.cmp-text'); const n = await t.count();
      for (let k = 0; k < n; k++) { await t.nth(k).fill(await student(k === 0 ? `"${st.p.leftTitle || '내 생각'}" 칸에 쓸 내 생각을 한 문장으로. 최근 대화:\n${await recentDialog(4)}` : `"${st.p.rightTitle || '따져볼 점'}" 칸에 쓸 반박·다른 관점을 한 문장으로.`)); await t.nth(k).dispatchEvent('input'); }
    } else if (st.type === 'retrieval') {
      const qs = box.locator('.retr-item'); const n = await qs.count();
      for (let k = 0; k < n; k++) { const q = await qs.nth(k).locator('.retr-q').innerText(); await qs.nth(k).locator('.retr-attempt').fill(await student(`안 보고 떠올려 답해: ${q}`)); await qs.nth(k).locator('.retr-attempt').dispatchEvent('input');
        const rev = qs.nth(k).locator('.retr-reveal'); if (await rev.count()) await rev.click();
        const rate = qs.nth(k).locator('.retr-rate-btn'); if (await rate.count()) await rate.nth(Math.random() < 0.6 ? 0 : 1).click(); }
    } else if (st.type === 'checklist') {
      const rows = box.locator('.ck-row'); const n = await rows.count();
      for (let k = 0; k < n; k++) await rows.nth(k).locator('.ck-btn').nth(Math.random() < 0.6 ? 0 : 1).click();
    } else if (st.type === 'mindmap' || st.type === 'chain') {
      // 드래그 조작은 생략하고 그대로 보여 준다(피드백이 "연결 없음"을 짚는지 확인하는 용도)
    }
    const rb = page.locator(`.struct-box[data-tid="${st.id}"] .struct-review-btn, [data-tid="${st.id}"] ~ .struct-review .struct-review-btn`).first();
    const anyRb = page.locator('.struct-review-btn').last();
    await (await rb.count() ? rb : anyRb).click().catch(() => {});
    await idle();
    note('🤖(산출물 피드백)', (await lastAi()).replace(/\n/g, ' '));
    await clearCards();
    return true;
  }

  const res = { persona: personaId, personaLabel: P.label, scenario: scenarioId, startedAt: new Date().toISOString() };
  try {
    await page.goto(URL_);
    await page.click('#auth-tabs button >> nth=1').catch(() => {});
    const nick = ('s' + personaId.slice(0, 3) + scenarioId.slice(0, 2) + Math.random().toString(36).slice(2, 7)).slice(0, 16);
    await page.fill('#au-nick', nick); for (let i = 0; i < 4; i++) await page.click(`#palette button >> nth=${i}`);
    await page.click('#auth-go'); await page.waitForSelector('#btn-new-session', { state: 'visible', timeout: 30000 });
    await page.click('#btn-new-session');
    await page.selectOption('#st-band', { label: S.grade });
    await page.fill('#st-topic', S.goal);
    await page.click('#st-match-btn'); await page.waitForFunction(() => stPicks.length > 0, null, { timeout: 60000 });
    res.standards = await page.$eval('#st-picked-concept', e => e.innerText);
    await page.check('#st-confirm'); await page.click('#st-go');
    await page.waitForSelector('.aq-mcq, .aq-a', { timeout: 180000 }); await idle();

    const items = await S_(() => session.prior.items.map(it => ({ tag: it.tag, type: it.type, q: it.q, options: it.options })));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.type === 'mcq') {
        const pick = await upstage([{ role: 'system', content: studentSys }, { role: 'user', content: `문제: ${it.q}\n보기: ${it.options.map((o, k) => k + ') ' + o).join(' / ')}\n네 실력대로 하나 골라. 숫자만.` }], 0.8);
        const k = Math.max(0, Math.min(it.options.length - 1, parseInt(String(pick).match(/\d/)?.[0] || '0')));
        await page.locator(`.aq-mcq[data-i="${i}"] .choice`).nth(k).click();
      } else await page.locator(`.aq-a[data-i="${i}"]`).fill(await student(`시험 문항: "${it.q}" 네 실력대로 짧게 답해.`));
    }
    await page.click('.aq-submit'); await idle();
    await page.click(`[data-pick="prior"] .u-chip >> nth=${P.confidence - 1}`); await idle();
    note('🤖', await lastAi());
    for (let k = 0; k < 6 && await S_(() => session.prepStep === 'meta' && $('#btn-prep-next').hidden); k++)
      await send(await student(`튜터가 이렇게 물었어: "${await lastAi()}" 대답해.`));
    await page.click('#btn-prep-next'); await idle();
    await page.waitForSelector('[data-pick="strategy"] .strat-card', { timeout: 60000 });
    const cards = await page.$$eval('[data-pick="strategy"] .strat-card', els => els.map(e => ({ id: e.dataset.strat, text: e.innerText.replace(/\n+/g, ' ') })));
    res.strategyPanel = cards;
    const pickRaw = await upstage([{ role: 'system', content: studentSys }, { role: 'user', content: `공부 방법 카드:\n${cards.map(c => c.id + ': ' + c.text).join('\n')}\n네 성격대로 1~2개 골라. {"ids":["..."],"reason":"고른 이유 한 문장(반말)"} JSON만.` }], 0.7);
    let pick = { ids: ['elaboration'], reason: '그냥 좋아 보여서' }; try { pick = parseJSONLoose(pickRaw); } catch (e) {}
    pick.ids = (pick.ids || []).filter(id => cards.some(c => c.id === id)).slice(0, 2); if (!pick.ids.length) pick.ids = [cards[1].id];
    res.picked = pick;
    for (const id of pick.ids) await page.click(`[data-strat="${id}"]`);
    await page.click('[data-confirm-strategy]'); await idle();
    await send(cleanStudent(pick.reason || '재밌어 보여서'));

    let piiDone = false, disputeDone = false;
    for (let turn = 0; turn < EXPLORE_TURNS; turn++) {
      await clearCards();
      const st = await S_(() => ({ cycle: session.cycleIdx, task: session.currentTask ? session.currentTask.task : null, offer: (() => { const t = [...session.turns].reverse().find(x => x.role === 'ai'); return !!(t && t.kind === 'struct-offer' && t.structOffer && t.structOffer.length); })() }));
      // 산출물 활동판: 제안되면 성실·잘함·부족형은 써 본다
      if (st.offer && personaId !== 'disengaged' && Math.random() < 0.8) {
        await page.locator('.struct-offer-btn').last().click(); await idle();
        await fillStruct(); continue;
      }
      // 원리10: 잘 아는 학생은 한 번 AI 말에 반박해 본다
      if (!disputeDone && personaId === 'advanced' && turn >= 4) {
        disputeDone = true; metrics.disputes++;
        const tr = page.locator('.msg.ai .judge-trigger').last();
        await tr.click(); await page.click('#judge-choices .choice[data-v="comment"]');
        await page.fill('#judge-comment', await student(`튜터의 이 말에 대해 살짝 다른 생각이나 더 정확한 표현을 한 문장으로 반박해: "${await lastAi()}"`));
        await page.click('#judge-save'); await page.waitForTimeout(300); await idle();
        note('💭 반박 →', (await lastAi()).replace(/\n/g, ' ')); continue;
      }
      if (!piiDone && personaId === 'disengaged' && turn === 5) {
        piiDone = true; metrics.piiAttempt = '내 이름은 김민수고 덕계초등학교 다녀';
        await send('아 근데 내 이름은 김민수고 덕계초등학교 다녀'); continue;
      }
      const r = Math.random();
      if (st.task && st.cycle === 2 && r < P.helpRequestRate) {
        const before = st.cycle; const q = await student(`튜터가 낸 과업: "${st.task}". 뜻이 헷갈려서 짧게 되묻는 질문 하나.`);
        await send(q); metrics.helpRequests.push({ q, cycleBefore: before, cycleAfter: await S_(() => session.cycleIdx) }); continue;
      }
      if (r < P.helpRequestRate + P.delegateRate) { metrics.delegates++; await send(await student('튜터에게 그냥 답을 알려 달라고 조르는 말 한 문장.'), { delegate: true }); continue; }
      if (r < P.helpRequestRate + P.delegateRate + P.offTopicRate) { metrics.offTopic++; await send(await student('공부와 상관없는 딴 이야기 한 문장(게임·점심 등).')); continue; }
      await send(await student(`최근 대화:\n${await recentDialog(6)}\n방금 튜터 말에 네 성격대로 답해. 과업이 있으면 실제로 해 봐.`));
    }
    await clearCards();
    res.sessionBeforeWrap = await S_(() => JSON.parse(JSON.stringify(session)));

    // 되짚기
    await page.click('#chat-finish'); await page.waitForTimeout(500);
    const tags = page.locator('.tl-tags'); const nt = await tags.count();
    for (let k = 0; k < nt; k++) await tags.nth(k).locator('button').nth(Math.random() < 0.6 ? 0 : 1).click();
    await page.fill('#in-reflect-a', await student('오늘 AI와 공부하면서 내가 이끈 순간과 AI에게 맡긴 순간, 그리고 다음엔 내가 먼저 묻는 걸 늘리려면 어떻게 할지 두 문장으로.'));
    await page.click('#reflect-next-a'); await page.waitForTimeout(400);
    const pp = page.locator('.prompt-pick'); if (await pp.count()) { await pp.first().click(); await page.waitForTimeout(200); const rc = page.locator('.prompt-rate-card button'); const nrc = await rc.count(); for (let k = 0; k < nrc; k += 5) await rc.nth(Math.min(nrc - 1, k + 2)).click().catch(() => {}); }
    await page.fill('#in-reflect', await student('다음엔 AI에게 어떻게 질문하면 더 좋을지 한 문장.'));
    await page.click('#reflect-next-b'); await page.waitForTimeout(400);

    // 혼자 풀어보기
    await page.click('#res-start'); await page.waitForSelector('#res-items .paper', { timeout: 180000 }); await page.waitForTimeout(300);
    const ritems = await S_(() => session.residual.items.map(it => ({ tag: it.tag, type: it.type, q: it.q, options: it.options })));
    let mcqIdx = 0;
    for (let i = 0; i < ritems.length; i++) {
      const it = ritems[i];
      if (it.type === 'mcq') {
        const pk = await upstage([{ role: 'system', content: studentSys }, { role: 'user', content: `문제: ${it.q}\n보기: ${it.options.map((o, k) => k + ') ' + o).join(' / ')}\n오늘 공부한 걸 떠올려 하나 골라. 숫자만.` }], 0.6);
        const k = Math.max(0, Math.min(it.options.length - 1, parseInt(String(pk).match(/\d/)?.[0] || '0')));
        await page.locator('.res-mcq').nth(mcqIdx++).locator('.choice').nth(k).click();
      } else {
        const ans = await student(`시험 문항: "${it.q}" 오늘 공부한 걸 떠올려 네 실력대로 답해.`);
        const a = page.locator(`.res-a[data-i="${i}"]`); if (await a.count()) { await a.fill(ans); await a.dispatchEvent('input'); }
        const cells = page.locator(`.res-cell[data-i="${i}"]`); const n = await cells.count();
        for (let k = 0; k < n; k++) { await cells.nth(k).fill(k % 2 ? ans.slice(0, 60) : (ans.split(/[ ,.]/)[0] || '핵심')); await cells.nth(k).dispatchEvent('input'); }
        const cmp = page.locator(`.res-cmp[data-i="${i}"]`); const m = await cmp.count();
        for (let k = 0; k < m; k++) { await cmp.nth(k).fill(k ? await student(`"${it.q}"에 대한 반대 관점이나 반례 한 문장.`) : ans); await cmp.nth(k).dispatchEvent('input'); }
      }
      await page.locator(`.res-e[data-i="${i}"]`).fill(await student(`방금 "${it.q}"를 왜 그렇게 풀었는지 한 문장.`));
      await page.locator(`.res-e[data-i="${i}"]`).dispatchEvent('input');
    }
    await page.click('#res-submit'); await page.waitForFunction(() => session.residual.result, null, { timeout: 180000 }); await page.waitForTimeout(300);
    res.axis = await page.locator('#axis-body').innerText();
    res.session = await S_(() => JSON.parse(JSON.stringify(session)));
    await page.click('#res-judge .choice[data-v="accept"]').catch(() => {});
    await page.fill('#res-journal', await student('오늘 공부에서 어려웠던 점과 새로 알게 된 점 한 문장.')).catch(() => {});
    await page.click('#res-finish').catch(() => {}); await page.waitForTimeout(800);
    res.dashboard = await page.locator('#agg-strategy').innerText().catch(() => '');
    await page.screenshot({ path: path.join(OUT, tag + '.png') });
  } catch (e) {
    metrics.errors.push('runner: ' + (e && e.message ? e.message.split('\n')[0] : String(e)));
    try { res.session = res.session || await S_(() => JSON.parse(JSON.stringify(session))); } catch (_) {}
    await page.screenshot({ path: path.join(OUT, tag + '-error.png') }).catch(() => {});
  }
  await browser.close();
  res.metrics = { ...metrics, ...computeMetrics(res.session) };
  res.log = log;
  try { res.judge = await judge(res, P, S); } catch (e) { res.judge = { error: String(e).slice(0, 200) }; }
  fs.writeFileSync(path.join(OUT, tag + '.json'), JSON.stringify(res, null, 1));
  note('완료 — 평가:', JSON.stringify(res.judge && res.judge.scores || res.judge));
  return res;
}

// ---------- 자동 지표 ----------
const NEW_PROBLEM_RE = /((다른|다음|새로운|추가|연습)\s*문제)|(풀어\s*(보자|볼까|봐|볼래))|((\d+\s*\/\s*\d+|\d+)\s*[+\-−×÷]\s*(\d+\s*\/\s*\d+|\d+)[^.!?\n]{0,30}(어떻게|몇|구해|계산|될까|일까))/;
function computeMetrics(s) {
  if (!s || !s.turns) return { incomplete: true };
  const ai = s.turns.filter(t => t.role === 'ai' && t.text);
  const explore = ai.filter(t => t.phase === 'explore');
  const evals = (s.tasks || []).flatMap(t => t.evals || []);
  return {
    aiTurns: ai.length,
    avgAiChars: Math.round(ai.reduce((a, t) => a + t.text.length, 0) / Math.max(1, ai.length)),
    bulletTurns: ai.filter(t => /(^|\n)\s*[·•\-]\s+/.test(t.text)).length,
    tableTurns: ai.filter(t => t.text.split('\n').filter(l => (l.match(/\|/g) || []).length >= 2).length >= 2).length,
    emojiTurns: ai.filter(t => /\p{Extended_Pictographic}/u.test(t.text)).length,
    thirdPersonLeaks: ai.filter(t => /(^|[^가-힣])학습자(가|는|에게|를|의)\s/.test(t.text)).length,
    newProblemInNonTaskTurns: explore.filter(t => !t.taskId && NEW_PROBLEM_RE.test(t.text)).length,
    tasks: (s.tasks || []).map(t => ({ strat: t.stratId, task: t.task, criteria: t.criteria, levels: (t.evals || []).map(e => e.level) })),
    evalLevels: evals.map(e => e.level),
    strategies: s.strategies, stratDone: s.stratDone, strategyChanges: (s.strategyChangeLog || []).length,
    supportFinal: s.support, checkpoints: (s.checkpoints || []).map(c => c.score),
    kType: s.ctx && s.ctx.kType,
    pre: s.prior && { diag: s.prior.diagScore, sub: s.prior.sub, conf: s.prior.score, calib: s.prior.calib },
    meta: s.meta && s.meta.scoreDetail,
    post: s.residual && { score: s.residual.postScore, sub: s.residual.sub, brier: s.residual.result && s.residual.result.metacogBrier },
    piiLeft: JSON.stringify(s.turns).includes('김민수') || JSON.stringify(s.turns).includes('덕계초등학교')
  };
}

// ---------- 원리별 평가(LLM 평가자) ----------
async function judge(res, P, S) {
  const s = res.session; if (!s || !s.turns) return { error: '세션 기록 없음' };
  const tasks = Object.fromEntries((s.tasks || []).map(t => [t.id, t]));
  const lines = s.turns.map(t => {
    if (t.role === 'me') return `학생: ${t.text}`;
    if (t.role === 'ai') {
      if (t.structured) return `AI: [활동판 ${t.structured.type}]`;
      let x = `AI: ${t.text}`;
      if (t.taskId && tasks[t.taskId]) x += `\n   [과업 명세] ${tasks[t.taskId].task} / 기준: ${tasks[t.taskId].criteria.join('; ')}`;
      if (t.evalId && tasks[t.evalTaskId]) { const e = tasks[t.evalTaskId].evals.find(v => v.id === t.evalId); if (e) x += `\n   [진단 카드] 수준 ${e.level} / 해낸 점: ${e.met.join('; ')} / 더 볼 점: ${e.missing.join('; ')} / 착오: ${e.errorType}`; }
      return x;
    }
    if (t.kind === 'checkpoint' && t.answered) return `[이해도 체크 ${t.score}/5: ${t.reason}]`;
    if (t.kind === 'fade-propose') return `[도움 줄이기 제안 → ${t.answered ? (t.accepted ? '수락' : '거절') : '미응답'}]`;
    return t.text ? `[안내] ${t.text}` : '';
  }).filter(Boolean).join('\n').slice(-24000);
  const prompt = `너는 교육공학 연구자로서, 초중등 메타인지 지원 AI 챗봇의 한 세션 기록을 설계원리에 비추어 평가한다.
학생 유형(가상): ${P.label} — ${P.desc}
주제: ${S.topic} / 학생이 고른 공부 방법: ${(s.strategies || []).join(', ')} / 내용 성격: ${s.ctx && s.ctx.kType}
평가 항목(각 1~5점, 5가 가장 좋음):
 P1 비계 적응: AI 도움의 양·직접성이 학생 수행 수준에 맞게 조절되었나
 P2 최종판단 보존·과업 대행 금지: 정답·풀이·정리를 AI가 대신 해 주지 않고 학생이 판단·수행하게 했나
 P6 교과지식 점검: 사전 진단 문항과 채점이 성취기준·학생 답에 타당했나
 P7 메타인지 점검: 이해·전략·연결 질문이 제대로 이뤄졌나
 P8 전략-과업 정합성: 과업이 고른 공부 방법과 내용 성격에 맞았나
 P9 모니터링 피드백: 피드백이 근거(학생 답 인용)·오류 유형을 짚고, 정답을 누설하지 않고, 스스로 고치게 했나
 P10 응답 검증: 학생 반박·이의에 적절히 대응했나(해당 없으면 null)
 Q 대화 품질: 학년 수준 말투, 적절한 길이, 사실 오류 없음, 흐름 자연스러움
각 항목에 점수와 근거 인용(짧게)을 달고, 가장 심각한 문제 3개와 개선 제안을 써라.
{"scores":{"P1":3,"P2":3,"P6":3,"P7":3,"P8":3,"P9":3,"P10":null,"Q":3},"evidence":{"P1":"...","P2":"...","P6":"...","P7":"...","P8":"...","P9":"...","P10":"...","Q":"..."},"issues":["...","...","..."],"suggestions":["...","..."]}
--- 세션 기록 ---
${lines}`;
  const raw = await upstage([{ role: 'system', content: '반드시 순수 JSON만 출력한다.' }, { role: 'user', content: prompt }], 0);
  return parseJSONLoose(raw);
}

// ---------- 보고서 ----------
function report(all) {
  const keys = ['P1', 'P2', 'P6', 'P7', 'P8', 'P9', 'P10', 'Q'];
  const avg = k => { const v = all.map(r => r.judge && r.judge.scores && r.judge.scores[k]).filter(x => typeof x === 'number'); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : '-'; };
  let md = `# 가상 학생 에이전트 테스트 보고서\n\n- 대상: ${URL_}\n- 실행: ${new Date().toISOString()}\n- 세션: ${all.length}개 (${personas.join(', ')} × ${scenarios.join(', ')})\n\n`;
  md += `## 원리별 평균 점수 (LLM 평가자, 1~5)\n\n| 항목 | ${keys.join(' | ')} |\n|---|${keys.map(() => '---').join('|')}|\n| 평균 | ${keys.map(avg).join(' | ')} |\n`;
  for (const r of all) md += `| ${r.personaLabel}·${r.scenario} | ${keys.map(k => (r.judge && r.judge.scores && r.judge.scores[k] != null) ? r.judge.scores[k] : '-').join(' | ')} |\n`;
  md += `\n## 자동 지표\n\n| 세션 | AI 턴 | 평균 글자 | 글머리 턴 | 표 턴 | 새문제(비과업턴) | 과업 수 | 진단 수준 | 사전→사후 | 도움 최종 | 오류 |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of all) { const m = r.metrics || {}; md += `| ${r.personaLabel}·${r.scenario} | ${m.aiTurns ?? '-'} | ${m.avgAiChars ?? '-'} | ${m.bulletTurns ?? '-'} | ${m.tableTurns ?? '-'} | ${m.newProblemInNonTaskTurns ?? '-'} | ${(m.tasks || []).length} | ${(m.evalLevels || []).join(',')} | ${m.pre ? m.pre.diag : '-'}→${m.post ? m.post.score : '-'} | ${m.supportFinal || '-'} | ${(m.errors || []).length} |\n`; }
  md += `\n## 세션별 주요 문제\n`;
  for (const r of all) {
    md += `\n### ${r.personaLabel} · ${r.scenario}\n- 고른 방법: ${(r.picked && r.picked.ids || []).join(', ')} / 내용 성격: ${r.metrics && r.metrics.kType}\n`;
    if (r.metrics && r.metrics.helpRequests && r.metrics.helpRequests.length) md += `- 도움 요청 시 순환 유지: ${r.metrics.helpRequests.map(h => h.cycleBefore === h.cycleAfter ? '유지' : '넘어감').join(', ')}\n`;
    if (r.metrics && r.metrics.piiAttempt) md += `- 개인정보 입력 시도 → 기록에 남음: ${r.metrics.piiLeft ? '예(문제)' : '아니오(가려짐)'}\n`;
    if (r.judge && r.judge.issues) md += r.judge.issues.map(x => `- ⚠ ${x}`).join('\n') + '\n';
    if (r.judge && r.judge.suggestions) md += r.judge.suggestions.map(x => `- 💡 ${x}`).join('\n') + '\n';
    if (r.metrics && r.metrics.errors && r.metrics.errors.length) md += `- 실행 오류: ${r.metrics.errors.slice(0, 3).join(' / ')}\n`;
  }
  fs.writeFileSync(path.join(OUT, 'report.md'), md);
  return md;
}

const jobs = []; for (const p of personas) for (const s of scenarios) jobs.push([p, s]);
const PAR = +(args.parallel || 2);
const all = [];
let idx = 0;
await Promise.all(Array.from({ length: PAR }, async () => { while (idx < jobs.length) { const [p, s] = jobs[idx++]; all.push(await runOne(p, s)); } }));
console.log('\n' + report(all));
console.log('\n결과 폴더:', OUT);
