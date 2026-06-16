const { expect } = require('chai');
const { normalizeToFlatRecords, rollupTotals, summarizeWindows } = require('../libs/common/normalize-query-result');

describe('normalize-query-result', () => {
  describe('normalizeToFlatRecords', () => {
    it('flattens single-aggregate attribute map', () => {
      const records = normalizeToFlatRecords(
        [{ channel: 'a', period: 'd', time: new Date('2026-01-01'), data: { invite: 5, attend: 3 } }],
        ['sum']
      );

      expect(records).to.have.length(2);
      expect(records[0]).to.include({ channel: 'a', attributeName: 'invite', aggregate: 'sum', data: 5 });
      expect(records[1]).to.include({ attributeName: 'attend', data: 3 });
    });

    it('flattens nested multi-aggregate map', () => {
      const records = normalizeToFlatRecords(
        [{ channel: 'a', period: 'h', time: new Date('2026-01-01'), data: { sum: { invite: 1 }, max: { score: 90 } } }],
        ['sum', 'max']
      );

      expect(records).to.have.length(2);
      expect(records.find(r => r.aggregate === 'max').data).to.equal(90);
    });
  });

  describe('rollupTotals', () => {
    it('sums across records and takes max per channel', () => {
      const rollup = rollupTotals([
        { channel: 'a', attributeName: 'invite', aggregate: 'sum', data: 2 },
        { channel: 'b', attributeName: 'invite', aggregate: 'sum', data: 3 },
        { channel: 'a', attributeName: 'score', aggregate: 'max', data: 80 },
        { channel: 'a', attributeName: 'score', aggregate: 'max', data: 95 }
      ]);

      expect(rollup.totals.invite).to.equal(5);
      expect(rollup.maxByChannel.a.score).to.equal(95);
      expect(rollup.totalsByChannel.b.invite).to.equal(3);
    });
  });

  describe('summarizeWindows', () => {
    it('groups records by period and time', () => {
      const time = new Date('2026-01-01');
      const summary = summarizeWindows([
        { period: 'h', time, attributeName: 'invite', aggregate: 'sum', data: 1 },
        { period: 'h', time, attributeName: 'attend', aggregate: 'sum', data: 2 }
      ]);

      expect(summary).to.have.length(1);
      expect(summary[0].period).to.equal('h');
      expect(summary[0].count).to.equal(2);
    });
  });
});
