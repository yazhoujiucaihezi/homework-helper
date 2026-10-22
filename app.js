'use strict';

/* ============================================================
   速答 · 作业答案卡
   纯前端，接入任意兼容 /chat/completions 的接口
   ============================================================ */

const LS = {
  settings: 'hw.settings.v2',
  convs: 'hw.convs.v2',
  current: 'hw.current.v2',
};

const PRESETS = [];

const SUBJECTS = ['通用', '数学', '物理', '化学', '生物', '英语', '语文', '政治', '史地', '其他'];

const MODES = {
  answer: { name: '速答', icon: '⚡', tip: '一次多题，直接出答案卡', placeholder: '把题目整段粘进来（可多题，自动按题号切分）…' },
  solve: { name: '详解', icon: '📘', tip: '完整推导，讲清每一步', placeholder: '单独贴一道题，我要看完整推导…' },
  guide: { name: '引导', icon: '🧭', tip: '只给思路，不直接给答案', placeholder: '卡在哪一步？说出来，我陪你推…' },
};

const LS_DEFAULT = {
  provider: 'custom',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0,
  judgeFmt: 'word',
  forceJson: true,
  useProxy: false,
  proxyUrl: 'http://localhost:8787',
  grade: '大学 / 成人',
};

const FORMATS = [
  { id: 'inline', name: '连排 1.A 2.B' },
  { id: 'lines', name: '逐行 1. A' },
  { id: 'plain', name: '纯答案' },
  { id: 'csv', name: 'CSV 表格' },
];

/* ---------------- state ---------------- */

let settings = Object.assign({}, LS_DEFAULT, loadJSON(LS.settings, {}));
let convs = loadJSON(LS.convs, []);
let currentId = localStorage.getItem(LS.current) || null;
let subject = '通用';
let mode = 'answer';
let controller = null;
let streaming = false;
let copyFormat = 'lines';

/* ---------------- utils ---------------- */

const $ = (s) => document.querySelector(s);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function loadJSON(key, fb) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fb;
  } catch (_) { return fb; }
}
function saveSettings() { localStorage.setItem(LS.settings, JSON.stringify(settings)); }
function saveConvs() { localStorage.setItem(LS.convs, JSON.stringify(convs)); }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
    return ok;
  }
}

/* ---------------- markdown / math ---------------- */

const hasMarked = typeof window.marked !== 'undefined';
const hasPurify = typeof window.DOMPurify !== 'undefined';
const hasKatex = typeof window.katex !== 'undefined' && typeof window.renderMathInElement === 'function';

if (hasMarked) window.marked.setOptions({ gfm: true, breaks: true });

const KATEX_OPTS = {
  delimiters: [
    { left: '$$', right: '$$', display: true },
    { left: '\\[', right: '\\]', display: true },
    { left: '\\(', right: '\\)', display: false },
    { left: '$', right: '$', display: false },
  ],
  throwOnError: false,
  strict: false,
  ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
};

function markdownToHtml(text) {
  let html;
  if (hasMarked) {
    try { html = window.marked.parse(text); }
    catch (_) { html = escapeHtml(text).replace(/\n/g, '<br>'); }
  } else {
    html = escapeHtml(text).replace(/\n/g, '<br>');
  }
  if (hasPurify) html = window.DOMPurify.sanitize(html);
  return html;
}

function renderMath(node) {
  if (!hasKatex || !node) return;
  try { window.renderMathInElement(node, KATEX_OPTS); } catch (_) {}
}

/* ---------------- 答案解析 ---------------- */

function normalizeAnswers(arr) {
  const out = [];
  arr.forEach((o, i) => {
    if (!o || typeof o !== 'object') return;
    const answerRaw = o.answer != null ? String(o.answer)
      : o.ans != null ? String(o.ans) : '';
    const no = o.no != null ? String(o.no) : String(i + 1);
    out.push({
      no: no.trim(),
      type: String(o.type || o.kind || '未知').trim(),
      answer: answerRaw.trim(),
      point: String(o.point || o.topic || o.knowledge || '').trim(),
    });
  });
  return out;
}

function balancedJsonSlice(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function salvageAnswers(s) {
  const out = [];
  const re = /\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(s))) {
    try {
      const o = JSON.parse(m[0]);
      if (o && (o.no != null || o.answer != null || o.ans != null)) out.push(o);
    } catch (_) {}
  }
  return out.length ? normalizeAnswers(out) : [];
}

