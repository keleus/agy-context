/**
 * Date utilities and adaptive time-series bucketing (hour / day / week / month / year).
 */

export function toLocalDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDateKey(dk) {
  const [y, m, d] = dk.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(dateObj, n) {
  return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate() + n);
}

export function diffDays(startDk, endDk) {
  if (!startDk || !endDk) return 0;
  const a = parseDateKey(startDk).getTime();
  const b = parseDateKey(endDk).getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function mondayOf(dateObj) {
  const dow = (dateObj.getDay() + 6) % 7; // Mon=0..Sun=6
  return addDays(dateObj, -dow);
}

export function mergeUsageInto(target, src) {
  target.tokens += src.tokens || 0;
  target.inputTokens += src.inputTokens || 0;
  target.cacheReadTokens += src.cacheReadTokens || 0;
  target.outputTokens += src.outputTokens || 0;
  for (const [m, mv] of Object.entries(src.models || {})) {
    if (!target.models[m]) target.models[m] = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
    target.models[m].inputTokens += mv.inputTokens || 0;
    target.models[m].cacheReadTokens += mv.cacheReadTokens || 0;
    target.models[m].outputTokens += mv.outputTokens || 0;
  }
}

function emptyUsagePoint(key, label, fullLabel, dateKey = '') {
  return {
    key,
    label,
    fullLabel,
    dateKey,
    tokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    models: {},
  };
}

function buildHourlySeries(targetDate, hourlyMap) {
  const points = [];
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0');
    const key = `${targetDate} ${hh}`;
    const pt = emptyUsagePoint(key, `${hh}:00`, `${targetDate} ${hh}:00–${hh}:59`, '');
    if (hourlyMap[key]) mergeUsageInto(pt, hourlyMap[key]);
    points.push(pt);
  }
  return { granularity: 'hour', points };
}

function buildDailySeries(startDateKey, endDateKey, dailyMap) {
  const points = [];
  let cur = parseDateKey(startDateKey);
  const end = parseDateKey(endDateKey);
  let guard = 0;
  while (cur <= end && guard < 400) {
    const dk = toLocalDateKey(cur);
    const pt = emptyUsagePoint(dk, dk.slice(5), dk, dk);
    if (dailyMap[dk]) mergeUsageInto(pt, dailyMap[dk]);
    points.push(pt);
    cur = addDays(cur, 1);
    guard++;
  }
  return { granularity: 'day', points };
}

