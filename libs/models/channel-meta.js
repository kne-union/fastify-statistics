module.exports = ({ DataTypes, options }) => {
  return {
    model: {
      channel: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '数据通道'
      },
      title: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '标题'
      },
      description: {
        type: DataTypes.TEXT,
        comment: '描述'
      }
    },
    options: {
      comment: '通道元数据',
      indexes: [{ name: 'idx_channel_meta_channel', unique: true, fields: ['channel'] }]
    }
  };
};
