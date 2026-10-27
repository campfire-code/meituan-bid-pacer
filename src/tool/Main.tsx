// 主界面：左边登录 / 读取 / 设置，右边今日进度、出价建议、每小时计划。默认只给建议，自动保存出价需要在设置里手动打开。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Eye, EyeOff, Gauge, LogIn, LogOut, RefreshCw, ShieldAlert } from 'lucide-react';
import type { CustomTool } from '../kit/types';
import { pickFolder, settingsStore } from '../kit/platform';
import {
  DEFAULT_AUTO, expectedSpend, hourlyBidGuide, judgeRollback, ledgerKey, minuteOfDay, newLedger, parseBusinessHours, parseExposureText,
  parseHours, planBudget, reconcilePending, recordChange, toCents, weekdayOf, yuan,
  type AppliedChange, type AutoSettings, type HourMapping, type Ledger, type Plan, type Snapshot, type Suggestion,
} from './core';
import { curveFromTooltips, mergeRange, normalizeSnapshot, planCsv, tick } from './flow';
import { DEMO_BUDGET_YUAN, DEMO_EXPOSURE, DEMO_HOURS, DEMO_NOW, DEMO_STORE } from './demo';
import './tool.css';

type Ctx = Parameters<CustomTool['Main']>[0]['ctx'];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isPreview = typeof location !== 'undefined' && location.pathname.endsWith('preview.html');
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const pad = (n: number) => String(n).padStart(2, '0');
const WATCH_MS = 45_000;

interface Form {
  budget: string; hours: string; exposure: string; minBid: string; maxBid: string;
  ceiling: string; maxStep: string; maxDaily: string;
  mSpend: string; mBid: string; mMin: string; mMax: string;
}
const EMPTY: Form = { budget: '', hours: '09:00-21:00', exposure: '', minBid: '', maxBid: '', ceiling: '', maxStep: '0.10', maxDaily: '6', mSpend: '', mBid: '', mMin: '', mMax: '' };
const DEMO: Form = { ...EMPTY, budget: DEMO_BUDGET_YUAN, hours: DEMO_HOURS, exposure: DEMO_EXPOSURE.join(','), ceiling: '2.00' };

function demoSnapshot(): Snapshot {
  const exp = expectedSpend(planBudget(20000, DEMO_EXPOSURE, parseHours(DEMO_HOURS)), minuteOfDay(DEMO_NOW));
  return { storeId: 'demo', planId: 'demo', day: '2026-10-27', capturedAt: DEMO_NOW - 3000, spend: exp - 3000, bid: 100, platformBudget: 20000, minBid: 10, maxBid: 400, bidStep: 10, status: 'running', scope: '午市时段（示例）', blocker: null };
}

