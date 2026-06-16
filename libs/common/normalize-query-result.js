const AGGREGATE_KEYS = ['sum', 'avg', 'count', 'min', 'max'];

const normalizeAttributeName = attributeName => {
  if (!attributeName || attributeName === 'default') {
    return '';
  }
  return attributeName;
};

/**
 * 将 query list（扁平或树形 item）规范化为 FlatRecord[]
 */
const normalizeToFlatRecords = (list, requestedAggregates) => {
  const records = [];
  if (!Array.isArray(list)) {
    return records;
  }

  const aggregateKeys = requestedAggregates?.length ? requestedAggregates : AGGREGATE_KEYS;

  for (const item of list) {
    const { channel, period, time, data, unit } = item;
    if (!data || typeof data !== 'object') {
      continue;
    }

    const isNestedByAggregate = aggregateKeys.some(key => Object.prototype.hasOwnProperty.call(data, key) && data[key] && typeof data[key] === 'object');

    if (isNestedByAggregate) {
      for (const agg of aggregateKeys) {
        const attrs = data[agg];
        if (!attrs || typeof attrs !== 'object') {
          continue;
        }
        for (const [attributeName, value] of Object.entries(attrs)) {
          if (value === null || value === undefined) {
            continue;
          }
          records.push({
            channel,
            period,
            time,
            attributeName: normalizeAttributeName(attributeName),
            aggregate: agg,
            data: Number(value),
            unit: typeof unit === 'object' ? unit[attributeName] : unit
          });
        }
      }
      continue;
    }

    const agg = aggregateKeys.length === 1 ? aggregateKeys[0] : 'sum';
    for (const [attributeName, value] of Object.entries(data)) {
      if (value === null || value === undefined) {
        continue;
      }
      records.push({
        channel,
        period,
        time,
        attributeName: normalizeAttributeName(attributeName),
        aggregate: agg,
        data: Number(value),
        unit: typeof unit === 'object' ? unit[attributeName] : unit
      });
    }
  }

  return records;
};

const rollupTotals = records => {
  const totals = {};
  const totalsByChannel = {};
  const maxByChannel = {};
  const attrStats = {};

  for (const record of records) {
    const { channel, attributeName, aggregate, data } = record;
    const attr = attributeName || 'default';
    const value = Number(data);
    if (Number.isNaN(value)) {
      continue;
    }

    if (aggregate === 'sum') {
      totals[attr] = (totals[attr] || 0) + value;
      if (!totalsByChannel[channel]) {
        totalsByChannel[channel] = {};
      }
      totalsByChannel[channel][attr] = (totalsByChannel[channel][attr] || 0) + value;
    }

    if (aggregate === 'max') {
      if (!maxByChannel[channel]) {
        maxByChannel[channel] = {};
      }
      maxByChannel[channel][attr] = Math.max(maxByChannel[channel][attr] ?? 0, value);
    }

    if (['sum', 'max', 'count'].includes(aggregate)) {
      if (!attrStats[attr]) {
        attrStats[attr] = { sum: 0, max: 0, count: 0 };
      }
      if (aggregate === 'sum') {
        attrStats[attr].sum += value;
      } else if (aggregate === 'max') {
        attrStats[attr].max = Math.max(attrStats[attr].max, value);
      } else if (aggregate === 'count') {
        attrStats[attr].count += value;
      }
    }
  }

  return { totals, totalsByChannel, maxByChannel, attrStats };
};

const summarizeWindows = records => {
  const map = new Map();
  for (const record of records) {
    const key = `${record.period}|${new Date(record.time).toISOString()}`;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Array.from(map.entries()).map(([key, count]) => {
    const [period, time] = key.split('|');
    return { period, time, count };
  });
};

module.exports = {
  AGGREGATE_KEYS,
  normalizeToFlatRecords,
  rollupTotals,
  summarizeWindows
};