function parseAnswers(text) {
  if (!text) return [];
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const slice = balancedJsonSlice(s);
  if (slice) {
    try {
      const obj = JSON.parse(slice);
      const arr = Array.isArray(obj) ? obj : (obj.answers || obj.data || obj.list);
      if (Array.isArray(arr)) return normalizeAnswers(arr);
    } catch (_) {}
  }
  return salvageAnswers(s);
}

/* ---------------- 复制格式 ---------------- */

function judgeTruth(ans) {
  const s = String(ans || '').trim().toUpperCase().replace(/\s/g, '');
  if (['对', '正确', '√', 'T', 'TRUE', '是', 'A', 'Y', 'YES'].includes(s)) return true;
  if (['错', '错误', '×', 'X', 'F', 'FALSE', '否', 'B', 'N', 'NO'].includes(s)) return false;
  return null;
}

function formatAnswer(item) {
  const isJudge = /判断/.test(item.type) || (/^[对错√×]$/.test(item.answer.trim()) && item.answer.length <= 1);
  if (!isJudge) return item.answer;
  const t = judgeTruth(item.answer);
  if (t === null) return item.answer;
  if (settings.judgeFmt === 'ab') return t ? 'A' : 'B';
  if (settings.judgeFmt === 'mark') return t ? '√' : '×';
  return t ? '对' : '错';
}

function buildCopyText(answers, fmt) {
  const f = fmt || copyFormat;
  if (f === 'plain') return answers.map((a) => formatAnswer(a)).join('\n');
  if (f === 'inline') return answers.map((a) => `${a.no}.${formatAnswer(a)}`).join(' ');
  if (f === 'csv') {
    const rows = [['题号', '题型', '答案', '考点']];
    answers.forEach((a) => rows.push([a.no, a.type, formatAnswer(a), a.point]));
    return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  }
  return answers.map((a) => `${a.no}. ${formatAnswer(a)}`).join('\n');
}

/* ---------------- 提示词 ---------------- */

function contextLine() {
  const g = settings.grade || '大学 / 成人';
  const s = subject && subject !== '通用' ? `科目：${subject}。` : '';
  return `学生学段：${g}。${s}`;
}

function answerSystemPrompt() {
  return `你是一位阅卷老师。学生会把一整套题目发给你，你的任务是全部做完，输出可以直接填进答题框的答案。${contextLine()}

【输出格式】只输出一个 json 对象，不要输出任何其他文字：
{"answers":[{"no":"1","type":"单选","answer":"A","point":"二次函数顶点"}]}

【字段规则】
- no：题号。原题有题号就原样照抄（如 "1"、"12"、"2-1"）；原题没有题号，按出现顺序写 1、2、3…
- type：只能是 单选 / 多选 / 判断 / 填空 / 简答 / 计算 之一。
- answer：必须是能直接抄进答题框的内容
  · 单选 → 只写一个大写字母，例如 A
  · 多选 → 字母按字母序连写，例如 ABD，不加空格、顿号
  · 判断 → 只写 对 或 错
  · 填空 → 只写填进空里的内容；有多个空时按空序标注，例如 ①3 ②-2
  · 简答 / 计算 → 只写最终结论或最终结果，30 字以内，公式用 $...$ 包裹
  · answer 里绝对不要出现"答案是""故选""正确答案为"这类话，也不要写解析过程
- point：这道题考什么，8 个字以内。

【硬性要求】
1. 题目数量和顺序必须与原文完全一致：不能合并、不能漏题、不能自己加题。
2. 不要反问我，不要留空。信息不全时按最可能的理解作答。
3. 确实无法确定的，answer 写"存疑"，point 写原因。
4. 直接给正确答案，不要写"你可以试试""建议复习"这类话。`;
}

function solveSystemPrompt() {
  return `你是一位耐心的${subject !== '通用' ? subject : ''}老师。${contextLine()}
请给出完整解答：先用一句话点明考查的知识点，再分步骤推导，每一步说明"为什么这么做"，关键计算不跳步。结尾给出结论，并用两三句话总结这类题的通用思路。
公式用 LaTeX：行内 $...$，独立公式 $$...$$。用 Markdown 排版，使用简体中文，不写客套话。`;
}

function guideSystemPrompt() {
  return `你是一位${subject !== '通用' ? subject : ''}老师，采用引导式讲解。${contextLine()}
不要直接给最终答案。先点明考查点，再给出第一步该怎么想，然后把最关键的一个问题抛回给学生。
学生回答后判断对错：对了就推进下一步，错了就指出具体错在哪、再给一个小提示。
每次回复控制在 150 字以内，一次只推进一小步。只有学生明确要求时，才给完整解法。`;
}

