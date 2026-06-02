module.exports = ({ DataTypes, options }) => {
  return {
    model: {
      period: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '周期类型：h(时)/d(日)/w(周)/m(月)/q(季)/y(年)'
      },
      nextTime: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '下一次应聚合的起始时间'
      }
    },
    options: {
      comment: '聚合水位线',
      indexes: [
        {
          name: `idx${options.modelPrefix || ''}_aggregation_watermark_period`,
          unique: true,
          fields: ['period']
        }
      ]
    }
  };
};
