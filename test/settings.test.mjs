import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import settingsStore from '../desktop/settings.cjs';

test('starting with existing preferences reads them without rewriting the profile', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sharesub-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'subscriptions.json');
  const existing = { id: 'aaaaaaaa-bbbb-4ccc-8888-dddddddddddd', sources: ['https://example.invalid/test'], theme: 'dark' };
  await writeFile(file, JSON.stringify(existing, null, 2));
  const before = await stat(file);
  const result = await settingsStore(dir).get();
  assert.equal(result.id, existing.id);
  assert.deepEqual(result.sources, existing.sources);
  assert.equal(result.theme, 'dark');
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), existing);
});

test('startup succeeds when a stale temporary file exists and updates are serialized', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sharesub-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacyTemporary = path.join(dir, 'subscriptions.json.tmp');
  await writeFile(legacyTemporary, 'stale');
  const store = settingsStore(dir);
  const [first, second] = await Promise.all([store.get(), store.get()]);
  assert.equal(first.id, second.id);
  await Promise.all([store.update({ theme: 'dark' }), store.update({ sources: ['https://example.invalid/test'] })]);
  const reopened = await settingsStore(dir).get();
  assert.equal(reopened.id, first.id);
  assert.equal(reopened.theme, 'dark');
  assert.deepEqual(reopened.sources, ['https://example.invalid/test']);
  assert.equal(await readFile(legacyTemporary, 'utf8'), 'stale');
});
