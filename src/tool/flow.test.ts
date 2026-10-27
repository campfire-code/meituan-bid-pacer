import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTO, expectedSpend, newLedger, parseHours, planBudget } from './core';
import { afterApplied, curveFromTooltips, mergeRange, normalizeSnapshot, planCsv, tick } from './flow';

const NOW = Date.parse('2026-10-27T06:00:00Z');
const EXPO = [0, 0, 0, 0, 0, 0, 0, 0, 20, 60, 120, 400, 380, 150, 90, 80, 110, 300, 420, 260, 140, 60, 0, 0];
const plan = planBudget(20000, EXPO, parseHours('09:00-21:00'));
const raw = { storeId: 'S1', planId: 'P1', capturedAt: NOW - 1000, spend: 8000, bid: 100, platformBudget: 20000, minBid: 10, maxBid: 400, status: 'running', scope: '下午茶时段' };

describe('页面数据整理', () => {
  it('合格数据通过，日期用当前北京时间', () => {
    expect(normalizeSnapshot(raw, NOW)).toMatchObject({ day: '2026-10-27', spend: 8000, bid: 100, status: 'running' });
  });
  it('不合格的数字置空，不当成 0；状态乱写当作未知', () => {
    const s = normalizeSnapshot({ ...raw, spend: -5, bid: 1.5, minBid: '10', maxBid: NaN, status: 'hacked' }, NOW)!;
    expect(s).toMatchObject({ spend: null, bid: null, minBid: null, maxBid: null, status: 'unknown' });
    expect(normalizeSnapshot(null, NOW)).toBeNull();
    expect(normalizeSnapshot('x', NOW)).toBeNull();
  });
  it('出价弹窗里读到的范围并入快照', () => {
    const prev = normalizeSnapshot(raw, NOW)!;
    const next = normalizeSnapshot({ ...raw, minBid: undefined, maxBid: undefined, bid: 110 }, NOW)!;
    expect(mergeRange(prev, next)).toMatchObject({ bid: 110, minBid: 10, maxBid: 400 });
    expect(mergeRange(null, next)).toBe(next);
  });
});

describe('图表悬停提示到曝光', () => {
  const tips = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00 昨日 ${EXPO[h]}`);
  it('24 个小时齐全才成功', () => {
    const r = curveFromTooltips(tips, null);
    expect(r.ok && r.values).toEqual(EXPO);
    expect(curveFromTooltips(tips.slice(0, 20), null).ok).toBe(false);
    expect(curveFromTooltips([...tips, ...tips], null).ok).toBe(true); // 重复悬停不影响
    expect(curveFromTooltips(['乱七八糟', ''], null).ok).toBe(false);
  });
});

describe('每一轮：建议 + 自动保护', () => {
  const exp = expectedSpend(plan, 14 * 60);
  const snap = normalizeSnapshot({ ...raw, spend: exp - 3000 }, NOW)!;
  const base = { plan, snapshot: snap, ledger: newLedger('2026-10-27'), now: NOW, limits: {} };
  it('自动关闭时只给建议，不会自动执行', () => {
    const t = tick({ ...base, autoCfg: DEFAULT_AUTO });
    expect(t.suggestion).toMatchObject({ action: 'increase', after: 110 });
    expect(t.auto.ok).toBe(false);
  });
  it('自动打开且有上限：放行；上限低于建议价则建议被压住且不放行', () => {
    const on = { ...DEFAULT_AUTO, enabled: true, confirmed: true, ceiling: 200 };
    expect(tick({ ...base, autoCfg: on }).auto.ok).toBe(true);
    const low = tick({ ...base, autoCfg: { ...on, ceiling: 100 } });
    expect(low.suggestion.action).toBe('hold');
    expect(low.auto.ok).toBe(false);
  });
  it('每日次数用完不放行', () => {
    const on = { ...DEFAULT_AUTO, enabled: true, confirmed: true, ceiling: 200, maxDaily: 2 };
    const t = tick({ ...base, ledger: { ...newLedger('2026-10-27'), changesToday: 2 }, autoCfg: on });
    expect(t.suggestion.action).toBe('hold');
    expect(t.auto.ok).toBe(false);
  });
  it('确认生效后更新记录', () => {
    const t = tick({ ...base, autoCfg: DEFAULT_AUTO });
    const l = afterApplied(base.ledger, '2026-10-27', t.suggestion, NOW);
    expect(l).toMatchObject({ changesToday: 1, startBid: 100, direction: 'increase' });
    expect(() => afterApplied(null, '2026-10-27', { ...t.suggestion, action: 'hold' }, NOW)).toThrow();
  });
});

describe('导出', () => {
  it('每小时计划 CSV：24 行 + 表头，营业外参考出价为空', () => {
    const csv = planCsv(plan, { minBid: 10, maxBid: 400, step: 10 }, {});
    const lines = csv.replace('﻿', '').trim().split('\n');
    expect(lines).toHaveLength(25);
    expect(lines[1]).toBe('00:00-01:00,否,0,0.00,');
    expect(lines[12].split(',')[1]).toBe('是');
    expect(planCsv(plan, null, {}).split('\n')[13]).toContain('是');
  });
});
