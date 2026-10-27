import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTO, allocate, canAutoApply, dateKey, editHour, expectedSpend, hourlyBidGuide, intervals, judgeRollback,
  ledgerKey, mapHours, minuteOfDay, missingFields, newLedger, parseExposureText, parseHours, parseTooltip, planBudget, recordChange,
  reconcilePending, suggest, parseBusinessHours, weekdayOf, toCents, type Ledger, type Plan, type Snapshot,
} from './core';

// 2026-10-27 14:00（北京时间）
const NOW = Date.parse('2026-10-27T06:00:00Z');
const MIN = 60_000;
// 虚构的昨日分时曝光：中午和晚饭前后高
const EXPO = [0, 0, 0, 0, 0, 0, 0, 0, 20, 60, 120, 400, 380, 150, 90, 80, 110, 300, 420, 260, 140, 60, 0, 0];

const plan = (budget = 20000): Plan => planBudget(budget, EXPO, parseHours('09:00-21:00'));
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  storeId: 'S1', planId: 'P1', day: '2026-10-27', capturedAt: NOW - 5000,
  spend: 8000, bid: 100, platformBudget: 20000, minBid: 10, maxBid: 400, bidStep: 10, status: 'running', scope: '下午茶时段', ...o,
});
const led = (o: Partial<Ledger> = {}): Ledger => ({ ...newLedger('2026-10-27'), ...o });

describe('时间与金额', () => {
  it('北京时间的日期与分钟', () => {
    expect(dateKey(NOW)).toBe('2026-10-27');
    expect(minuteOfDay(NOW)).toBe(14 * 60);
    expect(dateKey(Date.parse('2026-10-27T16:30:00Z'))).toBe('2026-10-28'); // 北京时间次日 00:30
  });
  it('元转分，无效值返回 null', () => {
    expect(toCents('1.25')).toBe(125);
    expect(toCents('1,000.5 元')).toBe(100050);
    expect(toCents('')).toBeNull();
    expect(toCents('abc')).toBeNull();
    expect(toCents(-1)).toBeNull();
  });
  it('营业时段：跨午夜拆分、合并、无效时段报错', () => {
    expect(intervals([[22 * 60, 2 * 60]])).toEqual([[0, 120], [1320, 1440]]);
    expect(intervals([[540, 720], [700, 800]])).toEqual([[540, 800]]);
    expect(() => intervals([[600, 600]])).toThrow('营业时段无效');
    expect(() => intervals([[1500, 100]])).toThrow();
    expect(parseHours('周一至周日 09:00-14:00，16:30-24:00')).toEqual([[540, 840], [990, 1440]]);
    expect(() => parseHours('全天营业')).toThrow('没有识别到');
    expect(() => parseHours('25:00-26:00')).toThrow();
  });
});

describe('按星期读营业时间', () => {
  const txt = '营业时间 周一至周五 09:00-21:00 周六、周日 10:00-23:30';
  it('取今天对应的时段', () => {
    expect(weekdayOf(NOW)).toBe(2); // 2026-10-27 是周二
    expect(parseBusinessHours(txt, 2)).toEqual([[540, 1260]]);
    expect(parseBusinessHours(txt, 6)).toEqual([[600, 1410]]);
    expect(parseBusinessHours('每天 08:00-12:00 14:00-20:00', 3)).toEqual([[480, 720], [840, 1200]]);
    expect(parseBusinessHours('10:00-22:00', 1)).toEqual([[600, 1320]]);
  });
  it('今天没有对应时段、或没有时段，报错不猜', () => {
    expect(() => parseBusinessHours('周一至周三 09:00-21:00', 5)).toThrow('没找到今天');
    expect(() => parseBusinessHours('暂无', 1)).toThrow('没有识别到');
    expect(() => parseBusinessHours('周一 25:00-26:00', 1)).toThrow();
  });
});

