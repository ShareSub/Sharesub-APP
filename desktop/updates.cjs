const { createHash, verify } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const site = 'https://app.sharesub.ru';
const feed = site + '/api/latest.json';
const limit = 256 * 1024 * 1024;

function newer(next, current) {
  const existing = current.split('.').map(Number);
  const difference = next.split('.').map((value, index) => Number(value) - existing[index]).find(value => value !== 0);
  return difference > 0;
}

module.exports = function createUpdater(app, beforeInstall) {
  let downloadTask, available, context = { state: 'idle' };

  async function check() {
    if (downloadTask) return { ...context };
    if (context.state === 'ready') return { ...context };
    try {
      const response = await fetch(feed, { redirect: 'error', signal: AbortSignal.timeout(12_000) });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16000) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(value);
      }
      const data = Buffer.concat(chunks, size).toString('utf8');
      const { payload, signature } = JSON.parse(data);
      const body = Buffer.from(payload, 'base64');
      const publicKey = await fs.readFile(path.join(__dirname, '../app/update-public.pem'));
      if (!verify('sha256', body, publicKey, Buffer.from(signature, 'base64'))) throw new Error();
      const { version, artifacts } = JSON.parse(body.toString('utf8'));
      const entry = artifacts.windows;
      const target = site + '/releases/ShareSub-' + version + '-Windows-x64.exe';
      if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version) || entry.url !== target ||
          !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > limit) throw new Error();
      available = newer(version, app.getVersion()) ? { ...entry, version } : null;
      context = available ? { state: 'available', version } : { state: 'current', version };
      return { ...context };
    } catch {
      if (context.state !== 'ready') context = { state: 'error', error: 'Не удалось проверить обновления.' };
      return { ...context };
    }
  }

  async function download(entry) {
    const dir = path.join(app.getPath('userData'), 'updates');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'ShareSub-' + entry.version + '-Windows-x64.exe');
    const partial = file + '.partial';
    const hash = createHash('sha256');
    let transferred = 0;
    try {
      const signal = AbortSignal.timeout(10 * 60_000);
      const response = await fetch(entry.url, { redirect: 'error', signal });
      if (!response.ok || !response.body) throw new Error();
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          transferred += chunk.length;
          if (transferred > entry.size) return callback(new Error('Size limit'));
          hash.update(chunk);
          context.progress = Math.floor(transferred * 100 / entry.size);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial, { flags: 'w', mode: 0o600 }), { signal });
      if (transferred !== entry.size || hash.digest('hex') !== entry.sha256) throw new Error();
      await fs.rename(partial, file);
      context = { state: 'ready', version: entry.version };
    } catch {
      await fs.unlink(partial).catch(() => {});
      context = { state: 'error', error: 'Не удалось скачать или проверить установщик.' };
    }
    return { ...context };
  }

  async function install() {
    if (downloadTask) return { ...context };
    if (!available || context.state !== 'ready') {
      if (!available) await check();
      if (!available) return { ...context };
      context = { state: 'downloading', version: available.version, progress: 0 };
      downloadTask = download(available).finally(() => { downloadTask = null; });
      return downloadTask;
    }
    const file = path.join(app.getPath('userData'), 'updates', 'ShareSub-' + available.version + '-Windows-x64.exe');
    const handle = await fs.open(file, 'r');
    try {
      if ((await handle.stat()).size !== available.size) throw new Error();
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest('hex') !== available.sha256) throw new Error();
    } finally {
      await handle.close();
    }
    await beforeInstall();
    const child = spawn(file, [], { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    app.quit();
    return { ...context };
  }

  return { check, install, status: () => ({ ...context }) };
};
