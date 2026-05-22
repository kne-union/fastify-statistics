const fp = require('fastify-plugin');
const omit = require('lodash/omit');

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];

  const detail = async ({ channel }) => {
    return models.channelMeta.findOne({
      where: { channel }
    });
  };

  const list = async ({ filter = {} } = {}) => {
    const where = {};
    if (filter.channel) {
      where.channel = filter.channel;
    }
    return models.channelMeta.findAll({ where });
  };

  const save = async ({ channel, ...data }) => {
    const [affectedCount] = await models.channelMeta.update(omit(data, ['channel']), { where: { channel } });
    if (affectedCount === 0) {
      throw new Error(`Channel meta not found: ${channel}`);
    }
    return models.channelMeta.findOne({
      where: { channel }
    });
  };

  Object.assign(fastify[options.name].services, {
    channelMeta: {
      detail,
      list,
      save
    }
  });
});
