import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { groupedServers } from '../app/group-servers.mjs';
import { importPayload } from '../app/import-link.mjs';

test('country grouping keeps all matching servers together, including uncategorized entries', () => {
  const de1 = { country: 'DE', region: 'Германия', key: 'de1' };
  const de2 = { country: 'DE', region: 'Германия', key: 'de2' };
  const fr = { country: 'FR', region: 'Франция', key: 'fr' };
  const other = { country: '', key: 'other' };
  const servers = [fr, de1, other, de2];
  assert.deepEqual(groupedServers(servers, new Set(['DE']), false).map(item => item.key),
    ['country:DE', 'country:FR', 'fr', 'country:', 'other']);
  const search = groupedServers(servers, new Set(['DE']), true);
  assert.equal(search[0].count, 2);
  assert.deepEqual(search.slice(1, 3), [de1, de2]);
});

test('import links unwrap ShareSub and Android links without admitting unrelated URLs', () => {
  const source = 'https://vpn.example.test/subscription?q=a%2Bb';
  const encoded = encodeURIComponent(source);
  assert.equal(importPayload('sharesub://import?url=' + encoded), source);
  assert.equal(importPayload('https://app.sharesub.ru/import?url=' + encoded), source);
  assert.equal(importPayload('sharesub://add/' + encoded), source);
  assert.equal(importPayload('happ://add/' + encoded), source);
  assert.equal(importPayload('sharesub://importer?url=' + encoded), '');
  assert.equal(importPayload('sharesub://import@another-host?url=' + encoded), '');
  assert.equal(importPayload('https://app.sharesub.ru.example/import?url=' + encoded), '');
  assert.equal(importPayload('sharesub://import?url=file%3A%2F%2F%2Ftmp%2Ftest'), '');
});

test('ShareSub launcher and subscription pages are converted to the subscription feed', () => {
  const token = 'abcDE1234_5678-fgh';
  const feed = 'https://sub.sharesub.ru/' + token;
  const launcher = 'https://sub.sharesub.ru/launch/sharesub/' + token + '?source=browser';
  assert.equal(importPayload(launcher), feed);
  assert.equal(importPayload('https://sub.sharesub.ru/subscription/' + token + '/'), feed);
  assert.equal(importPayload('sharesub://import?url=' + encodeURIComponent(launcher)), feed);
  assert.equal(importPayload('https://sub.sharesub.ru.example/launch/sharesub/' + token), '');
  assert.equal(importPayload('https://sub.sharesub.ru/launch/happ/' + token), '');
  assert.equal(importPayload('https://sub.sharesub.ru/launch/sharesub/short'), '');
});