function systemPromptFor(m) {
  if (m === 'solve') return solveSystemPrompt();
  if (m === 'guide') return guideSystemPrompt();
  return answerSystemPrompt();
}

/* ---------------- API ---------------- */

function normalizeBase(url) { return String(url || '').trim().replace(/\/+$/, ''); }
function cleanKey(s) {
  return String(s == null ? '' : s).trim().replace(/^['"`\s]+|['"`\s]+$/g, '').replace(/\s+/g, '');
}
function chatUrl() { return normalizeBase(settings.baseUrl) + '/chat/completions'; }

function buildRequest(messages, useJson) {
  const body = {
    model: settings.model,
    messages,
    stream: true,
    temperature: Number(settings.temperature) || 0,
  };
  if (useJson) body.response_format = { type: 'json_object' };

  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + settings.apiKey,
  };

  if (settings.useProxy) {
    headers['x-target-url'] = chatUrl();
    return {
      url: normalizeBase(settings.proxyUrl || 'http://localhost:8787') + '/proxy',
      init: { method: 'POST', headers, body: JSON.stringify(body) },
    };
  }
  return { url: chatUrl(), init: { method: 'POST', headers, body: JSON.stringify(body) } };
}

function friendlyError(status, text) {
  const excerpt = (text || '').slice(0, 400);
  let hint = '';
  if (status === 401) hint = 'API Key 被服务端拒绝了，不是网络问题。去接口提供方重新生成一个，整段复制（sk- 开头），粘贴时不要带空格、引号和换行；也确认 Key 和 Base URL 是同一家的。';
  else if (status === 402) hint = '账户余额不足，充值后再试。';
  else if (status === 403) hint = '没有权限访问该模型，确认 Key 的权限或模型名是否正确。';
  else if (status === 404) hint = '接口地址或模型名不存在。Base URL 一般以 <code>/v1</code> 结尾。';
  else if (status === 429) hint = '请求太频繁或额度用尽，等几秒再试。';
  else if (status >= 500) hint = '服务端出错，稍后重试或换个模型。';
  return {
    message: `请求失败（HTTP ${status}）`,
    hint: (hint ? hint + '<br>' : '') + (excerpt ? '返回：' + escapeHtml(excerpt) : ''),
    status,
  };
}

async function callAPI(messages, onDelta, onReasoning, signal, useJson) {
  const { url, init } = buildRequest(messages, useJson);
  const res = await fetch(url, Object.assign({}, init, { signal }));

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 400 && useJson && /response_format|json/i.test(text)) {
      return callAPI(messages, onDelta, onReasoning, signal, false);
    }
    throw friendlyError(res.status, text);
  }

  const ctype = res.headers.get('content-type') || '';

  if (ctype.includes('application/json')) {
    const json = await res.json();
    const msg = json.choices && json.choices[0] && json.choices[0].message;
    if (msg) {
      if (msg.reasoning_content) onReasoning(msg.reasoning_content);
      onDelta(msg.content || '');
    }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let json;
      try { json = JSON.parse(data); } catch (_) { continue; }
      if (json.error) {
        throw { message: '接口返回错误', hint: escapeHtml(json.error.message || JSON.stringify(json.error)) };
      }
      const delta = (json.choices && json.choices[0] && json.choices[0].delta) || {};
      if (delta.reasoning_content) onReasoning(delta.reasoning_content);
      if (delta.content) onDelta(delta.content);
    }
  }
}

/* ---------------- 消息构建 ---------------- */

function currentConv() { return convs.find((c) => c.id === currentId) || null; }

function ensureConv() {
  let c = currentConv();
  if (!c) {
    c = { id: uid(), title: '新任务', subject, mode, createdAt: Date.now(), messages: [] };
    convs.unshift(c);
    currentId = c.id;
    localStorage.setItem(LS.current, c.id);
    saveConvs();
  }
  return c;
}

function buildMessageEl(msg) {
  if (msg.role === 'user') {
    const wrap = el('div', 'msg user');
    wrap.appendChild(el('div', 'bubble', msg.content));
    return wrap;
  }

  const wrap = el('div', 'msg assistant');
  const head = el('div', 'head');
  head.appendChild(el('div', 'avatar', 'AI'));
  head.appendChild(el('div', 'who', msg.mode === 'answer' ? '答案卡' : '老师'));
  head.appendChild(buildActions(msg));
  wrap.appendChild(head);

  wrap.appendChild(buildAssistantBody(msg));
  return wrap;
}

