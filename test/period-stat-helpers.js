const fp = require('fastify-plugin');

const mockPeriodStatService = async (fastify, options) => {
  const servicePlugin = require('../libs/services/period-stat');
  await fp(servicePlugin)(fastify, options);
  await fastify[options.name || 'statistics'].services.periodStat.init();
};

const toTime = value => new Date(value).getTime();

const matchesScalarCondition = (value, condition) => {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    return value === condition;
  }
  if (condition.in) return condition.in.includes(value);
  if (condition.like) {
    const pattern = String(condition.like).replaceAll('\\%', '%').replaceAll('\\_', '_');
    return String(value || '').startsWith(pattern.replace(/%$/, ''));
  }
  return true;
};

const startOfHour = value => {
  const date = new Date(value);
  date.setMinutes(0, 0, 0);
  return date.getTime();
};

const matchesDateCondition = (value, condition, period) => {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    return toTime(value) === toTime(condition);
  }
  const time = toTime(value);
  if (condition.in) {
    return condition.in.some(item => toTime(item) === time || (period === 'h' && startOfHour(item) === startOfHour(value)));
  }
  if (condition.between) {
    const [start, end] = condition.between;
    return time >= toTime(start) && time <= toTime(end);
  }
  if (condition.gte && time < toTime(condition.gte)) return false;
  if (condition.gt && time <= toTime(condition.gt)) return false;
  if (condition.lte && time > toTime(condition.lte)) return false;
  if (condition.lt && time >= toTime(condition.lt)) return false;
  return true;
};

const matchesPeriodStatWhere = (row, where = {}) => {
  if (where.or) return where.or.some(branch => matchesPeriodStatWhere(row, branch));
  if (where.period && !matchesScalarCondition(row.period, where.period)) return false;
  if (where.channel && !matchesScalarCondition(row.channel, where.channel)) return false;
  if (where.attributeName && row.attributeName != null && !matchesScalarCondition(row.attributeName, where.attributeName)) return false;
  if (where.aggregate && !matchesScalarCondition(row.aggregate, where.aggregate)) return false;
  if (where.time && !matchesDateCondition(row.time, where.time, row.period)) return false;
  return true;
};

const createMockFastify = () => {
  const findAllResults = [];
  const bulkCreateCalls = [];
  const destroyCalls = [];
  const periodStatRows = [];

  const mockTransaction = {
    commit: async () => {},
    rollback: async () => {}
  };

  const mockModel = {
    dataRecord: {
      findAll: async (opts) => findAllResults.splice(0, findAllResults.length),
      destroy: async (opts) => {
        destroyCalls.push(opts);
      },
      findOne: async () => null
    },
    periodStat: {
      bulkCreate: async (records, opts) => {
        bulkCreateCalls.push({ records: [...records], opts: opts || {} });
        return records;
      },
      findAll: async () => periodStatRows.splice(0, periodStatRows.length),
      findOne: async () => null
    },
    aggregationWatermark: {
      findOne: async () => null,
      upsert: async () => {},
      create: async (data) => data
    },
    channelMeta: {
      findAll: async () => []
    }
  };

  const fastify = require('fastify')();

  fastify.decorate('sequelize', {
    Sequelize: { Op: { between: 'between', gte: 'gte', lt: 'lt' }, fn: (name, col) => `${name}(${col})`, col: name => name },
    instance: { transaction: async () => mockTransaction }
  });

  fastify.decorate('statistics', {
    models: mockModel,
    services: {}
  });

  return { fastify, findAllResults, bulkCreateCalls, destroyCalls, periodStatRows, mockModel };
};

