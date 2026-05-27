const fp = require('fastify-plugin');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const PERIOD_CONFIG = {
  h: {
    label: '时',
    cronTime: '1 * * * *',
    truncateTime: date => dayjs(date).startOf('hour').toDate(),
    getPrevStart: endTime => dayjs(endTime).subtract(1, 'hour').toDate(),
    getNextStart: startTime => dayjs(startTime).add(1, 'hour').toDate()
  },
  d: {
    label: '日',
    cronTime: '1 0 * * *',
    truncateTime: date => dayjs(date).startOf('day').toDate(),
    getPrevStart: endTime => dayjs(endTime).subtract(1, 'day').toDate(),
    getNextStart: startTime => dayjs(startTime).add(1, 'day').toDate()
  },
  w: {
    label: '周',
    cronTime: '1 0 * * 1',
    truncateTime: date => dayjs(date).startOf('week').add(1, 'day').startOf('day').toDate(),
    getPrevStart: endTime => dayjs(endTime).subtract(7, 'day').toDate(),
    getNextStart: startTime => dayjs(startTime).add(7, 'day').toDate()
  },
  m: {
    label: '月',
    cronTime: '1 0 1 * *',
    truncateTime: date => dayjs(date).startOf('month').toDate(),
    getPrevStart: endTime => dayjs(endTime).subtract(1, 'month').startOf('month').toDate(),
    getNextStart: startTime => dayjs(startTime).add(1, 'month').startOf('month').toDate()
  },
  q: {
    label: '季',
    cronTime: '1 0 1 1,4,7,10 *',
    truncateTime: date => {
      const d = dayjs(date);
      return d
        .month(Math.floor(d.month() / 3) * 3)
        .startOf('month')
        .toDate();
    },
    getPrevStart: endTime => dayjs(endTime).subtract(3, 'month').startOf('month').toDate(),
    getNextStart: startTime => dayjs(startTime).add(3, 'month').startOf('month').toDate()
  },
  y: {
    label: '年',
    cronTime: '1 0 1 1 *',
    truncateTime: date => dayjs(date).startOf('year').toDate(),
    getPrevStart: endTime => dayjs(endTime).subtract(1, 'year').startOf('year').toDate(),
    getNextStart: startTime => dayjs(startTime).add(1, 'year').startOf('year').toDate()
  }
};

const PERIOD_DEPENDENCY = {
  h: { source: 'data-record' },
  d: { source: 'period-stat', fromPeriod: 'h' },
  w: { source: 'period-stat', fromPeriod: 'd' },
  m: { source: 'period-stat', fromPeriod: 'd' },
  q: { source: 'period-stat', fromPeriod: 'm' },
  y: { source: 'period-stat', fromPeriod: 'q' }
};

const AGGREGATE_TYPES = [
  { key: 'sum', fn: 'SUM', label: '合计' },
  { key: 'avg', fn: 'AVG', label: '平均' },
  { key: 'count', fn: 'COUNT', label: '计数' },
  { key: 'min', fn: 'MIN', label: '最小' },
  { key: 'max', fn: 'MAX', label: '最大' }
];

const UPSERT_FIELDS = ['data', 'unit'];
const escapeLike = str => str.replace(/[%_\\]/g, '\\$&');