function buildAssistantBody(msg) {
  const box = el('div', 'body');

  if (msg.mode === 'answer') {
    if (msg.answers && msg.answers.length) {
      box.appendChild(buildAnswerCard(msg));
    } else if (msg.streaming) {
      box.appendChild(buildProgress(msg));
    } else if (msg.error) {
      box.appendChild(buildErrorBox(msg.error));
    } else {
      box.appendChild(buildProgress(msg, '没有解析出答案，下面是模型原始输出'));
      const md = el('div', 'md');
      md.innerHTML = markdownToHtml(msg.content || '');
      box.appendChild(md);
    }
    return box;
  }

  const md = el('div', 'md' + (msg.streaming ? ' streaming' : ''));
  md.innerHTML = markdownToHtml(msg.content || '');
  renderMath(md);
  box.appendChild(md);
  if (msg.error) box.appendChild(buildErrorBox(msg.error));
  return box;
}

function buildErrorBox(err) {
  const box = el('div', 'err-box');
  box.innerHTML = escapeHtml(err.message || String(err)) + (err.hint ? '<br>' + err.hint : '');
  return box;
}

function buildProgress(msg, label) {
  const p = el('div', 'ac-progress');
  const bar = el('div', 'bar');
  bar.appendChild(el('i'));
  p.appendChild(bar);
  const n = msg.answers ? msg.answers.length : countStreamed(msg.content);
  p.appendChild(el('span', null, label || (n ? `正在解析… 已完成 ${n} 题` : '正在读题…')));
  return p;
}

function countStreamed(text) {
  if (!text) return 0;
  const m = String(text).match(/"no"\s*:/g);
  return m ? m.length : 0;
}

/* ---------------- 答案卡 ---------------- */

function buildAnswerCard(msg) {
  const answers = msg.answers || [];
  const root = el('div', 'ac');

  /* head */
  const head = el('div', 'ac-head');
  const title = el('div', 'ac-title');
  title.appendChild(el('span', 'n', String(answers.length)));
  title.appendChild(el('span', null, '题'));
  title.appendChild(el('span', 'stat', statLine(answers)));
  head.appendChild(title);

  const tools = el('div', 'ac-tools');
  const sel = document.createElement('select');
  FORMATS.forEach((f) => {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.name;
    if (f.id === copyFormat) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    copyFormat = sel.value;
  });
  tools.appendChild(sel);

  const btn = el('button', 'btn-copy', '复制全部');
  btn.addEventListener('click', async () => {
    const text = buildCopyText(answers);
    const ok = await copyText(text);
    btn.textContent = ok ? '已复制 ✓' : '复制失败';
    btn.classList.toggle('done', ok);
    setTimeout(() => { btn.textContent = '复制全部'; btn.classList.remove('done'); }, 1600);
  });
  tools.appendChild(btn);
  head.appendChild(tools);
  root.appendChild(head);

  /* 进度条（流式时） */
  if (msg.streaming) {
    const p = el('div', 'ac-progress');
    const bar = el('div', 'bar');
    bar.appendChild(el('i'));
    p.appendChild(bar);
    p.appendChild(el('span', null, `正在解析… 已完成 ${answers.length} 题`));
    root.appendChild(p);
  }

  /* 列表 */
  const list = el('div', 'ac-list');
  answers.forEach((a) => list.appendChild(buildAnswerRow(a)));
  root.appendChild(list);

  /* 校验提示 */
  const warns = checkGaps(answers);
  if (warns) {
    const w = el('div', 'ac-warn');
    w.innerHTML = '<span>⚠</span><span>' + escapeHtml(warns) + '</span>';
    root.appendChild(w);
  }

  if (msg.error) root.appendChild(buildErrorBox(msg.error));

  /* 原文折叠 */
  if (msg.content) {
    const raw = el('details', 'ac-raw');
    raw.appendChild(el('summary', null, '查看模型原始输出'));
    const body = el('div', 'raw-body', msg.content);
    raw.appendChild(body);
    root.appendChild(raw);
  }

  /* 底栏 */
  const foot = el('div', 'ac-foot');
  foot.appendChild(el('span', null, '点任意一行可单独复制该题答案'));
  root.appendChild(foot);

  return root;
}

