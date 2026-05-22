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
    getPrevStart: endTime => dayjs(endTime).subtract(1, 'hour').toDate()
  },
  d: {
    label: '日',
    cronTime: '1 0 * * *',
    truncateTime: date => dayjs(date).startOf('day').toDate(),
    getPrevStart: endTime => dayjs(endTime).subtract(1, 'day').toDate()
  },
  w: {
    label: '周',
    cronTime: '1 0 * * 1',
    truncateTime: date => dayjs(date).startOf('week').add(1, 'day').startOf('day').toDate(),
    getPrevStart: endTime => dayjs(endTime).subtract(7, 'day').toDate()
  },
  m: {
    label: '月',
    cronTime: '1 0 1 * *',
    truncateTime: date => dayjs(date).startOf('month').toDate(),
    getPrevStart: endTime => dayjs(endTime).subtract(1, 'month').startOf('month').toDate()
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
    getPrevStart: endTime => dayjs(endTime).subtract(3, 'month').startOf('month').toDate()
  },
  y: {
    label: '年',
    cronTime: '1 0 1 1 *',
    truncateTime: date => dayjs(date).startOf('year').toDate(),
    getPrevStart: endTime => dayjs(endTime).subtract(1, 'year').startOf('year').toDate()
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

const UPSERT_FIELDS = ['data', 'title', 'unit', 'description'];

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const { Op, fn, col } = fastify.sequelize.Sequelize;
  const sequelize = fastify.sequelize.instance;

  const aggregateFromDataRecord = async (period, startTime, endTime) => {
    const results = await models.dataRecord.findAll({
      attributes: [
        'channel',
        'attributeName',
        [fn('MAX', col('title')), 'title'],
        [fn('MAX', col('unit')), 'unit'],
        [fn('MAX', col('description')), 'description'],
        ...AGGREGATE_TYPES.map(({ key, fn: aggFn }) => [fn(aggFn, col('data')), key])
      ],
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
          title: row.title,
          description: row.description || null,
          aggregate: key,
          data: parseFloat(value),
          unit: row.unit || null
        });
      }
    }

    if (records.length > 0) {
      const transaction = await sequelize.transaction();
      try {
        await models.periodStat.bulkCreate(records, { transaction, updateOnDuplicate: UPSERT_FIELDS });
        await models.dataRecord.destroy({
          where: {
            time: { [Op.between]: [startTime, endTime] }
          },
          transaction
        });
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
          title: row.title,
          unit: row.unit,
          description: row.description,
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
        title: group.title,
        description: group.description || null,
        unit: group.unit || null
      };

      if (sums.length > 0) {
        records.push({ ...base, aggregate: 'sum', data: sums.reduce((a, b) => a + b, 0) });
      }
      if (counts.length > 0) {
        records.push({ ...base, aggregate: 'count', data: counts.reduce((a, b) => a + b, 0) });
      }
      if (sums.length > 0 && counts.length > 0) {
        records.push({
          ...base,
          aggregate: 'avg',
          data: sums.reduce((a, b) => a + b, 0) / counts.reduce((a, b) => a + b, 0)
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

    const now = dayjs();
    if (!startTime || !endTime) {
      endTime = config.truncateTime(now);
      startTime = config.getPrevStart(endTime);
    }

    const dependency = PERIOD_DEPENDENCY[period];
    if (dependency.source === 'data-record') {
      return aggregateFromDataRecord(period, startTime, endTime);
    }
    return aggregateFromPeriodStat(period, dependency.fromPeriod, startTime, endTime);
  };

  if (fastify.cron) {
    for (const [period, config] of Object.entries(PERIOD_CONFIG)) {
      fastify.cron.createJob({
        name: `statistics-period-stat-${period}`,
        cronTime: config.cronTime,
        onTick: async () => {
          try {
            await aggregate(period);
          } catch (e) {
            fastify.log.error(`Failed to aggregate period ${period}: ${e.message}`);
          }
        },
        startWhenReady: true
      });
    }
  }

  const formatGroupData = (items, hasAttributeNamesFilter) => {
    const attrSet = new Set();
    const aggSet = new Set();
    for (const item of items) {
      attrSet.add(item.attributeName || 'default');
      aggSet.add(item.aggregate);
    }

    const shouldFlattenAttribute = !hasAttributeNamesFilter && attrSet.size === 1 && attrSet.has('default');
    const hasMultipleAggregates = aggSet.size > 1;

    if (shouldFlattenAttribute) {
      if (hasMultipleAggregates) {
        const data = {};
        for (const item of items) {
          data[item.aggregate] = item.data;
        }
        return data;
      }
      return items[0].data;
    }

    if (hasMultipleAggregates) {
      const data = {};
      for (const item of items) {
        if (!data[item.aggregate]) data[item.aggregate] = {};
        data[item.aggregate][item.attributeName || 'default'] = item.data;
      }
      return data;
    }

    const data = {};
    for (const item of items) {
      data[item.attributeName || 'default'] = item.data;
    }
    return data;
  };

  const query = async ({ channel, startTime, endTime, attributeNames, aggregates: queryAggregates, timezone: tz }) => {
    const aggregateList = queryAggregates && queryAggregates.length > 0 ? queryAggregates : AGGREGATE_TYPES.map(a => a.key);

    if (tz) {
      try {
        dayjs().tz(tz);
      } catch {
        throw new Error(`Invalid timezone: ${tz}`);
      }
    }

    const channelWhere = channel
      ? {
          [Op.or]: [{ channel }, { channel: { [Op.like]: `${channel}:%` } }]
        }
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

    const now = tz ? dayjs().tz(tz) : dayjs();
    const currentHourStart = now.startOf('hour').toDate();
    const endTimeDayjs = dayjs(endTime);

    if (endTimeDayjs.isAfter(currentHourStart)) {
      const startTimeDayjs = dayjs(startTime);
      const drStartTime = startTimeDayjs.isAfter(currentHourStart) ? startTimeDayjs.toDate() : currentHourStart;

      const drWhere = {
        ...channelWhere,
        ...attrWhere,
        time: { [Op.between]: [drStartTime, endTimeDayjs.toDate()] }
      };

      const dataRecords = await models.dataRecord.findAll({
        attributes: [
          'channel',
          'attributeName',
          [fn('MAX', col('title')), 'title'],
          [fn('MAX', col('unit')), 'unit'],
          ...AGGREGATE_TYPES.filter(a => aggregateList.includes(a.key)).map(({ key, fn: aggFn }) => [fn(aggFn, col('data')), key])
        ],
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
            title: row.title,
            aggregate: key,
            data: parseFloat(value)
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
      const data = formatGroupData(group._items, attributeNames && attributeNames.length > 0);
      results.push({
        channel: group.channel,
        period: group.period,
        time: group.time,
        data
      });
    }

    results.sort((a, b) => dayjs(a.time).valueOf() - dayjs(b.time).valueOf());

    return results;
  };

  Object.assign(fastify[options.name].services, {
    query,
    periodStat: {
      aggregate,
      query
    }
  });
});
