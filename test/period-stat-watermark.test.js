const { expect } = require('chai');
const { Sequelize, DataTypes, Op } = require('sequelize');
const fp = require('fastify-plugin');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * 创建基于 SQLite 内存数据库的测试环境
 * 包含所有真实 Sequelize 模型，可以直接执行 SQL 查询
 */
const createSqliteTestEnv = async () => {
  const sequelize = new Sequelize('sqlite::memory:', { logging: false });

  const channelMeta = sequelize.define('watermarkTestChannelMeta', {
    channel: { type: DataTypes.STRING, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT }
  }, {
    underscored: true,
    tableName: 'wm_test_channel_meta',
    indexes: [{ name: 'idx_wm_test_channel_meta_channel', unique: true, fields: ['channel'] }]
  });

  const dataRecord = sequelize.define('watermarkTestDataRecord', {
    channel: { type: DataTypes.STRING, allowNull: false },
    attributeName: { type: DataTypes.STRING, defaultValue: 'default' },
    data: { type: DataTypes.DECIMAL(16, 2), allowNull: false, defaultValue: 0 },
    time: { type: DataTypes.DATE, allowNull: false },
    unit: { type: DataTypes.STRING },
    channelMetaId: { type: DataTypes.INTEGER }
  }, {
    underscored: true,
    tableName: 'wm_test_data_record',
    indexes: [
      { name: 'idx_wm_test_data_record_channel', fields: ['channel'] },
      { name: 'idx_wm_test_data_record_time', fields: ['time'] },
      { name: 'idx_wm_test_data_record_channel_time', fields: ['channel', 'time'] },
      { name: 'idx_wm_test_data_record_channel_attr_time', fields: ['channel', 'attribute_name', 'time'] }
    ]
  });

  const periodStat = sequelize.define('watermarkTestPeriodStat', {
    period: { type: DataTypes.STRING, allowNull: false },
    time: { type: DataTypes.DATE, allowNull: false },
    channel: { type: DataTypes.STRING, allowNull: false },
    attributeName: { type: DataTypes.STRING, defaultValue: 'default' },
    aggregate: { type: DataTypes.STRING, allowNull: false },
    data: { type: DataTypes.DECIMAL(16, 2), allowNull: false, defaultValue: 0 },
    unit: { type: DataTypes.STRING },
    channelMetaId: { type: DataTypes.INTEGER }
  }, {
    underscored: true,
    tableName: 'wm_test_period_stat',
    indexes: [
      { name: 'idx_wm_test_period_stat_unique', unique: true, fields: ['period', 'channel', 'attribute_name', 'aggregate', 'time'] },
      { name: 'idx_wm_test_period_stat_period_time', fields: ['period', 'time'] },
      { name: 'idx_wm_test_period_stat_channel_attr_time', fields: ['channel', 'attribute_name', 'time'] }
    ]
  });

  const aggregationWatermark = sequelize.define('watermarkTestAggregationWatermark', {
    period: { type: DataTypes.STRING, allowNull: false },
    nextTime: { type: DataTypes.DATE, allowNull: false }
  }, {
    underscored: true,
    tableName: 'wm_test_aggregation_watermark',
    indexes: [
      { name: 'idx_wm_test_aggregation_watermark_period', unique: true, fields: ['period'] }
    ]
  });

  dataRecord.belongsTo(channelMeta, { foreignKey: 'channelMetaId' });
  periodStat.belongsTo(channelMeta, { foreignKey: 'channelMetaId' });

  await sequelize.sync({ force: true });

  const fastify = require('fastify')();
  fastify.decorate('sequelize', {
    Sequelize: { Op, fn: Sequelize.fn, col: Sequelize.col },
    instance: sequelize
  });
  fastify.decorate('statistics', {
    models: { dataRecord, periodStat, aggregationWatermark, channelMeta },
    services: {}
  });

  return { fastify, sequelize, models: { dataRecord, periodStat, aggregationWatermark, channelMeta } };
};

/**
 * 加载 period-stat 服务插件
 * 默认不启用自动补偿，由测试手动控制聚合流程
 */