function buildAnswerRow(a) {
  const row = el('button', 'ac-row');

  row.appendChild(el('span', 'no', a.no));

  const ans = el('span', 'ans');
  const shown = formatAnswer(a);
  ans.textContent = shown;
  if (!shown || /存疑|信息不足/.test(shown)) ans.classList.add('blank');
  else if (shown.length > 16 || shown.includes('\n')) ans.classList.add('long');
  row.appendChild(ans);

  row.appendChild(el('span', 'type', a.type || '—'));

  const point = el('span', 'point', a.point || '');
  point.title = a.point || '';
  row.appendChild(point);

  const cp = el('span', 'cp', '复制');
  row.appendChild(cp);

  row.addEventListener('click', async () => {
    const ok = await copyText(shown);
    cp.textContent = ok ? '✓ 已复制' : '失败';
    setTimeout(() => { cp.textContent = '复制'; }, 1200);
  });

  renderMath(ans);
  return row;
}

function statLine(answers) {
  const map = {};
  answers.forEach((a) => {
    const t = a.type && a.type !== '未知' ? a.type : '其他';
    map[t] = (map[t] || 0) + 1;
  });
  const parts = Object.keys(map).map((k) => `${k} ${map[k]}`);
  return parts.length ? parts.join(' · ') : '';
}

function checkGaps(answers) {
  const nums = answers.map((a) => Number(String(a.no).replace(/[^\d]/g, ''))).filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length < 3) return '';
  const set = new Set(nums);
  const max = Math.max.apply(null, nums);
  if (max > 300) return '';
  const missing = [];
  for (let i = 1; i <= max; i++) if (!set.has(i)) missing.push(i);
  if (missing.length && missing.length <= 12) {
    return `题号 ${missing.join('、')} 缺失，可能是原文没给题号或识别漏题，提交前核对一下。`;
  }
  if (set.size !== nums.length) return '有重复题号，注意核对顺序。';
  return '';
}

function buildActions(msg) {
  const acts = el('div', 'msg-actions');

  const copy = el('button');
  copy.title = '复制全文';
  copy.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';
  copy.addEventListener('click', async () => {
    const text = msg.answers && msg.answers.length ? buildCopyText(msg.answers) : msg.content || '';
    const ok = await copyText(text);
    copy.style.color = ok ? 'var(--ok)' : 'var(--danger)';
    setTimeout(() => { copy.style.color = ''; }, 1200);
  });
  acts.appendChild(copy);

  const regen = el('button');
  regen.title = '重新生成';
  regen.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.4 5.7"/><path d="M20 4v7h-7"/></svg>';
  regen.addEventListener('click', () => regenerate(msg));
  acts.appendChild(regen);

  return acts;
}

/* ---------------- 渲染列表 ---------------- */

function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  const conv = currentConv();
  const msgs = conv ? conv.messages : [];
  $('#welcome').style.display = msgs.length ? 'none' : 'block';
  msgs.forEach((m) => box.appendChild(buildMessageEl(m)));
  if (msgs.length) scrollToBottom(true);
}

function renderConvList() {
  const box = $('#convList');
  box.innerHTML = '';
  if (!convs.length) {
    const d = el('div', 'conv-item', '还没有记录');
    d.style.opacity = '0.4';
    d.style.cursor = 'default';
    box.appendChild(d);
    return;
  }
  convs.forEach((c) => {
    const item = el('div', 'conv-item' + (c.id === currentId ? ' on' : ''));
    item.appendChild(el('div', 't', c.title || '新任务'));
    const del = el('button', 'del');
    del.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.title = '删除';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = convs.findIndex((x) => x.id === c.id);
      if (i >= 0) convs.splice(i, 1);
      if (currentId === c.id) {
        currentId = convs[0] ? convs[0].id : null;
        if (currentId) localStorage.setItem(LS.current, currentId);
        else localStorage.removeItem(LS.current);
        loadConvIntoView();
      }
      saveConvs();
      renderConvList();
    });
    item.appendChild(del);
    item.addEventListener('click', () => {
      currentId = c.id;
      localStorage.setItem(LS.current, c.id);
      loadConvIntoView();
      closeSidebar();
    });
    box.appendChild(item);
  });
}

function loadConvIntoView() {
  const conv = currentConv();
  if (conv && conv.subject && SUBJECTS.includes(conv.subject)) {
    subject = conv.subject;
    renderSubjects();
  }
  $('#topbarTitle').textContent = conv ? conv.title : '新任务';
  renderMessages();
  renderConvList();
}

