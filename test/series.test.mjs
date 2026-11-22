import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUsageSeries } from '../sidecars/context_monitor/main.mjs';

test('buildUsageSeries dynamically picks hour, day, week, month, and year granularity', () => {
  const hourlyMap = {
    '2026-11-20 09': { tokens: 5000, inputTokens: 4000, cacheReadTokens: 800, outputTokens: 200, models: {} },
    '2026-11-20 21': { tokens: 12000, inputTokens: 2000, cacheReadTokens: 9500, outputTokens: 500, models: {} },
  };
  const sToday = buildUsageSeries({ range: 'today', startKey: '2026-11-20', endKey: '2026-11-20', dailyMap: {}, hourlyMap });
  assert.equal(sToday.granularity, 'hour');
  assert.equal(sToday.points.length, 24);
  assert.equal(sToday.points[9].tokens, 5000);
  assert.equal(sToday.points[21].tokens, 12000);

  const s7d = buildUsageSeries({ range: '7d', startKey: '2026-11-14', endKey: '2026-11-20', dailyMap: {}, hourlyMap: {} });
  assert.equal(s7d.granularity, 'day');
  assert.equal(s7d.points.length, 7);

  const s30d = buildUsageSeries({ range: '30d', startKey: '2026-10-22', endKey: '2026-11-20', dailyMap: {}, hourlyMap: {} });
  assert.equal(s30d.granularity, 'day');
  assert.equal(s30d.points.length, 30);

  const sAllWeek = buildUsageSeries({
    range: 'all',
    dailyMap: { '2026-08-01': { tokens: 100, models: {} }, '2026-11-20': { tokens: 200, models: {} } },
    hourlyMap: {},
    minDateKey: '2026-08-01',
    maxDateKey: '2026-11-20',
  });
  assert.equal(sAllWeek.granularity, 'week');
  assert.ok(sAllWeek.points.length >= 15 && sAllWeek.points.length <= 20);

  const sAllMonth = buildUsageSeries({
    range: 'all',
    dailyMap: { '2025-11-01': { tokens: 100, models: {} }, '2026-11-20': { tokens: 200, models: {} } },
    hourlyMap: {},
    minDateKey: '2025-11-01',
    maxDateKey: '2026-11-20',
  });
  assert.equal(sAllMonth.granularity, 'month');
  assert.equal(sAllMonth.points.length, 13);

  const sAllYear = buildUsageSeries({
    range: 'all',
    dailyMap: { '2023-01-10': { tokens: 100, models: {} }, '2026-11-20': { tokens: 200, models: {} } },
    hourlyMap: {},
    minDateKey: '2023-01-10',
    maxDateKey: '2026-11-20',
  });
  assert.equal(sAllYear.granularity, 'year');
  assert.equal(sAllYear.points.length, 4);
});
