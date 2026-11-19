const MAX_TEXT = 8 * 1024 * 1024;
const MAX_NODES = 20000;
const schemePattern = /^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//i;
const jsonProtocols = new Set(['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria', 'socks', 'http']);
const decoder = new TextDecoder('utf-8', { fatal: true });
const hwidDenied = /(?:\bhwid\b|hardware[ _-]+(?:id|identifier))(?=[\s\S]{0,180}(?:unsupported|not[ _-]+supported|disabled|required|missing|invalid|limit|не\s+поддержива|не\s+переда|лимит|требу))|(?:unsupported|not[ _-]+supported|does[ _-]+not[ _-]+support|disabled|required|missing|invalid|limit|не\s+поддержива|не\s+переда|лимит|требу)[\s\S]{0,100}(?:\bhwid\b|hardware[ _-]+(?:id|identifier))/iu;
const hwidError = 'Провайдер не принял HWID устройства. Проверьте, что ссылка использует HTTPS и в кабинете провайдера есть свободный слот для устройства.';

function base64(text) {
  const normalized = text.replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new Error('Invalid Base64');
  if (Uint8Array.fromBase64) return decoder.decode(Uint8Array.fromBase64(normalized));
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return decoder.decode(bytes);
}

const parsedJson = (text) => text ? JSON.parse(text) : undefined;
const cleanHost = (host) => String(host ?? '').replace(/^\[|\]$/g, '');
const validPort = (port) => Number.isInteger(port) && port > 0 && port <= 65535;
const cleanName = (label, host) => String(label || host).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 240) || host;
const optional = (value) => value || undefined;

export function countryOf(label) {
  const points = Array.from(label.match(/[\u{1f1e6}-\u{1f1ff}]{2}/u)?.[0] ?? '');
  return points.map(point => String.fromCharCode(point.codePointAt(0) - 0x1f1e6 + 65)).join('');
}

function node(name, host, port, outbound, key) {
  if (!host || /[\s/@]/.test(host) || !validPort(port)) throw new Error('Invalid address');
  const label = cleanName(name, host);
  return { name: label, country: countryOf(label), host, port, outbound, key };
}

function streamSettings(q, host, defaultSecurity = 'none') {
  const network = q.get('type') || 'tcp';
  const security = q.get('security') || defaultSecurity;
  if (!['none', 'tls', 'reality'].includes(security)) throw new Error('Unsupported security');
  const settings = { network, security };
  const path = optional(q.get('path'));
  const headerHost = optional(q.get('host'));
  const mode = optional(q.get('mode'));
  switch (network) {
    case 'tcp':
    case 'raw':
      if (q.get('headerType') === 'http') {
        settings.rawSettings = { header: { type: 'http', request: { path: [path || '/'], headers: headerHost ? { Host: headerHost.split(',') } : undefined } } };
      }
      break;
    case 'ws':
      settings.wsSettings = { path, host: headerHost, headers: headerHost ? { Host: headerHost } : undefined };
      break;
    case 'grpc':
      settings.grpcSettings = { serviceName: optional(q.get('serviceName')) || path, multiMode: mode === 'multi', authority: optional(q.get('authority')) };
      break;
    case 'xhttp':
    case 'splithttp':
      settings.xhttpSettings = { path, host: headerHost, mode, extra: parsedJson(q.get('extra')) };
      break;
    case 'httpupgrade':
      settings.httpupgradeSettings = { path, host: headerHost };
      break;
    case 'kcp':
      settings.kcpSettings = { header: { type: q.get('headerType') || 'none' }, seed: optional(q.get('seed')) };
      break;
    default:
      throw new Error('Unsupported transport');
  }
  if (security === 'tls') {
    settings.tlsSettings = {
      serverName: q.get('sni') || host,
      fingerprint: optional(q.get('fp')),
      alpn: q.get('alpn')?.split(',').filter(Boolean),
      pinnedPeerCertSha256: optional(q.get('pcs')),
    };
  }
  if (security === 'reality') {
    const password = q.get('pbk');
    if (!password) throw new Error('Missing REALITY key');
    settings.realitySettings = {
      serverName: q.get('sni') || host, fingerprint: q.get('fp') || 'chrome', password,
      shortId: q.get('sid') || '', spiderX: q.get('spx') || '', mldsa65Verify: optional(q.get('pqv')),
    };
  }
  if (q.has('fm')) settings.finalmask = parsedJson(q.get('fm'));
  return settings;
}

function parseVmess(payload, fragment, key) {
  const data = JSON.parse(base64(payload));
  const address = cleanHost(data.add);
  const port = Number(data.port);
  if (!data.id) throw new Error('Missing VMess id');
  const q = new URLSearchParams();
  for (const [name, value] of Object.entries({
    type: data.net, headerType: data.type, security: data.tls, sni: data.sni,
    host: data.host, path: data.path, fp: data.fp, alpn: data.alpn,
  })) if (value) q.set(name, value);
  return node(fragment || data.ps, address, port, {
    protocol: 'vmess',
    settings: { vnext: [{ address, port, users: [{ id: data.id, alterId: Number(data.aid || 0), security: data.scy || 'auto' }] }] },
    streamSettings: streamSettings(q, address),
  }, key);
}