function scrollToBottom(force) {
  const sc = $('#scroll');
  const near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 180;
  if (force || near) sc.scrollTop = sc.scrollHeight;
}

function updateModelBadge() {
  const b = $('#modelBadge');
  const ok = !!(settings.apiKey && settings.model && settings.baseUrl);
  b.className = 'model-badge' + (ok ? ' ok' : '');
  b.querySelector('span').textContent = ok ? settings.model : '未配置模型';
  b.title = ok ? `${settings.baseUrl} · ${settings.model}` : '点「API 设置」填写';
}

/* ---------------- 发送 ---------------- */

function setStreaming(on) {
  streaming = on;
  const btn = $('#btnSend');
  btn.classList.toggle('stop', on);
  document.getElementById('sendLabel').textContent = on ? '停止' : (mode === 'answer' ? '出答案' : '发送');
  document.getElementById('sendIcon').style.display = on ? 'none' : '';
  btn.onclick = on ? () => { if (controller) controller.abort(); } : send;
}

function toApiMessages(conv, msgMode) {
  const msgs = [{ role: 'system', content: systemPromptFor(msgMode) }];
  conv.messages.forEach((m) => {
    if (m.error) return;
    if (m.role === 'user') msgs.push({ role: 'user', content: m.content });
    else if (m.content) msgs.push({ role: 'assistant', content: m.content });
  });
  return msgs;
}

async function send() {
  if (streaming) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text) { input.focus(); return; }

  if (!settings.apiKey || !settings.model || !settings.baseUrl) {
    openSettings();
    flashSettingsHint('还没配置 API，填好 Key 就能用。');
    return;
  }

  const conv = ensureConv();
  conv.mode = mode;
  conv.subject = subject;

  conv.messages.push({ role: 'user', content: text, ts: Date.now() });
  if (conv.title === '新任务') {
    conv.title = text.replace(/\s+/g, ' ').slice(0, 24) || '新任务';
    $('#topbarTitle').textContent = conv.title;
  }

  input.value = '';
  autoGrow(input);
  updateHint();
  saveConvs();
  $('#welcome').style.display = 'none';
  $('#messages').appendChild(buildMessageEl(conv.messages[conv.messages.length - 1]));
  scrollToBottom(true);

  await runAssistant(conv, mode);
}

async function runAssistant(conv, msgMode) {
  const msg = { role: 'assistant', mode: msgMode, content: '', answers: [], streaming: true, ts: Date.now() };
  conv.messages.push(msg);

  const node = buildMessageEl(msg);
  $('#messages').appendChild(node);

  let bodyBox = node.querySelector('.body');
  let bodyMode = msgMode;
  let pending = false;

  const refreshAnswerBody = () => {
    const fresh = buildAssistantBody(msg);
    node.replaceChild(fresh, bodyBox);
    bodyBox = fresh;
    scrollToBottom(false);
  };

  setStreaming(true);
  scrollToBottom(true);

  const throttledMd = throttle(() => {
    if (bodyMode !== 'answer') {
      const md = bodyBox.querySelector('.md');
      if (md) {
        md.innerHTML = markdownToHtml(msg.content);
        renderMath(md);
      }
      scrollToBottom(false);
    }
  }, 80);

  const throttledCard = throttle(() => {
    if (bodyMode === 'answer') refreshAnswerBody();
  }, 260);

  try {
    controller = new AbortController();
    await callAPI(
      toApiMessages(conv, msgMode),
      (delta) => {
        msg.content += delta;
        if (bodyMode === 'answer') {
          const parsed = salvageAnswers(msg.content);
          if (parsed.length !== (msg.answers || []).length) {
            msg.answers = parsed;
            throttledCard();
          }
        } else {
          throttledMd();
        }
      },
      () => {},
      controller.signal,
      msgMode === 'answer' && settings.forceJson
    );
  } catch (err) {
    if (err && err.name === 'AbortError') {
      msg.aborted = true;
    } else {
      msg.error = { message: (err && err.message) || '请求失败', hint: (err && err.hint) || '' };
    }
  } finally {
    msg.streaming = false;
    if (msgMode === 'answer') {
      const final = parseAnswers(msg.content);
      if (final.length) msg.answers = final;
      if (!msg.answers.length && !msg.error && !msg.content) {
        msg.error = { message: '没有返回内容', hint: '可能是模型不支持 JSON 模式，去设置里取消勾选「强制 JSON 输出」再试。' };
      }
    }
    node.replaceChild(buildAssistantBody(msg), bodyBox);
    setStreaming(false);
    controller = null;
    saveConvs();
    renderConvList();
    scrollToBottom(false);
  }
}