describe('曝光读取与解析', () => {
  it('悬停提示三种小时写法，昨日系列优先', () => {
    expect(parseTooltip('09:00 昨日 1,234 今日 5')).toMatchObject({ hour: 9, kind: 'clock', value: 1234 });
    expect(parseTooltip('14时 昨日曝光人数：88')).toMatchObject({ hour: 14, kind: 'shi', value: 88 });
    expect(parseTooltip('7 单一 300')).toMatchObject({ hour: 7, kind: 'bare', value: 300 });
    expect(parseTooltip('')).toBeNull();
    expect(parseTooltip('没有数字')).toBeNull();
    expect(parseTooltip('10:00 今日 3 昨日 ')).toBeNull(); // 两个数字又没有昨日数值，不猜
  });
  it('小时映射：缺小时报错、1–24 编号必须确认、冲突报错', () => {
    const clock = Array.from({ length: 24 }, (_, h) => parseTooltip(`${String(h).padStart(2, '0')}:00 昨日 ${h + 1}`)!);
    const ok = mapHours(clock);
    expect(ok.ok && ok.values[5]).toBe(6);
    expect(mapHours(clock.slice(0, 23))).toMatchObject({ ok: false, missing: [23] });
    const bare = Array.from({ length: 24 }, (_, i) => parseTooltip(`${i + 1} 昨日 ${i * 10}`)!);
    expect(mapHours(bare)).toMatchObject({ ok: false, ambiguous: true });
    const end = mapHours(bare, 'end');
    expect(end.ok && end.values[0]).toBe(0);
    expect(end.ok && end.values[23]).toBe(230);
    const start = mapHours(bare, 'start');
    expect(start.ok).toBe(false); // 1–24 当起点用，会缺 0 点
    expect(mapHours([])).toMatchObject({ ok: false });
    expect(mapHours([...clock, { ...clock[3], value: 999 }])).toMatchObject({ ok: false, reason: expect.stringContaining('两个不同') });
  });
  it('手动粘贴曝光：24 个数字或逐行小时+数值', () => {
    expect(parseExposureText(EXPO.join(','))).toEqual(EXPO);
    expect(parseExposureText(EXPO.map((v, h) => `${h}:00 ${v}`).join('\n'))).toEqual(EXPO);
    expect(() => parseExposureText('1,2,3')).toThrow('需要 24 个');
    expect(() => parseExposureText(EXPO.map((v) => (v === 120 ? '-1' : v)).join(' '))).toThrow();
    expect(() => parseExposureText('')).toThrow();
  });
});

