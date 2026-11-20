const supported = /^(?:https?|vless|vmess|trojan|ss|hysteria2|hy2):\/\//i;
// Android WebView treats custom schemes as opaque URLs and leaves URL.hostname empty.
const appLink = /^(?:sharesub|happ|v2raytun|v2rayn):\/\/(?:import|add)(?:\/([^?#]*))?(?=[?#]|$)/i;

function subscriptionPageTarget(url) {
  if (url.origin !== 'https://sub.sharesub.ru' || url.username || url.password) return '';
  const match = /^\/(?:launch\/sharesub|subscription)\/([A-Za-z0-9_-]{16,256})\/?$/.exec(url.pathname);
  return match ? url.origin + '/' + match[1] : '';
}

export function importPayload(input) {
  if (typeof input !== 'string' || input.length > 32768) return '';
  try {
    const url = new URL(input);
    if (url.username || url.password) return '';
    const direct = subscriptionPageTarget(url);
    if (direct) return direct;
    const web = url.origin === 'https://app.sharesub.ru' && url.pathname === '/import';
    const appPath = appLink.exec(input);
    if (!web && !appPath) return '';
    const encoded = url.searchParams.get('url') || url.searchParams.get('data') || new URLSearchParams(url.hash.slice(1)).get('url');
    const value = (encoded || decodeURIComponent(appPath?.[1] ?? '')).trim();
    if (!supported.test(value)) return '';
    return /^https?:/i.test(value) ? subscriptionPageTarget(new URL(value)) || value : value;
  } catch {
    return '';
  }
}
