const escapeLike = str => str.replace(/[%_\\]/g, '\\$&');

const CHANNEL_SCOPES = ['exact', 'descendantsFlat', 'descendantsTree'];

const resolveChannelScope = ({ channelScope, includeChildren }) => {
  if (channelScope && CHANNEL_SCOPES.includes(channelScope)) {
    return channelScope;
  }
  if (includeChildren) {
    return 'descendantsTree';
  }
  return 'exact';
};

const getChannelDepth = channel => (channel ? channel.split(':').length : 0);

const buildChannelWhere = (channelList, channelScope, Op) => {
  if (!channelList.length) {
    return {};
  }

  if (channelScope === 'exact') {
    return { channel: { [Op.in]: channelList } };
  }

  return {
    [Op.or]: channelList.flatMap(ch => [{ channel: ch }, { channel: { [Op.like]: `${escapeLike(ch)}:%` } }])
  };
};

/**
 * 从 channel 列表中过滤出叶子 channel（不作为其他 channel 的前缀）
 */
const filterLeafChannels = (channels, { maxDepth } = {}) => {
  const unique = [...new Set(channels.filter(Boolean))];
  let candidates = unique;
  if (maxDepth) {
    candidates = candidates.filter(channel => getChannelDepth(channel) <= maxDepth);
  }
  const sorted = candidates.sort((a, b) => b.length - a.length || a.localeCompare(b));

  return sorted.filter(channel => !sorted.some(other => other !== channel && other.startsWith(`${channel}:`)));
};

/**
 * 将树形 query 结果展平为带 channel 的 item 列表
 */
const flattenTreeToList = nodes => {
  const results = [];

  const walk = node => {
    if (!node) {
      return;
    }
    if (Array.isArray(node.items)) {
      for (const item of node.items) {
        results.push({
          channel: node.channel,
          period: item.period,
          time: item.time,
          data: item.data,
          unit: item.unit
        });
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };

  for (const node of nodes) {
    if (node.channel && (node.items || node.children)) {
      walk(node);
      continue;
    }
    if (node.channel && node.period) {
      results.push(node);
    }
  }

  return results;
};

module.exports = {
  CHANNEL_SCOPES,
  escapeLike,
  resolveChannelScope,
  getChannelDepth,
  buildChannelWhere,
  filterLeafChannels,
  flattenTreeToList
};