describe('预算分配', () => {
  it('最大余数法：合计严格等于总额', () => {
    const a = allocate(1000, [1, 1, 1]);
    expect(a.reduce((x, y) => x + y)).toBe(1000);
    expect([...a].sort()).toEqual([333, 333, 334]);
    expect(allocate(7, [0, 5, 0])).toEqual([0, 7, 0]);
    expect(() => allocate(100, [0, 0])).toThrow('预算权重无效');
    expect(() => allocate(-1, [1])).toThrow();
    expect(() => allocate(1.5, [1])).toThrow();
  });
  it('只在营业时间内分配，合计等于日预算，曝光高的小时分得多', () => {
    const p = plan();
    expect(p.budgets.reduce((a, b) => a + b)).toBe(20000);
    for (let h = 0; h < 9; h++) expect(p.budgets[h]).toBe(0);
    for (let h = 21; h < 24; h++) expect(p.budgets[h]).toBe(0);
    expect(p.budgets[11]).toBeGreaterThan(p.budgets[10]);
    expect(p.budgets[18]).toBeGreaterThan(p.budgets[15]);
  });
  it('营业时间只有半小时的小时按比例减权', () => {
    const half = planBudget(10000, Array(24).fill(100), parseHours('09:30-10:30'));
    expect(half.budgets[9]).toBe(5000);
    expect(half.budgets[10]).toBe(5000);
  });
  it('数据缺失或无效直接报错，不补零', () => {
    expect(() => planBudget(20000, EXPO.slice(0, 23), parseHours('09:00-21:00'))).toThrow('完整的昨日 24 小时');
    expect(() => planBudget(20000, EXPO.map((v, i) => (i === 3 ? NaN : v)), parseHours('09:00-21:00'))).toThrow();
    expect(() => planBudget(0, EXPO, parseHours('09:00-21:00'))).toThrow('日预算');
    expect(() => planBudget(20000, EXPO, [])).toThrow('没有营业时段');
    expect(() => planBudget(20000, Array(24).fill(0), parseHours('09:00-21:00'))).toThrow('全为 0');
    expect(() => planBudget(20000, EXPO, parseHours('22:00-23:00'))).toThrow('全为 0'); // 营业时段内昨日曝光为 0
  });
  it('计划累计花费：营业前为 0，收档后等于日预算，单调不减', () => {
    const p = plan();
    expect(expectedSpend(p, 8 * 60)).toBe(0);
    expect(expectedSpend(p, 21 * 60)).toBe(20000);
    expect(expectedSpend(p, 1440)).toBe(20000);
    let last = 0;
    for (let m = 0; m <= 1440; m += 15) { const v = expectedSpend(p, m); expect(v).toBeGreaterThanOrEqual(last); last = v; }
    expect(() => expectedSpend(p, -1)).toThrow();
    expect(() => expectedSpend(p, 1441)).toThrow();
  });
  it('逐小时编辑：营业外不能给预算，不能超过日预算', () => {
    const p = plan();
    expect(editHour(p, 12, 3000).budgets[12]).toBe(3000);
    expect(() => editHour(p, 3, 100)).toThrow('不在营业时间');
    expect(() => editHour(p, 12, 20001)).toThrow();
    expect(() => editHour(p, 24, 1)).toThrow();
  });
});

describe('出价建议：数据缺失与阻断', () => {
  it('没有计划、没有快照、关键字段缺失都不给建议', () => {
    expect(suggest({ plan: null, snapshot: snap(), now: NOW }).action).toBe('blocked');
    expect(suggest({ plan: plan(), snapshot: null, now: NOW })).toMatchObject({ action: 'blocked', reason: expect.stringContaining('数据缺失') });
    const r = suggest({ plan: plan(), snapshot: snap({ spend: null, minBid: null }), now: NOW });
    expect(r.action).toBe('blocked');
    expect(r.reason).toContain('今日花费');
    expect(r.reason).toContain('出价下限');
    expect(missingFields(snap({ bidStep: null }))).toEqual(['出价步长']);
    expect(missingFields(snap())).toEqual([]);
  });
  it('数据过期、日期不是今天、时间在未来、页面有验证提示', () => {
    expect(suggest({ plan: plan(), snapshot: snap({ capturedAt: NOW - 61_000 }), now: NOW }).reason).toContain('过期');
    expect(suggest({ plan: plan(), snapshot: snap({ day: '2026-10-26' }), now: NOW }).reason).toContain('日期');
    expect(suggest({ plan: plan(), snapshot: snap({ capturedAt: NOW + 60_000 }), now: NOW }).action).toBe('blocked');
    expect(suggest({ plan: plan(), snapshot: snap({ blocker: '需要重新登录' }), now: NOW })).toMatchObject({ action: 'blocked', reason: '需要重新登录' });
  });
  it('平台预算与计划不一致、金额无效、花费倒退、上次未核对都阻断', () => {
    expect(suggest({ plan: plan(), snapshot: snap({ platformBudget: 30000 }), now: NOW }).reason).toContain('不一致');
    expect(suggest({ plan: plan(), snapshot: snap({ bid: 0 }), now: NOW }).action).toBe('blocked');
    expect(suggest({ plan: plan(), snapshot: snap({ minBid: 500 }), now: NOW }).action).toBe('blocked');
    expect(suggest({ plan: plan(), snapshot: snap({ spend: 5000 }), ledger: led({ lastSpend: 6000 }), now: NOW }).reason).toContain('比上次读到的还少');
    expect(suggest({ plan: plan(), snapshot: snap(), ledger: led({ pending: { action: 'increase', before: 90, after: 100, at: NOW } }), now: NOW }).reason).toContain('没有核对');
  });
  it('推广已暂停或状态未知时保持不动', () => {
    expect(suggest({ plan: plan(), snapshot: snap({ status: 'paused' }), now: NOW }).action).toBe('hold');
    expect(suggest({ plan: plan(), snapshot: snap({ status: 'unknown' }), now: NOW }).action).toBe('hold');
  });
});

