import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { balancedTunnelConfig, balancerCandidates, MAX_BALANCER_NODES } from '../app/vpn-config.mjs';

function node(index, host = 'fixture-' + index + '.invalid') {
  return { key: 'node-' + index, host, port: 443, outbound: { protocol: 'trojan', settings: { servers: [{ address: host, port: 443, password: 'fixture' }] } } };
}

test('large subscriptions use a bounded pool and preserve enough distinct endpoints', () => {
  const servers = Array.from({ length: 1200 }, (_, index) => node(index, index < 10 ? 'shared.invalid' : undefined));
  const measured = new Map([['node-5', 42], ['node-4', 18], ['node-1175', 26], ['node-1', null]]);
  const pool = balancerCandidates(servers, measured);
  assert.equal(pool.length, MAX_BALANCER_NODES);
  assert.equal(new Set(pool.map(server => server.host)).size, MAX_BALANCER_NODES);
  assert.deepEqual(pool.slice(0, 2).map(server => server.key), ['node-4', 'node-1175']);
  assert.ok(pool.some(server => !measured.has(server.key)));
});

test('small pools preserve distinct credentials at the same address and route the TUN through leastPing', () => {
  const servers = [node(1, 'same.invalid'), node(2, 'same.invalid'), node(3)];
  const ordered = balancerCandidates(servers, new Map([['node-2', 11]]));
  assert.deepEqual(ordered.map(server => server.key), ['node-2', 'node-1', 'node-3']);
  for (const platform of ['android', 'windows']) {
    const config = balancedTunnelConfig(ordered, platform);
    const [balancer] = config.routing.balancers;
    assert.equal(config.routing.rules[0].balancerTag, balancer.tag);
    assert.deepEqual(config.routing.rules[0].inboundTag, [config.inbounds[0].tag]);
    assert.deepEqual(config.observatory.subjectSelector, balancer.selector);
    assert.equal(balancer.strategy.type, 'leastPing');
    assert.equal(balancer.fallbackTag, config.outbounds[0].tag);
    assert.equal(config.outbounds.length, 3);
    assert.ok(config.outbounds.every(outbound => outbound.protocol === 'trojan'));
  }
});

test('global automatic routing sends Russian suffixes and addresses direct before the balancer', () => {
  const config = balancedTunnelConfig([node(1)], 'android', { ruDirect: true });
  const [domains, addresses, remainder] = config.routing.rules;
  assert.deepEqual(domains.domain, ['domain:ru', 'domain:xn--p1ai', 'domain:su']);
  assert.deepEqual(addresses.ip, ['geoip:ru']);
  assert.equal(addresses.outboundTag, domains.outboundTag);
  assert.equal(config.outbounds.find(item => item.tag === addresses.outboundTag).protocol, 'freedom');
  assert.equal(remainder.balancerTag, config.routing.balancers[0].tag);
  assert.equal(config.inbounds[0].sniffing.routeOnly, true);
});