const loadPeriodStatService = async (fastify, options = {}) => {
  const servicePlugin = require('../libs/services/period-stat');
  await fp(servicePlugin)(fastify, {
    name: 'statistics',
    compensationEnabled: false,
    ...options
  });
};

/**
 * 辅助：比较时间（兼容 raw:true 返回的字符串和 Date 对象）
 */
const isSameTime = (a, b) => {
  return new Date(a).getTime() === new Date(b).getTime();
};

/**
 * 辅助：查询指定周期的所有 period-stat 记录
 */
const findPeriodStatRecords = async (models, { period, channel, aggregate: aggType } = {}) => {
  const where = {};
  if (period) where.period = period;
  if (channel) where.channel = channel;
  if (aggType) where.aggregate = aggType;
  return models.periodStat.findAll({ where, raw: true });
};

/**
 * 辅助：查询指定周期的水位线
 */
const getWatermarkFromDb = async (models, period) => {
  const row = await models.aggregationWatermark.findOne({ where: { period }, raw: true });
  return row ? row.nextTime : null;
};

/**
 * 辅助：设置指定周期的水位线
 */
const setWatermarkToDb = async (models, period, nextTime) => {
  const existing = await models.aggregationWatermark.findOne({ where: { period } });
  if (existing) {
    await existing.update({ nextTime });
  } else {
    await models.aggregationWatermark.create({ period, nextTime });
  }
};