const createHashKey = obj => {
  const sorted = Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      const val = obj[key];
      acc[key] = Array.isArray(val) ? [...val].sort() : val;
      return acc;
    }, {});
  return JSON.stringify(sorted);
};

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const { Op, fn, col } = fastify.sequelize.Sequelize;
  const sequelize = fastify.sequelize.instance;

  const externalCache = options.cache ?? null;
  const queryCacheEnabled = options.queryCacheEnabled !== false;
  const queryCacheTTL = options.queryCacheTTL ?? 30;
  const queryCacheHistoryTTL = options.queryCacheHistoryTTL ?? 3600;
  const queryCacheMaxEntries = options.queryCacheMaxEntries ?? 100;

  const QUERY_CACHE_PREFIX = `${options.name || 'statistics'}:query:`;
  let globalVersion = 0;
  const channelVersions = new Map();

  const getChannelVersion = ch => channelVersions.get(ch) || 0;

  const memoryCacheStore = externalCache ? null : new Map();
  const queryCacheGet = async key => {
    if (externalCache) {
      const payload = await externalCache.get(QUERY_CACHE_PREFIX + key);
      if (!payload || typeof payload !== 'object' || !('value' in payload)) return null;
      if (payload.channelVersions) {
        if (payload.globalVersion !== undefined && payload.globalVersion !== globalVersion) {
          return null;
        }
        for (const [ch, ver] of Object.entries(payload.channelVersions)) {
          if (getChannelVersion(ch) !== ver) return null;
        }
      }
      return payload.value;
    }
    const entry = memoryCacheStore.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expireAt) {
      memoryCacheStore.delete(key);
      return null;
    }
    // Version check before LRU promotion
    if (entry.channelVersions) {
      if (entry.globalVersion !== undefined && entry.globalVersion !== globalVersion) {
        memoryCacheStore.delete(key);
        return null;
      }
      for (const [ch, ver] of Object.entries(entry.channelVersions)) {
        if (getChannelVersion(ch) !== ver) {
          memoryCacheStore.delete(key);
          return null;
        }
      }
    }
    // LRU: move to end on access
    memoryCacheStore.delete(key);
    memoryCacheStore.set(key, entry);
    return entry.value;
  };

  const queryCacheSet = async (key, value, ttl, channelList) => {
    if (externalCache) {
      const payload = channelList ? { value, channelVersions: Object.fromEntries(channelList.map(ch => [ch, getChannelVersion(ch)])) } : { value };
      if (channelList && channelList.length === 0) {
        payload.globalVersion = globalVersion;
      }
      if (typeof externalCache.set === 'function' && externalCache.set.length >= 3) {
        await externalCache.set(QUERY_CACHE_PREFIX + key, payload, ttl);
      } else {
        await externalCache.set(QUERY_CACHE_PREFIX + key, payload);
      }
      return;
    }
    if (memoryCacheStore.size >= queryCacheMaxEntries) {
      const oldest = memoryCacheStore.keys().next().value;
      memoryCacheStore.delete(oldest);
    }
    const entry = { value, expireAt: Date.now() + ttl * 1000 };
    if (channelList) {
      entry.channelVersions = Object.fromEntries(channelList.map(ch => [ch, getChannelVersion(ch)]));
      if (channelList.length === 0) {
        entry.globalVersion = globalVersion;
      }
    }
    memoryCacheStore.set(key, entry);
  };

  const invalidateQueryCache = (channels = []) => {
    globalVersion++;
    for (const ch of channels) {
      const parts = ch.split(':');
      for (let i = parts.length; i >= 1; i--) {
        const prefix = parts.slice(0, i).join(':');
        channelVersions.set(prefix, (channelVersions.get(prefix) || 0) + 1);
      }
    }
  };

  const aggregateFromDataRecord = async (period, startTime, endTime) => {
    const results = await models.dataRecord.findAll({
      attributes: ['channel', 'attributeName', [fn('MAX', col('unit')), 'unit'], ...AGGREGATE_TYPES.map(({ key, fn: aggFn }) => [fn(aggFn, col('data')), key])],
      where: {
        time: { [Op.between]: [startTime, endTime] }
      },
      group: ['channel', 'attributeName'],
      raw: true
    });

    const records = [];
    for (const row of results) {
      for (const { key } of AGGREGATE_TYPES) {
        const value = row[key];
        if (value === null || value === undefined) continue;
        records.push({
          period,
          time: startTime,
          channel: row.channel,
          attributeName: row.attributeName,
          aggregate: key,
          data: parseFloat(value),
          unit: row.unit
        });
      }
    }

    if (records.length > 0) {
      const transaction = await sequelize.transaction();
      try {
        await models.periodStat.bulkCreate(records, { transaction, updateOnDuplicate: UPSERT_FIELDS });
        await transaction.commit();
      } catch (e) {
        await transaction.rollback();
        throw e;
      }
    }

    return records;
  };

  const aggregateFromPeriodStat = async (period, fromPeriod, startTime, endTime) => {
    const rows = await models.periodStat.findAll({
      where: {
        period: fromPeriod,
        time: { [Op.between]: [startTime, endTime] }
      },
      raw: true
    });

    const grouped = {};
    for (const row of rows) {
      const key = JSON.stringify([row.channel, row.attributeName || '']);
      if (!grouped[key]) {
        grouped[key] = {
          channel: row.channel,
          attributeName: row.attributeName,
          items: []
        };
      }
      grouped[key].items.push(row);
    }

    const records = [];
    for (const group of Object.values(grouped)) {
      const items = group.items;
      const sums = items.filter(i => i.aggregate === 'sum').map(i => i.data);
      const counts = items.filter(i => i.aggregate === 'count').map(i => i.data);
      const mins = items.filter(i => i.aggregate === 'min').map(i => i.data);
      const maxs = items.filter(i => i.aggregate === 'max').map(i => i.data);

      const base = {
        period,
        time: startTime,
        channel: group.channel,
        attributeName: group.attributeName,
        unit: group.items[0]?.unit || null
      };

      const sumTotal = sums.length > 0 ? sums.reduce((a, b) => a + b, 0) : 0;
      const countTotal = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : 0;

      if (sums.length > 0) {
        records.push({ ...base, aggregate: 'sum', data: sumTotal });
      }
      if (counts.length > 0) {
        records.push({ ...base, aggregate: 'count', data: countTotal });
      }
      if (sums.length > 0 && counts.length > 0) {
        records.push({
          ...base,
          aggregate: 'avg',
          data: sumTotal / countTotal
        });
      }
      if (mins.length > 0) {
        records.push({ ...base, aggregate: 'min', data: mins.reduce((a, b) => Math.min(a, b), Infinity) });
      }
      if (maxs.length > 0) {
        records.push({ ...base, aggregate: 'max', data: maxs.reduce((a, b) => Math.max(a, b), -Infinity) });
      }
    }

    if (records.length > 0) {
      const transaction = await sequelize.transaction();
      try {
        await models.periodStat.bulkCreate(records, { transaction, updateOnDuplicate: UPSERT_FIELDS });
        await transaction.commit();
      } catch (e) {
        await transaction.rollback();
        throw e;
      }
    }

    return records;
  };

  const aggregate = async (period, { startTime, endTime } = {}) => {
    const config = PERIOD_CONFIG[period];
    if (!config) {
      throw new Error(`Unsupported period: ${period}, supported: ${Object.keys(PERIOD_CONFIG).join(',')}`);
    }

    if (!startTime || !endTime) {
      const now = dayjs();
      endTime = config.truncateTime(now);
      startTime = config.getPrevStart(endTime);
    }

    const dependency = PERIOD_DEPENDENCY[period];
    if (dependency.source === 'data-record') {
      return aggregateFromDataRecord(period, startTime, endTime);
    }
    return aggregateFromPeriodStat(period, dependency.fromPeriod, startTime, endTime);
  };

  const PERIOD_ORDER = ['h', 'd', 'w', 'm', 'q', 'y'];

  const compensationBatchSize = options.compensationBatchSize ?? 24;

  const getWatermark = async period => {
    const row = await models.aggregationWatermark.findOne({ where: { period } });
    return row ? row.nextTime : null;
  };

  const setWatermark = async (period, nextTime) => {
    await models.aggregationWatermark.upsert({ period, nextTime });
  };

  const initWatermark = async period => {
    const config = PERIOD_CONFIG[period];
    const dependency = PERIOD_DEPENDENCY[period];

    const existing = await getWatermark(period);
    if (existing) return existing;

    let minTime = null;
    if (dependency.source === 'data-record') {
      const row = await models.dataRecord.findOne({
        attributes: [[fn('MIN', col('time')), 'minTime']],
        raw: true
      });
      minTime = row?.minTime;
    } else {
      const row = await models.periodStat.findOne({
        attributes: [[fn('MIN', col('time')), 'minTime']],
        where: { period: dependency.fromPeriod },
        raw: true
      });
      minTime = row?.minTime;
    }

    const nextTime = minTime ? config.truncateTime(new Date(minTime)) : config.truncateTime(new Date());
    await setWatermark(period, nextTime);
    return nextTime;
  };

  const compensatingLocks = {};
  let startupCompensating = false;
  const isCompensating = () => startupCompensating || Object.values(compensatingLocks).some(v => v);

  const compensate = async period => {
    if (compensatingLocks[period]) return;
    compensatingLocks[period] = true;
    try {
      const config = PERIOD_CONFIG[period];
      const dependency = PERIOD_DEPENDENCY[period];

      let nextTime = await initWatermark(period);
      const nowTruncated = config.truncateTime(new Date());

      let count = 0;
      while (nextTime < nowTruncated && count < compensationBatchSize) {
        const endTime = config.getNextStart(nextTime);

        if (dependency.source === 'period-stat') {
          const upstreamNext = await getWatermark(dependency.fromPeriod);
          if (!upstreamNext || new Date(upstreamNext) < new Date(endTime)) {
            await compensate(dependency.fromPeriod);
          }
        }

        try {
          await aggregate(period, { startTime: nextTime, endTime });
        } catch (e) {
          fastify.log.error(`Failed to compensate period ${period} [${nextTime.toISOString()} - ${endTime.toISOString()}]: ${e.message}`);
          break;
        }

        nextTime = endTime;
        await setWatermark(period, nextTime);
        count++;
      }

      if (nextTime < nowTruncated) {
        fastify.log.warn(`period=${period} 补偿未完成，已补 ${count} 个窗口，下次继续`);
      } else if (count > 1) {
        fastify.log.info(`period=${period} 补偿完成，共补 ${count} 个窗口`);
      }
    } finally {
      compensatingLocks[period] = false;
    }
  };

  if (options.compensationEnabled !== false) {
    startupCompensating = true;
    (async () => {
      try {
        for (const period of PERIOD_ORDER) {
          await compensate(period);
        }
      } catch (e) {
        fastify.log.error(`Startup compensation failed: ${e.message}`);
      } finally {
        startupCompensating = false;
      }
    })();
  }

  if (fastify.cron) {
    for (const [period, config] of Object.entries(PERIOD_CONFIG)) {
      fastify.cron.createJob({
        name: `statistics-period-stat-${period}`,
        cronTime: config.cronTime,
        onTick: async () => {
          try {
            await compensate(period);
          } catch (e) {
            fastify.log.error(`Failed to compensate period ${period}: ${e.message}`);
          }
        },
        startWhenReady: true
      });
    }
  }

  const formatGroupData = items => {
    const aggSet = new Set();
    const unitMap = {};
    for (const item of items) {
      aggSet.add(item.aggregate);
      if (item.unit !== undefined && item.unit !== null && !((item.attributeName || 'default') in unitMap)) {
        unitMap[item.attributeName || 'default'] = item.unit;
      }
    }

    const hasMultipleAggregates = aggSet.size > 1;

    let data;
    if (hasMultipleAggregates) {
      data = {};
      for (const item of items) {
        if (!data[item.aggregate]) data[item.aggregate] = {};
        data[item.aggregate][item.attributeName || 'default'] = item.data;
      }
    } else {
      data = {};
      for (const item of items) {
        data[item.attributeName || 'default'] = item.data;
      }
    }

    const result = { data };

    const unitEntries = Object.entries(unitMap).filter(([, v]) => v !== undefined && v !== null);
    if (unitEntries.length > 0) {
      result.unit = Object.fromEntries(unitEntries);
    }

    return result;
  };

  const buildChannelTree = (flatResults, queriedChannels) => {
    const channelGroups = {};
    for (const item of flatResults) {
      if (!channelGroups[item.channel]) {
        channelGroups[item.channel] = [];
      }
      channelGroups[item.channel].push(item);
    }

    const buildNode = channel => {
      const items = channelGroups[channel] || [];

      const node = { channel };
      if (items.length > 0) {
        node.items = items.map(({ period, time, data, unit }) => {
          const entry = { period, time, data };
          if (unit !== undefined) entry.unit = unit;
          return entry;
        });
      }

      const prefix = channel + ':';
      const directChildren = Object.keys(channelGroups)
        .filter(ch => {
          if (!ch.startsWith(prefix)) return false;
          const rest = ch.slice(prefix.length);
          return !rest.includes(':');
        })
        .sort();

      if (directChildren.length > 0) {
        node.children = directChildren.map(ch => buildNode(ch)).filter(Boolean);
      }

      return items.length > 0 || (node.children && node.children.length > 0) ? node : null;
    };

    const tree = [];
    for (const rootChannel of queriedChannels) {
      const node = buildNode(rootChannel);
      if (node) tree.push(node);
    }

    return tree;
  };

  const query = async ({ channels, startTime, endTime, attributeNames, aggregates: queryAggregates, timezone: tz, includeChildren }) => {
    const aggregateList = queryAggregates && queryAggregates.length > 0 ? queryAggregates : AGGREGATE_TYPES.map(a => a.key);

    if (tz) {
      try {
        dayjs().tz(tz);
      } catch {
        throw new Error(`Invalid timezone: ${tz}`);
      }
    }

    const channelList = Array.isArray(channels) ? channels : channels ? [channels] : [];
    const now = tz ? dayjs().tz(tz) : dayjs();
    const currentHourStart = now.startOf('hour').toDate();
    const isRealtime = dayjs(endTime).isAfter(currentHourStart);

    // Query cache
    if (queryCacheEnabled && !isCompensating()) {
      const cacheKey = createHashKey({
        channels: channelList,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        attributeNames: attributeNames || [],
        aggregates: aggregateList,
        timezone: tz || '',
        includeChildren: !!includeChildren
      });

      const cached = await queryCacheGet(cacheKey);
      if (cached !== null && cached !== undefined) {
        return cached;
      }

      const result = await doQuery({ channelList, startTime, endTime, attributeNames, aggregateList, tz, includeChildren, currentHourStart, isRealtime });
      const ttl = isRealtime ? queryCacheTTL : queryCacheHistoryTTL;
      await queryCacheSet(cacheKey, result, ttl, isRealtime ? channelList : null);
      return result;
    }

    return await doQuery({ channelList, startTime, endTime, attributeNames, aggregateList, tz, includeChildren, currentHourStart, isRealtime });
  };

  const doQuery = async ({ channelList, startTime, endTime, attributeNames, aggregateList, tz, includeChildren, currentHourStart, isRealtime }) => {
    const channelWhere =
      channelList.length > 0
        ? includeChildren
          ? {
              [Op.or]: channelList.flatMap(ch => [{ channel: ch }, { channel: { [Op.like]: `${escapeLike(ch)}:%` } }])
            }
          : { channel: { [Op.in]: channelList } }
        : {};

    const attrWhere = attributeNames && attributeNames.length > 0 ? { attributeName: { [Op.in]: attributeNames } } : {};

    const allRecords = [];

    const records = await models.periodStat.findAll({
      where: {
        ...channelWhere,
        ...attrWhere,
        period: { [Op.in]: Object.keys(PERIOD_CONFIG) },
        time: { [Op.between]: [startTime, endTime] },
        aggregate: { [Op.in]: aggregateList }
      },
      raw: true
    });
    allRecords.push(...records);

    const endTimeDayjs = dayjs(endTime);

    if (isRealtime) {
      const startTimeDayjs = dayjs(startTime);
      const drStartTime = startTimeDayjs.isAfter(currentHourStart) ? startTimeDayjs.toDate() : currentHourStart;

      const drWhere = {
        ...channelWhere,
        ...attrWhere,
        time: { [Op.between]: [drStartTime, endTimeDayjs.toDate()] }
      };

      const dataRecords = await models.dataRecord.findAll({
        attributes: ['channel', 'attributeName', [fn('MAX', col('unit')), 'unit'], ...AGGREGATE_TYPES.filter(a => aggregateList.includes(a.key)).map(({ key, fn: aggFn }) => [fn(aggFn, col('data')), key])],
        where: drWhere,
        group: ['channel', 'attributeName'],
        raw: true
      });

      for (const row of dataRecords) {
        for (const { key } of AGGREGATE_TYPES.filter(a => aggregateList.includes(a.key))) {
          const value = row[key];
          if (value === null || value === undefined) continue;
          allRecords.push({
            period: 'h',
            time: currentHourStart,
            channel: row.channel,
            attributeName: row.attributeName || 'default',
            aggregate: key,
            data: parseFloat(value),
            unit: row.unit
          });
        }
      }
    }

    const grouped = {};
    for (const record of allRecords) {
      const timeKey = dayjs(record.time).toISOString();
      const key = `${record.channel}|${record.period}|${timeKey}`;
      if (!grouped[key]) {
        grouped[key] = {
          channel: record.channel,
          period: record.period,
          time: record.time,
          _items: []
        };
      }
      grouped[key]._items.push(record);
    }

    const results = [];
    for (const group of Object.values(grouped)) {
      const { data, unit } = formatGroupData(group._items);
      const item = {
        channel: group.channel,
        period: group.period,
        time: group.time,
        data
      };
      if (unit !== undefined) item.unit = unit;
      results.push(item);
    }

    results.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    const rootChannelSet = new Set();
    for (const r of results) {
      rootChannelSet.add(r.channel.split(':')[0]);
    }

    let channelMetas = {};
    if (rootChannelSet.size > 0) {
      const metas = await models.channelMeta.findAll({
        where: { channel: { [Op.in]: [...rootChannelSet] } },
        raw: true
      });
      for (const meta of metas) {
        channelMetas[meta.channel] = meta;
      }
    }

    const list = includeChildren ? buildChannelTree(results, channelList) : results;

    return { channelMetas, list };
  };

  Object.assign(fastify[options.name].services, {
    query,
    periodStat: {
      aggregate,
      query,
      isCompensating,
      invalidateQueryCache
    }
  });
});
