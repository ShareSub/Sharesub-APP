import { readNodes } from './subscriptions.mjs';

self.onmessage = ({ data }) => {
  const started = performance.now();
  let batch = [];
  let count = 0;
  try {
    for (const server of readNodes(data.text)) {
      batch.push(server);
      count++;
      if (batch.length !== (count < 129 ? 24 : 96)) continue;
      self.postMessage({ type: 'batch', batch });
      batch = [];
    }
    if (batch.length) self.postMessage({ type: 'batch', batch });
    if (!count) throw new Error('В подписке нет поддерживаемых серверов.');
    self.postMessage({ type: 'done', count, ms: performance.now() - started });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof SyntaxError ? 'Не удалось прочитать JSON подписки.' : error.message });
  }
};
