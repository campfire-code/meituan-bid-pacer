// 纯函数：预算分配、出价建议、限幅、冷却、回滚判断。不依赖界面和网络，金额一律用「分」（整数）。

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export const DEFAULT_POLICY = Object.freeze({
  /** 每次最多改动的金额（分）。平台出价步长通常是 10 分 */
  step: 10,
  /** 加价后的冷却时间，期间不再加价（降价不受冷却限制，超支要能快降） */
  cooldownMs: 30 * 60_000,
  /** 花费与计划相差小于这个金额（分）时保持不动 */
  minGap: 100,
  /** 花费与计划相差小于日预算的这个比例时保持不动 */
  minRatio: 0.02,
  /** 每天最多改几次 */
  maxDailyChanges: 12,
  /** 同一方向最多连续改几次 */
  maxStreak: 2,
  /** 相对当天起始出价，最多偏离多少（分） */
  maxOffset: 30,
  /** 页面数据超过多久算过期 */
  maxSnapshotAgeMs: 60_000,
});
export type Policy = { -readonly [K in keyof typeof DEFAULT_POLICY]: number };

/** 用户设置的出价保护：最高出价上限必须由用户填写，未填写时不允许自动调价 */
export interface Limits {
  /** 允许的最低出价（分），不填用平台下限 */
  minBid?: number;
  /** 允许的最高出价（分），不填用平台上限 */
  maxBid?: number;
}

// ---------- 金额与时间 ----------

/** 元 → 分。无效返回 null */
export function toCents(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.replace(/[,，\s元]/g, '')) : Number(v);
  if (v === '' || v == null || !finite(n) || n < 0 || n > 1_000_000) return null;
  return Math.round(n * 100);
}
export const yuan = (c: number | null | undefined) => (c == null ? '—' : (c / 100).toFixed(2));

const TZ = 'Asia/Shanghai';
export function dateKey(now: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
export function minuteOfDay(now: number): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now)).split(':').map(Number);
  return p[0] * 60 + p[1];
}

export type Interval = [number, number];

/** 营业时段（分钟）规整：跨午夜拆成两段、排序合并。无效时段抛错 */
export function intervals(input: Interval[]): Interval[] {
  const split: Interval[] = [];
  for (const [a, b] of input) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a >= 1440 || b < 0 || b > 1440 || a === b) throw new Error('营业时段无效');
    if (b < a) split.push([a, 1440], [0, b]);
    else split.push([a, b]);
  }
  const merged: Interval[] = [];
  for (const x of split.filter((x) => x[0] < x[1]).sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else merged.push([x[0], x[1]]);
  }
  return merged;
}

/** 从文字里读营业时段，例如「09:00-21:30，22:00-02:00」 */
export function parseHours(text: string): Interval[] {
  const ms = [...String(text ?? '').matchAll(/(\d{1,2}):(\d{2})\s*[-—~至到]\s*(\d{1,2}):(\d{2})/g)];
  if (!ms.length) throw new Error('没有识别到营业时段，请按「09:00-21:00」填写');
  return intervals(
    ms.map((m) => {
      const [h, a, k, b] = m.slice(1).map(Number);
      if (h > 23 || k > 24 || a > 59 || b > 59 || (k === 24 && b !== 0)) throw new Error('时间格式无效');
      const s = h * 60 + a;
      const e = k * 60 + b;
      return [s, e === s ? 1440 : e] as Interval;
    }),
  );
}