export function Main({ ctx }: { ctx?: Ctx }) {
  const [form, setForm] = useState<Form>(isPreview ? DEMO : EMPTY);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(isPreview ? demoSnapshot() : null);
  const [ledgers, setLedgers] = useState<Record<string, Ledger>>({});
  const [lastChange, setLastChange] = useState<AppliedChange | null>(null);
  const [auto, setAuto] = useState<AutoSettings>(DEFAULT_AUTO);
  const [mapping, setMapping] = useState<HourMapping>(null);
  const [needMapping, setNeedMapping] = useState<string[] | null>(null);
  const [watching, setWatching] = useState(false);
  const [now, setNow] = useState(isPreview ? DEMO_NOW : Date.now());
  const [log, setLog] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [askAuto, setAskAuto] = useState(false);
  const [agree, setAgree] = useState(false);
  const [observed, setObserved] = useState('');
  const loaded = useRef(false);

  const clock = useCallback(() => (isPreview ? DEMO_NOW : Date.now()), []);
  const say = useCallback((t: string) => setLog((l) => [`${pad(new Date().getHours())}:${pad(new Date().getMinutes())}:${pad(new Date().getSeconds())}  ${t}`, ...l].slice(0, 40)), []);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // 读取与保存设置（自动调价的开关不保存，重启后一律是关闭）
  useEffect(() => {
    if (isPreview || !inTauri) { loaded.current = true; return; }
    settingsStore().then(async (s) => {
      const f = await s.get<Form>('bp.form');
      const m = await s.get<HourMapping>('bp.mapping');
      const l = await s.get<Record<string, Ledger>>('bp.ledgers');
      if (f) setForm({ ...EMPTY, ...f });
      if (m) setMapping(m);
      if (l) setLedgers(l);
      loaded.current = true;
    }).catch(() => { loaded.current = true; });
  }, []);
  useEffect(() => {
    if (isPreview || !inTauri || !loaded.current) return;
    settingsStore().then((s) => { s.set('bp.form', form); s.set('bp.mapping', mapping); s.set('bp.ledgers', ledgers); }).catch(() => {});
  }, [form, mapping, ledgers]);

  // 自动调价参数 ← 表单
  const autoCfg: AutoSettings = useMemo(() => ({
    ...auto,
    ceiling: toCents(form.ceiling),
    maxStep: Math.min(100, Math.max(10, toCents(form.maxStep) ?? 10)),
    maxDaily: Math.min(48, Math.max(1, Math.floor(Number(form.maxDaily)) || 6)),
  }), [auto, form.ceiling, form.maxStep, form.maxDaily]);

  // 分时预算
  const planRes = useMemo<{ plan: Plan | null; err: string }>(() => {
    if (!form.budget.trim() && !form.exposure.trim()) return { plan: null, err: '' };
    try {
      const b = toCents(form.budget);
      if (b == null || b <= 0) throw new Error('请填写日预算（元），要和美团后台设置的一致');
      const ex = parseExposureText(form.exposure);
      return { plan: planBudget(b, ex, parseHours(form.hours)), err: '' };
    } catch (e) { return { plan: null, err: errText(e) }; }
  }, [form.budget, form.hours, form.exposure]);
  const plan = planRes.plan;

  // 手动填写的页面数据优先于读取到的
  const effective = useMemo<Snapshot | null>(() => {
    const spend = toCents(form.mSpend), bid = toCents(form.mBid), mn = toCents(form.mMin), mx = toCents(form.mMax);
    const manual = [spend, bid, mn, mx].some((v) => v != null);
    if (!manual) return snapshot;
    const base = snapshot ?? { storeId: 'manual', planId: 'manual', day: '', capturedAt: now, spend: null, bid: null, platformBudget: toCents(form.budget), minBid: null, maxBid: null, bidStep: 10, status: 'running' as const, scope: '', blocker: null };
    return { ...base, day: base.day || new Date(now + 8 * 3600_000).toISOString().slice(0, 10), capturedAt: snapshot ? base.capturedAt : now, spend: spend ?? base.spend, bid: bid ?? base.bid, minBid: mn ?? base.minBid, maxBid: mx ?? base.maxBid, platformBudget: base.platformBudget ?? toCents(form.budget), status: 'running' };
  }, [snapshot, form.mSpend, form.mBid, form.mMin, form.mMax, form.budget, now]);

  const limits = useMemo(() => ({ minBid: toCents(form.minBid) ?? undefined, maxBid: toCents(form.maxBid) ?? undefined }), [form.minBid, form.maxBid]);
  const key = effective ? ledgerKey(effective) : '';
  const ledger = key ? ledgers[key] ?? newLedger(effective!.day) : null;
  const result = useMemo(() => tick({ plan, snapshot: effective, ledger, now, limits, autoCfg }), [plan, effective, ledger, now, limits, autoCfg]);
  const sug = result.suggestion;
  const expectedNow = useMemo(() => { try { return plan ? expectedSpend(plan, minuteOfDay(now)) : null; } catch { return null; } }, [plan, now]);
  const guide = useMemo(() => {
    if (!plan) return null;
    const s = effective;
    const range = s?.minBid != null && s?.maxBid != null ? { minBid: s.minBid, maxBid: s.maxBid, step: 10 } : null;
    try { return range ? hourlyBidGuide(plan, range, { ...limits, maxBid: autoCfg.ceiling != null ? Math.min(limits.maxBid ?? autoCfg.ceiling, autoCfg.ceiling) : limits.maxBid }) : null; } catch { return null; }
  }, [plan, effective, limits, autoCfg.ceiling]);
  const rollback = useMemo(() => (lastChange && effective && plan ? judgeRollback({ change: lastChange, snapshot: effective, plan, now }) : null), [lastChange, effective, plan, now]);

  // ---------- 与商家后台窗口通信 ----------
  const ref = useRef({ effective, ledgers, key, plan, mapping, autoCfg, limits, watching, sug, result });
  ref.current = { effective, ledgers, key, plan, mapping, autoCfg, limits, watching, sug, result };
  const applying = useRef<{ s: Suggestion; key: string; day: string; gap: number } | null>(null);

  const call = useCallback(async (cmd: string, args?: Record<string, unknown>) => {
    if (!inTauri) { setNotice({ kind: 'err', text: '预览模式下不能打开美团窗口' }); return false; }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke(cmd, args);
      return true;
    } catch (e) {
      setBusy(false);
      setNotice({ kind: 'err', text: errText(e) });
      return false;
    }
  }, []);

  const apply = useCallback(async (s: Suggestion, who: string) => {
    const cur = ref.current;
    const e = cur.effective;
    if (!e || !cur.key || (s.action !== 'increase' && s.action !== 'decrease') || s.before == null || s.after == null) return;
    if (applying.current) { setNotice({ kind: 'err', text: '上一次修改还在确认中，请稍候' }); return; }
    if (e.bid !== s.before) { setNotice({ kind: 'err', text: '页面出价已变化，请重新读取后再应用' }); return; }
    const k = cur.key;
    const l = cur.ledgers[k] ?? newLedger(e.day);
    let gap = 0;
    try { gap = (e.spend ?? 0) - (cur.plan ? expectedSpend(cur.plan, minuteOfDay(clock())) : 0); } catch { /* 记 0 */ }
    // 先把意图写进记录，再去点保存；中途崩溃会留下「待核对」，不会重复提交
    setLedgers((m) => ({ ...m, [k]: { ...l, pending: { action: s.action as 'increase' | 'decrease', before: s.before!, after: s.after!, at: clock(), scope: e.scope } } }));
    applying.current = { s, key: k, day: e.day, gap };
    say(`${who}：出价 ${yuan(s.before)} → ${yuan(s.after)} 元，正在点保存`);
    const ok = await call('mt_apply', { before: s.before, target: s.after, maxStep: cur.autoCfg.maxStep, scope: e.scope ?? '' });
    if (!ok) { applying.current = null; setLedgers((m) => ({ ...m, [k]: { ...l, pending: null } })); }
  }, [call, clock, say]);

  const readNow = useCallback(() => call('mt_read', { name: 'read' }), [call]);

  useEffect(() => {
    if (!inTauri) return;
    let offs: (() => void)[] = [];
    let dead = false;
    import('@tauri-apps/api/event').then(async ({ listen }) => {
      const a = await listen<unknown>('mt-snapshot', (e) => {
        const t = clock();
        const n = normalizeSnapshot(e.payload, t);
        if (!n) return;
        const merged = mergeRange(ref.current.effective && ref.current.effective.storeId === n.storeId ? ref.current.effective : null, n);
        setSnapshot(merged);
        setNow(t);
        const ap = applying.current;
        if (ap) {
          const l = ref.current.ledgers[ap.key];
          if (l?.pending) {
            const r = reconcilePending(l.pending, merged, t);
            if (r.result === 'applied') {
              applying.current = null;
              setLedgers((m) => ({ ...m, [ap.key]: recordChange(m[ap.key] ?? newLedger(ap.day), { action: l.pending!.action, before: l.pending!.before, after: l.pending!.after, at: l.pending!.at }) }));
              setLastChange({ action: l.pending.action, before: l.pending.before, after: l.pending.after, at: t, gapAtChange: ap.gap });
              say(`回读确认：出价已是 ${yuan(merged.bid)} 元`);
              setNotice({ kind: 'ok', text: `出价已改为 ${yuan(merged.bid)} 元（已回读确认）` });
            } else if (r.result === 'not-applied') {
              applying.current = null;
              setLedgers((m) => ({ ...m, [ap.key]: { ...(m[ap.key] ?? newLedger(ap.day)), pending: null } }));
              say(`回读仍是原出价 ${yuan(merged.bid)} 元，视为未生效`);
              setNotice({ kind: 'err', text: '回读仍是原出价，这次修改没有生效' });
            } else { say(`待核对：${r.reason}`); }
          }
        }
      });
      const b = await listen<{ ok: boolean; msg: string; submitted?: boolean }>('mt-apply', (e) => {
        const p = e.payload;
        say(p.msg);
        if (p.ok) { setBusy(false); return; }
        const ap = applying.current;
        if (ap && !p.submitted) {
          applying.current = null;
          setLedgers((m) => ({ ...m, [ap.key]: { ...(m[ap.key] ?? newLedger(ap.day)), pending: null } }));
        }
        setNotice({ kind: 'err', text: p.submitted ? `${p.msg}。已点过保存，请到后台核对当前出价后在下方确认。` : p.msg });
      });
      const c = await listen<{ tooltips: string[] }>('mt-tooltips', (e) => {
        setBusy(false);
        const list = Array.isArray(e.payload?.tooltips) ? e.payload.tooltips.filter((x) => typeof x === 'string').slice(0, 400) : [];
        const r = curveFromTooltips(list, ref.current.mapping);
        if (r.ok) {
          setForm((f) => ({ ...f, exposure: r.values.join(',') }));
          setNeedMapping(null);
          say('已读到昨日 24 小时曝光');
          setNotice({ kind: 'ok', text: '已读到昨日 24 小时曝光，请对照后台图表核对几个小时' });
        } else if (r.ambiguous) {
          setNeedMapping(list);
          setNotice({ kind: 'err', text: r.reason });
        } else {
          setNotice({ kind: 'err', text: `${r.reason}。可以改用「手动粘贴曝光」。` });
        }
      });
      const d = await listen<{ text: string }>('mt-text', (e) => {
        setBusy(false);
        try {
          const iv = parseBusinessHours(String(e.payload?.text ?? ''), weekdayOf(clock()));
          const txt = iv.map(([s, t]) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}-${pad(Math.floor(t / 60) % 24 || (t === 1440 ? 24 : 0))}:${pad(t % 60)}`).join('，');
          setForm((f) => ({ ...f, hours: txt }));
          say(`读到营业时间：${txt}`);
          setNotice({ kind: 'ok', text: `读到今天的营业时间 ${txt}，请核对` });
        } catch (er) { setNotice({ kind: 'err', text: errText(er) }); }
      });
      const f = await listen<{ step: string }>('mt-status', (e) => { if (e.payload?.step === 'injected') say('已连上美团窗口'); });
      if (dead) [a, b, c, d, f].forEach((x) => x()); else offs = [a, b, c, d, f];
    }).catch(() => {});
    return () => { dead = true; offs.forEach((x) => x()); };
  }, [clock, say]);

  // 盯盘：只读，每 45 秒读一次点金页，并刷新「现在」
  useEffect(() => {
    if (isPreview) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!watching) return;
    readNow();
    const t = setInterval(readNow, WATCH_MS);
    return () => clearInterval(t);
  }, [watching, readNow]);

  // 自动调价：盯盘中、已打开、通过全部保护才执行；每次新数据到来评估一次
  useEffect(() => {
    const c = ref.current;
    if (!c.watching || !auto.enabled || !auto.confirmed || applying.current) return;
    const r = c.result;
    if (r.auto.ok) apply(r.suggestion, '自动调价');
    else if (rollback?.rollback && rollback.target != null && effective?.bid != null && lastChange) {
      const back: Suggestion = { action: rollback.target > effective.bid ? 'increase' : 'decrease', reason: rollback.reason, before: effective.bid, after: rollback.target, expected: null, actual: effective.spend };
      if (Math.abs(back.after! - back.before!) <= autoCfg.maxStep) apply(back, '自动回滚');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  // ---------- 动作 ----------
  const confirmPending = () => {
    const v = toCents(observed);
    const l = ledger;
    if (!l?.pending || v == null || v <= 0) { setNotice({ kind: 'err', text: '请填写你在美团后台看到的当前出价（元）' }); return; }
    const p = l.pending;
    setLedgers((m) => ({ ...m, [key]: v === p.after ? recordChange(l, p) : { ...l, pending: null } }));
    applying.current = null;
    say(v === p.after ? '人工核对：上次修改已生效' : '人工核对：上次修改未生效，按未改处理');
    setObserved('');
  };
  const manualApply = (s: Suggestion) => apply(s, '手动应用');
  const doExport = async () => {
    if (!ctx || !plan) return;
    try {
      const dir = await pickFolder();
      if (!dir) return;
      const e = effective;
      const range = e?.minBid != null && e?.maxBid != null ? { minBid: e.minBid, maxBid: e.maxBid, step: 10 } : null;
      const path = await ctx.join(dir, '点金每小时计划.csv');
      await ctx.writeText(path, planCsv(plan, range, limits));
      setNotice({ kind: 'ok', text: `已导出：${path}` });
    } catch (er) { setNotice({ kind: 'err', text: `导出失败：${errText(er)}` }); }
  };
  const turnAuto = (on: boolean) => {
    if (!on) { setAuto((a) => ({ ...a, enabled: false, confirmed: false })); say('自动调价已关闭'); return; }
    if (autoCfg.ceiling == null || autoCfg.ceiling <= 0) { setNotice({ kind: 'err', text: '打开自动调价前，请先在设置里填写「最高出价上限」' }); return; }
    setAgree(false); setAskAuto(true);
  };

  const day = effective?.day;
  const hourNow = Math.floor(minuteOfDay(now) / 60);
  const maxB = plan ? Math.max(1, ...plan.budgets) : 1;
  const sugTone = sug.action === 'increase' ? 'up' : sug.action === 'decrease' ? 'down' : sug.action === 'blocked' ? 'blocked' : '';
  const sugTitle = sug.action === 'increase' ? `建议加价：${yuan(sug.before)} → ${yuan(sug.after)} 元` : sug.action === 'decrease' ? `建议降价：${yuan(sug.before)} → ${yuan(sug.after)} 元` : sug.action === 'hold' ? `建议保持：${yuan(sug.before)} 元` : '暂时不给建议';
  const ageS = effective ? Math.max(0, Math.round((now - effective.capturedAt) / 1000)) : null;

  return (
    <div className="bp-root">
      <aside className="k-panel bp-side k-scroll">
        <section className="bp-sec">
          <b>1. 登录美团商家后台</b>
          <p className="k-muted bp-p">在应用自带的窗口里登录，进入「门店推广 → 点金」。登录状态只保存在本应用里，不读取你的浏览器，也不读取密码和 Cookie。</p>
          <div className="bp-btns">
            <button className="k-btn primary" onClick={() => call('open_meituan')}><LogIn size={14} />打开美团窗口</button>
            <button className="k-btn ghost" title="清除本应用里保存的美团登录状态" onClick={() => call('clear_meituan_login')}><LogOut size={14} />退出登录</button>
          </div>
        </section>
        <section className="bp-sec">
          <b>2. 读点金页面</b>
          <div className="bp-btns">
            <button className="k-btn primary" onClick={readNow}><RefreshCw size={14} />读取一次</button>
            <button className={`k-btn ${watching ? 'primary' : ''}`} onClick={() => setWatching((w) => !w)}>{watching ? <EyeOff size={14} /> : <Eye size={14} />}{watching ? '停止盯盘' : '开始盯盘'}</button>
          </div>
          <small className="k-muted">盯盘只读：每 45 秒读一次今日花费、当前出价和出价范围。出价范围要打开一次「推广出价」弹窗才读得到，也可以在下面手动填写。</small>
          <div className="bp-got" aria-live="polite">
            <span className={effective?.spend != null ? 'ok' : ''}>花费 {effective?.spend != null ? `${yuan(effective.spend)} 元` : '未读到'}</span>
            <span className={effective?.bid != null ? 'ok' : ''}>出价 {effective?.bid != null ? `${yuan(effective.bid)} 元` : '未读到'}</span>
            <span className={effective?.minBid != null && effective?.maxBid != null ? 'ok' : ''}>范围 {effective?.minBid != null && effective?.maxBid != null ? `${yuan(effective.minBid)}–${yuan(effective.maxBid)}` : '未读到'}</span>
          </div>
        </section>
        <section className="bp-sec">
          <b>3. 今天的预算</b>
          <label className="bp-row"><span>日预算</span><input className="k-input bp-num" inputMode="decimal" placeholder="与后台一致" value={form.budget} onChange={set('budget')} /><span>元</span></label>
          <label className="bp-row"><span>营业时间</span><input className="k-input" value={form.hours} onChange={set('hours')} placeholder="09:00-21:00，22:00-02:00" /></label>
          <div className="bp-btns"><button className="k-btn" onClick={() => call('mt_read', { name: 'text' }).then((o) => { if (o) { setBusy(true); say('请求读取营业时间（需停在「门店管理」的营业时间页）'); } })}>从页面读营业时间</button></div>
          <b className="bp-p">昨日分时曝光</b>
          <div className="bp-btns"><button className="k-btn" onClick={() => call('mt_read', { name: 'curve' }).then((o) => { if (o) { setBusy(true); say('请求读取曝光图表（需停在「经营数据 → 流量」昨日曝光人数图）'); } })}>从图表读取</button></div>
          {needMapping && (
            <div className="k-notice err" role="alert">
              <span>图表横轴是 1–24 的编号，请确认「1」表示：</span>
              <button className="k-btn" onClick={() => { setMapping('end'); const r = curveFromTooltips(needMapping, 'end'); if (r.ok) { setForm((f) => ({ ...f, exposure: r.values.join(',') })); setNeedMapping(null); } else setNotice({ kind: 'err', text: r.reason }); }}>00:00–01:00</button>
              <button className="k-btn" onClick={() => { setMapping('start'); const r = curveFromTooltips(needMapping, 'start'); if (r.ok) { setForm((f) => ({ ...f, exposure: r.values.join(',') })); setNeedMapping(null); } else setNotice({ kind: 'err', text: r.reason }); }}>01:00–02:00</button>
            </div>
          )}
          <textarea className="k-input bp-ta" placeholder="或手动粘贴：0–23 点共 24 个数字，用逗号 / 空格 / 换行分隔；也可每行「9:00 1234」" value={form.exposure} onChange={set('exposure')} />
          {planRes.err && <small className="bp-warn">{planRes.err}</small>}
        </section>
        <section className="bp-sec">
          <details className="bp-details">
            <summary>手动填写页面数据（读不到时用）</summary>
            <div className="bp-sec">
              <label className="bp-row"><span>今日花费</span><input className="k-input bp-num" inputMode="decimal" value={form.mSpend} onChange={set('mSpend')} /><span>元</span></label>
              <label className="bp-row"><span>当前出价</span><input className="k-input bp-num" inputMode="decimal" value={form.mBid} onChange={set('mBid')} /><span>元</span></label>
              <label className="bp-row"><span>出价下限</span><input className="k-input bp-num" inputMode="decimal" value={form.mMin} onChange={set('mMin')} /><span>元</span></label>
              <label className="bp-row"><span>出价上限</span><input className="k-input bp-num" inputMode="decimal" value={form.mMax} onChange={set('mMax')} /><span>元</span></label>
              <small className="k-muted">填了任何一项，就以你填的为准。</small>
            </div>
          </details>
        </section>
        <section className="bp-sec">
          <details className="bp-details" open={isPreview}>
            <summary>出价保护与自动调价</summary>
            <div className="bp-sec">
              <label className="bp-row"><span>最低出价</span><input className="k-input bp-num" inputMode="decimal" placeholder="不限" value={form.minBid} onChange={set('minBid')} /><span>元</span></label>
              <label className="bp-row"><span>最高出价上限</span><input className="k-input bp-num" inputMode="decimal" placeholder="自动调价必填" value={form.ceiling} onChange={set('ceiling')} /><span>元</span></label>
              <label className="bp-row"><span>单次最多改</span><input className="k-input bp-num" inputMode="decimal" value={form.maxStep} onChange={set('maxStep')} /><span>元</span></label>
              <label className="bp-row"><span>每天最多改</span><input className="k-input bp-num" inputMode="numeric" value={form.maxDaily} onChange={set('maxDaily')} /><span>次</span></label>
              <label className="k-toggle"><input type="checkbox" checked={auto.enabled && auto.confirmed} onChange={(e) => turnAuto(e.target.checked)} /><span>自动调价（默认关闭）</span></label>
              <small className="k-muted">关闭时只显示建议，由你手动改或点「应用这条建议」。打开后也只在盯盘期间运行，且受上面的上限、步长、次数保护；重启应用后会恢复为关闭。</small>
            </div>
          </details>
        </section>
        <section className="bp-sec">
          <button className="k-btn" disabled={!plan} onClick={doExport}><Download size={14} />导出每小时计划（CSV）</button>
        </section>
        {log.length > 0 && <section className="bp-sec"><b>记录</b><ul className="bp-log">{log.map((l, i) => <li key={i}>{l}</li>)}</ul></section>}
      </aside>

      <main className="bp-main k-scroll">
        {isPreview && <div className="bp-demo">示例：{DEMO_STORE}，门店与全部数字均为虚构，仅用于演示界面。</div>}
        {notice && <div className={`k-notice ${notice.kind}`} role="status"><span>{notice.text}</span></div>}
        {busy && !notice && <div className="k-notice ok"><span>已发出请求，等待页面返回……</span></div>}

        {ledger?.pending && (
          <section className="k-panel bp-card" role="alert">
            <h3 className="bp-warn"><ShieldAlert size={15} /> 上一次修改还没有核对</h3>
            <p className="bp-p">出价 {yuan(ledger.pending.before)} → {yuan(ledger.pending.after)} 元已提交，但还没读回确认。请到美团后台看当前出价，填在这里（核对前不会再提交新的修改）。</p>
            <div className="bp-row"><input className="k-input bp-num" inputMode="decimal" placeholder="当前出价" value={observed} onChange={(e) => setObserved(e.target.value)} /><span>元</span><button className="k-btn primary" onClick={confirmPending}>确认</button></div>
          </section>
        )}

        {!plan && !effective && (
          <div className="bp-empty k-muted">
            <Gauge size={30} />
            <p>还没有数据。按左边的步骤登录、读取页面，填好日预算、营业时间和昨日曝光。<br />只想先看看效果，可以在预览页里查看示例。</p>
          </div>
        )}

        {(plan || effective) && (
          <>
            <div className="bp-stats">
              <div><b className="k-num">{effective?.spend != null ? yuan(effective.spend) : '—'}</b><span>今日花费（元）</span></div>
              <div><b className="k-num">{expectedNow != null ? yuan(expectedNow) : '—'}</b><span>计划此刻应花（元）</span></div>
              <div><b className="k-num">{effective?.bid != null ? yuan(effective.bid) : '—'}</b><span>当前出价（元）</span></div>
              <div><b className="k-num">{effective?.minBid != null && effective?.maxBid != null ? `${yuan(effective.minBid)}–${yuan(effective.maxBid)}` : '—'}</b><span>平台出价范围（元）</span></div>
            </div>

            <div className={`bp-sug ${sugTone}`}>
              <div className="bp-sug-main">
                <b>{sugTitle}</b>
                <span>{sug.reason}</span>
                <span className="bp-auto">{auto.enabled && auto.confirmed ? (result.auto.ok ? '自动调价：下一轮会执行这一条' : `自动调价已打开，本条不会执行：${result.auto.reason}`) : '自动调价：关闭（只显示建议）'}{ageS != null && !isPreview ? ` · 数据 ${ageS} 秒前` : ''}</span>
              </div>
              {(sug.action === 'increase' || sug.action === 'decrease') && (
                <button className="k-btn primary big" disabled={!!ledger?.pending} onClick={() => manualApply(sug)}>应用这条建议</button>
              )}
            </div>
            {rollback?.rollback && lastChange && effective?.bid != null && (
              <div className="bp-sug down">
                <div className="bp-sug-main"><b>建议回滚</b><span>{rollback.reason}</span></div>
                <button className="k-btn" onClick={() => manualApply({ action: lastChange.before > effective.bid! ? 'increase' : 'decrease', reason: rollback.reason, before: effective.bid, after: lastChange.before, expected: null, actual: effective.spend })}>改回 {yuan(lastChange.before)} 元</button>
              </div>
            )}

            {plan && (
              <>
                <section className="k-panel bp-card">
                  <div className="bp-card-hd"><h3>每小时预算（元）</h3><span className="k-muted">{day ?? ''} · 当前 {pad(hourNow)}:00 一档</span></div>
                  <div className="bp-bars" role="img" aria-label="每小时预算分配">
                    {plan.budgets.map((b, h) => (
                      <div key={h} className={`bp-bar${h === hourNow ? ' now' : ''}`} title={`${pad(h)}:00  预算 ${yuan(b)} 元`}>
                        <div className="bp-bar-col" style={{ height: `${(b / maxB) * 100}%` }} />
                      </div>
                    ))}
                  </div>
                  <div className="bp-axis"><span>0 点</span><span>6 点</span><span>12 点</span><span>18 点</span><span>23 点</span></div>
                </section>
                <section className="k-panel bp-card">
                  <div className="bp-card-hd"><h3>每小时计划与参考出价</h3><small className="k-muted">参考出价是按预算占比估算的，不是平台承诺的效果；当前这一小时以上面的建议为准。</small></div>
                  <div className="bp-tablewrap">
                    <table className="k-table">
                      <thead><tr><th>时段</th><th>昨日曝光</th><th>预算（元）</th><th>参考出价（元）</th></tr></thead>
                      <tbody>
                        {plan.budgets.map((b, h) => {
                          const g = guide?.[h];
                          const open = g ? g.open : b > 0;
                          return (
                            <tr key={h} className={h === hourNow ? 'bp-now' : !open ? 'bp-off' : ''}>
                              <td className="k-num">{pad(h)}:00–{pad((h + 1) % 24)}:00{h === hourNow ? '（现在）' : ''}</td>
                              <td className="k-num">{plan.exposure[h]}</td>
                              <td className="k-num">{open ? yuan(b) : '休息'}</td>
                              <td className="k-num">{g?.bid != null ? yuan(g.bid) : open ? <span className="k-muted">需要出价范围</span> : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </main>

      {askAuto && (
        <div className="bp-modal" role="dialog" aria-modal="true" aria-label="打开自动调价">
          <div className="bp-dialog">
            <h3 className="bp-warn">打开自动调价前，请确认风险</h3>
            <ul>
              <li>打开后，应用会在盯盘期间<b>自动修改你的推广出价并点保存</b>，直接影响推广花费，改错的钱不会退回。</li>
              <li>美团后台改版后，自动点击可能点错或失效；应用会回读核对，但无法保证每次都成功。</li>
              <li>自动修改推广出价可能违反平台规则，账号处罚等后果由你自己承担。</li>
              <li>保护：单次最多改 {yuan(autoCfg.maxStep)} 元，每天最多 {autoCfg.maxDaily} 次，出价不会超过 {yuan(autoCfg.ceiling)} 元，加价后冷却 30 分钟。</li>
              <li>重启应用后会自动恢复为关闭。第一次建议先只看建议、手动应用几次，确认一切正常。</li>
            </ul>
            <label className="k-toggle"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>我已了解以上风险，愿意自己承担后果</span></label>
            <div className="bp-btns">
              <button className="k-btn ghost" onClick={() => setAskAuto(false)}>取消</button>
              <button className="k-btn primary" disabled={!agree} onClick={() => { setAuto((a) => ({ ...a, enabled: true, confirmed: true })); setAskAuto(false); say('自动调价已打开（受上限、步长、次数保护）'); if (!watching) setWatching(true); }}>打开自动调价</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