describe('出价建议：营业时间与预算', () => {
  it('营业时间外保持不动', () => {
    const night = Date.parse('2026-10-26T16:00:00Z'); // 北京时间 00:00，日期是 10-27
    const r = suggest({ plan: plan(), snapshot: snap({ capturedAt: night - 1000, spend: 0 }), now: night });
    expect(r).toMatchObject({ action: 'hold', reason: expect.stringContaining('不在营业时间') });
  });
  it('预算刚好用完和用超都保持不动，用超时提示超出金额', () => {
    expect(suggest({ plan: plan(), snapshot: snap({ spend: 20000 }), now: NOW }).reason).toContain('已用完');
    const over = suggest({ plan: plan(), snapshot: snap({ spend: 21550 }), now: NOW });
    expect(over.action).toBe('hold');
    expect(over.reason).toContain('15.50');
    expect(over.after).toBe(100);
  });
});

describe('出价建议：加减价与限幅', () => {
  const exp14 = expectedSpend(plan(), 14 * 60);
  it('计划此刻应花金额大于 0 且小于日预算（测试前提）', () => {
    expect(exp14).toBeGreaterThan(5000);
    expect(exp14).toBeLessThan(20000);
  });
  it('花费慢于计划：加一步；快于计划：减一步', () => {
    const slow = suggest({ plan: plan(), snapshot: snap({ spend: exp14 - 3000 }), now: NOW });
    expect(slow).toMatchObject({ action: 'increase', before: 100, after: 110 });
    const fast = suggest({ plan: plan(), snapshot: snap({ spend: exp14 + 3000 }), now: NOW });
    expect(fast).toMatchObject({ action: 'decrease', before: 100, after: 90 });
  });
  it('差距很小保持不动：小于 1 元，或小于日预算 2%', () => {
    expect(suggest({ plan: plan(), snapshot: snap({ spend: exp14 + 99 }), now: NOW }).action).toBe('hold');
    expect(suggest({ plan: plan(10_000_000), snapshot: snap({ platformBudget: 10_000_000, spend: expectedSpend(plan(10_000_000), 840) + 150_000 }), now: NOW }).action).toBe('hold');
  });
  it('单次步长：任何建议与当前出价相差不超过一步', () => {
    for (const d of [-9000, -1500, 500, 2500, 9000]) {
      const r = suggest({ plan: plan(), snapshot: snap({ spend: Math.max(0, exp14 + d) }), now: NOW });
      expect(Math.abs((r.after ?? 0) - (r.before ?? 0))).toBeLessThanOrEqual(10);
    }
    const big = suggest({ plan: plan(), snapshot: snap({ spend: exp14 - 3000 }), now: NOW, policy: { step: 30 } });
    expect(big.after).toBe(130);
  });
  it('平台出价范围：已在上限不能再加、已在下限不能再降', () => {
    expect(suggest({ plan: plan(), snapshot: snap({ spend: exp14 - 3000, bid: 400 }), now: NOW, ledger: led({ startBid: 400 }) })).toMatchObject({ action: 'hold', reason: expect.stringContaining('上限') });
    expect(suggest({ plan: plan(), snapshot: snap({ spend: exp14 + 3000, bid: 10 }), now: NOW, ledger: led({ startBid: 10 }) })).toMatchObject({ action: 'hold', reason: expect.stringContaining('下限') });
  });
  it('用户设置的出价范围收窄平台范围：最高出价上限生效', () => {
    const r = suggest({ plan: plan(), snapshot: snap({ spend: exp14 - 3000, bid: 120 }), now: NOW, limits: { maxBid: 120 }, ledger: led({ startBid: 120 }) });
    expect(r.action).toBe('hold');
    const r2 = suggest({ plan: plan(), snapshot: snap({ spend: exp14 - 3000, bid: 120 }), now: NOW, limits: { maxBid: 130 } });
    expect(r2).toMatchObject({ action: 'increase', after: 130 });
  });
  it('当前出价高于用户上限：小步降低；低于用户下限：阻断；范围无交集：阻断', () => {
    const r = suggest({ plan: plan(), snapshot: snap({ bid: 200, spend: exp14 - 3000 }), now: NOW, limits: { maxBid: 150 } });
    expect(r).toMatchObject({ action: 'decrease', after: 190 });
    expect(suggest({ plan: plan(), snapshot: snap({ bid: 50 }), now: NOW, limits: { minBid: 80 } }).action).toBe('blocked');
    expect(suggest({ plan: plan(), snapshot: snap({ bid: 100 }), now: NOW, limits: { minBid: 500, maxBid: 600 } }).reason).toContain('没有交集');
  });
  it('步长必须是平台步长的整数倍', () => {
    expect(suggest({ plan: plan(), snapshot: snap({ spend: exp14 - 3000, bidStep: 20 }), now: NOW, policy: { step: 10 } }).action).toBe('blocked');
    expect(suggest({ plan: plan(), snapshot: snap({ spend: exp14 - 3000, bidStep: 10 }), now: NOW, policy: { step: 20 } }).after).toBe(120);
  });
});