/** 北京时间的星期，1 = 周一 … 7 = 周日 */
export function weekdayOf(now: number): number {
  const d = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date(now));
  return ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[d];
}
const CN_DAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const DAY_EXPR = /(每天|全周|周[一二三四五六日天](?:\s*[至到\-~—]\s*周?[一二三四五六日天])?(?:\s*[、，,]\s*周[一二三四五六日天](?:\s*[至到\-~—]\s*周?[一二三四五六日天])?)*)/g;
function dayIncludes(expr: string, target: number): boolean {
  if (/每天|全周/.test(expr)) return true;
  for (const m of expr.matchAll(/周([一二三四五六日天])(?:\s*[至到\-~—]\s*周?([一二三四五六日天]))?/g)) {
    const a = CN_DAY[m[1]];
    const b = m[2] ? CN_DAY[m[2]] : a;
    if (a <= b ? target >= a && target <= b : target >= a || target <= b) return true;
  }
  return false;
}
const RANGE = /(\d{1,2}):(\d{2})\s*[-—~至到]\s*(\d{1,2}):(\d{2})/g;

/**
 * 从门店管理页上的营业时间文字里取「今天」的营业时段。
 * 支持「周一至周五 09:00-21:00 周六、周日 10:00-22:00」「每天 …」，没写星期时全部算今天。今天没有对应时段会报错，不猜。
 */
export function parseBusinessHours(text: string, weekday: number): Interval[] {
  const t = String(text ?? '').replace(/\s+/g, ' ');
  const groups = [...t.matchAll(DAY_EXPR)];
  let picked: RegExpMatchArray[] = [];
  let seen = 0;
  let matched = false;
  groups.forEach((g, i) => {
    const block = t.slice((g.index ?? 0) + g[0].length, groups[i + 1]?.index ?? t.length);
    const rs = [...block.matchAll(RANGE)];
    if (!rs.length) return;
    seen++;
    if (dayIncludes(g[1], weekday)) { matched = true; picked.push(...rs); }
  });
  if (!groups.length || !seen) picked = [...t.matchAll(RANGE)];
  if (seen && !matched) throw new Error('营业时间按星期设置，没找到今天对应的时段，请核对后手动填写');
  if (!picked.length) throw new Error('没有识别到营业时段，请按「09:00-21:00」手动填写');
  return intervals(
    picked.map((m) => {
      const [h, a, k, b] = m.slice(1).map(Number);
      if (h > 23 || k > 24 || a > 59 || b > 59 || (k === 24 && b !== 0)) throw new Error('时间格式无效');
      const st = h * 60 + a;
      const e = k * 60 + b;
      return [st, e === st ? 1440 : e] as Interval;
    }),
  );
}

export function activeMinutes(xs: Interval[], a: number, b: number): number {
  return xs.reduce((s, [start, end]) => s + Math.max(0, Math.min(end, b) - Math.max(start, a)), 0);
}
export const isOpen = (xs: Interval[], minute: number) => activeMinutes(xs, minute, minute + 1) > 0;

// ---------- 昨日曝光读取与解析 ----------

export interface TooltipEntry { hour: number; kind: 'clock' | 'shi' | 'bare'; label: string; value: number; series: string; raw: string }
const HOUR_PATTERNS: { kind: TooltipEntry['kind']; re: RegExp }[] = [
  { kind: 'clock', re: /(?:^|[^\d:])([01]?\d|2[0-3]):00(?:\s*[-~—至]\s*([01]?\d|2[0-4]):00)?(?![\d:])/ },
  { kind: 'shi', re: /(?:^|[^\d])([01]?\d|2[0-4])\s*[时点](?![\d])/ },
  { kind: 'bare', re: /(?:^|[^\d.,])([1-9]|1\d|2[0-4])(?![\d.,:])/ },
];

