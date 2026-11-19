import { readFile } from 'node:fs/promises';
import { readNodes } from '../app/subscriptions.mjs';

if (!process.argv[2]) throw new Error('Usage: npm run bench -- <subscription file>');
const input = await readFile(process.argv[2], 'utf8');
const times = [];
let count = 0;
for (let run = 0; run < 35; run++) {
  const started = performance.now();
  count = 0;
  for (const node of readNodes(input)) count++;
  if (run >= 5) times.push(performance.now() - started);
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({
  servers: count, bytes: Buffer.byteLength(input), runs: times.length,
  medianMs: Number(times[Math.floor(times.length / 2)].toFixed(2)),
  p95Ms: Number(times[Math.ceil(times.length * .95) - 1].toFixed(2)),
}));