function buildWeeklySeries(startDateKey, endDateKey, dailyMap) {
  const buckets = new Map();
  let cur = mondayOf(parseDateKey(startDateKey));
  const endMonday = mondayOf(parseDateKey(endDateKey));
  let guard = 0;
  while (cur <= endMonday && guard < 120) {
    const wkStart = toLocalDateKey(cur);
    const wkEnd = toLocalDateKey(addDays(cur, 6));
    buckets.set(wkStart, emptyUsagePoint(wkStart, wkStart.slice(5), `${wkStart} ~ ${wkEnd}`, ''));
    cur = addDays(cur, 7);
    guard++;
  }
  for (const [dk, entry] of Object.entries(dailyMap)) {
    const wkStart = toLocalDateKey(mondayOf(parseDateKey(dk)));
    if (!buckets.has(wkStart)) {
      const wkEnd = toLocalDateKey(addDays(parseDateKey(wkStart), 6));
      buckets.set(wkStart, emptyUsagePoint(wkStart, wkStart.slice(5), `${wkStart} ~ ${wkEnd}`, ''));
    }
    mergeUsageInto(buckets.get(wkStart), entry);
  }
  return { granularity: 'week', points: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

function buildMonthlySeries(startDateKey, endDateKey, dailyMap) {
  const buckets = new Map();
  const s = parseDateKey(startDateKey);
  const e = parseDateKey(endDateKey);
  let y = s.getFullYear();
  let m = s.getMonth();
  const endY = e.getFullYear();
  const endM = e.getMonth();
  let guard = 0;
  while ((y < endY || (y === endY && m <= endM)) && guard < 120) {
    const mk = `${y}-${String(m + 1).padStart(2, '0')}`;
    buckets.set(mk, emptyUsagePoint(mk, mk, mk, ''));
    m++;
    if (m >= 12) { m = 0; y++; }
    guard++;
  }
  for (const [dk, entry] of Object.entries(dailyMap)) {
    const mk = dk.slice(0, 7);
    if (!buckets.has(mk)) buckets.set(mk, emptyUsagePoint(mk, mk, mk, ''));
    mergeUsageInto(buckets.get(mk), entry);
  }
  return { granularity: 'month', points: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

function buildYearlySeries(startDateKey, endDateKey, dailyMap) {
  const buckets = new Map();
  const sY = parseDateKey(startDateKey).getFullYear();
  const eY = parseDateKey(endDateKey).getFullYear();
  for (let y = sY; y <= eY; y++) {
    const yk = String(y);
    buckets.set(yk, emptyUsagePoint(yk, yk, yk, ''));
  }
  for (const [dk, entry] of Object.entries(dailyMap)) {
    const yk = dk.slice(0, 4);
    if (!buckets.has(yk)) buckets.set(yk, emptyUsagePoint(yk, yk, yk, ''));
    mergeUsageInto(buckets.get(yk), entry);
  }
  return { granularity: 'year', points: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

/**
 * Selects optimal time-series granularity for the active range:
 *   - today / single date -> 24 hourly buckets
 *   - 7d -> 7 daily buckets
 *   - 30d -> 30 daily buckets
 *   - all -> adaptive by actual data span:
 *       <= 1d: hour | <= 35d: day | <= 180d: week | <= 730d: month | > 730d: year
 */
export function buildUsageSeries({ range, startKey, endKey, dailyMap, hourlyMap, minDateKey, maxDateKey }) {
  const todayKey = toLocalDateKey(new Date());

  if (range === 'today' || range === 'date') {
    return buildHourlySeries(startKey || todayKey, hourlyMap);
  }
  if (range === '7d' || range === '30d') {
    const days = range === '7d' ? 6 : 29;
    const s = startKey || toLocalDateKey(addDays(new Date(), -days));
    const e = endKey || todayKey;
    return buildDailySeries(s, e, dailyMap);
  }

  const sKey = (range === 'custom' ? startKey : '') || minDateKey || todayKey;
  const eKey = (range === 'custom' ? endKey : '') || maxDateKey || sKey;
  const span = diffDays(sKey, eKey);
  if (span <= 1 && sKey === eKey) {
    return buildHourlySeries(sKey, hourlyMap);
  }
  if (span <= 35) {
    return buildDailySeries(sKey, eKey, dailyMap);
  }
  if (span <= 180) {
    return buildWeeklySeries(sKey, eKey, dailyMap);
  }
  if (span <= 730) {
    return buildMonthlySeries(sKey, eKey, dailyMap);
  }
  return buildYearlySeries(sKey, eKey, dailyMap);
}

export function resolveDateBounds(range, exactDate, customStart = '', customEnd = '') {
  const now = new Date();
  const todayKey = toLocalDateKey(now);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (exactDate && DATE_RE.test(exactDate)) {
    return { startKey: exactDate, endKey: exactDate, range: 'date' };
  }
  const hasStart = DATE_RE.test(customStart);
  const hasEnd = DATE_RE.test(customEnd);
  if (range === 'custom' || hasStart || hasEnd) {
    if (hasStart && hasEnd) {
      const sKey = customStart <= customEnd ? customStart : customEnd;
      const eKey = customStart <= customEnd ? customEnd : customStart;
      return { startKey: sKey, endKey: eKey, range: 'custom' };
    }
    return {
      startKey: hasStart ? customStart : '',
      endKey: hasEnd ? customEnd : '',
      range: 'custom',
    };
  }
  if (range === 'today') {
    return { startKey: todayKey, endKey: todayKey, range: 'today' };
  }
  if (range === '7d') {
    return { startKey: toLocalDateKey(addDays(now, -6)), endKey: todayKey, range: '7d' };
  }
  if (range === '30d') {
    return { startKey: toLocalDateKey(addDays(now, -29)), endKey: todayKey, range: '30d' };
  }
  return { startKey: '', endKey: '', range: 'all' };
}
