import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readNodes } from '../app/subscriptions.mjs';
import { balancerCandidates, tunnelConfig } from '../app/vpn-config.mjs';

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

test('an Xray JSON profile keeps its balancer, DNS and routing on the system TUN', () => {
  const [{ outbound }] = readNodes(first);
  const profile = {
    remarks: '🇩🇪 Балансер',
    inbounds: [
      { protocol: 'socks', tag: 'socks', port: 10808, sniffing: { enabled: true, destOverride: ['tls'] } },
      { protocol: 'http', tag: 'http', port: 10809 },
      { protocol: 'dokodemo-door', tag: 'api', port: 1234 },
    ],
    outbounds: [
      { ...outbound, tag: 'proxy-1', mux: { enabled: false } },
      { ...outbound, tag: 'proxy-2' },
      { protocol: 'freedom', tag: 'direct' },
    ],
    dns: { tag: 'profile-dns', servers: ['1.1.1.1'] },
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
        { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
        { type: 'field', inboundTag: ['socks', 'http', 'profile-dns'], balancerTag: 'best' },
      ],
      balancers: [{ tag: 'best', selector: ['proxy-'], strategy: { type: 'leastLoad' }, fallbackTag: 'proxy-1' }],
    },
    burstObservatory: { subjectSelector: ['proxy-'], pingConfig: { destination: 'https://example.invalid/' } },
    api: { tag: 'api' },
    env: { 'xray.location.asset': 'untrusted-path' },
  };
  const servers = [...readNodes(JSON.stringify([profile, profile]))];
  assert.equal(servers.length, 1);
  const [server] = servers;
  assert.equal(server.country, 'DE');
  assert.equal(server.host, undefined);
  for (const platform of ['android', 'windows']) {
    const config = JSON.parse(JSON.stringify(tunnelConfig(server, platform)));
    assert.deepEqual(config.inbounds.map(item => item.protocol), ['tun']);
    assert.deepEqual(config.inbounds[0].sniffing.destOverride, ['tls']);
    assert.deepEqual(config.outbounds, JSON.parse(JSON.stringify(profile.outbounds)));
    assert.deepEqual(config.dns, profile.dns);
    assert.deepEqual(config.burstObservatory, profile.burstObservatory);
    assert.deepEqual(config.routing.balancers, profile.routing.balancers);
    assert.deepEqual(config.routing.rules, [
      profile.routing.rules[0],
      { ...profile.routing.rules[2], inboundTag: ['profile-dns', config.inbounds[0].tag] },
    ]);
    assert.equal(config.api, undefined);
    assert.equal(config.env, undefined);
  }
  assert.equal(balancerCandidates(servers, new Map()).length, 2);
});

test('Xray JSON can use bundled routing assets and skips profiles referencing local files or scripts', () => {
  const [{ outbound }] = readNodes(first);
  const config = { outbounds: [{ ...outbound, tag: 'proxy' }] };
  const rule = { type: 'field', outboundTag: 'proxy' };
  const profile = (ruleFields) => ({ ...config, routing: { rules: [{ ...rule, ...ruleFields }] } });
  const valid = profile({ domain: ['geosite:cn', 'ext:geosite.dat:cn'], ip: ['!ext-ip:geoip.dat:private'] });
  const [server] = readNodes(JSON.stringify([
    profile({ domain: ['ext:other.dat:cn'] }),
    { ...config, dns: { script: 'test' } },
    { ...config, outbounds: [{ ...outbound, streamSettings: { tlsSettings: { masterKeyLog: 'local.txt' } } }] },
    valid,
  ]));
  assert.equal(server.host, 'server.invalid');
  assert.deepEqual(tunnelConfig(server, 'android').routing.rules, valid.routing.rules);
  assert.equal([...readNodes(JSON.stringify([profile({ domain: ['ext:other.dat:cn'] })]))].length, 0);
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