describe('出价建议：冷却、次数、方向、偏移', () => {
  const exp14 = expectedSpend(plan(), 14 * 60);
  const slow = snap({ spend: exp14 - 3000 });
  it('加价冷却 30 分钟：冷却中不加，到点可以加；降价不受冷却', () => {
    expect(suggest({ plan: plan(), snapshot: slow, now: NOW, ledger: led({ lastAdjustmentAt: NOW - 10 * MIN, startBid: 100 }) }).reason).toContain('冷却');
    expect(suggest({ plan: plan(), snapshot: slow, now: NOW, ledger: led({ lastAdjustmentAt: NOW - 31 * MIN, startBid: 100 }) }).action).toBe('increase');
    expect(suggest({ plan: plan(), snapshot: snap({ spend: exp14 + 3000 }), now: NOW, ledger: led({ lastAdjustmentAt: NOW - 1 * MIN, startBid: 100 }) }).action).toBe('decrease');
  });
  it('每日次数上限', () => {
    expect(suggest({ plan: plan(), snapshot: slow, now: NOW, ledger: led({ changesToday: 12 }) })).toMatchObject({ action: 'hold', reason: expect.stringContaining('每日上限') });
    expect(suggest({ plan: plan(), snapshot: slow, now: NOW, ledger: led({ changesToday: 3 }), policy: { maxDailyChanges: 3 } }).action).toBe('hold');
  });
  it('同方向连续上限', () => {
    expect(suggest({ plan: plan(), snapshot: slow, now: NOW, ledger: led({ direction: 'increase', streak: 2, startBid: 100 }) }).reason).toContain('连续');
    expect(suggest({ plan: plan(), snapshot: slow, now: NOW, ledger: led({ direction: 'decrease', streak: 5, startBid: 100 }) }).action).toBe('increase');
  });
  it('相对起始出价最多偏离 0.30 元', () => {
    expect(suggest({ plan: plan(), snapshot: snap({ spend: exp14 - 3000, bid: 130 }), now: NOW, ledger: led({ startBid: 100 }) })).toMatchObject({ action: 'hold', reason: expect.stringContaining('偏离') });
    expect(suggest({ plan: plan(), snapshot: snap({ spend: exp14 - 3000, bid: 120 }), now: NOW, ledger: led({ startBid: 100 }) }).after).toBe(130);
  });
  it('记录一次修改：起始价、方向、连续次数、次数累加、清除待核对', () => {
    let l = recordChange(led({ pending: { action: 'increase', before: 100, after: 110, at: NOW } }), { action: 'increase', before: 100, after: 110, at: NOW });
    expect(l).toMatchObject({ startBid: 100, streak: 1, changesToday: 1, direction: 'increase', pending: null });
    l = recordChange(l, { action: 'increase', before: 110, after: 120, at: NOW + 1 });
    expect(l).toMatchObject({ startBid: 100, streak: 2, changesToday: 2 });
    l = recordChange(l, { action: 'decrease', before: 120, after: 110, at: NOW + 2 });
    expect(l.streak).toBe(1);
  });
  it('不同出价时段的记录分开', () => {
    expect(ledgerKey(snap({ scope: 'A' }))).not.toBe(ledgerKey(snap({ scope: 'B' })));
  });
});