const createQueryMockFastify = () => {
  const periodStatRows = [];
  const dataRecordFindAllResult = [];
  const findAllCalls = [];
  const channelMetaRows = [];

  const mockTransaction = {
    commit: async () => {},
    rollback: async () => {}
  };

  const mockModel = {
    dataRecord: {
      findAll: async (opts) => {
        findAllCalls.push({ model: 'dataRecord', opts });
        return dataRecordFindAllResult.splice(0);
      },
      destroy: async () => {},
      findOne: async () => null
    },
    periodStat: {
      bulkCreate: async () => {},
      findAll: async (opts) => {
        findAllCalls.push({ model: 'periodStat', opts });
        return periodStatRows.filter(row => matchesPeriodStatWhere(row, opts.where));
      },
      findOne: async () => null
    },
    channelMeta: {
      findAll: async ({ where }) => {
        if (where && where.channel && where.channel.in) {
          return channelMetaRows.filter(row => where.channel.in.includes(row.channel));
        }
        return channelMetaRows;
      }
    },
    aggregationWatermark: {
      findOne: async () => null,
      upsert: async () => {},
      create: async (data) => data
    }
  };

  const fastify = require('fastify')();

  fastify.decorate('sequelize', {
    Sequelize: {
      Op: { between: 'between', like: 'like', or: 'or', in: 'in', gte: 'gte', lt: 'lt' },
      fn: (name, col) => `${name}(${col})`,
      col: name => name
    },
    instance: { transaction: async () => mockTransaction }
  });

  fastify.decorate('statistics', {
    models: mockModel,
    services: {}
  });

  return { fastify, periodStatRows, dataRecordFindAllResult, findAllCalls, channelMetaRows };
};

const createCacheTestMockFastify = () => {
  const periodStatRows = [];
  const findAllCalls = [];
  const channelMetaRows = [];

  const mockTransaction = {
    commit: async () => {},
    rollback: async () => {}
  };

  const mockModel = {
    dataRecord: {
      findAll: async (opts) => {
        findAllCalls.push({ model: 'dataRecord', opts });
        return [];
      },
      destroy: async () => {},
      findOne: async () => null
    },
    periodStat: {
      bulkCreate: async () => {},
      findAll: async (opts) => {
        findAllCalls.push({ model: 'periodStat', opts });
        return periodStatRows.filter(row => matchesPeriodStatWhere(row, opts.where));
      },
      findOne: async () => null
    },
    channelMeta: {
      findAll: async ({ where }) => {
        if (where && where.channel && where.channel.in) {
          return channelMetaRows.filter(row => where.channel.in.includes(row.channel));
        }
        return channelMetaRows;
      }
    },
    aggregationWatermark: {
      findOne: async () => null,
      upsert: async () => {},
      create: async (data) => data
    }
  };

  const fastify = require('fastify')();

  fastify.decorate('sequelize', {
    Sequelize: {
      Op: { between: 'between', like: 'like', or: 'or', in: 'in', gte: 'gte', lt: 'lt' },
      fn: (name, col) => `${name}(${col})`,
      col: name => name
    },
    instance: { transaction: async () => mockTransaction }
  });

  fastify.decorate('statistics', {
    models: mockModel,
    services: {}
  });

  return { fastify, periodStatRows, findAllCalls, channelMetaRows };
};

const createExternalCacheMockFastify = () => {
  const cacheStore = {};
  const externalCache = {
    get: async (key) => cacheStore[key] || null,
    set: async (key, value, ttl) => { cacheStore[key] = value; }
  };

  const periodStatRows = [];
  const findAllCalls = [];
  const channelMetaRows = [];

  const mockTransaction = {
    commit: async () => {},
    rollback: async () => {}
  };

  const mockModel = {
    dataRecord: {
      findAll: async (opts) => {
        findAllCalls.push({ model: 'dataRecord', opts });
        return [];
      },
      destroy: async () => {},
      findOne: async () => null
    },
    periodStat: {
      bulkCreate: async () => {},
      findAll: async (opts) => {
        findAllCalls.push({ model: 'periodStat', opts });
        return periodStatRows.filter(row => matchesPeriodStatWhere(row, opts.where));
      },
      findOne: async () => null
    },
    channelMeta: {
      findAll: async ({ where }) => {
        if (where && where.channel && where.channel.in) {
          return channelMetaRows.filter(row => where.channel.in.includes(row.channel));
        }
        return channelMetaRows;
      }
    },
    aggregationWatermark: {
      findOne: async () => null,
      upsert: async () => {},
      create: async (data) => data
    }
  };

  const fastify = require('fastify')();

  fastify.decorate('sequelize', {
    Sequelize: {
      Op: { between: 'between', like: 'like', or: 'or', in: 'in', gte: 'gte', lt: 'lt' },
      fn: (name, col) => `${name}(${col})`,
      col: name => name
    },
    instance: { transaction: async () => mockTransaction }
  });

  fastify.decorate('statistics', {
    models: mockModel,
    services: {}
  });

  return { fastify, periodStatRows, findAllCalls, channelMetaRows, cacheStore, externalCache };
};

