const { expect } = require('chai');
const {
  resolveChannelScope,
  filterLeafChannels,
  flattenTreeToList,
  buildChannelWhere
} = require('../libs/common/channel-utils');

describe('channel-utils', () => {
  describe('resolveChannelScope', () => {
    it('defaults to exact', () => {
      expect(resolveChannelScope({})).to.equal('exact');
    });

    it('maps includeChildren to descendantsTree', () => {
      expect(resolveChannelScope({ includeChildren: true })).to.equal('descendantsTree');
    });

    it('prefers explicit channelScope', () => {
      expect(resolveChannelScope({ channelScope: 'descendantsFlat', includeChildren: true })).to.equal('descendantsFlat');
    });
  });

  describe('filterLeafChannels', () => {
    it('keeps only leaf channels', () => {
      const leaves = filterLeafChannels(['interview', 'interview:1', 'interview:1:2', 'interview:1:3']);
      expect(leaves).to.deep.equal(['interview:1:2', 'interview:1:3']);
    });

    it('respects maxDepth', () => {
      const leaves = filterLeafChannels(['interview:1:2:3', 'interview:1:2'], { maxDepth: 3 });
      expect(leaves).to.deep.equal(['interview:1:2']);
    });
  });

  describe('flattenTreeToList', () => {
    it('flattens tree nodes to channel items', () => {
      const list = flattenTreeToList([
        {
          channel: 'sensor',
          items: [{ period: 'h', time: new Date('2026-01-01'), data: { temp: 1 } }],
          children: [
            {
              channel: 'sensor:a',
              items: [{ period: 'h', time: new Date('2026-01-01'), data: { temp: 2 } }]
            }
          ]
        }
      ]);

      expect(list).to.have.length(2);
      expect(list[0].channel).to.equal('sensor');
      expect(list[1].channel).to.equal('sensor:a');
    });
  });

  describe('buildChannelWhere', () => {
    it('builds exact IN clause', () => {
      const Op = { in: 'in' };
      expect(buildChannelWhere(['a', 'b'], 'exact', Op)).to.deep.equal({ channel: { in: ['a', 'b'] } });
    });

    it('builds descendants OR clause', () => {
      const Op = { or: 'or', like: 'like' };
      const where = buildChannelWhere(['sensor'], 'descendantsFlat', Op);
      expect(where.or).to.have.length(2);
    });
  });
});
