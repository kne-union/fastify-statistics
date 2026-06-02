module.exports = ({ DataTypes, options }) => {
  return {
    model: {
      channel: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '数据通道'
      },
      attributeName: {
        type: DataTypes.STRING,
        comment: '属性名',
        defaultValue: 'default'
      },
      data: {
        type: DataTypes.DECIMAL(16, 2),
        allowNull: false,
        comment: '数据值',
        defaultValue: 0
      },
      time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '采集时间'
      },
      unit: {
        type: DataTypes.STRING,
        comment: '数据单位'
      }
    },
    associate: ({ dataRecord, channelMeta }) => {
      dataRecord.belongsTo(channelMeta, {
        comment: '通道meta数据'
      });
    },
    options: {
      comment: '数据采集记录',
      indexes: [
        {
          name: `idx${options.modelPrefix || ''}_data_record_channel`,
          fields: ['channel']
        },
        {
          name: `idx${options.modelPrefix || ''}_data_record_time`,
          fields: ['time']
        },
        {
          name: `idx${options.modelPrefix || ''}_data_record_channel_time`,
          fields: ['channel', 'time']
        },
        {
          name: `idx${options.modelPrefix || ''}_data_record_channel_attr_time`,
          fields: ['channel', 'attribute_name', 'time']
        },
        { name: `idx${options.modelPrefix || ''}_idx_data_record_attr_name`, fields: ['attribute_name'] }
      ]
    }
  };
};