function parseShadowsocks(payload, fragment, key) {
  const [body, query = ''] = payload.split('?');
  if (new URLSearchParams(query).has('plugin')) throw new Error('Unsupported plugin');
  const pair = body.includes('@') ? body : base64(body);
  const split = pair.lastIndexOf('@');
  const user = decodeURIComponent(pair.slice(0, split));
  const credentials = user.includes(':') ? user : base64(user);
  const colon = credentials.indexOf(':');
  if (split < 1 || colon < 1) throw new Error('Invalid Shadowsocks link');
  const url = new URL('http://' + pair.slice(split + 1));
  const address = cleanHost(url.hostname);
  const port = Number(url.port || (/:80(?:\/|$)/.test(pair.slice(split + 1)) ? 80 : NaN));
  const method = credentials.slice(0, colon);
  const password = credentials.slice(colon + 1);
  if (!password) throw new Error('Missing password');
  return node(fragment, address, port, { protocol: 'shadowsocks', settings: { servers: [{ address, port, method, password }] } }, key);
}

function parseUri(text) {
  const scheme = schemePattern.exec(text)?.[1].toLowerCase();
  if (!scheme) return null;
  const hash = text.indexOf('#');
  const key = hash < 0 ? text : text.slice(0, hash);
  let label = hash < 0 ? '' : text.slice(hash + 1);
  try { label = decodeURIComponent(label); } catch { /* labels may be unescaped */ }
  const payload = key.slice(scheme.length + 3);
  if (scheme === 'vmess') return parseVmess(payload, label, key);
  if (scheme === 'ss') return parseShadowsocks(payload, label, key);
  const link = new URL(key);
  const address = cleanHost(link.hostname);
  const port = Number(link.port || (scheme === 'vless' ? NaN : 443));
  const user = decodeURIComponent(link.username);
  if (!user) throw new Error('Missing credentials');
  const q = link.searchParams;
  if (scheme === 'vless') {
    return node(label, address, port, {
      protocol: 'vless',
      settings: { vnext: [{ address, port, users: [{ id: user, encryption: q.get('encryption') || 'none', flow: optional(q.get('flow')) }] }] },
      streamSettings: streamSettings(q, address),
    }, key);
  }
  const password = link.password ? user + ':' + decodeURIComponent(link.password) : user;
  if (scheme === 'trojan') {
    return node(label, address, port, {
      protocol: 'trojan', settings: { servers: [{ address, port, password }] },
      streamSettings: streamSettings(q, address, 'tls'),
    }, key);
  }
  if (['insecure', 'allowInsecure'].some(name => /^(1|true)$/i.test(q.get(name) ?? '')) ||
      q.has('pinSHA256') || q.has('mport') || q.has('ports')) throw new Error('Unsupported Hysteria2 option');
  const stream = streamSettings(new URLSearchParams({
    security: 'tls', sni: q.get('sni') || address, alpn: q.get('alpn') || 'h3',
  }), address, 'tls');
  stream.network = 'hysteria';
  stream.hysteriaSettings = { version: 2, auth: password };
  if (q.has('obfs') && q.get('obfs') !== 'none') {
    if (q.get('obfs') !== 'salamander' || (q.get('obfs-password')?.length ?? 0) < 4) throw new Error('Unsupported Hysteria2 obfuscation');
    stream.finalmask = { udp: [{ type: 'salamander', settings: { password: q.get('obfs-password') } }] };
  }
  return node(label, address, port, { protocol: 'hysteria', settings: { version: 2, address, port }, streamSettings: stream }, key);
}

function providerDenial(value) {
  return typeof value === 'string' && hwidDenied.test(value.slice(0, 512));
}

function* jsonNodes(root) {
  for (const profile of Array.isArray(root) ? root : [root]) {
    const outbounds = profile?.outbounds ?? [profile];
    if (!Array.isArray(outbounds)) continue;
    for (const outbound of outbounds) {
      if (!jsonProtocols.has(outbound?.protocol)) continue;
      const { protocol, settings, streamSettings } = outbound;
      const endpoint = settings?.vnext?.[0] ?? settings?.servers?.[0] ?? settings;
      const host = cleanHost(endpoint?.address);
      const port = Number(endpoint?.port);
      if (!host || /[\s/@]/.test(host) || !validPort(port)) continue;
      const config = { protocol, settings, streamSettings };
      yield node(profile.remarks || profile.name || outbound.tag, host, port, config, JSON.stringify(config));
    }
  }
}

export function* readNodes(input) {
  if (typeof input !== 'string' || input.length > MAX_TEXT) throw new Error('Подписка слишком большая.');
  let text = input.trim();
  if (!text) return;
  let rejectedHWID = false;
  if (!/^[\[{]/.test(text) && !text.includes('://')) {
    if (providerDenial(text)) throw new Error(hwidError);
    try { text = base64(text).trim().replace(/^\uFEFF/, ''); }
    catch { throw new Error('Формат подписки не поддерживается.'); }
  }
  const structured = /^[\[{]/.test(text);
  const value = structured ? JSON.parse(text) : null;
  const profiles = structured ? (Array.isArray(value) ? value : [value]) : [];
  if (profiles.some(profile => providerDenial(profile?.message) || providerDenial(profile?.error))) rejectedHWID = true;
  const candidates = structured
    ? jsonNodes(value)
    : (function* () {
        for (const line of text.split(/\r?\n|\r/)) {
          try {
            const entry = parseUri(line.trim());
            if (entry) yield entry;
            else if (providerDenial(line)) rejectedHWID = true;
          }
          catch { /* one invalid link does not stop the import */ }
        }
      })();
  const seen = new Set();
  for (const entry of candidates) {
    if (providerDenial(entry.name)) {
      rejectedHWID = true;
      continue;
    }
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    yield entry;
    if (seen.size >= MAX_NODES) break;
  }
  if (!seen.size && rejectedHWID) throw new Error(hwidError);
}
