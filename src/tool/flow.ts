// 流程：把注入脚本转交来的页面数据整理成快照，并把「建议 → 自动保护 → 记录」串起来。纯函数，不碰界面和网络。
import {
  canAutoApply, dateKey, hourlyBidGuide, mapHours, newLedger, parseTooltip, recordChange, suggest, yuan,
  type AutoSettings, type HourMapping, type Ledger, type Limits, type MapResult, type Plan, type Snapshot, type Suggestion, type TooltipEntry,
} from './core';

const isCents = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < 100_000_000;
const orNull = (v: unknown) => (isCents(v) ? v : null);

/** 页面脚本发来的数据不可信：逐项检查，不合格的置空（后面会因为「数据缺失」停下，而不是用错值） */
export function normalizeSnapshot(raw: unknown, now: number): Snapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, n = 80) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  const status = r.status === 'running' || r.status === 'paused' ? r.status : 'unknown';
  return {
    storeId: str(r.storeId),
    planId: str(r.planId),
    day: dateKey(now),
    capturedAt: typeof r.capturedAt === 'number' && Number.isFinite(r.capturedAt) ? r.capturedAt : now,
    spend: orNull(r.spend),
    bid: orNull(r.bid),
    platformBudget: orNull(r.platformBudget),
    minBid: orNull(r.minBid),
    maxBid: orNull(r.maxBid),
    // 步长：页面没有直接给，按平台惯例 0.10 元；与建议的步长不匹配时 suggest 会阻断
    bidStep: 10,
    status,
    scope: str(r.scope, 60) ?? '',
    blocker: str(r.blocker, 120),
  };
}

/** 把页面脚本读到的出价弹窗里的范围并入快照（弹窗打开时才有范围） */
export function mergeRange(prev: Snapshot | null, next: Snapshot): Snapshot {
  if (!prev) return next;
  return {
    ...next,
    minBid: next.minBid ?? prev.minBid,
    maxBid: next.maxBid ?? prev.maxBid,
    platformBudget: next.platformBudget ?? prev.platformBudget,
    scope: next.scope || prev.scope,
  };
}

/** 图表悬停提示 → 24 小时曝光。提示读不全就报错，不补零 */
export function curveFromTooltips(texts: string[], mapping: HourMapping): MapResult {
  const best = new Map<number, TooltipEntry>();
  for (const t of texts) {
    const e = parseTooltip(t);
    if (e && !best.has(e.hour)) best.set(e.hour, e);
  }
  return mapHours([...best.values()], mapping);
}

export interface Tick {
  suggestion: Suggestion;
  /** 自动调价是否会执行这一条 */
  auto: { ok: boolean; reason: string };
}

/** 每一轮：先出建议，再过自动调价的保护。自动保存关闭时 auto.ok 一定是 false */
export function tick(a: { plan: Plan | null; snapshot: Snapshot | null; ledger: Ledger | null; now: number; limits: Limits; autoCfg: AutoSettings }): Tick {
  const limits: Limits = { ...a.limits };
  if (a.autoCfg.ceiling != null) limits.maxBid = Math.min(limits.maxBid ?? a.autoCfg.ceiling, a.autoCfg.ceiling);
  const suggestion = suggest({ plan: a.plan, snapshot: a.snapshot, ledger: a.ledger, now: a.now, limits, policy: { step: a.autoCfg.maxStep, maxDailyChanges: Math.max(a.autoCfg.maxDaily, 1) } });
  return { suggestion, auto: canAutoApply(suggestion, a.ledger, a.autoCfg, a.now) };
}

/** 回读确认生效后更新记录 */
export function afterApplied(ledger: Ledger | null, day: string, s: Suggestion, now: number): Ledger {
  if ((s.action !== 'increase' && s.action !== 'decrease') || s.before == null || s.after == null) throw new Error('没有可记录的修改');
  return recordChange(ledger ?? newLedger(day), { action: s.action, before: s.before, after: s.after, at: now });
}

/** 导出每小时计划（CSV，带 BOM，Excel 直接打开） */
export function planCsv(p: Plan, range: { minBid: number; maxBid: number; step: number } | null, limits: Limits): string {
  const guide = range ? hourlyBidGuide(p, range, limits) : null;
  const rows = ['小时,是否营业,昨日曝光,预算(元),参考出价(元)'];
  for (let h = 0; h < 24; h++) {
    const g = guide?.[h];
    const open = g ? g.open : p.budgets[h] > 0;
    rows.push([`${String(h).padStart(2, '0')}:00-${String((h + 1) % 24).padStart(2, '0')}:00`, open ? '是' : '否', p.exposure[h], yuan(p.budgets[h]), g?.bid != null ? yuan(g.bid) : ''].join(','));
  }
  return '﻿' + rows.join('\n') + '\n';
}