const createCompensateMockFastify = () => {
  const findAllResults = [];
  const periodStatRows = [];
  const bulkCreateCalls = [];
  const watermarkStore = {};
  let destroyCount = 0;

  const mockTransaction = {
    commit: async () => {},
    rollback: async () => {}
  };

  const mockModel = {
    dataRecord: {
      findAll: async () => findAllResults.splice(0),
      findOne: async () => null,
      destroy: async () => { destroyCount++; return destroyCount; }
    },
    periodStat: {
      bulkCreate: async (records, opts) => {
        bulkCreateCalls.push({ records: [...records], opts: opts || {} });
        return records;
      },
      findAll: async (opts) => {
        return periodStatRows.filter(row => matchesPeriodStatWhere(row, opts.where));
      },
      findOne: async () => null
    },
    channelMeta: {
      findAll: async () => []
    },
    aggregationWatermark: {
      findOne: async ({ where }) => {
        const entry = watermarkStore[where.period];
        if (!entry) return null;
        return {
          ...entry,
          update: async (values) => { Object.assign(entry, values); }
        };
      },
      upsert: async (data) => { watermarkStore[data.period] = data; },
      create: async (data) => { watermarkStore[data.period] = data; return data; }
    }
  };

  const fastify = require('fastify')();
  fastify.decorate('sequelize', {
    Sequelize: { Op: { between: 'between', gte: 'gte', lt: 'lt' }, fn: (name, col) => `${name}(${col})`, col: name => name },
    instance: { transaction: async () => mockTransaction }
  });
  fastify.decorate('statistics', { models: mockModel, services: {} });

  return { fastify, findAllResults, periodStatRows, bulkCreateCalls, watermarkStore, mockModel };
};

const createFullMockFastify = () => {
  const periodStatRows = [];
  const findAllResults = [];
  const findAllCalls = [];
  const channelMetaRows = [];
  const bulkCreateCalls = [];
  const watermarkStore = {};
  const logCalls = { error: [], warn: [], info: [] };

  const mockTransaction = {
    commit: async () => {},
    rollback: async () => {}
  };

  const mockModel = {
    dataRecord: {
      findAll: async (opts) => {
        findAllCalls.push({ model: 'dataRecord', opts });
        return [...findAllResults];
      },
      findOne: async () => null,
      destroy: async () => {}
    },
    periodStat: {
      bulkCreate: async (records, opts) => {
        bulkCreateCalls.push({ records: [...records], opts: opts || {} });
        return records;
      },
      findAll: async (opts) => {
        findAllCalls.push({ model: 'periodStat', opts });
        return periodStatRows.filter(row => matchesPeriodStatWhere(row, opts.where));
      },
      findOne: async () => null
    },
    channelMeta: {
      findAll: async ({ where }) => {
        if (where && where.channel && where.channel.in) {
          return channelMetaRows.filter(row => where.channel.in.includes(row.channel));
        }
        return channelMetaRows;
      }
    },
    aggregationWatermark: {
      findOne: async ({ where }) => {
        const entry = watermarkStore[where.period];
        if (!entry) return null;
        return {
          ...entry,
          update: async (values) => { Object.assign(entry, values); }
        };
      },
      upsert: async (data) => { watermarkStore[data.period] = data; },
      create: async (data) => { watermarkStore[data.period] = data; return data; }
    }
  };

  const fastify = require('fastify')();

  ['error', 'warn', 'info'].forEach(level => {
    const orig = fastify.log[level];
    fastify.log[level] = function (...args) {
      logCalls[level].push(args.join(' '));
      return orig ? orig.apply(this, args) : undefined;
    };
  });

  fastify.decorate('sequelize', {
    Sequelize: {
      Op: { between: 'between', like: 'like', or: 'or', in: 'in', gte: 'gte', lt: 'lt' },
      fn: (name, col) => `${name}(${col})`,
      col: name => name
    },
    instance: { transaction: async () => mockTransaction }
  });

  fastify.decorate('statistics', {
    models: mockModel,
    services: {}
  });

  return {
    fastify, periodStatRows, findAllResults, findAllCalls,
    channelMetaRows, bulkCreateCalls, watermarkStore, logCalls, mockModel,
    mockTransaction
  };
};

module.exports = {
  mockPeriodStatService,
  createMockFastify,
  createQueryMockFastify,
  createCacheTestMockFastify,
  createExternalCacheMockFastify,
  createCompensateMockFastify,
  createFullMockFastify
};