describe('每小时参考出价', () => {
  const range = { minBid: 10, maxBid: 400, step: 10 };
  it('营业外没有参考价；营业内落在范围内、是步长整数倍；预算高的小时更高', () => {
    const g = hourlyBidGuide(plan(), range);
    expect(g[3]).toMatchObject({ open: false, bid: null });
    for (const x of g.filter((x) => x.open)) {
      expect(x.bid!).toBeGreaterThanOrEqual(10);
      expect(x.bid!).toBeLessThanOrEqual(400);
      expect((x.bid! - 10) % 10).toBe(0);
    }
    expect(g[11].bid!).toBeGreaterThan(g[9].bid!);
  });
  it('用户上限收窄后不超过上限；范围无效报错', () => {
    expect(Math.max(...hourlyBidGuide(plan(), range, { maxBid: 150 }).map((x) => x.bid ?? 0))).toBeLessThanOrEqual(150);
    expect(() => hourlyBidGuide(plan(), range, { minBid: 500 })).toThrow('出价范围无效');
    expect(() => hourlyBidGuide(plan(), { ...range, step: 0 })).toThrow();
  });
});

describe('回滚判断', () => {
  const p = plan();
  const exp14 = expectedSpend(p, 14 * 60);
  const inc = { action: 'increase' as const, before: 100, after: 110, at: NOW - 40 * MIN, gapAtChange: -2000 };
  it('观察时间不够不回滚', () => {
    expect(judgeRollback({ change: { ...inc, at: NOW - 5 * MIN }, snapshot: snap({ bid: 110, spend: exp14 + 5000 }), plan: p, now: NOW }).rollback).toBe(false);
  });
  it('加价后反而超支：建议改回原价', () => {
    const v = judgeRollback({ change: inc, snapshot: snap({ bid: 110, spend: exp14 + 2500 }), plan: p, now: NOW });
    expect(v).toMatchObject({ rollback: true, target: 100 });
  });
  it('加价后差距在缩小：保持', () => {
    expect(judgeRollback({ change: inc, snapshot: snap({ bid: 110, spend: exp14 - 500 }), plan: p, now: NOW }).rollback).toBe(false);
  });
  it('降价后更落后：建议改回', () => {
    const dec = { action: 'decrease' as const, before: 100, after: 90, at: NOW - 40 * MIN, gapAtChange: 2000 };
    expect(judgeRollback({ change: dec, snapshot: snap({ bid: 90, spend: exp14 - 2500 }), plan: p, now: NOW })).toMatchObject({ rollback: true, target: 100 });
    expect(judgeRollback({ change: dec, snapshot: snap({ bid: 90, spend: exp14 + 500 }), plan: p, now: NOW }).rollback).toBe(false);
  });
  it('数据缺失、出价已被改动都不判断', () => {
    expect(judgeRollback({ change: inc, snapshot: snap({ bid: 110, spend: null }), plan: p, now: NOW }).rollback).toBe(false);
    expect(judgeRollback({ change: inc, snapshot: snap({ bid: 120, spend: exp14 + 5000 }), plan: p, now: NOW }).reason).toContain('不再判断');
  });
});

