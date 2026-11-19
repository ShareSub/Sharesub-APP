import { parseError, readBatches } from './subscriptions.mjs';

self.onmessage = ({ data }) => {
  const started = performance.now();
  let count = 0;
  try {
    for (const batch of readBatches(data.text)) {
      count += batch.length;
      self.postMessage({ type: 'batch', batch });
    }
    self.postMessage({ type: 'done', count, ms: performance.now() - started });
  } catch (error) {
    self.postMessage({ type: 'error', message: parseError(error) });
  }
};
