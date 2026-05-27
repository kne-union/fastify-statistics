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
 */
const createSqliteTestEnv = async () => {
  const sequelize = new Sequelize('sqlite::memory:', { logging: false });

  const channelMeta = sequelize.define('cascadeTestChannelMeta', {
    channel: { type: DataTypes.STRING, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT }
  }, {
    underscored: true,
    tableName: 'cascade_test_channel_meta',
    indexes: [{ name: 'idx_cascade_test_channel_meta_channel', unique: true, fields: ['channel'] }]
  });

  const dataRecord = sequelize.define('cascadeTestDataRecord', {
    channel: { type: DataTypes.STRING, allowNull: false },
    attributeName: { type: DataTypes.STRING, defaultValue: 'default' },
    data: { type: DataTypes.DECIMAL(16, 2), allowNull: false, defaultValue: 0 },
    time: { type: DataTypes.DATE, allowNull: false },
    unit: { type: DataTypes.STRING },
    channelMetaId: { type: DataTypes.INTEGER }
  }, {
    underscored: true,
    tableName: 'cascade_test_data_record',
    indexes: [
      { name: 'idx_cascade_test_data_record_channel', fields: ['channel'] },
      { name: 'idx_cascade_test_data_record_time', fields: ['time'] },
      { name: 'idx_cascade_test_data_record_channel_attr_time', fields: ['channel', 'attribute_name', 'time'] }
    ]
  });

  const periodStat = sequelize.define('cascadeTestPeriodStat', {
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
    tableName: 'cascade_test_period_stat',
    indexes: [
      { name: 'idx_cascade_test_period_stat_unique', unique: true, fields: ['period', 'channel', 'attribute_name', 'aggregate', 'time'] },
      { name: 'idx_cascade_test_period_stat_period_time', fields: ['period', 'time'] }
    ]
  });

  const aggregationWatermark = sequelize.define('cascadeTestAggregationWatermark', {
    period: { type: DataTypes.STRING, allowNull: false },
    nextTime: { type: DataTypes.DATE, allowNull: false }
  }, {
    underscored: true,
    tableName: 'cascade_test_aggregation_watermark',
    indexes: [
      { name: 'idx_cascade_test_aggregation_watermark_period', unique: true, fields: ['period'] }
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

const loadPeriodStatService = async (fastify, options = {}) => {
  const servicePlugin = require('../libs/services/period-stat');
  await fp(servicePlugin)(fastify, {
    name: 'statistics',
    ...options
  });
};

const isSameTime = (a, b) => new Date(a).getTime() === new Date(b).getTime();

/**
 * 辅助：将本地时间日期字符串转为 dayjs 在当前时区下的 Date 对象
 * 因为 period-stat 服务使用本地时区计算 truncateTime
 */
const localDate = (str) => dayjs(str).toDate();

describe('@kne/fastify-statistics', function () {
  this.timeout(60000);

  describe('init 级联聚合集成测试', () => {
    describe('跨年数据：init 从 data-record 自动级联聚合所有周期', () => {
      it('应在 init 时从 data-record 自动完成 h→d→w→m→q→y 的全链路聚合', async () => {
        const { fastify, models } = await createSqliteTestEnv();
        await loadPeriodStatService(fastify, { compensationEnabled: true });

        // ===== 构造跨年数据（使用本地时区时间） =====
        // dayjs 默认用本地时区，我们用本地时区的时间字符串
        // 数据跨越 2025-Q3 ~ 2026-Q2，覆盖两个年份

        const records = [];

        // --- 2025-09-15: Q3 ---
        records.push(
          { channel: 'task', attributeName: 'total', data: 10, time: localDate('2025-09-15T08:00:00'), unit: 'count' },
          { channel: 'task', attributeName: 'total', data: 5, time: localDate('2025-09-15T09:00:00'), unit: 'count' },
          { channel: 'task', attributeName: 'success', data: 8, time: localDate('2025-09-15T08:30:00'), unit: 'count' },
          { channel: 'task', attributeName: 'success', data: 4, time: localDate('2025-09-15T09:30:00'), unit: 'count' }
        );

        // --- 2025-12-10: Q4 ---
        records.push(
          { channel: 'task', attributeName: 'total', data: 20, time: localDate('2025-12-10T10:00:00'), unit: 'count' },
          { channel: 'task', attributeName: 'total', data: 15, time: localDate('2025-12-10T11:00:00'), unit: 'count' },
          { channel: 'task', attributeName: 'success', data: 18, time: localDate('2025-12-10T10:30:00'), unit: 'count' },
          { channel: 'task', attributeName: 'success', data: 12, time: localDate('2025-12-10T11:30:00'), unit: 'count' }
        );

        // --- 2026-01-05: Q1 ---
        records.push(
          { channel: 'task', attributeName: 'total', data: 30, time: localDate('2026-01-05T14:00:00'), unit: 'count' },
          { channel: 'task', attributeName: 'total', data: 25, time: localDate('2026-01-05T15:00:00'), unit: 'count' },
          { channel: 'task', attributeName: 'success', data: 28, time: localDate('2026-01-05T14:30:00'), unit: 'count' },
          { channel: 'task', attributeName: 'success', data: 22, time: localDate('2026-01-05T15:30:00'), unit: 'count' }
        );

        // --- 2026-03-20: Q1 另一天 ---
        records.push(
          { channel: 'task', attributeName: 'total', data: 40, time: localDate('2026-03-20T16:00:00'), unit: 'count' },
          { channel: 'task', attributeName: 'total', data: 35, time: localDate('2026-03-20T17:00:00'), unit: 'count' },
          { channel: 'task', attributeName: 'success', data: 38, time: localDate('2026-03-20T16:30:00'), unit: 'count' },
          { channel: 'task', attributeName: 'success', data: 30, time: localDate('2026-03-20T17:30:00'), unit: 'count' }
        );

        // --- 昨天 (Q2) ---
        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
        records.push(
          { channel: 'task', attributeName: 'total', data: 50, time: localDate(`${yesterday}T08:00:00`), unit: 'count' },
          { channel: 'task', attributeName: 'total', data: 45, time: localDate(`${yesterday}T09:00:00`), unit: 'count' },
          { channel: 'task', attributeName: 'success', data: 48, time: localDate(`${yesterday}T08:30:00`), unit: 'count' },
          { channel: 'task', attributeName: 'success', data: 40, time: localDate(`${yesterday}T09:30:00`), unit: 'count' }
        );

        await models.dataRecord.bulkCreate(records);

        // 验证初始数据量
        expect(await models.dataRecord.count()).to.equal(20);
        expect(await models.periodStat.count()).to.equal(0);
        expect(await models.aggregationWatermark.count()).to.equal(0);

        // ===== 执行 init =====
        await fastify.statistics.services.periodStat.init();

        // ===== 验证 h 周期聚合 =====
        const hRecords = await models.periodStat.findAll({ where: { period: 'h' }, raw: true });
        const hTimes = [...new Set(hRecords.map(r => new Date(r.time).toISOString()))].sort();

        // 5 个不同日期，每个有不同小时
        // 注意：init 会从最早数据的小时开始逐小时补偿到当前小时
        // 有数据的小时是 5 个
        expect(hTimes.length).to.be.at.least(5);

        // 验证具体小时数据
        // 2025-09-15 08:00 h: total sum=10, success sum=8
        const sep15_08 = dayjs('2025-09-15T08:00:00').startOf('hour').toDate();
        const h08TotalSum = hRecords.find(
          r => isSameTime(r.time, sep15_08) && r.attributeName === 'total' && r.aggregate === 'sum'
        );
        expect(h08TotalSum).to.exist;
        expect(parseFloat(h08TotalSum.data)).to.equal(10);

        // data-record 应已被删除（h 聚合后删除源数据）
        expect(await models.dataRecord.count()).to.equal(0);

        // ===== 验证 d 周期聚合 =====
        const dRecords = await models.periodStat.findAll({ where: { period: 'd' }, raw: true });
        const dTimes = [...new Set(dRecords.map(r => new Date(r.time).toISOString()))].sort();

        // 至少 5 天的数据
        expect(dTimes.length).to.be.at.least(5);

        // 2025-09-15 d: total sum=10+5=15, success sum=8+4=12
        const sep15 = dayjs('2025-09-15').startOf('day').toDate();
        const d0915TotalSum = dRecords.find(
          r => isSameTime(r.time, sep15) && r.attributeName === 'total' && r.aggregate === 'sum'
        );
        expect(d0915TotalSum).to.exist;
        expect(parseFloat(d0915TotalSum.data)).to.equal(15);

        // 昨天 d: total sum=50+45=95, success sum=48+40=88
        const yesterdayStart = dayjs().subtract(1, 'day').startOf('day').toDate();
        const dYesterdayTotalSum = dRecords.find(
          r => isSameTime(r.time, yesterdayStart) && r.attributeName === 'total' && r.aggregate === 'sum'
        );
        expect(dYesterdayTotalSum).to.exist;
        expect(parseFloat(dYesterdayTotalSum.data)).to.equal(95);

        // ===== 验证 w 周期聚合 =====
        const wRecords = await models.periodStat.findAll({ where: { period: 'w' }, raw: true });
        expect(wRecords.length).to.be.at.least(3); // 至少 3 个不同的周

        // ===== 验证 m 周期聚合 =====
        const mRecords = await models.periodStat.findAll({ where: { period: 'm' }, raw: true });
        const mTimes = [...new Set(mRecords.map(r => new Date(r.time).toISOString()))].sort();

        // init 会补偿到当前月，已完成的月至少有：2025-09, 2025-12, 2026-01, 2026-03
        // 当前月 2026-05 的 m 不会被聚合（月份未完成）
        expect(mTimes.length).to.be.at.least(4);

        // 2025-09 m: total sum=15, success sum=12
        const sep1 = dayjs('2025-09-01').startOf('month').toDate();
        const m09TotalSum = mRecords.find(
          r => isSameTime(r.time, sep1) && r.attributeName === 'total' && r.aggregate === 'sum'
        );
        expect(m09TotalSum).to.exist;
        expect(parseFloat(m09TotalSum.data)).to.equal(15);

        // ===== 验证 q 周期聚合 =====
        const qRecords = await models.periodStat.findAll({ where: { period: 'q' }, raw: true });
        const qTimes = [...new Set(qRecords.map(r => new Date(r.time).toISOString()))].sort();

        // 已完成的季度：2025-Q3, 2025-Q4, 2026-Q1
        // 当前季度 2026-Q2 未完成，不会被聚合
        expect(qTimes.length).to.be.at.least(3);

        // 2025-Q3: total sum=15, success sum=12
        const q3Start = dayjs('2025-07-01').startOf('month').toDate();
        const q3TotalSum = qRecords.find(
          r => isSameTime(r.time, q3Start) && r.attributeName === 'total' && r.aggregate === 'sum'
        );
        expect(q3TotalSum).to.exist;
        expect(parseFloat(q3TotalSum.data)).to.equal(15);

        // 2025-Q4: total sum=20+15=35, success sum=18+12=30
        const q4Start = dayjs('2025-10-01').startOf('month').toDate();
        const q4TotalSum = qRecords.find(
          r => isSameTime(r.time, q4Start) && r.attributeName === 'total' && r.aggregate === 'sum'
        );
        expect(q4TotalSum).to.exist;
        expect(parseFloat(q4TotalSum.data)).to.equal(35);

        // 2026-Q1: total sum=30+25+40+35=130, success sum=28+22+38+30=118
        const q1Start = dayjs('2026-01-01').startOf('month').toDate();
        const q1TotalSum = qRecords.find(
          r => isSameTime(r.time, q1Start) && r.attributeName === 'total' && r.aggregate === 'sum'
        );
        expect(q1TotalSum).to.exist;
        expect(parseFloat(q1TotalSum.data)).to.equal(130);

        // ===== 验证 y 周期聚合 =====
        const yRecords = await models.periodStat.findAll({ where: { period: 'y' }, raw: true });
        const yTimes = [...new Set(yRecords.map(r => new Date(r.time).toISOString()))].sort();

        // 已完成的年：2025
        // 当前年 2026 未完成，不会被聚合
        expect(yTimes.length).to.be.at.least(1);

        // 2025: total sum=15+35=50, success sum=12+30=42
        const y2025Start = dayjs('2025-01-01').startOf('year').toDate();
        const y2025TotalSum = yRecords.find(
          r => isSameTime(r.time, y2025Start) && r.attributeName === 'total' && r.aggregate === 'sum'
        );
        expect(y2025TotalSum).to.exist;
        expect(parseFloat(y2025TotalSum.data)).to.equal(50);

        const y2025SuccessSum = yRecords.find(
          r => isSameTime(r.time, y2025Start) && r.attributeName === 'success' && r.aggregate === 'sum'
        );
        expect(y2025SuccessSum).to.exist;
        expect(parseFloat(y2025SuccessSum.data)).to.equal(42);

        // ===== 验证水位线 =====
        const hWm = await models.aggregationWatermark.findOne({ where: { period: 'h' }, raw: true });
        const dWm = await models.aggregationWatermark.findOne({ where: { period: 'd' }, raw: true });
        const mWm = await models.aggregationWatermark.findOne({ where: { period: 'm' }, raw: true });
        const qWm = await models.aggregationWatermark.findOne({ where: { period: 'q' }, raw: true });
        const yWm = await models.aggregationWatermark.findOne({ where: { period: 'y' }, raw: true });

        // h 水位线应推进到当前小时
        const nowTruncatedH = dayjs().startOf('hour').toDate();
        expect(new Date(hWm.nextTime).getTime()).to.equal(nowTruncatedH.getTime());

        // d 水位线应推进到今天
        const nowTruncatedD = dayjs().startOf('day').toDate();
        expect(new Date(dWm.nextTime).getTime()).to.equal(nowTruncatedD.getTime());

        // m 水位线应推进到当前月
        const nowTruncatedM = dayjs().startOf('month').toDate();
        expect(new Date(mWm.nextTime).getTime()).to.equal(nowTruncatedM.getTime());

        // q 水位线应推进到当前季度
        const nowQ = dayjs();
        const nowTruncatedQ = nowQ.month(Math.floor(nowQ.month() / 3) * 3).startOf('month').toDate();
        expect(new Date(qWm.nextTime).getTime()).to.equal(nowTruncatedQ.getTime());

        // y 水位线应推进到当前年
        const nowTruncatedY = dayjs().startOf('year').toDate();
        expect(new Date(yWm.nextTime).getTime()).to.equal(nowTruncatedY.getTime());

        await fastify.close();
      });

      it('应正确处理跨月多天的 d→m→q→y 聚合', async () => {
        const { fastify, models } = await createSqliteTestEnv();
        await loadPeriodStatService(fastify, { compensationEnabled: true });

        // 构造 2025 年的完整数据（已完成的年、季、月）
        // 2025-04 和 2025-05 (都在 Q2)
        const records = [];

        // 2025-04-10 (Q2)
        records.push(
          { channel: 'order', attributeName: 'amount', data: 100, time: localDate('2025-04-10T10:00:00'), unit: 'yuan' },
          { channel: 'order', attributeName: 'amount', data: 200, time: localDate('2025-04-10T14:00:00'), unit: 'yuan' }
        );

        // 2025-04-15 (Q2)
        records.push(
          { channel: 'order', attributeName: 'amount', data: 150, time: localDate('2025-04-15T09:00:00'), unit: 'yuan' },
          { channel: 'order', attributeName: 'amount', data: 250, time: localDate('2025-04-15T16:00:00'), unit: 'yuan' }
        );

        // 2025-05-01 (Q2)
        records.push(
          { channel: 'order', attributeName: 'amount', data: 400, time: localDate('2025-05-01T08:00:00'), unit: 'yuan' },
          { channel: 'order', attributeName: 'amount', data: 500, time: localDate('2025-05-01T12:00:00'), unit: 'yuan' }
        );

        // 2025-07-15 (Q3, 不同季度)
        records.push(
          { channel: 'order', attributeName: 'amount', data: 300, time: localDate('2025-07-15T11:00:00'), unit: 'yuan' }
        );

        await models.dataRecord.bulkCreate(records);

        await fastify.statistics.services.periodStat.init();

        // ===== 验证 d 聚合 =====
        const dRecords = await models.periodStat.findAll({ where: { period: 'd', attributeName: 'amount' }, raw: true });
        const dTimes = [...new Set(dRecords.map(r => new Date(r.time).toISOString()))].sort();
        expect(dTimes.length).to.be.at.least(4); // 4 天

        // 2025-04-10: sum=100+200=300
        const d0410 = dayjs('2025-04-10').startOf('day').toDate();
        const d0410Sum = dRecords.find(r => isSameTime(r.time, d0410) && r.aggregate === 'sum');
        expect(d0410Sum).to.exist;
        expect(parseFloat(d0410Sum.data)).to.equal(300);

        // 2025-05-01: sum=400+500=900
        const d0501 = dayjs('2025-05-01').startOf('day').toDate();
        const d0501Sum = dRecords.find(r => isSameTime(r.time, d0501) && r.aggregate === 'sum');
        expect(d0501Sum).to.exist;
        expect(parseFloat(d0501Sum.data)).to.equal(900);

        // ===== 验证 m 聚合 =====
        const mRecords = await models.periodStat.findAll({ where: { period: 'm', attributeName: 'amount' }, raw: true });

        // 2025-04: sum=100+200+150+250=700
        const mApr = dayjs('2025-04-01').startOf('month').toDate();
        const mAprSum = mRecords.find(r => isSameTime(r.time, mApr) && r.aggregate === 'sum');
        expect(mAprSum).to.exist;
        expect(parseFloat(mAprSum.data)).to.equal(700);

        // 2025-05: sum=400+500=900
        const mMay = dayjs('2025-05-01').startOf('month').toDate();
        const mMaySum = mRecords.find(r => isSameTime(r.time, mMay) && r.aggregate === 'sum');
        expect(mMaySum).to.exist;
        expect(parseFloat(mMaySum.data)).to.equal(900);

        // 2025-07: sum=300
        const mJul = dayjs('2025-07-01').startOf('month').toDate();
        const mJulSum = mRecords.find(r => isSameTime(r.time, mJul) && r.aggregate === 'sum');
        expect(mJulSum).to.exist;
        expect(parseFloat(mJulSum.data)).to.equal(300);

        // ===== 验证 q 聚合 =====
        const qRecords = await models.periodStat.findAll({ where: { period: 'q', attributeName: 'amount' }, raw: true });

        // 2025-Q2 (04-01): sum=700+900=1600
        const qQ2 = dayjs('2025-04-01').startOf('month').toDate();
        const qQ2Sum = qRecords.find(r => isSameTime(r.time, qQ2) && r.aggregate === 'sum');
        expect(qQ2Sum).to.exist;
        expect(parseFloat(qQ2Sum.data)).to.equal(1600);

        // 2025-Q3 (07-01): sum=300
        const qQ3 = dayjs('2025-07-01').startOf('month').toDate();
        const qQ3Sum = qRecords.find(r => isSameTime(r.time, qQ3) && r.aggregate === 'sum');
        expect(qQ3Sum).to.exist;
        expect(parseFloat(qQ3Sum.data)).to.equal(300);

        // ===== 验证 y 聚合 =====
        const yRecords = await models.periodStat.findAll({ where: { period: 'y', attributeName: 'amount' }, raw: true });

        // 2025: sum=1600+300=1900
        const y2025 = dayjs('2025-01-01').startOf('year').toDate();
        const y2025Sum = yRecords.find(r => isSameTime(r.time, y2025) && r.aggregate === 'sum');
        expect(y2025Sum).to.exist;
        expect(parseFloat(y2025Sum.data)).to.equal(1900);

        await fastify.close();
      });

      it('应正确聚合多通道层级数据', async () => {
        const { fastify, models } = await createSqliteTestEnv();
        await loadPeriodStatService(fastify, { compensationEnabled: true });

        // 使用历史日期确保聚合完成
        const records = [];
        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

        records.push(
          { channel: 'record-result', attributeName: 'total', data: 5, time: localDate(`${yesterday}T08:00:00`), unit: 'count' },
          { channel: 'record-result:system', attributeName: 'total', data: 3, time: localDate(`${yesterday}T08:00:00`), unit: 'count' },
          { channel: 'record-result:system:7', attributeName: 'total', data: 1, time: localDate(`${yesterday}T08:00:00`), unit: 'count' }
        );

        await models.dataRecord.bulkCreate(records);

        await fastify.statistics.services.periodStat.init();

        // 验证 d 聚合 - 每个通道各自聚合
        const dRecords = await models.periodStat.findAll({ where: { period: 'd', aggregate: 'sum' }, raw: true });

        const dRoot = dRecords.find(r => r.channel === 'record-result' && r.attributeName === 'total');
        expect(dRoot).to.exist;
        expect(parseFloat(dRoot.data)).to.equal(5);

        const dSystem = dRecords.find(r => r.channel === 'record-result:system' && r.attributeName === 'total');
        expect(dSystem).to.exist;
        expect(parseFloat(dSystem.data)).to.equal(3);

        const dSystem7 = dRecords.find(r => r.channel === 'record-result:system:7' && r.attributeName === 'total');
        expect(dSystem7).to.exist;
        expect(parseFloat(dSystem7.data)).to.equal(1);

        await fastify.close();
      });

      it('应在 init 后再次 init 时不重复聚合已有数据', async () => {
        const { fastify, models } = await createSqliteTestEnv();
        await loadPeriodStatService(fastify, { compensationEnabled: true });

        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
        await models.dataRecord.bulkCreate([
          { channel: 'task', attributeName: 'total', data: 10, time: localDate(`${yesterday}T08:00:00`), unit: 'count' },
          { channel: 'task', attributeName: 'total', data: 20, time: localDate(`${yesterday}T09:00:00`), unit: 'count' }
        ]);

        // 第一次 init
        await fastify.statistics.services.periodStat.init();

        const hCount1 = await models.periodStat.count({ where: { period: 'h' } });
        const dCount1 = await models.periodStat.count({ where: { period: 'd' } });

        // 第二次 init - 水位线已是最新的，不应重复聚合
        await fastify.statistics.services.periodStat.init();

        const hCount2 = await models.periodStat.count({ where: { period: 'h' } });
        const dCount2 = await models.periodStat.count({ where: { period: 'd' } });

        expect(hCount2).to.equal(hCount1);
        expect(dCount2).to.equal(dCount1);

        await fastify.close();
      });

      it('应正确处理昨天数据生成 d 级别聚合（用户报告的 bug）', async () => {
        const { fastify, models } = await createSqliteTestEnv();
        await loadPeriodStatService(fastify, { compensationEnabled: true });

        // 模拟用户报告的场景：data-record 中有今天和昨天的数据
        // init 后应该有昨天的 d 级别聚合
        const yesterday = dayjs().subtract(1, 'day');
        const yesterdayStr = yesterday.format('YYYY-MM-DD');
        const todayStr = dayjs().format('YYYY-MM-DD');

        await models.dataRecord.bulkCreate([
          // 昨天的数据
          { channel: 'task', attributeName: 'total', data: 10, time: localDate(`${yesterdayStr}T08:00:00`), unit: 'count' },
          { channel: 'task', attributeName: 'total', data: 20, time: localDate(`${yesterdayStr}T14:00:00`), unit: 'count' },
          // 今天的数据
          { channel: 'task', attributeName: 'total', data: 30, time: localDate(`${todayStr}T08:00:00`), unit: 'count' }
        ]);

        await fastify.statistics.services.periodStat.init();

        // 验证昨天的 h 聚合存在
        const hRecords = await models.periodStat.findAll({ where: { period: 'h' }, raw: true });
        const yesterdayH = hRecords.filter(r => {
          const t = new Date(r.time);
          return dayjs(t).format('YYYY-MM-DD') === yesterdayStr;
        });
        expect(yesterdayH.length).to.be.at.least(2); // 至少 2 个小时窗口

        // 关键验证：昨天的 d 聚合必须存在！
        const dRecords = await models.periodStat.findAll({ where: { period: 'd' }, raw: true });
        const yesterdayDStart = yesterday.startOf('day').toDate();
        const yesterdayDSum = dRecords.find(
          r => isSameTime(r.time, yesterdayDStart) && r.attributeName === 'total' && r.aggregate === 'sum'
        );
        expect(yesterdayDSum).to.exist;
        expect(parseFloat(yesterdayDSum.data)).to.equal(30); // 10 + 20

        await fastify.close();
      });
    });
  });
});
