const compareRegion = new Intl.Collator('ru', { sensitivity: 'base' }).compare;

export function groupedServers(servers, collapsed, searching) {
  const countries = new Map();
  for (const server of servers) {
    const code = server.country || '';
    if (!countries.has(code)) countries.set(code, { code, name: server.region || 'Без страны', servers: [] });
    countries.get(code).servers.push(server);
  }
  const ordered = [...countries.values()].sort((a, b) => Number(!a.code) - Number(!b.code) || compareRegion(a.name, b.name));
  const entries = [];
  for (const { code, name, servers: children } of ordered) {
    const open = searching || !collapsed.has(code);
    entries.push({ group: true, key: 'country:' + code, country: code, display: name, count: children.length, open });
    if (open) entries.push(...children);
  }
  return entries;
}
