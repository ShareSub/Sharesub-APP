import { outboundEndpoint } from './subscriptions.mjs';

export const DNS = '1.1.1.1';
export const MAX_BALANCER_NODES = 24;

function baseTunnelConfig(platform) {
  const windows = platform === 'windows';
  return {
    log: { loglevel: 'warning' },
    inbounds: [{
      tag: 'sharesub-vpn',
      protocol: 'tun',
      settings: {
        name: 'ShareSub',
        mtu: 1500,
        ...(windows ? {
          desc: 'ShareSub VPN',
          gateway: ['172.28.57.1/30', 'fd56:5348:4152::1/64'],
          dns: [DNS],
          autoSystemRoutingTable: ['0.0.0.0/0', '::/0'],
          autoSystemWfpBlockLeak: ['dns', 'misconfigtun'],
        } : {}),
      },
    }],
  };
}

export function tunnelConfig(server, platform) {
  const tunnel = baseTunnelConfig(platform);
  if (!server.profile) return { ...tunnel, outbounds: [{ ...server.outbound, tag: 'node' }] };
  const { config, clientTags, sniffing } = server.profile;
  const [inbound] = tunnel.inbounds;
  if (sniffing) inbound.sniffing = sniffing;
  const routing = config.routing;
  const rules = [];
  for (const rule of Array.isArray(routing?.rules) ? routing.rules : []) {
    if (!rule || typeof rule !== 'object') continue;
    if (rule.inboundTag == null) {
      rules.push(rule);
      continue;
    }
    const tags = Array.isArray(rule.inboundTag) ? rule.inboundTag : String(rule.inboundTag).split(',').map(tag => tag.trim());
    const mapped = new Set(tags.filter(tag => tag === config.dns?.tag));
    if (tags.some(tag => clientTags.includes(tag))) mapped.add(inbound.tag);
    if (mapped.size) rules.push({ ...rule, inboundTag: [...mapped] });
  }
  return {
    ...config,
    ...tunnel,
    ...(routing ? { routing: { domainStrategy: routing.domainStrategy, balancers: routing.balancers, rules } } : {}),
  };
}

function poolOutbounds(servers) {
  const candidates = [];
  const seen = new Set();
  for (const server of servers) {
    if (!server.profile) {
      candidates.push(server);
      continue;
    }
    for (const outbound of server.profile.config.outbounds) {
      if (outbound.proxySettings || outbound.streamSettings?.sockopt?.dialerProxy) continue;
      const endpoint = outboundEndpoint(outbound);
      if (!endpoint) continue;
      const { tag, ...settings } = outbound;
      const key = JSON.stringify(settings);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ ...endpoint, key: server.host ? server.key : key, outbound: settings });
    }
  }
  return candidates;
}

export function balancerCandidates(servers, probes) {
  servers = poolOutbounds(servers);
  if (servers.length <= MAX_BALANCER_NODES) {
    const best = [...servers].sort((left, right) => pingScore(probes, left) - pingScore(probes, right));
    return best;
  }
  const prioritized = [...servers].sort((left, right) => pingScore(probes, left) - pingScore(probes, right));
  const candidates = [];
  const seen = new Set();
  const deferred = [];
  for (const server of prioritized) {
    const endpoint = server.host + ':' + server.port;
    if (seen.has(endpoint)) {
      deferred.push(server);
      continue;
    }
    seen.add(endpoint);
    candidates.push(server);
  }

  // Keep room for unmeasured servers and spread the sample across subscription order.
  const ranked = candidates.filter(server => pingScore(probes, server) !== Number.MAX_SAFE_INTEGER).slice(0, 12);
  const picked = new Set(ranked);
  const unranked = candidates.filter(server => !picked.has(server));
  const remaining = MAX_BALANCER_NODES - ranked.length;
  const sample = unranked.length <= remaining ? unranked
    : Array.from({ length: remaining }, (_, index) => unranked[Math.floor(index * unranked.length / remaining)]);
  const result = [...ranked, ...sample];
  return result.length < MAX_BALANCER_NODES
    ? result.concat(deferred.slice(0, MAX_BALANCER_NODES - result.length))
    : result;
}

function pingScore(probes, server) {
  const score = probes.get(server.key);
  return typeof score === 'number' && Number.isFinite(score) && score > 0 ? score : Number.MAX_SAFE_INTEGER;
}

export function balancedTunnelConfig(candidates, platform, { ruDirect = false } = {}) {
  if (candidates.length === 0 || candidates.length > MAX_BALANCER_NODES) throw new RangeError('Invalid balancer size');
  const prefix = 'sharesub-pool-';
  const tag = 'sharesub-best';
  const config = baseTunnelConfig(platform);
  const inbound = config.inbounds[0];
  const outbounds = candidates.map((server, index) => ({ ...server.outbound, tag: prefix + index }));
  const rules = [];
  if (ruDirect) {
    const direct = 'sharesub-ru-direct';
    inbound.sniffing = { enabled: true, routeOnly: true, destOverride: ['http', 'tls', 'quic'] };
    outbounds.push({ tag: direct, protocol: 'freedom' });
    rules.push(
      { type: 'field', inboundTag: [inbound.tag], domain: ['domain:ru', 'domain:xn--p1ai', 'domain:su'], outboundTag: direct },
      { type: 'field', inboundTag: [inbound.tag], ip: ['geoip:ru'], outboundTag: direct },
    );
  }
  rules.push({ type: 'field', inboundTag: [inbound.tag], balancerTag: tag });
  return {
    ...config,
    outbounds,
    observatory: {
      subjectSelector: [prefix],
      probeURL: 'https://www.gstatic.com/generate_204',
      probeInterval: '60s',
      enableConcurrency: true,
    },
    routing: {
      ...(ruDirect ? { domainStrategy: 'IPOnDemand' } : {}),
      rules,
      balancers: [{ tag, selector: [prefix], strategy: { type: 'leastPing' }, fallbackTag: prefix + '0' }],
    },
  };
}
