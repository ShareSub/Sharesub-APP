const supported = /^(?:https?|vless|vmess|trojan|ss|hysteria2|hy2):\/\//i;

export function importPayload(input) {
  if (typeof input !== 'string' || input.length > 32768) return '';
  try {
    const url = new URL(input);
    if (url.username || url.password) return '';
    const sharesub = url.protocol === 'sharesub:' && (url.hostname === 'import' || url.hostname === 'add');
    const web = url.origin === 'https://app.sharesub.ru' && url.pathname === '/import';
    const legacy = ['happ:', 'v2raytun:', 'v2rayn:'].includes(url.protocol) && ['add', 'import'].includes(url.hostname);
    if (!sharesub && !web && !legacy) return '';
    const encoded = url.searchParams.get('url') || url.searchParams.get('data') || new URLSearchParams(url.hash.slice(1)).get('url');
    const path = url.pathname.slice(1);
    const value = (encoded || (path && !web ? decodeURIComponent(path) : '')).trim();
    return supported.test(value) ? value : '';
  } catch {
    return '';
  }
}