describe('@kne/fastify-statistics', function () {
  this.timeout(30000);

  describe('水位线聚合集成测试（SQLite）', () => {
    describe('场景一：无水位线和period-stat，从data-record聚合并设置水位线', () => {
      it('应从data-record聚合h数据，级联聚合d/w/m/q/y，并设置水位线', async () => {
        const { fastify, models } = await createSqliteTestEnv();
        await loadPeriodStatService(fastify);

        // ===== Step 1: 插入 data-record 打点数据（3个小时，每小时2条）=====
        await models.dataRecord.bulkCreate([
          { channel: 'sensor:temp', attributeName: 'value', data: 20, time: new Date('2026-05-01T00:15:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 22, time: new Date('2026-05-01T00:45:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 21, time: new Date('2026-05-01T01:15:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 23, time: new Date('2026-05-01T01:45:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 19, time: new Date('2026-05-01T02:15:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 24, time: new Date('2026-05-01T02:45:00Z'), unit: '°C' }
        ]);

        // 验证初始状态：data-record 有数据，period-stat 为空，水位线为空
        expect(await models.dataRecord.count()).to.equal(6);
        expect(await models.periodStat.count()).to.equal(0);
        expect(await getWatermarkFromDb(models, 'h')).to.be.null;

        // ===== Step 2: 聚合 h 数据（从 data-record）=====
        await fastify.statistics.services.periodStat.aggregate('h', {
          startTime: new Date('2026-05-01T00:00:00Z'),
          endTime: new Date('2026-05-01T01:00:00Z')
        });
        await fastify.statistics.services.periodStat.aggregate('h', {
          startTime: new Date('2026-05-01T01:00:00Z'),
          endTime: new Date('2026-05-01T02:00:00Z')
        });
        await fastify.statistics.services.periodStat.aggregate('h', {
          startTime: new Date('2026-05-01T02:00:00Z'),
          endTime: new Date('2026-05-01T03:00:00Z')
        });

        // 验证 h 记录：5种聚合 × 3小时 = 15条
        const hRecords = await findPeriodStatRecords(models, { period: 'h' });
        expect(hRecords.length).to.equal(15);

        // 验证 h:00 的聚合值（sum=42, count=2, avg=21, min=20, max=22）
        const h00Sum = hRecords.find(r => isSameTime(r.time, '2026-05-01T00:00:00Z') && r.aggregate === 'sum');
        expect(h00Sum).to.exist;
        expect(parseFloat(h00Sum.data)).to.equal(42);

        const h00Count = hRecords.find(r => isSameTime(r.time, '2026-05-01T00:00:00Z') && r.aggregate === 'count');
        expect(parseFloat(h00Count.data)).to.equal(2);

        const h00Avg = hRecords.find(r => isSameTime(r.time, '2026-05-01T00:00:00Z') && r.aggregate === 'avg');
        expect(parseFloat(h00Avg.data)).to.equal(21);

        const h00Min = hRecords.find(r => isSameTime(r.time, '2026-05-01T00:00:00Z') && r.aggregate === 'min');
        expect(parseFloat(h00Min.data)).to.equal(20);

        const h00Max = hRecords.find(r => isSameTime(r.time, '2026-05-01T00:00:00Z') && r.aggregate === 'max');
        expect(parseFloat(h00Max.data)).to.equal(22);

        // 验证 data-record 已被删除（h聚合后删除源数据）
        expect(await models.dataRecord.count()).to.equal(0);

        // ===== Step 3: 级联聚合 d（从 h 数据）=====
        await fastify.statistics.services.periodStat.aggregate('d', {
          startTime: new Date('2026-05-01T00:00:00Z'),
          endTime: new Date('2026-05-02T00:00:00Z')
        });

        const dRecords = await findPeriodStatRecords(models, { period: 'd' });
        expect(dRecords.length).to.equal(5);

        // d: sum=42+44+43=129, count=2+2+2=6, avg=129/6=21.5, min=19, max=24
        const dSum = dRecords.find(r => r.aggregate === 'sum');
        expect(parseFloat(dSum.data)).to.equal(129);

        const dCount = dRecords.find(r => r.aggregate === 'count');
        expect(parseFloat(dCount.data)).to.equal(6);

        const dAvg = dRecords.find(r => r.aggregate === 'avg');
        expect(parseFloat(dAvg.data)).to.equal(21.5);

        const dMin = dRecords.find(r => r.aggregate === 'min');
        expect(parseFloat(dMin.data)).to.equal(19);

        const dMax = dRecords.find(r => r.aggregate === 'max');
        expect(parseFloat(dMax.data)).to.equal(24);

        // ===== Step 4: 级联聚合 w（从 d 数据）=====
        // 2026-05-01 是周五，所在周从 2026-04-27（周一）开始
        await fastify.statistics.services.periodStat.aggregate('w', {
          startTime: new Date('2026-04-27T00:00:00Z'),
          endTime: new Date('2026-05-04T00:00:00Z')
        });

        const wRecords = await findPeriodStatRecords(models, { period: 'w' });
        expect(wRecords.length).to.equal(5);

        const wSum = wRecords.find(r => r.aggregate === 'sum');
        expect(parseFloat(wSum.data)).to.equal(129);

        // ===== Step 5: 级联聚合 m（从 d 数据）=====
        await fastify.statistics.services.periodStat.aggregate('m', {
          startTime: new Date('2026-05-01T00:00:00Z'),
          endTime: new Date('2026-06-01T00:00:00Z')
        });

        const mRecords = await findPeriodStatRecords(models, { period: 'm' });
        expect(mRecords.length).to.equal(5);

        const mSum = mRecords.find(r => r.aggregate === 'sum');
        expect(parseFloat(mSum.data)).to.equal(129);

        // ===== Step 6: 级联聚合 q（从 m 数据）=====
        await fastify.statistics.services.periodStat.aggregate('q', {
          startTime: new Date('2026-04-01T00:00:00Z'),
          endTime: new Date('2026-07-01T00:00:00Z')
        });

        const qRecords = await findPeriodStatRecords(models, { period: 'q' });
        expect(qRecords.length).to.equal(5);

        // ===== Step 7: 级联聚合 y（从 q 数据）=====
        await fastify.statistics.services.periodStat.aggregate('y', {
          startTime: new Date('2026-01-01T00:00:00Z'),
          endTime: new Date('2027-01-01T00:00:00Z')
        });

        const yRecords = await findPeriodStatRecords(models, { period: 'y' });
        expect(yRecords.length).to.equal(5);

        // ===== Step 8: 设置水位线 =====
        await setWatermarkToDb(models, 'h', new Date('2026-05-01T03:00:00Z'));
        await setWatermarkToDb(models, 'd', new Date('2026-05-02T00:00:00Z'));
        await setWatermarkToDb(models, 'w', new Date('2026-05-04T00:00:00Z'));
        await setWatermarkToDb(models, 'm', new Date('2026-06-01T00:00:00Z'));
        await setWatermarkToDb(models, 'q', new Date('2026-07-01T00:00:00Z'));
        await setWatermarkToDb(models, 'y', new Date('2027-01-01T00:00:00Z'));

        // ===== Step 9: 验证水位线 =====
        expect(new Date(await getWatermarkFromDb(models, 'h')).toISOString()).to.equal('2026-05-01T03:00:00.000Z');
        expect(new Date(await getWatermarkFromDb(models, 'd')).toISOString()).to.equal('2026-05-02T00:00:00.000Z');
        expect(new Date(await getWatermarkFromDb(models, 'w')).toISOString()).to.equal('2026-05-04T00:00:00.000Z');
        expect(new Date(await getWatermarkFromDb(models, 'm')).toISOString()).to.equal('2026-06-01T00:00:00.000Z');
        expect(new Date(await getWatermarkFromDb(models, 'q')).toISOString()).to.equal('2026-07-01T00:00:00.000Z');
        expect(new Date(await getWatermarkFromDb(models, 'y')).toISOString()).to.equal('2027-01-01T00:00:00.000Z');

        // 汇总验证：period-stat 中所有周期的记录数
        const allRecords = await models.periodStat.count();
        // h:15 + d:5 + w:5 + m:5 + q:5 + y:5 = 40
        expect(allRecords).to.equal(40);

        await fastify.close();
      });

      it('应支持多通道多属性名的聚合', async () => {
        const { fastify, models } = await createSqliteTestEnv();
        await loadPeriodStatService(fastify);

        // 插入两个通道的数据
        await models.dataRecord.bulkCreate([
          { channel: 'sensor:temp', attributeName: 'value', data: 20, time: new Date('2026-05-01T00:15:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 24, time: new Date('2026-05-01T00:45:00Z'), unit: '°C' },
          { channel: 'sensor:humidity', attributeName: 'value', data: 60, time: new Date('2026-05-01T00:20:00Z'), unit: '%' },
          { channel: 'sensor:humidity', attributeName: 'value', data: 65, time: new Date('2026-05-01T00:50:00Z'), unit: '%' }
        ]);

        await fastify.statistics.services.periodStat.aggregate('h', {
          startTime: new Date('2026-05-01T00:00:00Z'),
          endTime: new Date('2026-05-01T01:00:00Z')
        });

        // 2个通道 × 5种聚合 = 10条 h 记录
        const hRecords = await findPeriodStatRecords(models, { period: 'h' });
        expect(hRecords.length).to.equal(10);

        const tempSum = hRecords.find(r => r.channel === 'sensor:temp' && r.aggregate === 'sum');
        expect(parseFloat(tempSum.data)).to.equal(44);

        const humiditySum = hRecords.find(r => r.channel === 'sensor:humidity' && r.aggregate === 'sum');
        expect(parseFloat(humiditySum.data)).to.equal(125);

        await fastify.close();
      });
    });

    describe('场景二：水位线过期，从水位线时间补偿聚合并更新水位线', () => {
      it('应从过期水位线位置开始补偿h聚合，级联更新d/w/m，然后更新水位线', async () => {
        const { fastify, models } = await createSqliteTestEnv();
        await loadPeriodStatService(fastify);

        // ===== Step 1: 初始聚合 - 小时 00、01 =====
        await models.dataRecord.bulkCreate([
          { channel: 'sensor:temp', attributeName: 'value', data: 20, time: new Date('2026-05-01T00:15:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 22, time: new Date('2026-05-01T00:45:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 21, time: new Date('2026-05-01T01:15:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 23, time: new Date('2026-05-01T01:45:00Z'), unit: '°C' }
        ]);

        await fastify.statistics.services.periodStat.aggregate('h', {
          startTime: new Date('2026-05-01T00:00:00Z'),
          endTime: new Date('2026-05-01T01:00:00Z')
        });
        await fastify.statistics.services.periodStat.aggregate('h', {
          startTime: new Date('2026-05-01T01:00:00Z'),
          endTime: new Date('2026-05-01T02:00:00Z')
        });

        // 聚合 d
        await fastify.statistics.services.periodStat.aggregate('d', {
          startTime: new Date('2026-05-01T00:00:00Z'),
          endTime: new Date('2026-05-02T00:00:00Z')
        });

        // 记录初始 d 的 sum 值
        const dRecordsBefore = await findPeriodStatRecords(models, { period: 'd', aggregate: 'sum' });
        expect(dRecordsBefore.length).to.equal(1);
        const dSumBefore = parseFloat(dRecordsBefore[0].data);
        // 20+22 + 21+23 = 86
        expect(dSumBefore).to.equal(86);

        // ===== Step 2: 设置过期水位线 =====
        // h 水位线在 02:00（实际应该推进到 03:00），表示小时 02 未聚合
        await setWatermarkToDb(models, 'h', new Date('2026-05-01T02:00:00Z'));
        // d 水位线在当天 00:00（实际应该推进到次日），表示当天 d 需要重新聚合
        await setWatermarkToDb(models, 'd', new Date('2026-05-01T00:00:00Z'));

        // ===== Step 3: 插入新的 data-record 打点数据（小时 02）=====
        await models.dataRecord.bulkCreate([
          { channel: 'sensor:temp', attributeName: 'value', data: 19, time: new Date('2026-05-01T02:15:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 24, time: new Date('2026-05-01T02:45:00Z'), unit: '°C' }
        ]);

        // 验证新数据已入库
        expect(await models.dataRecord.count()).to.equal(2);

        // ===== Step 4: 从水位线位置开始补偿 h 聚合 =====
        // 模拟补偿：从 h 水位线时间 02:00 聚合到 03:00
        await fastify.statistics.services.periodStat.aggregate('h', {
          startTime: new Date('2026-05-01T02:00:00Z'),
          endTime: new Date('2026-05-01T03:00:00Z')
        });

        // 验证新的 h 记录
        const hRecords = await findPeriodStatRecords(models, { period: 'h' });
        // 5种聚合 × 3小时 = 15条
        expect(hRecords.length).to.equal(15);

        const h02Sum = hRecords.find(
          r => isSameTime(r.time, '2026-05-01T02:00:00Z') && r.aggregate === 'sum'
        );
        expect(parseFloat(h02Sum.data)).to.equal(43); // 19 + 24

        const h02Count = hRecords.find(
          r => isSameTime(r.time, '2026-05-01T02:00:00Z') && r.aggregate === 'count'
        );
        expect(parseFloat(h02Count.data)).to.equal(2);

        // 验证 data-record 中新的打点数据已被删除
        expect(await models.dataRecord.count()).to.equal(0);

        // ===== Step 5: 重新聚合 d（包含新的 h 数据）=====
        await fastify.statistics.services.periodStat.aggregate('d', {
          startTime: new Date('2026-05-01T00:00:00Z'),
          endTime: new Date('2026-05-02T00:00:00Z')
        });

        // 验证 d 的 sum 已更新（86 + 43 = 129）
        const dRecordsAfter = await findPeriodStatRecords(models, { period: 'd', aggregate: 'sum' });
        expect(dRecordsAfter.length).to.equal(1);
        expect(parseFloat(dRecordsAfter[0].data)).to.equal(129);

        // 验证 d 的 count 已更新（4 + 2 = 6）
        const dCountAfter = await findPeriodStatRecords(models, { period: 'd', aggregate: 'count' });
        expect(parseFloat(dCountAfter[0].data)).to.equal(6);

        // 验证 d 的 min 已更新（之前 min=20，现在 min=19）
        const dMinAfter = await findPeriodStatRecords(models, { period: 'd', aggregate: 'min' });
        expect(parseFloat(dMinAfter[0].data)).to.equal(19);

        // 验证 d 的 max 已更新（之前 max=23，现在 max=24）
        const dMaxAfter = await findPeriodStatRecords(models, { period: 'd', aggregate: 'max' });
        expect(parseFloat(dMaxAfter[0].data)).to.equal(24);

        // ===== Step 6: 重新聚合 w/m/q/y（级联更新）=====
        await fastify.statistics.services.periodStat.aggregate('w', {
          startTime: new Date('2026-04-27T00:00:00Z'),
          endTime: new Date('2026-05-04T00:00:00Z')
        });
        const wSumAfter = await findPeriodStatRecords(models, { period: 'w', aggregate: 'sum' });
        expect(parseFloat(wSumAfter[0].data)).to.equal(129);

        await fastify.statistics.services.periodStat.aggregate('m', {
          startTime: new Date('2026-05-01T00:00:00Z'),
          endTime: new Date('2026-06-01T00:00:00Z')
        });
        const mSumAfter = await findPeriodStatRecords(models, { period: 'm', aggregate: 'sum' });
        expect(parseFloat(mSumAfter[0].data)).to.equal(129);

        // ===== Step 7: 更新水位线到最新 =====
        await setWatermarkToDb(models, 'h', new Date('2026-05-01T03:00:00Z'));
        await setWatermarkToDb(models, 'd', new Date('2026-05-02T00:00:00Z'));
        await setWatermarkToDb(models, 'w', new Date('2026-05-04T00:00:00Z'));
        await setWatermarkToDb(models, 'm', new Date('2026-06-01T00:00:00Z'));

        // ===== Step 8: 验证水位线已更新 =====
        expect(new Date(await getWatermarkFromDb(models, 'h')).toISOString()).to.equal('2026-05-01T03:00:00.000Z');
        expect(new Date(await getWatermarkFromDb(models, 'd')).toISOString()).to.equal('2026-05-02T00:00:00.000Z');
        expect(new Date(await getWatermarkFromDb(models, 'w')).toISOString()).to.equal('2026-05-04T00:00:00.000Z');
        expect(new Date(await getWatermarkFromDb(models, 'm')).toISOString()).to.equal('2026-06-01T00:00:00.000Z');

        await fastify.close();
      });

      it('应正确处理多窗口补偿：水位线落后多个小时', async () => {
        const { fastify, models } = await createSqliteTestEnv();
        await loadPeriodStatService(fastify);

        // 初始：聚合小时 00
        await models.dataRecord.bulkCreate([
          { channel: 'sensor:temp', attributeName: 'value', data: 20, time: new Date('2026-05-01T00:15:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 22, time: new Date('2026-05-01T00:45:00Z'), unit: '°C' }
        ]);
        await fastify.statistics.services.periodStat.aggregate('h', {
          startTime: new Date('2026-05-01T00:00:00Z'),
          endTime: new Date('2026-05-01T01:00:00Z')
        });

        // 设置 h 水位线在 01:00（落后3个小时：01、02、03 未聚合）
        await setWatermarkToDb(models, 'h', new Date('2026-05-01T01:00:00Z'));

        // 插入 01、02、03 小时的打点数据
        await models.dataRecord.bulkCreate([
          { channel: 'sensor:temp', attributeName: 'value', data: 10, time: new Date('2026-05-01T01:15:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 11, time: new Date('2026-05-01T01:45:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 12, time: new Date('2026-05-01T02:15:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 13, time: new Date('2026-05-01T02:45:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 14, time: new Date('2026-05-01T03:15:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 15, time: new Date('2026-05-01T03:45:00Z'), unit: '°C' }
        ]);

        // 模拟补偿循环：从水位线 01:00 开始逐窗口聚合到 04:00
        const watermarkTime = new Date('2026-05-01T01:00:00Z');
        const targetTime = new Date('2026-05-01T04:00:00Z');
        let nextTime = watermarkTime;

        while (nextTime < targetTime) {
          const endTime = new Date(nextTime.getTime() + 3600000); // +1小时
          await fastify.statistics.services.periodStat.aggregate('h', {
            startTime: nextTime,
            endTime
          });
          nextTime = endTime;
          await setWatermarkToDb(models, 'h', nextTime);
        }

        // 验证：h 水位线已推进到 04:00
        expect(new Date(await getWatermarkFromDb(models, 'h')).toISOString()).to.equal('2026-05-01T04:00:00.000Z');

        // 验证：所有 4 个小时的 h 记录都存在
        const hRecords = await findPeriodStatRecords(models, { period: 'h' });
        expect(hRecords.length).to.equal(20); // 5种聚合 × 4小时

        // 验证：data-record 已全部删除
        expect(await models.dataRecord.count()).to.equal(0);

        // 验证：每小时的数据正确
        const h01Sum = hRecords.find(
          r => isSameTime(r.time, '2026-05-01T01:00:00Z') && r.aggregate === 'sum'
        );
        expect(parseFloat(h01Sum.data)).to.equal(21); // 10+11

        const h02Sum = hRecords.find(
          r => isSameTime(r.time, '2026-05-01T02:00:00Z') && r.aggregate === 'sum'
        );
        expect(parseFloat(h02Sum.data)).to.equal(25); // 12+13

        const h03Sum = hRecords.find(
          r => isSameTime(r.time, '2026-05-01T03:00:00Z') && r.aggregate === 'sum'
        );
        expect(parseFloat(h03Sum.data)).to.equal(29); // 14+15

        await fastify.close();
      });

      it('应正确处理无新数据的补偿窗口', async () => {
        const { fastify, models } = await createSqliteTestEnv();
        await loadPeriodStatService(fastify);

        // 初始：聚合小时 00
        await models.dataRecord.bulkCreate([
          { channel: 'sensor:temp', attributeName: 'value', data: 20, time: new Date('2026-05-01T00:15:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 22, time: new Date('2026-05-01T00:45:00Z'), unit: '°C' }
        ]);
        await fastify.statistics.services.periodStat.aggregate('h', {
          startTime: new Date('2026-05-01T00:00:00Z'),
          endTime: new Date('2026-05-01T01:00:00Z')
        });

        // 设置 h 水位线在 01:00
        await setWatermarkToDb(models, 'h', new Date('2026-05-01T01:00:00Z'));

        // 小时 01 没有数据（空窗口），小时 02 有数据
        await models.dataRecord.bulkCreate([
          { channel: 'sensor:temp', attributeName: 'value', data: 30, time: new Date('2026-05-01T02:15:00Z'), unit: '°C' },
          { channel: 'sensor:temp', attributeName: 'value', data: 32, time: new Date('2026-05-01T02:45:00Z'), unit: '°C' }
        ]);

        // 补偿小时 01（空窗口）
        await fastify.statistics.services.periodStat.aggregate('h', {
          startTime: new Date('2026-05-01T01:00:00Z'),
          endTime: new Date('2026-05-01T02:00:00Z')
        });

        // 空 window 不应产生 period-stat 记录
        const hRecordsAfterEmpty = await findPeriodStatRecords(models, { period: 'h' });
        const h01Records = hRecordsAfterEmpty.filter(
          r => isSameTime(r.time, '2026-05-01T01:00:00Z')
        );
        expect(h01Records.length).to.equal(0);

        // 补偿小时 02（有数据）
        await fastify.statistics.services.periodStat.aggregate('h', {
          startTime: new Date('2026-05-01T02:00:00Z'),
          endTime: new Date('2026-05-01T03:00:00Z')
        });

        const hRecordsAfter02 = await findPeriodStatRecords(models, { period: 'h' });
        const h02Records = hRecordsAfter02.filter(
          r => isSameTime(r.time, '2026-05-01T02:00:00Z')
        );
        expect(h02Records.length).to.equal(5); // 5种聚合

        // 推进水位线跳过空窗口
        await setWatermarkToDb(models, 'h', new Date('2026-05-01T03:00:00Z'));
        expect(new Date(await getWatermarkFromDb(models, 'h')).toISOString()).to.equal('2026-05-01T03:00:00.000Z');

        await fastify.close();
      });
    });
  });
});