describe('提交后核对', () => {
  const pend = { action: 'increase' as const, before: 100, after: 110, at: NOW - 2 * MIN, scope: '下午茶时段' };
  it('回读目标价 = 生效；回读原价 = 未生效', () => {
    expect(reconcilePending(pend, snap({ bid: 110 }), NOW).result).toBe('applied');
    expect(reconcilePending(pend, snap({ bid: 100 }), NOW).result).toBe('not-applied');
  });
  it('价格对不上、出价时段变了、超过 45 分钟、读不到：都不自动清除', () => {
    expect(reconcilePending(pend, snap({ bid: 130 }), NOW).result).toBe('unknown');
    expect(reconcilePending(pend, snap({ bid: 110, scope: '晚餐时段' }), NOW).result).toBe('unknown');
    expect(reconcilePending(pend, snap({ bid: 110 }), NOW + 50 * MIN).result).toBe('unknown');
    expect(reconcilePending(pend, snap({ bid: null }), NOW).result).toBe('unknown');
  });
});

describe('自动调价保护', () => {
  const sug = { action: 'increase' as const, reason: '', before: 100, after: 110, expected: 0, actual: 0 };
  const on = { ...DEFAULT_AUTO, enabled: true, confirmed: true, ceiling: 200 };
  it('默认关闭：未打开、或没有二次确认都不能自动改', () => {
    expect(DEFAULT_AUTO.enabled).toBe(false);
    expect(canAutoApply(sug, null, DEFAULT_AUTO, NOW).ok).toBe(false);
    expect(canAutoApply(sug, null, { ...on, confirmed: false }, NOW).ok).toBe(false);
    expect(canAutoApply(sug, null, { ...on, enabled: false }, NOW).ok).toBe(false);
  });
  it('全部满足才放行', () => {
    expect(canAutoApply(sug, led(), on, NOW)).toMatchObject({ ok: true });
  });
  it('没有最高出价上限、超过上限、低于最低出价都拒绝', () => {
    expect(canAutoApply(sug, null, { ...on, ceiling: null }, NOW).ok).toBe(false);
    expect(canAutoApply({ ...sug, after: 210, before: 200 }, null, on, NOW).reason).toContain('最高出价上限');
    expect(canAutoApply(sug, null, { ...on, floor: 120 }, NOW).ok).toBe(false);
  });
  it('单次步长、每日次数、待核对、冷却', () => {
    expect(canAutoApply({ ...sug, after: 130 }, null, on, NOW).reason).toContain('步长');
    expect(canAutoApply(sug, led({ changesToday: 6 }), on, NOW).reason).toContain('次上限');
    expect(canAutoApply(sug, led({ pending: { action: 'increase', before: 90, after: 100, at: NOW } }), on, NOW).ok).toBe(false);
    expect(canAutoApply(sug, led({ lastAdjustmentAt: NOW - MIN }), on, NOW).reason).toContain('冷却');
    expect(canAutoApply({ ...sug, action: 'decrease', before: 110, after: 100 }, led({ lastAdjustmentAt: NOW - MIN }), on, NOW).ok).toBe(true);
  });
  it('保持 / 阻断的建议不会被自动执行', () => {
    expect(canAutoApply({ ...sug, action: 'hold' }, null, on, NOW).ok).toBe(false);
    expect(canAutoApply({ ...sug, action: 'blocked' }, null, on, NOW).ok).toBe(false);
  });
});
