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
    const transaction = await sequelize.transaction();
    try {
      // 使用 [startTime, endTime) 左闭右开区间，endTime 是下一窗口起始，不应包含
      const timeRange = { [Op.gte]: startTime, [Op.lt]: endTime };

      const results = await models.dataRecord.findAll({
        attributes: ['channel', 'attributeName', [fn('MAX', col('unit')), 'unit'], ...AGGREGATE_TYPES.map(({ key, fn: aggFn }) => [fn(aggFn, col('data')), key])],
        where: {
          time: timeRange
        },
        group: ['channel', 'attributeName'],
        raw: true,
        transaction
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
        await models.periodStat.bulkCreate(records, { transaction, updateOnDuplicate: UPSERT_FIELDS });
      }

      // 聚合完成后删除已聚合的源数据
      await models.dataRecord.destroy({
        where: {
          time: timeRange
        },
        transaction
      });

      await transaction.commit();
      return records;
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  };

  const aggregateFromPeriodStat = async (period, fromPeriod, startTime, endTime) => {
    // 使用 [startTime, endTime) 左闭右开区间，endTime 是下一窗口起始，不应包含
    const rows = await models.periodStat.findAll({
      where: {
        period: fromPeriod,
        time: { [Op.gte]: startTime, [Op.lt]: endTime }
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
      const sums = items.filter(i => i.aggregate === 'sum').map(i => parseFloat(i.data));
      const counts = items.filter(i => i.aggregate === 'count').map(i => parseFloat(i.data));
      const mins = items.filter(i => i.aggregate === 'min').map(i => parseFloat(i.data));
      const maxs = items.filter(i => i.aggregate === 'max').map(i => parseFloat(i.data));

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
    const existing = await models.aggregationWatermark.findOne({ where: { period } });
    if (existing) {
      await existing.update({ nextTime });
    } else {
      await models.aggregationWatermark.create({ period, nextTime });
    }
  };

  const determineStartFromSource = async period => {
    const config = PERIOD_CONFIG[period];
    const dependency = PERIOD_DEPENDENCY[period];

    if (dependency.source === 'data-record') {
      // h 周期：从 data-record 的最早记录开始
      const row = await models.dataRecord.findOne({
        attributes: [[fn('MIN', col('time')), 'minTime']],
        raw: true
      });
      return row?.minTime ? config.truncateTime(new Date(row.minTime)) : null;
    }

    // 其他周期：从上游 period-stat 已有数据的最小时间截断到当前周期开始
    // 使用 MIN 而非 MAX+nextStart，确保所有上游数据都被聚合到当前周期
    const row = await models.periodStat.findOne({
      attributes: [[fn('MIN', col('time')), 'minTime']],
      where: { period: dependency.fromPeriod },
      raw: true
    });
    return row?.minTime ? config.truncateTime(new Date(row.minTime)) : null;
  };

  const compensatingLocks = {};
  let startupCompensating = false;
  let initialized = false;
  const isCompensating = () => startupCompensating || Object.values(compensatingLocks).some(v => v);

  const compensate = async (period, { maxWindows } = {}) => {
    if (compensatingLocks[period]) return;
    compensatingLocks[period] = true;
    try {
      const config = PERIOD_CONFIG[period];
      const dependency = PERIOD_DEPENDENCY[period];

      const watermark = await getWatermark(period);
      if (!watermark) return;
      let nextTime = new Date(watermark);
      const nowTruncated = config.truncateTime(new Date());

      const windowLimit = maxWindows ?? compensationBatchSize;
      let count = 0;
      let failCount = 0;
      const maxFailCount = options.maxCompensationFailCount ?? 3;
      while (nextTime < nowTruncated && count < windowLimit && failCount < maxFailCount) {
        const endTime = config.getNextStart(nextTime);

        if (dependency.source === 'period-stat') {
          const upstreamNext = await getWatermark(dependency.fromPeriod);
          if (!upstreamNext || new Date(upstreamNext) < new Date(endTime)) {
            await compensate(dependency.fromPeriod);
          }
        }

        try {
          await aggregate(period, { startTime: nextTime, endTime });
          nextTime = endTime;
          await setWatermark(period, nextTime);
          count++;
          failCount = 0;
        } catch (e) {
          failCount++;
          fastify.log.error(`Failed to compensate period ${period} [${nextTime.toISOString()} - ${endTime.toISOString()}] (${failCount}/${maxFailCount}): ${e.message}`);
          // 跳过失败窗口，推进水位线，避免无限重试同一窗口
          nextTime = endTime;
          await setWatermark(period, nextTime);
          count++;
        }
      }

      if (failCount >= maxFailCount && nextTime < nowTruncated) {
        fastify.log.error(`period=${period} 补偿连续失败 ${maxFailCount} 次，停止补偿，下次 cron 继续`);
      } else if (nextTime < nowTruncated) {
        fastify.log.warn(`period=${period} 补偿未完成，已补 ${count} 个窗口，下次继续`);
      } else if (count > 1) {
        fastify.log.info(`period=${period} 补偿完成，共补 ${count} 个窗口`);
      }
    } finally {
      compensatingLocks[period] = false;
    }
  };

  // period-stat 数据保留策略：h 保留当月，d/w 保留当年，m/q/y 永久保留
  const cleanupOldPeriodStats = async () => {
    const now = dayjs();

    // h: 保留当月，需确保 d 已聚合（检查 d 水位线）
    const dWatermark = await getWatermark('d');
    const hCutoff = now.startOf('month').toDate();
    const hSafeCutoff = dWatermark && new Date(dWatermark) < hCutoff ? new Date(dWatermark) : hCutoff;
    const hCount = await models.periodStat.destroy({
      where: { period: 'h', time: { [Op.lt]: hSafeCutoff } }
    });
    if (hCount > 0) {
      fastify.log.info(`Cleaned up ${hCount} old period-stat records for period=h before ${hSafeCutoff.toISOString()}`);
    }

    // d: 保留当年，需确保 w/m 已聚合（检查 w、m 水位线）
    const wWatermark = await getWatermark('w');
    const mWatermark = await getWatermark('m');
    let dSafeCutoff = now.startOf('year').toDate();
    if (wWatermark && new Date(wWatermark) < dSafeCutoff) dSafeCutoff = new Date(wWatermark);
    if (mWatermark && new Date(mWatermark) < dSafeCutoff) dSafeCutoff = new Date(mWatermark);
    const dCount = await models.periodStat.destroy({
      where: { period: 'd', time: { [Op.lt]: dSafeCutoff } }
    });
    if (dCount > 0) {
      fastify.log.info(`Cleaned up ${dCount} old period-stat records for period=d before ${dSafeCutoff.toISOString()}`);
    }

    // w: 保留当年，无下游依赖
    const wCutoff = now.startOf('year').toDate();
    const wCount = await models.periodStat.destroy({
      where: { period: 'w', time: { [Op.lt]: wCutoff } }
    });
    if (wCount > 0) {
      fastify.log.info(`Cleaned up ${wCount} old period-stat records for period=w before ${wCutoff.toISOString()}`);
    }
  };

  const init = async () => {
    const maxCompensationWindows = options.maxCompensationWindows ?? Infinity;
    const maxFailCount = options.maxCompensationFailCount ?? 3;
    const compensationEnabled = options.compensationEnabled !== false;

    startupCompensating = true;
    try {
      for (const period of PERIOD_ORDER) {
        const config = PERIOD_CONFIG[period];
        const nowTruncated = config.truncateTime(new Date());

        // Step 1: 确定补偿起始点
        let startTime;
        const existing = await getWatermark(period);

        if (existing && new Date(existing) < nowTruncated) {
          // 场景一：水位线存在但过期
          startTime = new Date(existing);
          fastify.log.info(`period=${period} 水位线过期 (${existing}), 从 ${startTime.toISOString()} 开始补偿`);
        } else if (existing) {
          // 水位线已是最新的，跳过
          fastify.log.info(`period=${period} 水位线正常: ${existing}`);
          continue;
        } else {
          // 场景二：水位线不存在，从源数据推断
          startTime = await determineStartFromSource(period);
          if (!startTime) {
            // 场景三：全新系统，无任何数据
            await setWatermark(period, nowTruncated);
            fastify.log.info(`period=${period} 全新系统，水位线设为 ${nowTruncated.toISOString()}`);
            continue;
          }
          fastify.log.info(`period=${period} 水位线不存在，从源数据推断起始点 ${startTime.toISOString()}`);
        }

        if (!compensationEnabled) {
          // 补偿未启用，仅设置水位线到起始点，不执行补偿
          await setWatermark(period, startTime);
          fastify.log.info(`period=${period} 补偿未启用，水位线设为 ${startTime.toISOString()}`);
          continue;
        }

        // Step 2: 执行补偿聚合，逐窗口推进水位线
        let nextTime = startTime;
        let count = 0;
        let failCount = 0;

        while (nextTime < nowTruncated && count < maxCompensationWindows) {
          const endTime = config.getNextStart(nextTime);

          try {
            await aggregate(period, { startTime: nextTime, endTime });
            count++;
            failCount = 0;
          } catch (e) {
            failCount++;
            fastify.log.error(`period=${period} 补偿失败 [${nextTime.toISOString()}] (${failCount}/${maxFailCount}): ${e.message}`);
            if (failCount >= maxFailCount) {
              fastify.log.error(`period=${period} 连续失败 ${maxFailCount} 次，停止补偿`);
              break;
            }
          }

          nextTime = endTime;
          // 逐窗口推进水位线，确保水位线与实际聚合进度一致
          await setWatermark(period, nextTime);
        }

        if (nextTime < nowTruncated) {
          fastify.log.warn(`period=${period} 补偿未完成（到 ${nextTime.toISOString()}），下次 cron 继续`);
        } else {
          fastify.log.info(`period=${period} 补偿完成，共 ${count} 个窗口`);
        }
      }

      fastify.log.info('Startup compensation finished');
    } catch (e) {
      fastify.log.error(`Startup compensation failed: ${e.message}`);
    } finally {
      startupCompensating = false;
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

      fastify.cron.createJob({
        name: 'statistics-period-stat-cleanup',
        cronTime: '0 3 * * *',
        onTick: async () => {
          try {
            await cleanupOldPeriodStats();
          } catch (e) {
            fastify.log.error(`Failed to cleanup old period-stat records: ${e.message}`);
          }
        },
        startWhenReady: true
      });
    }

    initialized = true;
    fastify.log.info('Period statistics service initialized');
  };

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

    if (!initialized) {
      throw new Error('Period statistics service is not initialized yet');
    }

    const channelList = Array.isArray(channels) ? channels : channels ? [channels] : [];
    // 写入数据全使用服务器时间，isRealtime 和 currentHourStart 必须基于服务器时间判断
    // 因为数据是按服务器时间分桶聚合的，客户端时区仅影响展示层的日期/小时转换
    const currentHourStart = dayjs().startOf('hour').toDate();
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
      await queryCacheSet(cacheKey, result, ttl, channelList);
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

  /**
   * 重置指定周期的 period-stat 数据和水位线
   * 用于修复错误聚合数据：删除旧数据 → 重置水位线 → 重新补偿聚合
   * @param {string} period - 周期类型
   * @param {object} [options]
   * @param {Date} [options.startTime] - 重置起始时间（水位线将设为此值），默认为当前截断时间
   * @param {Date} [options.endTime] - 重置结束时间（仅删除此范围内的 period-stat 数据），默认删除全部
   * @param {boolean} [options.cascade=false] - 是否级联重置下游周期（如重置 h 时同时重置依赖 h 的 d）
   * @returns {{ period, deletedCount, nextTime }}
   */
  const resetPeriodStats = async (period, { startTime, endTime, cascade = false } = {}) => {
    const config = PERIOD_CONFIG[period];
    if (!config) {
      throw new Error(`Unsupported period: ${period}, supported: ${Object.keys(PERIOD_CONFIG).join(',')}`);
    }

    const where = { period };
    if (startTime && endTime) {
      where.time = { [Op.between]: [startTime, endTime] };
    } else if (startTime) {
      where.time = { [Op.gte]: startTime };
    } else if (endTime) {
      where.time = { [Op.lte]: endTime };
    }

    const deletedCount = await models.periodStat.destroy({ where });

    // 重置水位线
    const nextTime = startTime || config.truncateTime(new Date());
    await setWatermark(period, nextTime);

    // 使查询缓存失效
    invalidateQueryCache();

    const result = { period, deletedCount, nextTime };

    // 级联重置下游周期
    if (cascade) {
      const downstreamPeriods = Object.entries(PERIOD_DEPENDENCY)
        .filter(([, dep]) => dep.source === 'period-stat' && dep.fromPeriod === period)
        .map(([p]) => p);

      for (const dp of downstreamPeriods) {
        const subResult = await resetPeriodStats(dp, {
          startTime: startTime ? PERIOD_CONFIG[dp].truncateTime(startTime) : undefined,
          endTime: endTime ? PERIOD_CONFIG[dp].truncateTime(endTime) : undefined,
          cascade: true
        });
        result[`cascade_${dp}`] = subResult;
      }
    }

    return result;
  };

  Object.assign(fastify[options.name].services, {
    query,
    periodStat: {
      init,
      aggregate,
      query,
      isCompensating,
      invalidateQueryCache,
      cleanupOldPeriodStats,
      resetPeriodStats
    }
  });
});