async function regenerate(msg) {
  if (streaming) return;
  const conv = currentConv();
  if (!conv) return;
  const i = conv.messages.indexOf(msg);
  if (i < 0) return;
  conv.messages.splice(i, 1);
  saveConvs();
  renderMessages();
  await runAssistant(conv, msg.mode || 'answer');
}

const throttle = (fn, ms) => {
  let last = 0, timer = null;
  return function () {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      clearTimeout(timer); timer = null; last = now; fn();
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(); }, wait);
    }
  };
};

/* ---------------- 设置 ---------------- */

function openSettings() {
  $('#baseUrl').value = settings.baseUrl || '';
  $('#apiKey').value = settings.apiKey || '';
  $('#model').value = settings.model || '';
  $('#temperature').value = settings.temperature;
  $('#judgeFmt').value = settings.judgeFmt || 'word';
  $('#forceJson').checked = !!settings.forceJson;
  $('#useProxy').checked = !!settings.useProxy;
  $('#proxyUrl').value = settings.proxyUrl || 'http://localhost:8787';
  $('#proxyField').style.display = settings.useProxy ? 'flex' : 'none';
  renderPresets();
  const box = $('#testResult');
  box.className = 'test-result';
  box.textContent = '';
  $('#settingsModal').classList.add('open');
  $('#settingsModal').setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  $('#settingsModal').classList.remove('open');
  $('#settingsModal').setAttribute('aria-hidden', 'true');
}

function renderPresets() {
  const row = $('#presetRow');
  if (!row) return;
  row.innerHTML = '';
  PRESETS.forEach((p) => {
    const b = el('button', 'preset' + (settings.provider === p.id ? ' on' : ''), p.name);
    b.addEventListener('click', () => {
      settings.provider = p.id;
      if (p.baseUrl) {
        $('#baseUrl').value = p.baseUrl;
        $('#model').value = p.model;
      }
      renderPresets();
    });
    row.appendChild(b);
  });
}

function saveSettingsFromForm() {
  settings.baseUrl = $('#baseUrl').value.trim();
  settings.apiKey = cleanKey($('#apiKey').value);
  settings.model = $('#model').value.trim();
  settings.temperature = Number($('#temperature').value) || 0;
  settings.judgeFmt = $('#judgeFmt').value;
  settings.forceJson = $('#forceJson').checked;
  settings.useProxy = $('#useProxy').checked;
  settings.proxyUrl = $('#proxyUrl').value.trim() || 'http://localhost:8787';
  saveSettings();
  updateModelBadge();
  closeSettings();
  renderMessages();
}

async function testConnection() {
  const box = $('#testResult');
  const trial = {
    baseUrl: $('#baseUrl').value.trim(),
    apiKey: cleanKey($('#apiKey').value),
    model: $('#model').value.trim(),
    proxyUrl: $('#proxyUrl').value.trim(),
    useProxy: $('#useProxy').checked,
    temperature: 0,
  };
  if (!trial.baseUrl || !trial.apiKey || !trial.model) {
    box.className = 'test-result show bad';
    box.textContent = 'Base URL、API Key、模型名都要填。';
    return;
  }
  box.className = 'test-result show';
  box.style.color = 'var(--text-dim)';
  box.textContent = '正在测试…';

  const backup = settings;
  settings = Object.assign({}, settings, trial);
  try {
    let got = '';
    await callAPI(
      [{ role: 'system', content: '只回复 ok 两个字符' }, { role: 'user', content: '测试' }],
      (d) => { got += d; }, () => {}, null, false
    );
    box.className = 'test-result show ok';
    box.textContent = '连接成功，模型回复：' + (got.slice(0, 40) || '(空)');
  } catch (err) {
    box.className = 'test-result show bad';
    box.innerHTML = escapeHtml(err.message || '连接失败') + (err.hint ? '<br>' + err.hint : '');
  } finally {
    settings = backup;
  }
}

function flashSettingsHint(text) {
  const box = $('#testResult');
  box.className = 'test-result show bad';
  box.textContent = text;
}

/* ---------------- 其他 UI ---------------- */