/** 解析图表悬停提示（如「09:00 昨日 1,234」）。读不出返回 null，绝不猜 */
export function parseTooltip(text: string): TooltipEntry | null {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  let hour: number | null = null;
  let kind: TooltipEntry['kind'] | null = null;
  let label = '';
  for (const p of HOUR_PATTERNS) {
    const m = t.match(p.re);
    if (m) { label = m[0].trim(); kind = p.kind; hour = Number(m[1]); break; }
  }
  let value: number | null = null;
  let series = '昨日';
  const y = t.match(/昨日[^\d]{0,12}([\d,]+(?:\.\d+)?)/);
  if (y) value = Number(y[1].replace(/,/g, ''));
  else if (/昨日/.test(t)) return null; // 提示里有「昨日」却没有它的数值：不拿别的系列顶替
  else {
    const rest = label ? t.slice(t.indexOf(label) + label.length) : t;
    const nums = [...rest.matchAll(/([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
    if (nums.length === 1) { value = nums[0]; series = '单一数值'; }
  }
  if (hour == null || kind == null || value == null || !finite(value)) return null;
  return { hour, kind, label, value, series, raw: t.slice(0, 160) };
}

export type HourMapping = 'start' | 'end' | null;
export type MapResult =
  | { ok: true; values: number[]; mode: string }
  | { ok: false; ambiguous?: boolean; reason: string; missing?: number[] };

/** 把读到的小时标签落到 0–23。横轴是 1–24 编号时含义不明，必须由用户确认，不猜 */
export function mapHours(entries: TooltipEntry[], mapping: HourMapping = null): MapResult {
  if (!entries.length) return { ok: false, reason: '没有读到任何小时的曝光' };
  const kinds = new Set(entries.map((e) => e.kind));
  const hs = entries.map((e) => e.hour);
  const min = Math.min(...hs);
  const max = Math.max(...hs);
  let mode: string | null = null;
  if (kinds.has('clock')) mode = 'clock';
  else if (min === 0 && max === 23) mode = 'zero';
  else if (min === 1 && max === 24) mode = mapping === 'end' ? 'end' : mapping === 'start' ? 'start' : null;
  else if (min >= 0 && max <= 23) mode = 'zero';
  if (mode === null) return { ok: false, ambiguous: true, reason: '横轴是 1–24 的编号，需要确认「1」表示 00:00–01:00 还是 01:00–02:00' };
  const values: (number | null)[] = Array(24).fill(null);
  for (const e of entries) {
    let h: number | null = e.hour;
    if (mode === 'end') h = e.hour - 1;
    else if (mode === 'start') h = e.hour;
    else if (mode === 'clock' && h === 24) h = null;
    if (h == null || h < 0 || h > 23) continue;
    if (values[h] != null && values[h] !== e.value) return { ok: false, reason: `第 ${h} 小时读到两个不同的值` };
    values[h] = e.value;
  }
  const missing = values.map((v, i) => (v == null ? i : -1)).filter((i) => i >= 0);
  if (missing.length) return { ok: false, reason: `昨日曝光缺少 ${missing.length} 个小时：${missing.join('、')}`, missing };
  return { ok: true, values: values as number[], mode };
}

/** 手动粘贴曝光：支持 24 个数字（逗号 / 空格 / 换行分隔，对应 0–23 点），或每行「9:00 1234」 */
export function parseExposureText(text: string): number[] {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const timed = lines.map((l) => l.match(/^(\d{1,2})(?::00|\s*[时点])?\s*[\s,，:：\t]+\s*([\d,]+(?:\.\d+)?)$/));
  if (lines.length >= 24 && timed.every(Boolean)) {
    const out: (number | null)[] = Array(24).fill(null);
    for (const m of timed as RegExpMatchArray[]) {
      const h = Number(m[1]);
      if (h < 0 || h > 23) throw new Error(`小时 ${h} 超出 0–23`);
      out[h] = Number(m[2].replace(/,/g, ''));
    }
    if (out.some((v) => v == null)) throw new Error('每行「小时 数值」的写法需要 0–23 点共 24 行齐全');
    return out as number[];
  }
  const nums = String(text ?? '').split(/[\s,，;；]+/).filter(Boolean).map(Number);
  if (nums.length !== 24 || nums.some((n) => !finite(n) || n < 0)) throw new Error(`需要 24 个非负数字（0–23 点各一个），现在读到 ${nums.length} 个`);
  return nums;
}

// ---------- 预算分配 ----------

/** 最大余数法：把 total（分）按权重拆成整数，合计严格等于 total */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total) || total < 0 || !weights.length || weights.some((x) => !finite(x) || x < 0) || sum <= 0) throw new Error('预算权重无效');
  const exact = weights.map((x) => (total * x) / sum);
  const out = exact.map(Math.floor);
  const order = exact.map((x, i) => ({ i, r: x - out[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  let left = total - out.reduce((a, b) => a + b, 0);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length].i]++;
  return out;
}

export interface Plan {
  /** 日预算（分） */
  budget: number;
  hours: Interval[];
  exposure: number[];
  /** 24 个小时各自的预算（分） */
  budgets: number[];
  /** 每个小时前半小时占该小时预算的比例 */
  ratios: number[];
}

/** 日预算 × 昨日分时曝光 × 当小时营业分钟，分配到 24 小时 */
export function planBudget(budget: number, exposure: number[], hours: Interval[]): Plan {
  if (!Array.isArray(exposure) || exposure.length !== 24 || exposure.some((x) => !finite(x) || x < 0)) throw new Error('需要完整的昨日 24 小时曝光');
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('日预算必须大于 0');
  const xs = intervals(hours);
  if (!xs.length) throw new Error('没有营业时段');
  const weights = exposure.map((e, h) => (e * activeMinutes(xs, h * 60, h * 60 + 60)) / 60);
  if (weights.reduce((a, b) => a + b, 0) <= 0) throw new Error('营业时段内昨日曝光全为 0，无法分配预算');
  const budgets = allocate(budget, weights);
  const ratios = weights.map((_, h) => {
    const all = activeMinutes(xs, h * 60, h * 60 + 60);
    return all ? activeMinutes(xs, h * 60, h * 60 + 30) / all : 0;
  });
  return { budget, hours: xs, exposure: [...exposure], budgets, ratios };
}

export function validatePlan(p: Plan): Interval[] {
  if (!p || !Number.isSafeInteger(p.budget) || p.budget <= 0 || p.budgets?.length !== 24 || p.ratios?.length !== 24) throw new Error('分时预算数值无效');
  if (p.budgets.some((x) => !Number.isSafeInteger(x) || x < 0 || x > p.budget) || p.ratios.some((x) => !finite(x) || x < 0 || x > 1)) throw new Error('分时预算数值无效');
  const xs = intervals(p.hours);
  if (p.budgets.some((v, h) => v > 0 && !activeMinutes(xs, h * 60, h * 60 + 60))) throw new Error('非营业时段存在预算');
  return xs;
}

/** 到 minute（当天第几分钟）为止，计划应该已经花掉多少（分） */
export function expectedSpend(p: Plan, minute: number): number {
  const xs = validatePlan(p);
  if (!finite(minute) || minute < 0 || minute > 1440) throw new Error('时间无效');
  let total = 0;
  for (let h = 0; h < 24; h++) {
    const first = activeMinutes(xs, h * 60, h * 60 + 30);
    const second = activeMinutes(xs, h * 60 + 30, h * 60 + 60);
    const ratio = first === 0 ? 0 : second === 0 ? 1 : p.ratios[h];
    if (first) total += (p.budgets[h] * ratio * activeMinutes(xs, h * 60, Math.min(minute, h * 60 + 30))) / first;
    if (second) total += (p.budgets[h] * (1 - ratio) * activeMinutes(xs, h * 60 + 30, Math.min(minute, h * 60 + 60))) / second;
  }
  return Math.round(total);
}

/** 只改一个小时的预算，其余小时不动 */
export function editHour(p: Plan, h: number, value: number): Plan {
  validatePlan(p);
  if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isSafeInteger(value) || value < 0 || value > p.budget) throw new Error('小时预算值无效');
  if (value > 0 && !activeMinutes(p.hours, h * 60, h * 60 + 60)) throw new Error('该小时不在营业时间内');
  const q = structuredClone(p);
  q.budgets[h] = value;
  return q;
}

// ---------- 页面快照 ----------

export interface Snapshot {
  /** 门店或计划标识，读不到为空 */
  storeId?: string | null;
  planId?: string | null;
  day: string;
  capturedAt: number;
  /** 今日花费（分） */
  spend: number | null;
  /** 当前出价（分） */
  bid: number | null;
  /** 平台日预算（分） */
  platformBudget: number | null;
  /** 平台允许的出价范围与步长（分） */
  minBid: number | null;
  maxBid: number | null;
  bidStep: number | null;
  status: 'running' | 'paused' | 'unknown';
  /** 当前出价时段名称，例如「下午茶时段」；用来把不同时段的记录分开 */
  scope?: string;
  /** 页面上出现验证、登录失效等需要人工处理的提示 */
  blocker?: string | null;
}

export const snapshotIdentity = (s: Pick<Snapshot, 'storeId' | 'planId' | 'day'>) => [s.storeId ?? '', s.planId ?? '', s.day].join('|');

/** 检查快照里哪些关键数据缺失，返回缺失项的名称 */
export function missingFields(s: Snapshot | null | undefined): string[] {
  if (!s) return ['页面数据'];
  const miss: string[] = [];
  const need: [keyof Snapshot, string][] = [['spend', '今日花费'], ['bid', '当前出价'], ['platformBudget', '平台日预算'], ['minBid', '出价下限'], ['maxBid', '出价上限'], ['bidStep', '出价步长']];
  for (const [k, name] of need) if (!Number.isSafeInteger(s[k])) miss.push(name);
  return miss;
}

// ---------- 记录（冷却、次数、方向）----------

export interface Pending { action: 'increase' | 'decrease'; before: number; after: number; at: number; scope?: string }
export interface Ledger {
  day: string;
  /** 当天（该出价时段）第一次调价前的出价 */
  startBid?: number;
  lastAdjustmentAt?: number;
  direction?: 'increase' | 'decrease';
  streak: number;
  changesToday: number;
  lastSpend?: number;
  /** 已提交但还没回读确认的修改 */
  pending?: Pending | null;
}
export const newLedger = (day: string): Ledger => ({ day, streak: 0, changesToday: 0 });
export const ledgerKey = (s: Snapshot) => `${snapshotIdentity(s)}|${s.scope ?? ''}`;

/** 记录一次已确认生效的修改 */
export function recordChange(l: Ledger, c: { action: 'increase' | 'decrease'; before: number; after: number; at: number }): Ledger {
  return {
    ...l,
    startBid: l.startBid ?? c.before,
    lastAdjustmentAt: c.at,
    streak: l.direction === c.action ? l.streak + 1 : 1,
    direction: c.action,
    changesToday: l.changesToday + 1,
    pending: null,
  };
}

// ---------- 出价建议 ----------

export type Action = 'increase' | 'decrease' | 'hold' | 'blocked';
export interface Suggestion {
  action: Action;
  reason: string;
  before: number | null;
  /** 建议改成的出价（分）；保持 / 无法判断时等于当前出价 */
  after: number | null;
  /** 此刻计划应花掉的金额（分） */
  expected: number | null;
  actual: number | null;
}

export interface DecideInput {
  plan: Plan | null;
  snapshot: Snapshot | null;
  ledger?: Ledger | null;
  now: number;
  limits?: Limits;
  policy?: Partial<Policy>;
}

/**
 * 出价建议。花费快于计划就小步降价，慢于计划就小步加价。
 * 页面数据缺失、过期、不在营业时间、预算用完、冷却中、次数用完，一律保持不动或停下，不硬给建议。
 */
export function suggest(input: DecideInput): Suggestion {
  const { plan: p, snapshot: s, now } = input;
  const policy: Policy = { ...DEFAULT_POLICY, ...input.policy };
  const limits = input.limits ?? {};
  const base = (action: Action, reason: string, after: number | null = s?.bid ?? null, expected: number | null = null): Suggestion => ({ action, reason, before: s?.bid ?? null, after, expected, actual: s?.spend ?? null });

  if (!p) return base('blocked', '还没有生成分时预算：先填日预算、营业时间和昨日曝光');
  if (!s) return base('blocked', '数据缺失：还没有读到点金页面');
  const miss = missingFields(s);
  if (miss.length) return base('blocked', `数据缺失：${miss.join('、')}（请在点金页刷新后重读，或手动填写）`);
  if (s.blocker) return base('blocked', s.blocker);
  if (s.day !== dateKey(now)) return base('blocked', '页面数据的日期不是今天，请重新读取');
  if (!finite(s.capturedAt) || s.capturedAt > now + 5000) return base('blocked', '页面数据时间无效，请重新读取');
  if (now - s.capturedAt > policy.maxSnapshotAgeMs) return base('blocked', '页面数据已过期，请重新读取');
  if (s.status !== 'running') return base('hold', s.status === 'paused' ? '点金推广已暂停，不给建议' : '点金是否在推广中未确认，不给建议');
  const spend = s.spend as number;
  const bid = s.bid as number;
  const minB = s.minBid as number;
  const maxB = s.maxBid as number;
  const platStep = s.bidStep as number;
  if (spend < 0 || bid <= 0 || minB <= 0 || maxB < minB || platStep <= 0) return base('blocked', '金额或平台出价范围无效，请重新读取');
  if (s.platformBudget !== p.budget) return base('blocked', `平台日预算（${yuan(s.platformBudget)} 元）与计划预算（${yuan(p.budget)} 元）不一致，请重新生成计划`);
  if (input.ledger?.pending) return base('blocked', '上一次修改还没有核对结果，先确认后台当前出价');

  let expected: number;
  try { expected = expectedSpend(p, minuteOfDay(now)); } catch (e) { return base('blocked', (e as Error).message); }
  const out = (action: Action, reason: string, after: number | null = bid) => base(action, reason, after, expected);

  const ledger = input.ledger ?? newLedger(s.day);
  if (ledger.lastSpend != null && spend < ledger.lastSpend) return out('blocked', '今日花费比上次读到的还少，数据可能异常，请重新核对');
  const minute = minuteOfDay(now);
  if (!isOpen(p.hours, minute)) return out('hold', '当前不在营业时间，不调价');
  if (spend >= p.budget) return out('hold', spend > p.budget ? `今日花费已超出预算 ${yuan(spend - p.budget)} 元，保持当前出价` : '今日预算已用完，保持当前出价');

  const lo = Math.max(minB, limits.minBid ?? minB);
  const hi = Math.min(maxB, limits.maxBid ?? maxB);
  if (lo > hi) return out('blocked', '你设置的出价范围与平台允许的范围没有交集');
  const stepOk = (v: number) => (v - minB) % platStep === 0;
  if (policy.step % platStep !== 0) return out('blocked', '单次步长不是平台出价步长的整数倍');
  if (bid < lo) return out('blocked', `当前出价低于允许下限 ${yuan(lo)} 元`);

  const step = policy.step;
  const stepTo = (dir: 1 | -1) => Math.max(lo, Math.min(hi, bid + dir * step));
  if (bid > hi) {
    const t = Math.max(hi, bid - step);
    return out('decrease', `当前出价高于允许上限 ${yuan(hi)} 元，先小步降低`, t);
  }

  const gap = spend - expected;
  if (Math.abs(gap) < policy.minGap || Math.abs(gap) / p.budget < policy.minRatio) return out('hold', '花费进度与计划差距很小，保持当前出价');
  const action: 'increase' | 'decrease' = gap > 0 ? 'decrease' : 'increase';

  if (ledger.changesToday >= policy.maxDailyChanges) return out('hold', `今天已改过 ${ledger.changesToday} 次，达到每日上限`);
  if (action === 'increase' && ledger.lastAdjustmentAt != null && now - ledger.lastAdjustmentAt < policy.cooldownMs) return out('hold', '刚加过价，冷却中：先看花费变化再决定是否继续加');
  if (ledger.direction === action && ledger.streak >= policy.maxStreak) return out('hold', '同方向已连续调整到上限，等待复核');

  const target = stepTo(action === 'increase' ? 1 : -1);
  if (!stepOk(target)) return out('blocked', '目标出价不符合平台步长');
  if (target === bid) return out('hold', action === 'increase' ? '出价已到允许上限，无法再加' : '出价已到允许下限，无法再降');
  const start = ledger.startBid ?? bid;
  if (Math.abs(target - start) > policy.maxOffset) return out('hold', `已偏离今天起始出价 ${yuan(policy.maxOffset)} 元，不再继续`);
  return out(action, action === 'decrease' ? '花费快于分时计划，小步降低出价' : '花费慢于分时计划，小步提高出价', target);
}

// ---------- 每小时参考出价 ----------

export interface HourGuide { hour: number; budget: number; open: boolean; bid: number | null }

/**
 * 每小时参考出价（估算，不是平台承诺的效果）：
 * 营业小时里，预算占比越高（昨日曝光越集中）的小时参考出价越靠上，按平台步长取整并限制在允许范围内。
 * 当前这一小时的实际建议以 suggest() 为准。
 */
export function hourlyBidGuide(p: Plan, range: { minBid: number; maxBid: number; step: number }, limits: Limits = {}): HourGuide[] {
  validatePlan(p);
  const lo = Math.max(range.minBid, limits.minBid ?? range.minBid);
  const hi = Math.min(range.maxBid, limits.maxBid ?? range.maxBid);
  if (!(range.step > 0) || lo > hi) throw new Error('出价范围无效');
  const open = p.budgets.map((_, h) => activeMinutes(p.hours, h * 60, h * 60 + 60) > 0);
  const share = p.budgets.map((b, h) => (open[h] ? b : 0));
  const n = open.filter(Boolean).length || 1;
  const mean = share.reduce((a, b) => a + b, 0) / n;
  return p.budgets.map((b, h) => {
    if (!open[h]) return { hour: h, budget: b, open: false, bid: null };
    const w = mean > 0 ? Math.max(0, Math.min(1, share[h] / mean / 2)) : 0.5;
    const raw = lo + (hi - lo) * w;
    let bid = lo + Math.round((raw - lo) / range.step) * range.step;
    bid = Math.max(lo, Math.min(hi, bid));
    return { hour: h, budget: b, open: true, bid };
  });
}

// ---------- 回滚判断 ----------

export interface AppliedChange { action: 'increase' | 'decrease'; before: number; after: number; at: number; gapAtChange: number }
export interface RollbackVerdict { rollback: boolean; reason: string; target?: number }

/**
 * 改价之后过一段观察时间，如果花费朝着不希望的方向继续偏离，就建议改回原价。
 * 加价后更超支、或降价后更落后，都算「变差」。
 */
export function judgeRollback(a: { change: AppliedChange; snapshot: Snapshot; plan: Plan; now: number; observeMs?: number }): RollbackVerdict {
  const observe = a.observeMs ?? 30 * 60_000;
  const { change: c, snapshot: s } = a;
  if (!Number.isSafeInteger(s.spend)) return { rollback: false, reason: '数据缺失，暂不判断回滚' };
  if (a.now - c.at < observe) return { rollback: false, reason: `改价后观察不足 ${Math.round(observe / 60000)} 分钟，先观察` };
  if (s.bid !== c.after) return { rollback: false, reason: '当前出价已不是上次修改后的值，不再判断回滚' };
  let expected: number;
  try { expected = expectedSpend(a.plan, minuteOfDay(a.now)); } catch { return { rollback: false, reason: '无法计算计划花费，暂不判断回滚' }; }
  const gap = (s.spend as number) - expected;
  const tol = Math.max(DEFAULT_POLICY.minGap, a.plan.budget * DEFAULT_POLICY.minRatio);
  if (c.action === 'increase' && gap > tol && gap > c.gapAtChange) return { rollback: true, target: c.before, reason: `加价后花费反而比计划多出 ${yuan(gap)} 元，建议改回 ${yuan(c.before)} 元` };
  if (c.action === 'decrease' && gap < -tol && gap < c.gapAtChange) return { rollback: true, target: c.before, reason: `降价后花费落后计划 ${yuan(-gap)} 元且差距更大，建议改回 ${yuan(c.before)} 元` };
  return { rollback: false, reason: '改价后花费没有朝坏的方向偏离，保持' };
}

// ---------- 提交后核对 ----------

export type Reconcile = 'applied' | 'not-applied' | 'unknown';
/** 读回后台当前出价，判断上一次提交是否生效。超时、出价时段变了、价格对不上都不自动清除 */
export function reconcilePending(p: Pending, s: Snapshot, now: number, windowMs = 45 * 60_000): { result: Reconcile; reason: string } {
  if (!Number.isSafeInteger(s.bid)) return { result: 'unknown', reason: '读不到当前出价' };
  if ((p.scope ?? '') !== (s.scope ?? '')) return { result: 'unknown', reason: '出价时段已变化，请人工核对' };
  if (now - p.at > windowMs) return { result: 'unknown', reason: '超过 45 分钟，请人工核对' };
  if (s.bid === p.after) return { result: 'applied', reason: '回读到目标出价，已生效' };
  if (s.bid === p.before) return { result: 'not-applied', reason: '回读仍是原出价，未生效' };
  return { result: 'unknown', reason: `回读 ${yuan(s.bid)} 元，既不是原价也不是目标价，请人工核对` };
}

// ---------- 自动调价保护 ----------

export interface AutoSettings {
  /** 总开关，默认关闭 */
  enabled: boolean;
  /** 用户已看过风险说明并二次确认 */
  confirmed: boolean;
  /** 最高出价上限（分）。没填写时一律不自动改 */
  ceiling: number | null;
  /** 允许自动改的最低出价（分），不填用平台下限 */
  floor?: number | null;
  /** 单次最多改动（分） */
  maxStep: number;
  /** 每天最多自动改几次 */
  maxDaily: number;
}
export const DEFAULT_AUTO: AutoSettings = { enabled: false, confirmed: false, ceiling: null, floor: null, maxStep: 10, maxDaily: 6 };

/** 自动保存前的最后一道关：不满足任何一条都不能自动改。（独立于 suggest，防止上游漏判） */
export function canAutoApply(s: Suggestion, ledger: Ledger | null | undefined, a: AutoSettings, now: number, cooldownMs = DEFAULT_POLICY.cooldownMs): { ok: boolean; reason: string } {
  if (!a.enabled || !a.confirmed) return { ok: false, reason: '自动调价没有打开' };
  if (s.action !== 'increase' && s.action !== 'decrease') return { ok: false, reason: '当前没有需要修改的建议' };
  if (s.before == null || s.after == null) return { ok: false, reason: '建议缺少出价' };
  if (a.ceiling == null || !(a.ceiling > 0)) return { ok: false, reason: '没有设置最高出价上限' };
  if (s.after > a.ceiling) return { ok: false, reason: `建议出价 ${yuan(s.after)} 元超过你设置的最高出价上限 ${yuan(a.ceiling)} 元` };
  if (a.floor != null && s.after < a.floor) return { ok: false, reason: `建议出价低于你设置的最低出价 ${yuan(a.floor)} 元` };
  if (Math.abs(s.after - s.before) > a.maxStep) return { ok: false, reason: `单次改动超过你设置的步长 ${yuan(a.maxStep)} 元` };
  if (ledger?.pending) return { ok: false, reason: '上一次修改还没有核对' };
  if ((ledger?.changesToday ?? 0) >= a.maxDaily) return { ok: false, reason: `今天自动改价已达 ${a.maxDaily} 次上限` };
  if (s.action === 'increase' && ledger?.lastAdjustmentAt != null && now - ledger.lastAdjustmentAt < cooldownMs) return { ok: false, reason: '加价冷却中' };
  return { ok: true, reason: '通过全部保护' };
}
