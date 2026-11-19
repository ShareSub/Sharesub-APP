const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function subscriptionRefreshMinutes(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1440 ? value : 60;
}

function settingsStore(directory) {
  const file = path.join(directory, 'subscriptions.json');
  let loading, current;
  let writes = Promise.resolve();

  async function write(value) {
    await fs.mkdir(directory, { recursive: true });
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true });
      await fs.rename(temporary, file);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  async function load() {
    let data;
    let exists = true;
    try {
      data = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      exists = error.code !== 'ENOENT';
    }
    if (!data || typeof data !== 'object') data = {};
    const hasId = typeof data.id === 'string' && /^[a-f0-9-]{36}$/i.test(data.id);
    current = {
      id: hasId ? data.id : crypto.randomUUID(),
      sources: Array.isArray(data.sources) ? data.sources.filter(value => typeof value === 'string') : [],
      grouped: Boolean(data.grouped),
      automatic: data.automatic !== false,
      subscriptionRefreshMinutes: subscriptionRefreshMinutes(data.subscriptionRefreshMinutes),
      theme: data.theme === 'dark' ? 'dark' : 'light',
      showMemory: data.showMemory !== false,
      showBattery: data.showBattery !== false,
    };
    if (!exists) await write(current).catch(() => {});
    return current;
  }

  async function get() {
    if (loading) await loading;
    else await (loading = load());
    return current;
  }

  function update(fields) {
    const task = writes.then(async () => {
      const value = { ...await get(), ...fields };
      await write(value);
      current = value;
    });
    writes = task.catch(() => {});
    return task;
  }

  return { get, update };
}

module.exports = Object.assign(settingsStore, { subscriptionRefreshMinutes });