function renderSubjects() {
  const box = $('#subjectChips');
  box.innerHTML = '';
  SUBJECTS.forEach((s) => {
    const b = el('button', 'chip' + (s === subject ? ' on' : ''), s);
    b.addEventListener('click', () => {
      subject = s;
      renderSubjects();
      const c = currentConv();
      if (c) { c.subject = s; saveConvs(); }
    });
    box.appendChild(b);
  });
}

function renderModes() {
  const bar = $('#modeBar');
  bar.innerHTML = '';
  Object.entries(MODES).forEach(([key, m]) => {
    const b = el('button', 'mode-btn' + (key === mode ? ' on' : ''));
    b.appendChild(el('span', null, m.icon));
    b.appendChild(el('span', null, m.name));
    b.title = m.tip;
    b.addEventListener('click', () => {
      mode = key;
      renderModes();
    });
    bar.appendChild(b);
  });
  $('#input').placeholder = MODES[mode].placeholder;
  document.getElementById('sendLabel').textContent = streaming ? '停止' : (mode === 'answer' ? '出答案' : '发送');
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
}

function countQuestions(text) {
  if (!text) return 0;
  const m = text.match(/(^|\n)\s*[（(]?\s*\d{1,3}\s*[.、．)）]\s*/g);
  return m ? m.length : 0;
}

function updateHint() {
  const h = $('#hintText');
  const n = countQuestions($('#input').value);
  if (n >= 2) {
    h.textContent = `检测到 ${n} 道题 · 将生成 ${n} 条答案`;
    h.classList.add('detected');
  } else {
    h.textContent = 'Enter 发送 · Shift+Enter 换行';
    h.classList.remove('detected');
  }
}

function exportCsv() {
  const conv = currentConv();
  if (!conv) return;
  const msg = conv.messages.slice().reverse().find((m) => m.answers && m.answers.length);
  if (!msg) { alert('当前没有答案卡可导出。'); return; }
  const csv = buildCopyText(msg.answers, 'csv');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (conv.title || '答案卡').replace(/[\\/:*?"<>|]/g, '_') + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#scrim').classList.add('show');
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('show');
}

/* ---------------- init ---------------- */

function init() {
  renderSubjects();
  renderModes();
  renderConvList();
  updateModelBadge();
  $('#gradeSelect').value = settings.grade || '大学 / 成人';

  if (!currentId && convs.length) currentId = convs[0].id;
  loadConvIntoView();

  const input = $('#input');
  input.addEventListener('input', () => { autoGrow(input); updateHint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  $('#btnSend').onclick = send;

  document.querySelectorAll('#exampleCards .card').forEach((c) => {
    c.addEventListener('click', () => {
      input.value = c.dataset.fill || '';
      autoGrow(input);
      updateHint();
      input.focus();
    });
  });

  $('#btnNew').addEventListener('click', () => {
    const c = { id: uid(), title: '新任务', subject, mode, createdAt: Date.now(), messages: [] };
    convs.unshift(c);
    currentId = c.id;
    localStorage.setItem(LS.current, c.id);
    saveConvs();
    loadConvIntoView();
    closeSidebar();
    input.focus();
  });

  $('#btnClear').addEventListener('click', () => {
    const conv = currentConv();
    if (!conv || !conv.messages.length) return;
    if (!confirm('清空当前任务的所有记录？')) return;
    conv.messages = [];
    conv.title = '新任务';
    saveConvs();
    loadConvIntoView();
  });

  $('#btnExport').addEventListener('click', exportCsv);

  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#btnSaveSettings').addEventListener('click', saveSettingsFromForm);
  $('#btnTest').addEventListener('click', testConnection);
  $('#useProxy').addEventListener('change', (e) => {
    $('#proxyField').style.display = e.target.checked ? 'flex' : 'none';
  });
  $('#settingsModal').addEventListener('click', (e) => {
    if (e.target === $('#settingsModal')) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openSettings();
    }
  });

  $('#gradeSelect').addEventListener('change', (e) => {
    settings.grade = e.target.value;
    saveSettings();
  });

  $('#btnMenu').addEventListener('click', openSidebar);
  $('#btnCloseSide').addEventListener('click', closeSidebar);
  $('#scrim').addEventListener('click', closeSidebar);

  if (!settings.apiKey) {
    setTimeout(() => {
      openSettings();
      flashSettingsHint('第一次用，先填接口地址、API Key 和模型名。');
    }, 420);
  }
}

document.addEventListener('DOMContentLoaded', init);
