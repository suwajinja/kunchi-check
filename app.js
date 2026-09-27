/* 長崎くんち 職務チェックリスト — 画面側
 * データ（予定・チェック・申し送り）は GAS の API から取得し、端末にも保存します。
 * 通信できないときの操作は「未送信」として端末に貯め、つながった時点で自動送信します。
 */
'use strict';
(function () {
  // ---------- 基本 ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('kc.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('kc.' + k, JSON.stringify(v)); } catch (e) { /* 保存できない環境 */ } },
  };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const norm = (s) => String(s || '').normalize('NFKC').trim();

  const cfg = window.KUNCHI_CONFIG || {};
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || /^(192\.168|10)\./.test(location.hostname);
  const apiParam = new URLSearchParams(location.search).get('api'); // 開発用：?api=http://localhost:8787
  const API = isLocalHost && apiParam ? apiParam : isLocalHost || !/^https:\/\//.test(cfg.apiUrl || '') ? '/api' : cfg.apiUrl;

  const PLACE_CLASS = { 御旅所: 'p-otabi', 神社: 'p-jinja', 移動: 'p-ido', 休憩: 'p-kyukei' };
  const OVERVIEW = '全体';

  // ---------- 時刻（Asia/Tokyo 固定） ----------
  const params = new URLSearchParams(location.search);
  const loadedAt = Date.now();
  let testNow = null; // ?now=2026-10-08T14:30 で時刻を仮定して確認できる
  if (params.get('now')) {
    const t = Date.parse(params.get('now').replace(' ', 'T') + (params.get('now').length <= 16 ? ':00' : '') + '+09:00');
    if (!isNaN(t)) testNow = t;
  }
  const nowMs = () => (testNow == null ? Date.now() : testNow + (Date.now() - loadedAt));
  const jst = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  function parts(ts) {
    const o = {};
    for (const p of jst.formatToParts(new Date(ts))) o[p.type] = p.value;
    return o;
  }
  const hm = (ts) => { const p = parts(ts); return `${+p.hour}:${p.minute}`; };
  const dhm = (ts) => { const p = parts(ts); return `${+p.month}/${+p.day} ${+p.hour}:${p.minute}`; };
  const hms = (ts) => { const p = parts(ts); return `${+p.hour}:${p.minute}:${p.second}`; };

  // ---------- 状態 ----------
  let pass = LS.get('pass', '');
  let myName = LS.get('name', '');
  let myGroup = LS.get('group', '');
  let data = LS.get('data', null);
  let server = LS.get('server', { v: null, checks: {}, notes: [] });
  let pending = LS.get('pending', []);
  let myNotes = new Set(LS.get('myNotes', []));
  let seen = LS.get('seen', {});
  let tab = LS.get('tab', OVERVIEW);
  let onlyTodo = LS.get('onlyTodo', false);
  let noteTab = tab;
  let lastOk = LS.get('lastOk', 0);
  let online = null;
  let fails = 0;
  let syncing = false;
  let syncTimer = null;
  const inflight = new Set();
  let started = false;
  let timelines = {};

  const savePending = () => LS.set('pending', pending);

  // ---------- 通信 ----------
  async function api(body, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
    try {
      // Content-Type を付けない（text/plain）ことで、GAS へのプリフライト無しで送れる
      const res = await fetch(API, { method: 'POST', body: JSON.stringify(body), signal: ctrl.signal, cache: 'no-store', redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function sync() {
    if (syncing || !pass) return;
    syncing = true;
    clearTimeout(syncTimer);
    const ops = pending.slice(0, 100);
    ops.forEach((o) => inflight.add(o.opId));
    updateStatus();
    try {
      const res = await api({ action: 'sync', pass, v: server.v, ops });
      if (!res.ok) {
        if (res.error === 'auth') { pass = ''; LS.set('pass', ''); askPass('合言葉が変更されました。新しい合言葉を入力してください。'); return; }
        throw new Error(res.error || 'error');
      }
      if (res.acked && res.acked.length) {
        const a = new Set(res.acked);
        pending = pending.filter((o) => !a.has(o.opId));
        savePending();
      }
      let changed = false;
      if (!res.same && res.checks) {
        server = { v: res.v, checks: res.checks, notes: res.notes || [] };
        LS.set('server', server);
        changed = true;
      }
      online = true;
      fails = 0;
      lastOk = Date.now();
      LS.set('lastOk', lastOk);
      if (data && res.dataHash && res.dataHash !== data.meta.hash) await refreshData();
      else if (changed || ops.length) {
        refreshChecks();
        if (!$('#notes').hidden) renderNotes();
      }
    } catch (e) {
      online = false;
      fails++;
    } finally {
      ops.forEach((o) => inflight.delete(o.opId));
      syncing = false;
      updateStatus();
      scheduleSync();
    }
  }

  function scheduleSync(ms) {
    clearTimeout(syncTimer);
    let delay = ms;
    if (delay == null) {
      if (online === false) delay = Math.min(30000, 4000 * Math.max(1, fails));
      else delay = document.hidden ? 60000 : pending.length ? 1500 : 10000;
    }
    syncTimer = setTimeout(sync, delay);
  }

  async function refreshData() {
    try {
      const res = await api({ action: 'data', pass });
      if (res.ok && res.data) {
        data = res.data;
        LS.set('data', data);
        timelines = {};
        renderAll(false);
        toast('予定表が更新されました');
      }
    } catch (e) { /* 次回に再取得 */ }
  }

  // ---------- チェックの集計 ----------
  function effChecks() {
    const m = Object.assign({}, server.checks);
    for (const op of pending) {
      if (op.type !== 'check') continue;
      if (op.done) m[op.id] = [op.name, op.ts, true];
      else delete m[op.id];
    }
    return m;
  }

  function effNotes() {
    const del = new Set(pending.filter((o) => o.type === 'delnote').map((o) => o.nid));
    const have = new Set(server.notes.map((n) => n.nid));
    const local = pending.filter((o) => o.type === 'note' && !have.has(o.nid))
      .map((o) => ({ nid: o.nid, g: o.group, text: o.text, n: o.name, t: o.ts, pend: true }));
    return local.concat(server.notes).filter((n) => !del.has(n.nid)).sort((a, b) => b.t - a.t);
  }

  function groupById(id) { return data.groups.find((g) => g.id === id); }

  function countGroup(g, checks) {
    const days = g.days.map((d) => {
      let done = 0, total = 0;
      d.rows.forEach((r) => r.items.forEach((it) => { total++; if (checks[it.id]) done++; }));
      return { date: d.date, label: d.label, done, total };
    });
    return { days, done: days.reduce((a, d) => a + d.done, 0), total: days.reduce((a, d) => a + d.total, 0) };
  }

  // ---------- 時刻の読み取り（原本の「時刻」列から、おおよその開始時刻を決める） ----------
  const HINTS = [['起床後', 5, 30], ['夜間', 22, 0], ['日中', 9, 0], ['朝', 6, 30], ['夜', 21, 0]];
  const epoch = (month, day, h, m) => Date.UTC(data.meta.year, month - 1, day, h - 9, m);

  // 1) 「15:00」「22:00まで」「朝」など時刻の分かる行を先に決め、
  // 2) 「終了後」「清祓後」など時刻のない行は、前後の時刻の間に最大60分刻みで割り振る。
  function buildTimeline(days) {
    const out = [];
    const HOUR = 3600e3;
    for (const d of days) {
      const day = +d.date;
      const es = d.rows.map((row, i) => ({ row, day: d, idx: i, start: null, exact: false, deadline: null }));
      let anchor = null;
      for (const e of es) {
        const t = String(e.row.time || '').replace(/\s+/g, '');
        const m = t.match(/(\d{1,2}):(\d{2})/);
        if (m) {
          let at = epoch(d.month, day, +m[1], +m[2]);
          if (anchor != null && at < anchor - 3 * HOUR) at += 24 * HOUR; // 「4:00前」など翌日未明
          if (/まで|前/.test(t.slice(m.index + m[0].length))) { e.deadline = at; e.start = at - HOUR; }
          else { e.start = at; e.exact = true; }
        } else {
          const h = HINTS.find(([k]) => t.includes(k));
          if (h) e.start = epoch(d.month, day, h[1], h[2]);
        }
        if (e.start != null) anchor = e.start;
      }
      for (let i = 0; i < es.length; i++) {
        if (es[i].start != null) continue;
        let j = i;
        while (j < es.length && es[j].start == null) j++;
        const n = j - i;
        const A = i > 0 ? es[i - 1].start : null;
        const B = j < es.length ? es[j].start : null;
        let base, step;
        if (A != null && B != null) { step = Math.min(HOUR, (B - A) / (n + 1)); base = A; }
        else if (A != null) { step = HOUR; base = A; }
        else if (B != null) { step = HOUR; base = B - HOUR * (n + 1); }
        else { step = 60e3; base = epoch(d.month, day, 0, 0); }
        for (let k = 0; k < n; k++) es[i + k].start = base + step * (k + 1);
        i = j - 1;
      }
      for (let i = 1; i < es.length; i++) if (es[i].start <= es[i - 1].start) es[i].start = es[i - 1].start + 60e3;
      out.push(...es);
    }
    return out;
  }

  function timelineFor(tabId) {
    if (!timelines[tabId]) {
      const days = tabId === OVERVIEW ? data.overview.days : groupById(tabId).days;
      timelines[tabId] = buildTimeline(days);
    }
    return timelines[tabId];
  }

  function period() {
    const days = data.overview.days;
    const f = days[0], l = days[days.length - 1];
    return { start: epoch(f.month, +f.date, 0, 0), end: epoch(l.month, +l.date, 0, 0) + 86400e3 };
  }

  function whereNow() {
    const tl = timelineFor(tab);
    const now = nowMs();
    const p = period();
    if (now < p.start || now >= p.end) return { out: true, first: tl[0], now };
    let cur = null;
    for (const e of tl) if (e.start <= now) cur = e;
    const next = tl.find((e) => e.start > now) || null;
    const nextExact = tl.find((e) => (e.exact || e.deadline) && (e.exact ? e.start : e.deadline) > now) || null;
    return { cur, next, nextExact, now };
  }

  // ---------- 描画 ----------
  const rowDomId = (e) => (tab === OVERVIEW ? `ov-${e.day.date}-${e.idx}` : e.row.id);
  const placeChip = (p, cls) => (p ? `<span class="chip ${PLACE_CLASS[p] || ''} ${cls || ''}">${esc(p)}</span>` : '');
  const rich = (s) => esc(s).replace(/【(.+?)】/g, (_, p) => placeChip(p, 'inline'));
  const plain = (s) => String(s).replace(/【(.+?)】/g, '$1：').replace(/\n/g, ' ');
  const rowText = (e) => (tab === OVERVIEW ? e.row.cells.map((c) => plain(c.text)).join(' ／ ') : e.row.items.map((i) => i.text).join(' ／ '));

  function renderTabs() {
    const ids = [OVERVIEW].concat(data.groups.map((g) => g.id));
    $('#tabs').innerHTML = ids.map((id) =>
      `<button type="button" class="tab ${id === myGroup ? 'mine' : ''}" role="tab" data-tab="${esc(id)}" aria-selected="${id === tab}">${id === myGroup ? '<span class="mine-mark">自分</span>' : ''}${esc(id)}<span class="tab-n" data-tabn="${esc(id)}"></span></button>`).join('');
    const sel = $('#tabs .tab[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  function groupHTML(g) {
    let h = `<section class="summary" aria-label="進捗">
      <div class="sum-top"><h2>${esc(g.name)}の進捗</h2><strong data-sum-total></strong></div>
      <span class="bar-i"><b data-sum-bar></b></span>
      <div class="sum-days">${g.days.map((d) => `<div class="sum-day" data-sum-day="${esc(d.date)}"><span>${esc(d.month)}月${esc(d.date)}日 <b></b></span><span class="bar-i"><b></b></span></div>`).join('')}</div>
      ${g.subtitle && !/^長崎くんち/.test(g.subtitle) ? `<p class="sum-sub">${esc(g.subtitle)}</p>` : ''}
      ${(g.notes || []).map((n) => `<p class="sum-sub">${esc(n)}</p>`).join('')}
    </section>`;
    for (const d of g.days) {
      h += `<section class="day" data-day="${esc(d.date)}" id="day-${esc(d.date)}">
        <h2 class="day-h"><span>${esc(d.label)}</span><span class="day-prog"></span><span class="bar-i"><b></b></span></h2>`;
      for (const r of d.rows) {
        h += `<div class="row" id="${esc(r.id)}">
          <div class="row-h"><span class="time">${esc(r.time)}</span>${placeChip(r.place)}<span class="now-badge">いま</span></div>
          <div class="items">${r.items.map((it) =>
            `<button type="button" class="item" data-id="${esc(it.id)}" role="checkbox" aria-checked="false"><span class="box" aria-hidden="true"></span><span class="txt">${esc(it.text)}</span><span class="who"></span></button>`).join('')}</div>
        </div>`;
      }
      h += (d.notes || []).map((n) => `<p class="day-note">${esc(n)}</p>`).join('');
      h += `<p class="day-done">✓ この日の項目はすべて完了しました</p></section>`;
    }
    return h;
  }

  function overviewHTML(ov) {
    const days = ov.days;
    let h = `<section class="summary" aria-label="各班の進捗">
      <div class="sum-top"><h2>各班の進捗</h2><strong data-sum-total></strong></div>
      <table class="matrix"><thead><tr><th></th>${days.map((d) => `<th>${esc(d.month)}/${esc(d.date)}</th>`).join('')}</tr></thead>
      <tbody>${data.groups.map((g) => `<tr data-mx="${esc(g.id)}"><th><button type="button" class="g-link" data-tab="${esc(g.id)}">${esc(g.name)}</button></th>${
        g.days.map((d) => `<td data-mx-day="${esc(d.date)}"><span class="n"></span><span class="bar-i"><b></b></span></td>`).join('')}</tr>`).join('')}</tbody></table>
    </section>`;
    const cols = ov.columns || [];
    for (const d of days) {
      h += `<section class="day" id="day-${esc(d.date)}"><h2 class="day-h"><span>${esc(d.label)}</span></h2>`;
      d.rows.forEach((r, i) => {
        h += `<div class="row orow" id="ov-${esc(d.date)}-${i}">
          <div class="row-h"><span class="time">${esc(r.time)}</span><span class="now-badge">いま</span></div>
          ${r.cells.map((c) => {
            const all = c.span >= cols.length;
            const label = all ? '全員' : cols.slice(c.col, c.col + c.span).join('・');
            const endRow = c.rowspan > 1 ? d.rows[i + c.rowspan - 1] : null;
            return `<div class="ocell"><span class="col-label ${all ? 'all' : ''}">${esc(label)}${endRow ? `<span class="span-note">${esc(r.time)}〜${esc(endRow.time)}</span>` : ''}</span><div class="otext">${rich(c.text)}</div></div>`;
          }).join('')}
        </div>`;
      });
      h += (d.notes || []).map((n) => `<p class="day-note">${esc(n)}</p>`).join('');
      h += `</section>`;
    }
    return h;
  }

  function renderAll(scroll) {
    if (tab !== OVERVIEW && !groupById(tab)) tab = OVERVIEW;
    document.body.classList.toggle('todo', onlyTodo);
    $('#todo').setAttribute('aria-pressed', String(onlyTodo));
    $('#drum').textContent = data.meta.drum;
    renderWho();
    renderTabs();
    $('#main').innerHTML = tab === OVERVIEW ? overviewHTML(data.overview) : groupHTML(groupById(tab));
    refreshChecks();
    updateNow();
    measure();
    if (scroll) requestAnimationFrame(() => scrollToNow(false));
  }

  function setBar(el, done, total) {
    if (el) el.style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  }

  function refreshChecks() {
    if (!data) return;
    const checks = effChecks();
    // 班タブの完了数
    data.groups.forEach((g) => {
      const c = countGroup(g, checks);
      const el = document.querySelector(`[data-tabn="${CSS.escape(g.id)}"]`);
      if (el) { el.textContent = `${c.done}/${c.total}`; el.classList.toggle('all', c.done === c.total && c.total > 0); }
    });

    if (tab === OVERVIEW) {
      let D = 0, T = 0;
      data.groups.forEach((g) => {
        const c = countGroup(g, checks);
        D += c.done; T += c.total;
        c.days.forEach((d) => {
          const td = document.querySelector(`tr[data-mx="${CSS.escape(g.id)}"] td[data-mx-day="${CSS.escape(d.date)}"]`);
          if (td) { td.querySelector('.n').textContent = `${d.done}／${d.total}`; setBar(td.querySelector('b'), d.done, d.total); }
        });
      });
      const tot = document.querySelector('[data-sum-total]');
      if (tot) tot.innerHTML = `${D}<small> ／ ${T}</small>`;
    } else {
      const g = groupById(tab);
      document.querySelectorAll('.item').forEach((el) => {
        const c = checks[el.dataset.id];
        el.classList.toggle('done', !!c);
        el.setAttribute('aria-checked', String(!!c));
        el.querySelector('.who').innerHTML = c ? `✓ ${esc(c[0])}・${esc(dhm(c[1]))}${c[2] ? '<span class="pend">未送信</span>' : ''}` : '';
      });
      document.querySelectorAll('.row').forEach((row) => {
        const items = row.querySelectorAll('.item');
        row.classList.toggle('all-done', items.length > 0 && [...items].every((i) => i.classList.contains('done')));
      });
      const c = countGroup(g, checks);
      const tot = document.querySelector('[data-sum-total]');
      if (tot) tot.innerHTML = `${c.done}<small> ／ ${c.total}</small>`;
      setBar(document.querySelector('[data-sum-bar]'), c.done, c.total);
      c.days.forEach((d) => {
        const sd = document.querySelector(`[data-sum-day="${CSS.escape(d.date)}"]`);
        if (sd) { sd.querySelector('span b').textContent = `${d.done}／${d.total}`; setBar(sd.querySelector('.bar-i b'), d.done, d.total); }
        const sec = document.getElementById(`day-${d.date}`);
        if (sec) {
          sec.querySelector('.day-prog').innerHTML = `完了 <b>${d.done}</b>／${d.total}`;
          setBar(sec.querySelector('.day-h .bar-i b'), d.done, d.total);
          sec.classList.toggle('all-done', d.total > 0 && d.done === d.total);
        }
      });
    }
    updateBadge();
  }

  function fmtLeft(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return `あと${m}分`;
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return `あと${h}時間${mm ? mm + '分' : ''}`;
    return `あと${Math.floor(h / 24)}日${h % 24 ? (h % 24) + '時間' : ''}`;
  }

  let nowRowId = null;
  function updateNow() {
    if (!data) return;
    const w = whereNow();
    const el = $('#now');
    const test = (testNow != null ? '<span class="now-test">時刻テスト</span>' : '') +
      (tab !== OVERVIEW && myGroup && tab !== myGroup ? `<span class="now-other">表示中：${esc(tab)}</span>` : '');
    const label = (e) => `<span class="t">${esc(e.day.date)}日 ${esc(String(e.row.time).replace(/\n/g, ''))}</span>`;
    let html;
    let target = null;
    if (w.out) {
      const f = w.first;
      html = `<span class="now-k wait">期間外</span>
        <span class="now-main">${test}本番は ${esc(data.overview.days[0].label)}〜</span>
        <span class="now-next">最初の予定 ${label(f)} ${esc(rowText(f))}</span>`;
    } else {
      const cur = w.cur;
      target = cur;
      const nx = w.next;
      let nextLine = '';
      if (nx) {
        nextLine = `次 ${label(nx)}${esc(rowText(nx))}`;
        const x = w.nextExact;
        if (x) nextLine = `<b>${fmtLeft((x.exact ? x.start : x.deadline) - w.now)}</b>（${esc(hm(x.exact ? x.start : x.deadline))}）・${nextLine}`;
      } else nextLine = 'この後の予定はありません';
      if (cur) {
        html = `<span class="now-k">いま</span>
          <span class="now-main">${test}${label(cur)}${tab === OVERVIEW ? '' : placeChip(cur.row.place, 'inline')} ${esc(rowText(cur))}</span>
          <span class="now-next">${nextLine}</span>`;
      } else {
        target = nx;
        html = `<span class="now-k wait">まもなく</span>
          <span class="now-main">${test}${nx ? label(nx) + esc(rowText(nx)) : ''}</span>
          <span class="now-next">${nx && w.nextExact ? `<b>${fmtLeft(w.nextExact.start - w.now)}</b>` : ''}</span>`;
      }
    }
    el.innerHTML = html;
    const id = target ? rowDomId(target) : null;
    if (id !== nowRowId) {
      document.querySelectorAll('.row.is-now').forEach((r) => r.classList.remove('is-now'));
      nowRowId = id;
    }
    if (id && w.cur) { const r = document.getElementById(id); if (r) r.classList.add('is-now'); }
  }

  function scrollToNow(smooth) {
    const w = whereNow();
    const e = w.out ? null : w.cur || w.next;
    const el = e && document.getElementById(rowDomId(e));
    if (el) el.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    else window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
  }

  function measure() {
    const bar = $('#bar'), dock = document.querySelector('.dock');
    document.documentElement.style.setProperty('--hdr-h', bar.offsetHeight + 'px');
    document.documentElement.style.setProperty('--dock-h', dock.offsetHeight + 'px');
  }

  function updateStatus() {
    const el = $('#status');
    const n = pending.length;
    el.classList.remove('syncing', 'offline');
    if (online === false) { el.classList.add('offline'); el.textContent = n ? `圏外 未送信${n}` : '圏外'; }
    else if (syncing && n) { el.classList.add('syncing'); el.textContent = '送信中'; }
    else if (n) { el.classList.add('syncing'); el.textContent = `未送信${n}`; }
    else el.textContent = lastOk ? hm(lastOk) : '接続中';
    el.setAttribute('aria-label', statusText());
  }

  function statusText() {
    const n = pending.length;
    if (online === false) return `通信できません。チェックはこの端末に保存され、電波が戻ると自動で送信します。${n ? `（未送信 ${n}件）` : ''}${lastOk ? ` 最終同期 ${hms(lastOk)}` : ''}`;
    if (n) return `未送信 ${n}件を送信しています…`;
    return lastOk ? `全員の画面と同期済み（${hms(lastOk)}）` : '接続しています…';
  }

  // ---------- 申し送り ----------
  function notesFor(g) { return effNotes().filter((n) => g === OVERVIEW || n.g === g); }
  function unreadCount(g) {
    const since = seen[g] || 0;
    return notesFor(g).filter((n) => n.t > since && n.n !== myName && !n.pend).length;
  }
  function updateBadge() {
    const n = unreadCount(tab);
    const b = $('#noteBadge');
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : n;
  }

  function renderNotes() {
    const ids = [OVERVIEW].concat(data.groups.map((g) => g.id));
    $('#noteTabs').innerHTML = ids.map((id) =>
      `<button type="button" class="note-tab" role="tab" data-ntab="${esc(id)}" aria-selected="${id === noteTab}">${id === OVERVIEW ? 'すべて' : esc(id)}</button>`).join('');
    $('#composeTo').textContent = noteTab === OVERVIEW ? '宛先：全体' : `宛先：${noteTab}`;
    const since = seen[noteTab] || 0;
    const list = notesFor(noteTab);
    $('#noteList').innerHTML = list.length ? list.map((n) => `
      <article class="note ${n.t > since && n.n !== myName && !n.pend ? 'unread' : ''}">
        <div class="note-h"><span class="g-chip">${esc(n.g)}</span><b>${esc(n.n)}</b><time>${esc(dhm(n.t))}</time>
          ${n.pend ? '<span class="pend">未送信</span>' : ''}
          ${myNotes.has(n.nid) ? `<button type="button" class="del" data-del="${esc(n.nid)}">削除</button>` : ''}</div>
        <p>${esc(n.text)}</p>
      </article>`).join('') : `<p class="empty">まだ申し送りはありません</p>`;
  }

  function openNotes() {
    noteTab = tab;
    renderNotes();
    $('#notes').hidden = false;
    history.pushState({ notes: 1 }, '');
  }
  function closeNotes(fromPop) {
    if ($('#notes').hidden) return;
    seen[noteTab] = Date.now();
    if (noteTab === OVERVIEW) data.groups.forEach((g) => { seen[g.id] = Date.now(); });
    LS.set('seen', seen);
    $('#notes').hidden = true;
    updateBadge();
    if (!fromPop && history.state && history.state.notes) history.back();
  }

  // ---------- 操作 ----------
  function toggle(el) {
    const id = el.dataset.id;
    const done = !effChecks()[id];
    // 送信前の同じ項目の操作は、最後の1つだけ残す
    pending = pending.filter((o) => !(o.type === 'check' && o.id === id && !inflight.has(o.opId)));
    pending.push({ type: 'check', opId: uid(), id, done, name: myName, ts: Date.now() });
    savePending();
    if (onlyTodo && done) {
      el.classList.add('keep');
      const row = el.closest('.row');
      if (row) row.classList.add('keep');
      setTimeout(() => { el.classList.remove('keep'); if (row) row.classList.remove('keep'); }, 1600);
    }
    if (navigator.vibrate) navigator.vibrate(12);
    refreshChecks();
    updateStatus();
    scheduleSync(300);
  }

  function postNote(text) {
    const nid = uid();
    pending.push({ type: 'note', opId: uid(), nid, group: noteTab, text, name: myName, ts: Date.now() });
    savePending();
    myNotes.add(nid);
    LS.set('myNotes', [...myNotes]);
    renderNotes();
    updateStatus();
    scheduleSync(200);
  }

  function deleteNote(nid) {
    if (!confirm('この申し送りを削除しますか？')) return;
    const wasPending = pending.some((o) => o.type === 'note' && o.nid === nid && !inflight.has(o.opId));
    if (wasPending) pending = pending.filter((o) => !(o.type === 'note' && o.nid === nid));
    else pending.push({ type: 'delnote', opId: uid(), nid, name: myName, ts: Date.now() });
    savePending();
    renderNotes();
    scheduleSync(200);
  }

  async function exportCsv() {
    const btn = $('#exportCsv');
    btn.disabled = true;
    try {
      const res = await api({ action: 'export', pass });
      if (!res.ok || !res.csv) throw new Error(res.error);
      const p = parts(Date.now());
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([res.csv], { type: 'text/csv' }));
      a.download = `くんち職務記録_${p.month}月${p.day}日${p.hour}時${p.minute}分.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) {
      toast('記録を取得できませんでした。電波の良い場所でもう一度お試しください');
    } finally {
      btn.disabled = false;
    }
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3200);
  }

  // ---------- 合言葉・名前 ----------
  let modalHandler = null;
  function modal({ title, desc, value, placeholder, button, type, cancel, onSubmit }) {
    $('#modalTitle').textContent = title;
    $('#modalDesc').textContent = desc || '';
    const inp = $('#modalInput');
    inp.value = value || '';
    inp.placeholder = placeholder || '';
    inp.type = type || 'text';
    $('#modalBtn').textContent = button;
    $('#modalBtn').disabled = false;
    $('#modalErr').textContent = '';
    $('#modalCancel').hidden = !cancel;
    modalHandler = onSubmit;
    $('#modal').hidden = false;
    setTimeout(() => inp.focus(), 50);
  }
  const closeModal = () => { $('#modal').hidden = true; modalHandler = null; };

  function askPass(msg) {
    modal({
      title: '合言葉を入力',
      desc: msg || '職員用のページです。\n事務所から伝えられた合言葉を入力してください。',
      placeholder: '合言葉',
      button: '次へ',
      onSubmit: async (v) => {
        const p = norm(v).toLowerCase();
        if (!p) return '合言葉を入力してください';
        $('#modalBtn').disabled = true;
        try {
          const res = await api({ action: 'data', pass: p });
          if (!res.ok) return res.error === 'auth' ? '合言葉が違います' : 'エラーが発生しました。もう一度お試しください';
          pass = p; LS.set('pass', p);
          if (!data || data.meta.hash !== res.data.meta.hash) timelines = {};
          data = res.data; LS.set('data', data);
          if (!myName) { askName(true); return null; }
          closeModal();
          if (!myGroup || !groupById(myGroup)) { askGroup(true); return null; }
          start();
          return null;
        } catch (e) {
          return '通信できませんでした。電波の良い場所でもう一度お試しください';
        } finally {
          $('#modalBtn').disabled = false;
        }
      },
    });
  }

  function askName(first) {
    modal({
      title: first ? 'お名前を入力' : '名前の変更',
      desc: first ? 'チェックや申し送りに表示されます。\n（例：植木）' : '名前を変えない場合はそのまま「保存」。\n次の画面で班も変更できます。',
      value: myName,
      placeholder: '名前',
      button: first ? 'はじめる' : '保存',
      cancel: !first,
      onSubmit: (v) => {
        const n = norm(v).slice(0, 20);
        if (!n) return '名前を入力してください';
        myName = n; LS.set('name', n);
        closeModal();
        renderWho();
        updateBadge();
        askGroup(first || !myGroup || !groupById(myGroup));
        return null;
      },
    });
  }

  // ---------- 自分の班 ----------
  // 宿直者はどちらも2班から出るので、取り違えないよう説明と確認をはさむ
  const GROUP_HELP = {
    '1班': '1班の人',
    '2班': '2班の人（宿直に当たっていない人）',
    '7日宿直者': '2班のうち、10月7日の夜に神社で宿直する人',
    '8日宿直者': '2班のうち、10月8日の夜に神社で宿直する人',
  };
  const groupLabel = (id) => (/宿直/.test(id) ? `${id}（2班）` : id);
  const renderWho = () => { $('#who').textContent = myName ? `${myName}・${myGroup || '班未設定'}` : '名前を設定'; };

  function askGroup(first) {
    const box = $('#groupPick');
    const list = $('#groupStep');
    const confirmBox = $('#groupConfirm');
    $('#groupList').innerHTML = data.groups.map((g) =>
      `<button type="button" class="g-pick ${g.id === myGroup ? 'current' : ''}" data-pick="${esc(g.id)}">
        <b>${esc(groupLabel(g.id))}</b><span>${esc(GROUP_HELP[g.id] || g.subtitle || '')}</span></button>`).join('');
    list.hidden = false;
    confirmBox.hidden = true;
    $('#groupCancel').hidden = first || !myGroup;
    box.hidden = false;
    box.onclick = (e) => {
      const pick = e.target.closest('[data-pick]');
      if (pick) {
        const id = pick.dataset.pick;
        $('#groupConfirmName').textContent = groupLabel(id);
        $('#groupConfirmHelp').textContent = GROUP_HELP[id] || '';
        const f0 = groupById(id).days.flatMap((d) => d.rows.map((r) => ({ d, r })))[0];
        $('#groupConfirmFirst').textContent = f0 ? `最初の予定：${f0.d.label} ${String(f0.r.time).replace(/\n/g, '')}　${f0.r.items.map((i) => i.text).join(' ／ ')}` : '';
        $('#groupOk').dataset.id = id;
        list.hidden = true;
        confirmBox.hidden = false;
        return;
      }
      if (e.target.closest('#groupBack')) { list.hidden = false; confirmBox.hidden = true; return; }
      if (e.target.closest('#groupCancel')) { box.hidden = true; return; }
      const ok = e.target.closest('#groupOk');
      if (ok) {
        myGroup = ok.dataset.id; LS.set('group', myGroup);
        tab = myGroup; LS.set('tab', tab);
        box.hidden = true;
        if (!started) start(); else renderAll(true);
        toast(`${groupLabel(myGroup)}の予定を表示しています`, 2400);
      }
    };
  }

  // ---------- 起動 ----------
  function start() {
    if (started) return;
    started = true;
    renderAll(true);
    sync();
    setInterval(updateNow, 20000);
    if ('ResizeObserver' in window) new ResizeObserver(measure).observe($('#bar'));
    window.addEventListener('resize', measure);
  }

  function bind() {
    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b || b.dataset.tab === tab) return;
      tab = b.dataset.tab; LS.set('tab', tab);
      renderAll(true);
    });
    $('#main').addEventListener('click', (e) => {
      const it = e.target.closest('.item');
      if (it) return toggle(it);
      const g = e.target.closest('[data-tab]');
      if (g) { tab = g.dataset.tab; LS.set('tab', tab); renderAll(true); }
    });
    $('#now').addEventListener('click', () => scrollToNow(true));
    $('#goNow').addEventListener('click', () => { updateNow(); scrollToNow(true); });
    $('#todo').addEventListener('click', () => {
      onlyTodo = !onlyTodo; LS.set('onlyTodo', onlyTodo);
      document.body.classList.toggle('todo', onlyTodo);
      $('#todo').setAttribute('aria-pressed', String(onlyTodo));
      toast(onlyTodo ? '未完了の項目だけを表示しています' : 'すべての項目を表示しています', 1800);
    });
    $('#status').addEventListener('click', () => { toast(statusText(), 4000); sync(); });
    $('#who').addEventListener('click', () => askName(false));
    $('#openNotes').addEventListener('click', openNotes);
    $('#closeNotes').addEventListener('click', () => closeNotes(false));
    window.addEventListener('popstate', () => closeNotes(true));
    $('#noteTabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ntab]');
      if (!b) return;
      seen[noteTab] = Date.now(); LS.set('seen', seen);
      noteTab = b.dataset.ntab;
      renderNotes();
    });
    $('#noteList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-del]');
      if (b) deleteNote(b.dataset.del);
    });
    $('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      const ta = $('#noteText');
      const text = ta.value.trim();
      if (!text) return;
      postNote(text);
      ta.value = '';
      ta.blur();
      toast(online === false ? '圏外のため端末に保存しました。電波が戻ると送信します' : '投稿しました', 2400);
    });
    $('#modalForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!modalHandler) return;
      const err = await modalHandler($('#modalInput').value);
      if (err) $('#modalErr').textContent = err;
    });
    $('#modalCancel').addEventListener('click', closeModal);
    $('#exportCsv').addEventListener('click', exportCsv);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { updateNow(); sync(); } else scheduleSync();
    });
    window.addEventListener('online', () => sync());
    window.addEventListener('offline', () => { online = false; updateStatus(); });
  }

  function registerSW() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  bind();
  registerSW();
  updateStatus();
  if (!pass || !data) askPass();
  else if (!myName) askName(true);
  else if (!myGroup || !groupById(myGroup)) askGroup(true);
  else start();

  // 開発時の確認用
  window.__kunchi = {
    buildTimeline: (t) => timelineFor(t || tab), whereNow, sync,
    get pending() { return pending; },
    get net() { return { online, fails, syncing, lastOk }; },
  };
})();
