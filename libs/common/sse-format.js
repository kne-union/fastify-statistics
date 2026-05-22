const formatData = data => {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return (
    json
      .split('\n')
      .map(line => `data: ${line}`)
      .join('\n') + '\n\n'
  );
};

const formatEvent = (event, data) => {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  const dataLines = json
    .split('\n')
    .map(line => `data: ${line}`)
    .join('\n');
  return `event: ${event}\n${dataLines}\n\n`;
};

module.exports = { formatData, formatEvent };
