import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readNodes } from '../app/subscriptions.mjs';
import { tunnelConfig } from '../app/vpn-config.mjs';

const id = '3f07e637-81e1-42d9-8d64-be80fc4bb09e';
const pk = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const first = 'vless://' + id + '@server.invalid:443?type=xhttp&security=reality&sni=site.invalid&fp=chrome&pbk=' + pk + '&sid=7c&path=%2Fvpn#%F0%9F%87%A9%F0%9F%87%AA%20Berlin';
const encoded = (value) => Buffer.from(value).toString('base64url');

test('ShareSub Base64 with CRLF preserves REALITY and XHTTP and drops duplicates', () => {
  const list = [...readNodes(encoded(first + '\r\nvless://malformed\r\n' + first.replace('%20Berlin', '%20Berlin%202')))];
  assert.equal(list.length, 1);
  const [node] = list;
  assert.equal(node.name, '🇩🇪 Berlin');
  assert.equal(node.country, 'DE');
  assert.equal(node.outbound.streamSettings.realitySettings.password, pk);
  assert.equal(node.outbound.streamSettings.xhttpSettings.path, '/vpn');
  assert.equal(node.outbound.settings.vnext[0].users[0].encryption, 'none');
});

test('individual VMess, Trojan, Shadowsocks and Hysteria2 links', () => {
  const vmess = 'vmess://' + encoded(JSON.stringify({ add: 'example.invalid', port: 443, id, net: 'ws', path: '/relay', tls: 'tls', ps: 'VM' }));
  const trojan = 'trojan://hunter%3A2@[2001:db8::1]:443?sni=example.invalid';
  const ss = 'ss://' + encoded('aes-128-gcm:password') + '@example.invalid:80';
  const legacy = 'ss://' + encoded('aes-128-gcm:old@example.invalid:88');
  const hy2 = 'hy2://test@example.invalid:443?obfs=salamander&obfs-password=pass';
  const list = [...readNodes([vmess, trojan, ss, legacy, hy2].join('\n'))];
  assert.deepEqual(list.map(n => n.outbound.protocol), ['vmess', 'trojan', 'shadowsocks', 'shadowsocks', 'hysteria']);
  assert.equal(list[1].host, '2001:db8::1');
  assert.equal(list[1].outbound.settings.servers[0].password, 'hunter:2');
  assert.equal(list[2].port, 80);
  assert.equal(list[3].port, 88);
  assert.equal(list[4].outbound.streamSettings.finalmask.udp[0].type, 'salamander');
  assert.equal([...readNodes(hy2 + '&insecure=1')].length, 0);
});

test('Xray JSON imports nodes and uses application tunnel settings', () => {
  const [node] = readNodes(first);
  const profile = { remarks: 'Сервер', inbounds: [{ protocol: 'http' }], outbounds: [node.outbound, { protocol: 'freedom' }] };
  const [loaded] = readNodes(JSON.stringify([profile]));
  assert.equal(loaded.name, 'Сервер');
  const config = tunnelConfig(loaded, 'windows');
  assert.equal(config.inbounds[0].protocol, 'tun');
  assert.deepEqual(config.inbounds[0].settings.autoSystemRoutingTable, ['0.0.0.0/0', '::/0']);
  assert.equal(config.outbounds.length, 1);
});

test('HWID rejection pseudo-nodes are errors, and real nodes from mixed lists survive', () => {
  const notice = first.split('#')[0] + '#' + encodeURIComponent('Приложение не поддерживает HWID');
  for (const input of [
    notice, encoded(notice), 'Application does not support HWID',
    JSON.stringify({ message: 'HWID required' }),
  ]) assert.throws(() => [...readNodes(input)], /Провайдер не принял HWID/);
  const outbounds = [...readNodes(first)][0].outbound;
  assert.throws(() => [...readNodes(JSON.stringify([{ remarks: 'Приложение не поддерживает HWID', outbounds: [outbounds] }]))], /HWID/);
  assert.equal([...readNodes(notice + '\n' + first)].length, 1);
});
