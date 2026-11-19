import { call } from './bridge.mjs';
import { flagCodes } from './flag-codes.mjs';
import { groupedServers } from './group-servers.mjs';
import { importPayload } from './import-link.mjs';
import { parseError, readBatches } from './subscriptions.mjs';
import { balancedTunnelConfig, balancerCandidates, isBalancer, probeEndpoints, tunnelConfig } from './vpn-config.mjs';

const pageOptions = new URLSearchParams(location.search);
const fontScale = Number(pageOptions.get('fontScale'));
if (fontScale >= .75 && fontScale <= 2.5) document.documentElement.style.fontSize = fontScale * 100 + '%';
if (pageOptions.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';

const $ = (id) => document.getElementById(id);
const list = $('list'), rows = $('rows'), search = $('search'), dialog = $('import-dialog');
const countFormat = new Intl.NumberFormat('ru');
const countryNames = new Intl.DisplayNames(['ru'], { type: 'region', fallback: 'none' });
const probes = new Map();
const endpointProbes = new Map();
const refreshProbeAge = 5 * 60_000;
const sources = new Map();
const rendered = new Map();
const collapsed = new Set();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const nodeGlyph = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c5 4 5 12 0 16-5-4-5-12 0-16Z"/></svg>';
const balanceGlyph = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h4c4 0 4 12 8 12h4m-4-4 4 4-4 4M4 18h4c4 0 4-12 8-12h4m-4-4 4 4-4 4"/></svg>';
const automaticKey = 'pool:auto';
let servers = [], filtered = [], filteredServers = [], selected = null, connectedKey = null;
let connectedPool = null;
let connectedPing, measuringTunnel = false, pingSession = 0, nextTunnelPing = 0;
let position = 0, frame = 0, freshFrom = 0, freshTo = 0, freshUntil = 0;
let busy = false, pinging = false, switching = false, vpn = { state: 'idle' };
let operationError = '', platform;
let rowHeight = 0;
let grouped = false, automatic = true, queuedLink = '';
let subscriptionRefreshMinutes = 60, refreshedAt = Date.now(), refreshTimer;
let update = { state: 'idle' }, checkingUpdate = false, updating = false;
let savingPreferences = Promise.resolve();
let theme = 'light', showMemory = true, showBattery = true, metricsSnapshot = {}, metricsRequest = 0;

function updateRowHeight() {
  const style = getComputedStyle(document.documentElement);
  rowHeight = parseFloat(style.getPropertyValue('--row')) * parseFloat(style.fontSize);
  const height = filtered.length * rowHeight + 'px';
  rows.style.height = height;
  list.style.setProperty('--list-content', height);
}

function setFlag(slot, country) {
  const code = country || '';
  if (slot.dataset.country === code) return;
  slot.dataset.country = code;
  if (!flagCodes.has(code)) {
    slot.innerHTML = nodeGlyph;
    return;
  }
  const flag = new Image();
  flag.alt = '';
  flag.src = 'flags/' + code.toLowerCase() + '.webp';
  flag.addEventListener('error', () => {
    if (slot.dataset.country === code) slot.innerHTML = nodeGlyph;
  }, { once: true });
  slot.replaceChildren(flag);
}

function nextPaint(callback) {
  const animation = requestAnimationFrame(() => {
    clearTimeout(fallback);
    callback();
  });
  const fallback = setTimeout(() => {
    cancelAnimationFrame(animation);
    callback();
  }, 80);
}

function setNotice(message = '') {
  $('list-status').textContent = message;
  $('list-status').hidden = !message;
}

function formatError(error) {
  return String(error?.message || 'Попробуйте ещё раз.').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function rebuild(animate = false) {
  const previous = filtered.length;
  const previousServers = servers;
  const query = search.value.trim().toLocaleLowerCase('ru');
  const unique = new Map();
  for (const entries of sources.values()) for (const node of entries) if (!unique.has(node.key)) unique.set(node.key, node);
  servers = [...unique.values()];
  if (previousServers.some(server => !unique.has(server.key))) {
    for (const key of probes.keys()) {
      if (!unique.has(key)) probes.delete(key);
    }
  } else if (servers.length !== previousServers.length) {
    probes.delete(automaticKey);
    for (const key of probes.keys()) if (key.startsWith('country:')) probes.delete(key);
  }
  filteredServers = query ? servers.filter(value => value.search.includes(query)) : servers;
  filtered = grouped ? groupedServers(filteredServers, collapsed, Boolean(query)) : filteredServers;
  if (!selected || !unique.has(selected.key)) {
    if (!selected || selected.key !== connectedKey || vpn.state !== 'connected') selected = servers[0] || null;
  } else selected = unique.get(selected.key);
  if (animate && filtered.length > previous) {
    freshFrom = previous; freshTo = filtered.length; freshUntil = performance.now() + 230;
  }
  position = Math.max(0, Math.min(position, filtered.length - 1));
  $('server-count').textContent = countFormat.format(servers.length);
  $('server-count').hidden = !servers.length;
  $('group-actions').hidden = !grouped || !servers.length || Boolean(query);
  $('expand-groups').disabled = !filtered.some(entry => entry.group && !entry.open);
  $('collapse-groups').disabled = !filtered.some(entry => entry.group && entry.open);
  $('empty').hidden = Boolean(filtered.length);
  $('empty-title').textContent = query ? 'Ничего не найдено' : busy ? 'Загружаем серверы…' : 'Пока нет серверов';
  $('empty-hint').textContent = query ? 'Попробуйте другое название.' : busy ? '' : 'Добавьте ссылку на подписку или сервер.';
  list.hidden = !filtered.length;
  updateRowHeight();
  redraw();
  updateControls();
}

function pingLabel(value) {
  if (value === 'pending') return '…';
  if (value === null) return 'Нет ответа';
  return typeof value === 'number' ? value + ' мс' : '—';
}

const endpointKey = ({ host, port }) => JSON.stringify([host, port]);
const pingValue = (key) => vpn.state === 'connected' && vpn.tunnelPing && connectedKey === key && connectedPing !== undefined
  ? connectedPing : probes.get(key);
const profilePing = 'Задержка HTTP через активный туннель';
const estimatedPing = 'Минимальная задержка TCP по проверенным серверам пула';

function redraw() {
  if (list.hidden) {
    rows.replaceChildren();
    rendered.clear();
    return;
  }
  const top = Math.floor(list.scrollTop / rowHeight);
  const from = Math.max(0, top - 3);
  const to = Math.min(filtered.length, top + Math.ceil(list.clientHeight / rowHeight) + 4);
  const visible = new Set();
  let previousRow = null;
  const entering = performance.now() < freshUntil && !reduceMotion.matches;
  for (let index = from; index < to; index++) {
    const entry = filtered[index];
    visible.add(entry.key);
    let item = rendered.get(entry.key);
    if (!item) {
      const row = document.createElement('div');
      row.className = 'row';
      row.setAttribute('role', 'option');
      const flag = document.createElement('span');
      flag.className = 'node-flag';
      flag.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'node-name';
      const ping = document.createElement('span');
      ping.className = 'node-ping';
      const reading = document.createElement('span');
      ping.append(reading);
      let connect;
      if (entry.group) {
        row.dataset.group = 'true';
        row.setAttribute('role', 'group');
        ping.classList.add('group-tail');
        ping.insertAdjacentHTML('beforeend', '<svg class="group-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>');
        connect = document.createElement('button');
        connect.className = 'secondary group-connect';
        connect.type = 'button';
        connect.innerHTML = balanceGlyph + '<span class="group-connect-label">Балансер</span><span class="group-latency" hidden></span>';
        connect.addEventListener('click', event => {
          event.stopPropagation();
          const group = filtered[Number(row.dataset.index)];
          if (group?.group) connectCountry(group);
        });
      }
      row.append(flag, name, ping);
      if (connect) row.append(connect);
      if (entering && index >= freshFrom && index < freshTo) {
        row.classList.add('fresh');
        row.style.setProperty('--delay', Math.min(index - from, 6) * 18 + 'ms');
        row.addEventListener('animationend', () => row.classList.remove('fresh'), { once: true });
      }
      item = { row, flag, name, ping, reading, connect };
      rendered.set(entry.key, item);
    }
    const { row, flag, name, ping, reading: readingText, connect } = item;
    row.id = 'node-' + index;
    row.style.top = index * rowHeight + 'px';
    row.dataset.index = index;
    row.dataset.focus = document.activeElement === list && index === position;
    row.dataset.last = index === filtered.length - 1;
    if (entry.group) {
      row.dataset.open = entry.open;
      row.removeAttribute('aria-selected');
      const active = vpn.state === 'connected' && connectedKey === entry.key;
      connect.setAttribute('aria-pressed', String(active));
      const action = active ? 'Отключить балансер' : 'Подключить балансер';
      const value = pingValue(entry.key);
      const latency = connect.querySelector('.group-latency');
      latency.hidden = value == null;
      latency.textContent = pingLabel(value);
      const description = action + ' · ' + entry.display + (value == null ? '' : ' · ' + pingLabel(value));
      connect.setAttribute('aria-label', description);
      connect.title = description + (value == null ? '' : ' · ' + (active ? profilePing : estimatedPing));
      connect.disabled = switching || busy;
      connect.hidden = !entry.country;
    } else row.setAttribute('aria-selected', String(!connectedPool && selected?.key === entry.key));
    row.setAttribute('aria-posinset', index + 1);
    row.setAttribute('aria-setsize', filtered.length);
    setFlag(flag, entry.country);
    if (name.textContent !== entry.display) name.textContent = entry.display;
    name.title = entry.display;
    const value = pingValue(entry.key);
    const reading = entry.group ? countFormat.format(entry.count) : value === null ? '—' : pingLabel(value);
    if (readingText.textContent !== reading) readingText.textContent = reading;
    ping.title = entry.group ? 'Количество серверов' : isBalancer(entry)
      ? pingLabel(value) + ' · ' + (vpn.tunnelPing && connectedKey === entry.key ? profilePing : estimatedPing)
      : pingLabel(value);
    row.setAttribute('aria-label', entry.group
      ? entry.display + ', серверов ' + reading + (entry.open ? ', раскрыто' : ', свёрнуто')
      : [entry.display, entry.region, ping.title].filter(Boolean).join(', '));
    const before = previousRow ? previousRow.nextSibling : rows.firstChild;
    if (before !== row) rows.insertBefore(row, before);
    previousRow = row;
  }
  for (const [key, { row }] of rendered) {
    if (visible.has(key)) continue;
    row.remove();
    rendered.delete(key);
  }
  if (position >= from && position < to) list.setAttribute('aria-activedescendant', 'node-' + position);
  else list.removeAttribute('aria-activedescendant');
}

function scheduleRows() {
  if (frame) return;
  frame = 1;
  nextPaint(() => { frame = 0; redraw(); });
}

function updateControls() {
  const state = switching && vpn.state === 'idle' ? 'connecting' : vpn.state;
  const active = state === 'connected';
  const inFlight = switching || state === 'connecting' || state === 'disconnecting';
  $('connection-card').dataset.state = state;
  const stateLabel = ({
    idle: 'VPN выключен', connecting: 'Подключаемся…', connected: 'VPN подключён', disconnecting: 'Отключаемся…',
  })[state] || 'VPN выключен';
  if ($('vpn-state').textContent !== stateLabel) $('vpn-state').textContent = stateLabel;
  renderMetrics();
  $('connect').querySelector('span').textContent = active ? 'Отключиться' : 'Подключиться';
  $('connect').disabled = inFlight || (!active && !selected);
  const pool = connectedPool;
  const measuringActive = active && vpn.tunnelPing;
  const selectedName = active ? vpn.name || pool?.display || selected?.display : selected?.display;
  $('active-server').textContent = selectedName || 'Выберите сервер';
  $('active-server').title = selectedName || '';
  $('active-server').dataset.empty = !selectedName;
  const flagTarget = pool || selected;
  $('active-flag').hidden = !flagTarget;
  if (flagTarget) setFlag($('active-flag'), flagTarget.country);
  const value = measuringActive ? measuringTunnel ? 'pending' : connectedPing : selected && probes.get(selected.key);
  const pingText = typeof value === 'number' ? String(value) : value === 'pending' ? '…' : '—';
  const pingOutput = $('active-ping');
  if (pingOutput.textContent !== pingText) {
    pingOutput.textContent = pingText;
    if (typeof value === 'number' && !reduceMotion.matches) {
      pingOutput.getAnimations().forEach(animation => animation.cancel());
      pingOutput.animate([{ opacity: .45 }, { opacity: 1 }], { duration: 210, easing: 'ease-out' });
    }
  }
  $('active-ping-unit').hidden = typeof value !== 'number';
  const pingDescription = measuringActive ? profilePing : isBalancer(selected) ? estimatedPing : '';
  $('ping-one').setAttribute('aria-label', 'Обновить пинг. ' + pingLabel(value) + (pingDescription ? '. ' + pingDescription : ''));
  $('ping-one').title = pingDescription || 'Обновить пинг';
  $('ping-one').dataset.pending = value === 'pending';
  $('ping-one').disabled = inFlight || (measuringActive ? measuringTunnel : !selected || value === 'pending');
  $('auto-connect').disabled = inFlight || busy || !servers.length;
  $('auto-connect').hidden = !servers.length;
  $('auto-connect').setAttribute('aria-pressed', String(active && connectedKey === automaticKey));
  const autoPing = $('auto-ping');
  const autoValue = pingValue(automaticKey);
  autoPing.hidden = autoValue == null;
  autoPing.textContent = pingLabel(autoValue);
  autoPing.title = active && connectedKey === automaticKey ? profilePing : estimatedPing;
  search.disabled = !servers.length && !search.value;
  $('ping-all').disabled = pinging || !servers.length;
  $('refresh').disabled = busy || ![...sources.keys()].some(isUrl);
  $('refresh').classList.toggle('working', busy);
  $('open-import').disabled = busy;
  $('vpn-error').hidden = !operationError;
  $('vpn-error').textContent = operationError;
}

function choose(index) {
  const entry = filtered[index];
  if (!entry) return;
  position = index;
  if (entry.group) {
    if (search.value.trim()) return;
    if (entry.open) collapsed.add(entry.country);
    else collapsed.delete(entry.country);
    rebuild();
    const children = entry.open ? [] : [...rendered.values()].slice(0, 12).filter(({ row }) =>
      Number(row.dataset.index) > index && Number(row.dataset.index) <= index + entry.count);
    if (!reduceMotion.matches) for (const [delay, { row }] of children.entries()) {
      row.animate([{ opacity: .35, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }],
        { duration: 190, delay: Math.min(delay, 5) * 12, easing: 'ease-out', fill: 'backwards' });
    }
    return;
  }
  if (switching || vpn.state === 'connecting' || vpn.state === 'disconnecting') return;
  selected = entry;
  operationError = '';
  redraw();
  updateControls();
  if (!probes.has(entry.key)) checkPing(entry);
  if (vpn.state === 'connected' && connectedKey !== entry.key) connectTarget(entry);
}

function setAllGroups(open) {
  collapsed.clear();
  if (!open) for (const { country } of servers) collapsed.add(country || '');
  list.scrollTop = 0;
  position = 0;
  if (open) {
    freshFrom = 0;
    freshTo = Number.MAX_SAFE_INTEGER;
    freshUntil = performance.now() + 230;
  }
  rebuild();
  $(open ? 'collapse-groups' : 'expand-groups').focus();
}

async function checkPing(entry, refresh = false) {
  if (vpn.state === 'connected' && vpn.tunnelPing && connectedKey === entry.key) {
    return measureTunnelPing(Boolean(refresh));
  }
  if (probes.get(entry.key) === 'pending' || (!refresh && probes.has(entry.key))) return;
  probes.set(entry.key, 'pending');
  if (!pinging) updateControls();
  const results = await Promise.all(probeEndpoints(entry.group ? entry.servers : [entry])
    .map(endpoint => pingEndpoint(endpoint, refresh)));
  const readings = results.filter(value => typeof value === 'number');
  probes.set(entry.key, readings.length ? Math.min(...readings) : null);
  if (!pinging) {
    updateControls();
    scheduleRows();
  }
}

function pingEndpoint(endpoint, refreshFrom) {
  const key = endpointKey(endpoint);
  const cached = endpointProbes.get(key);
  const earliest = typeof refreshFrom === 'number' ? refreshFrom : refreshFrom ? Date.now() : Date.now() - refreshProbeAge;
  if (cached && (cached.pending || cached.updated >= earliest)) return cached.promise;
  const result = { pending: true };
  result.promise = call('ping', endpoint).catch(() => null).then(value => {
    result.pending = false;
    result.updated = Date.now();
    return value;
  });
  endpointProbes.set(key, result);
  if (endpointProbes.size > 24_000) {
    for (const [key, item] of endpointProbes) {
      if (!item.pending && Date.now() - item.updated >= refreshProbeAge) endpointProbes.delete(key);
    }
  }
  return result.promise;
}

async function measureTunnelPing(refresh = false) {
  if (vpn.state !== 'connected' || !vpn.tunnelPing || measuringTunnel || (!refresh && Date.now() < nextTunnelPing)) return;
  const session = pingSession;
  measuringTunnel = true;
  if (connectedPing === undefined || refresh) connectedPing = 'pending';
  updateControls();
  scheduleRows();
  let reading;
  try { reading = await call('tunnelPing'); } catch { /* next probe can recover */ }
  if (session !== pingSession) return;
  measuringTunnel = false;
  connectedPing = reading ?? null;
  nextTunnelPing = Date.now() + (reading ? 60_000 : 15_000);
  updateControls();
  scheduleRows();
}

async function pingList() {
  if (pinging) return;
  const targets = (filteredServers.length ? filteredServers : servers).slice();
  if (!targets.length) return;
  if (servers.length) targets.unshift({ group: true, key: automaticKey, servers });
  if (grouped) {
    const countries = new Map();
    for (const server of servers) {
      if (!server.country) continue;
      const entries = countries.get(server.country) ?? [];
      entries.push(server);
      countries.set(server.country, entries);
    }
    for (const [country, entries] of countries) targets.push({ group: true, key: 'country:' + country, servers: entries });
  }
  pinging = true;
  updateControls();
  const queue = targets.values();
  const started = Date.now();
  let total = 0;
  let statusFrame;
  try {
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (const entry of queue) {
        await checkPing(entry, started);
        total++;
        if (!statusFrame) statusFrame = setTimeout(() => {
          statusFrame = undefined;
          updateControls();
          scheduleRows();
          if (!busy) setNotice('Проверка пинга · ' + countFormat.format(total) + ' из ' + countFormat.format(targets.length));
        }, 80);
      }
    }));
  } finally {
    clearTimeout(statusFrame);
    pinging = false;
    if (!busy) setNotice();
    updateControls();
    redraw();
  }
}

const isUrl = (value) => /^https?:\/\/\S+$/i.test(value);
const paint = () => new Promise(nextPaint);

function addPresentation(batch) {
  for (const item of batch) {
    item.display = item.name
      .replace(/[\u{1f1e6}-\u{1f1ff}]{2}|\p{Extended_Pictographic}|[\u200d\ufe0e\ufe0f\u{1f3fb}-\u{1f3ff}]/gu, '')
      .replace(/\s+/gu, ' ').trim() || item.host || item.name;
    item.region = item.country ? countryNames.of(item.country) : '';
    item.search = [item.name, item.display, item.country, item.region, item.host].join(' ').toLocaleLowerCase('ru');
  }
}

async function load(source, refresh = false, onFirstBatch) {
  const text = isUrl(source) ? await call('subscription', source) : source;
  const existing = sources.get(source);
  const nodes = [];
  const queue = [];
  let ended = false, problem, scheduled = false;
  let worker, localBatches;
  const finished = new Promise((resolve, reject) => {
    const drain = () => {
      scheduled = false;
      if (problem) { reject(new Error(problem)); return; }
      let entries = queue.shift();
      if (localBatches) {
        try {
          const batch = localBatches.next();
          entries = batch.value;
          ended = batch.done;
        } catch (error) {
          reject(new Error(parseError(error)));
          return;
        }
      }
      if (entries) {
        if (!nodes.length) onFirstBatch?.();
        addPresentation(entries);
        nodes.push(...entries);
        if (!refresh || !existing) {
          sources.set(source, nodes);
          rebuild(true);
        }
      }
      if (queue.length || (localBatches && !ended)) schedule();
      else if (ended) resolve();
    };
    function schedule() {
      if (!scheduled) {
        scheduled = true;
        nextPaint(drain);
      }
    }
    function useLocalParser() {
      worker?.terminate();
      if (nodes.length || queue.length) problem = 'Фоновый парсер подписки остановился.';
      else localBatches = readBatches(text);
      schedule();
    }
    try {
      worker = new Worker('parser.worker.mjs', { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (data.type === 'batch') queue.push(data.batch);
        if (data.type === 'done') ended = true;
        if (data.type === 'error') problem = data.message;
        schedule();
      };
      worker.onerror = useLocalParser;
      worker.postMessage({ text });
    } catch { useLocalParser(); }
  });
  try {
    await finished;
    sources.set(source, nodes);
    rebuild();
    if (selected && !probes.has(selected.key)) checkPing(selected);
    return nodes.length;
  } catch (error) {
    if (existing) sources.set(source, existing);
    else sources.delete(source);
    rebuild();
    throw error;
  } finally { worker?.terminate(); }
}

function setBusy(value) {
  busy = value;
  rebuild();
  if (settingsDialog.open) renderProviders();
  if (!busy) scheduleSubscriptionRefresh();
}

function scheduleSubscriptionRefresh() {
  clearTimeout(refreshTimer);
  if (!subscriptionRefreshMinutes || busy || ![...sources.keys()].some(isUrl)) return;
  const remaining = refreshedAt + subscriptionRefreshMinutes * 60_000 - Date.now();
  refreshTimer = setTimeout(() => {
    if (addDialog.open || dialog.open || removeDialog.open) {
      refreshTimer = setTimeout(scheduleSubscriptionRefresh, 15_000);
      return;
    }
    refreshAll();
  }, Math.max(0, remaining));
}

async function refreshAll() {
  if (busy) return;
  setBusy(true);
  setNotice('Обновляем подписки…');
  const failures = [];
  try {
    for (const source of sources.keys()) {
      if (!isUrl(source)) continue;
      try { await load(source, true); } catch (error) { failures.push(formatError(error)); }
    }
  } finally {
    refreshedAt = Date.now();
    setBusy(false);
    setNotice(failures[0]);
  }
}

function renderVpn(next) {
  const stateChanged = next.state !== vpn.state;
  const disconnected = next.state === 'idle' && connectedKey != null;
  if (disconnected) {
    connectedKey = null;
    connectedPool = null;
  }
  if (next.error && next.error !== vpn.error) operationError = next.error;
  vpn = next;
  if (stateChanged) {
    metricsSnapshot = {};
    metricsRequest++;
    pingSession++;
    measuringTunnel = false;
    connectedPing = undefined;
    nextTunnelPing = 0;
    if (next.state === 'connected') {
      refreshMetrics();
      measureTunnelPing();
    }
  }
  if (disconnected) rebuild();
  else {
    updateControls();
    redraw();
  }
}

async function connectTarget(target, poolServers) {
  if (switching) return;
  if (poolServers && !poolServers.length) return;
  const next = vpn.state === 'connected' && target?.key === connectedKey ? null : target;
  switching = true;
  operationError = '';
  try {
    let config;
    if (next && poolServers) {
      const candidates = balancerCandidates(poolServers, probes);
      if (!candidates.length) throw new Error('Для балансера нужны отдельные серверы. Можно выбрать готовый профиль из списка.');
      config = balancedTunnelConfig(candidates, platform, { ruDirect: next.key === automaticKey });
    } else if (next) config = tunnelConfig(next, platform);
    if (vpn.state === 'connected') {
      renderVpn({ state: 'disconnecting' });
      renderVpn(await call('disconnect'));
    }
    if (!next) return;
    if (!poolServers) selected = next;
    connectedKey = next.key;
    connectedPool = poolServers ? next : null;
    renderVpn({ state: 'connecting' });
    renderVpn(await call('connect', { name: next.display, config, measureTunnel: Boolean(poolServers) || isBalancer(next) }));
  } catch (error) {
    operationError = formatError(error);
    try { renderVpn(await call('status')); }
    catch { renderVpn({ state: 'idle' }); }
  } finally {
    switching = false;
    updateControls();
    redraw();
  }
}

function toggleVpn() {
  return connectTarget(vpn.state === 'connected' ? null : selected);
}

function connectCountry(group) {
  if (!group.country || busy) return;
  const pool = servers.filter(server => server.country === group.country);
  return connectTarget({ ...group, display: group.display + ' · балансер' }, pool);
}

$('bot').onclick = () => { call('bot').catch(() => setNotice('Не удалось открыть Telegram.')); };
const addDialog = $('add-dialog');
const settingsDialog = $('settings-dialog');
const removeDialog = $('remove-provider-dialog');
const showError = (element, message = '') => { element.textContent = message; element.hidden = !message; };
const removeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg>';
let removal;

function sourceLabel(source, nodes) {
  if (isUrl(source)) {
    try { return new URL(source).host; } catch { return 'Ссылка на подписку'; }
  }
  if (/^\s*[\[{]/.test(source)) return 'Xray JSON';
  return nodes.length === 1 ? nodes[0].display : 'Импортированные серверы';
}

function renderProviders() {
  const providers = $('provider-list');
  const next = document.createDocumentFragment();
  const labels = [...sources].map(([source, nodes]) => sourceLabel(source, nodes));
  const totals = new Map();
  for (const label of labels) totals.set(label, (totals.get(label) || 0) + 1);
  const seen = new Map();
  let index = 0;
  for (const [source, nodes] of sources) {
    const label = labels[index++];
    const ordinal = (seen.get(label) || 0) + 1;
    seen.set(label, ordinal);
    const title = totals.get(label) > 1 ? label + ' · ' + ordinal : label;
    const entry = document.createElement('li');
    entry.className = 'provider-row';
    const description = document.createElement('div');
    description.className = 'provider-label';
    const name = document.createElement('span');
    name.textContent = title;
    const count = document.createElement('small');
    count.textContent = 'Серверов: ' + countFormat.format(nodes.length);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button provider-remove';
    remove.setAttribute('aria-label', 'Удалить источник ' + title);
    remove.title = 'Удалить источник';
    remove.disabled = busy || !platform;
    remove.innerHTML = removeIcon;
    remove.onclick = () => {
      removal = { source, title };
      $('remove-provider-message').textContent = 'Источник «' + title + '» и его серверы будут удалены с этого устройства.';
      showError($('provider-error'));
      removeDialog.showModal();
    };
    description.append(name, count);
    entry.append(description, remove);
    next.append(entry);
  }
  providers.replaceChildren(next);
  $('providers-empty').hidden = Boolean(sources.size);
}

$('cancel-provider').onclick = () => removeDialog.close();
removeDialog.addEventListener('cancel', event => { if ($('confirm-provider').disabled) event.preventDefault(); });
$('confirm-provider').onclick = async () => {
  if (busy || !removal || !sources.has(removal.source)) return;
  const { source, title } = removal;
  const remaining = [...sources.keys()].filter(key => key !== source);
  $('cancel-provider').disabled = $('confirm-provider').disabled = true;
  showError($('provider-error'));
  setBusy(true);
  try {
    if (!await call('save', remaining)) throw new Error('Не удалось сохранить изменения.');
    sources.delete(source);
    removeDialog.close();
    showError($('provider-status'), 'Источник «' + title + '» удалён.');
    setNotice();
  } catch (error) {
    showError($('provider-error'), formatError(error));
  } finally {
    $('cancel-provider').disabled = $('confirm-provider').disabled = false;
    setBusy(false);
    if (!removeDialog.open) $('providers-title').focus();
  }
};

function showImport(value = '', title = 'Добавить подписку') {
  addDialog.close();
  showError($('import-error'));
  $('import-title').textContent = title;
  $('source').value = value;
  if (!dialog.open) dialog.showModal();
}

$('open-import').onclick = () => {
  showError($('add-error'));
  addDialog.showModal();
};
$('close-add').onclick = () => addDialog.close();
$('manual-import').onclick = () => showImport();
$('paste-import').onclick = async () => {
  try {
    const text = (await call('clipboard')).trim();
    if (!text) throw new Error('В буфере обмена нет текста.');
    if (text.length > 8 * 1024 * 1024) throw new Error('В буфере слишком много данных.');
    showImport(importPayload(text) || text);
  } catch (error) { showError($('add-error'), formatError(error)); }
};
$('file-import').onclick = () => $('import-file').click();
$('import-file').onchange = async ({ target }) => {
  const [file] = target.files;
  target.value = '';
  if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('Файл слишком большой.');
    showImport(await file.text(), 'Импорт Xray JSON');
  } catch (error) { showError($('add-error'), formatError(error)); }
};
$('close-import').onclick = () => dialog.close();
dialog.addEventListener('cancel', (event) => { if ($('import-submit').disabled) event.preventDefault(); });
$('import-form').onsubmit = async (event) => {
  event.preventDefault();
  const field = $('source');
  const retry = $('import-error');
  const text = field.value.trim();
  const input = importPayload(text) || text;
  if (!input || busy) return;
  const firstSubscription = isUrl(input) && ![...sources.keys()].some(isUrl);
  setBusy(true);
  $('import-submit').disabled = $('close-import').disabled = true;
  $('import-submit').textContent = 'Загружаем…';
  retry.hidden = true;
  try {
    await paint();
    await load(input, sources.has(input), () => {
      setNotice('Добавляем серверы…');
      dialog.close();
    });
    if (firstSubscription) refreshedAt = Date.now();
    setNotice();
    try { await call('save', [...sources.keys()]); }
    catch { setNotice('Не удалось сохранить подписку на устройстве.'); }
    field.value = '';
    dialog.close();
  } catch (error) {
    if (dialog.open) {
      retry.textContent = formatError(error);
      retry.hidden = false;
    } else setNotice(formatError(error));
  } finally {
    setBusy(false);
    $('import-submit').disabled = $('close-import').disabled = false;
    $('import-submit').textContent = 'Добавить';
  }
};
$('connect').onclick = toggleVpn;
$('auto-connect').onclick = () => connectTarget({ key: automaticKey, display: 'Автовыбор' }, servers);
$('expand-groups').onclick = () => setAllGroups(true);
$('collapse-groups').onclick = () => setAllGroups(false);
$('ping-one').onclick = () => {
  if (vpn.state === 'connected' && vpn.tunnelPing) measureTunnelPing(true);
  else if (selected) checkPing(selected, true);
};
$('ping-all').onclick = pingList;
$('refresh').onclick = refreshAll;

function updateNotice(state) {
  update = state;
  const check = $('check-update');
  const button = $('apply-update');
  const visible = ['available', 'ready'].includes(state.state);
  check.disabled = checkingUpdate || ['downloading', 'ready'].includes(state.state);
  check.textContent = checkingUpdate ? 'Проверяем…' : 'Проверить обновления';
  button.hidden = !visible;
  button.disabled = updating;
  button.textContent = state.state === 'ready' ? 'Установить обновление' : 'Скачать обновление';
  const bar = $('update-progress');
  bar.hidden = state.state !== 'downloading';
  bar.value = state.progress || 0;
  showError($('update-state'), ({
    current: 'Установлена актуальная версия',
    available: 'Доступна версия ' + state.version,
    downloading: 'Загружается версия ' + state.version + ' · ' + (state.progress ?? 0) + '%',
    ready: 'Версия ' + state.version + ' готова к установке',
    error: state.error,
  })[state.state] || '');
  const available = visible || state.state === 'downloading';
  $('open-settings').classList.toggle('has-update', available);
  $('open-settings').setAttribute('aria-label', available ? 'Настройки. Доступно обновление' : 'Настройки');
}

async function checkUpdate(background = false) {
  if (checkingUpdate || !platform || ['ready', 'downloading'].includes(update.state)) return;
  checkingUpdate = true;
  if (!background) updateNotice(update);
  try {
    const state = await call('updateCheck');
    if (state.state === 'available' && automatic) {
      updateNotice({ ...state, state: 'downloading', progress: 0 });
      updateNotice(await call('updateAction'));
    } else updateNotice(state);
  } catch (error) {
    if (!background) updateNotice({ state: 'error', error: formatError(error) });
  } finally {
    checkingUpdate = false;
    updateNotice(update);
  }
}

$('open-settings').onclick = () => {
  showError($('settings-error'));
  showError($('provider-status'));
  renderProviders();
  settingsDialog.showModal();
};
$('close-settings').onclick = () => settingsDialog.close();
$('check-update').onclick = () => checkUpdate();
$('apply-update').onclick = async () => {
  if (updating) return;
  updating = true;
  showError($('settings-error'));
  updateNotice(update);
  try {
    if (update.state === 'ready' && platform === 'android') await call('updateInstall');
    else updateNotice(await call('updateAction'));
  } catch (error) { showError($('settings-error'), formatError(error)); }
  finally { updating = false; updateNotice(update); }
};
function savePreferences() {
  const groupChanged = grouped !== $('group-setting').checked;
  const autoChanged = automatic !== $('auto-setting').checked;
  const memoryChanged = showMemory !== $('memory-setting').checked;
  const batteryChanged = showBattery !== $('battery-setting').checked;
  grouped = $('group-setting').checked;
  automatic = $('auto-setting').checked;
  theme = $('theme-setting').value === 'dark' ? 'dark' : 'light';
  showMemory = $('memory-setting').checked;
  showBattery = $('battery-setting').checked;
  const minutes = Number($('subscription-refresh-setting').value);
  if (minutes !== subscriptionRefreshMinutes) {
    subscriptionRefreshMinutes = minutes;
    scheduleSubscriptionRefresh();
  }
  if (groupChanged) {
    list.scrollTop = 0;
    position = 0;
    rebuild();
  }
  applyAppearance();
  if (memoryChanged || batteryChanged) {
    metricsRequest++;
    if (memoryChanged) delete metricsSnapshot.memory;
    if (batteryChanged) delete metricsSnapshot.batteryRate;
    renderMetrics();
  }
  const desired = { grouped, automatic, theme, showMemory, showBattery, subscriptionRefreshMinutes };
  savingPreferences = savingPreferences.then(async () => {
    try {
      if (!await call('preferences', desired)) throw new Error('Не удалось сохранить настройки.');
      showError($('settings-error'));
      if (memoryChanged || batteryChanged) refreshMetrics();
    } catch (error) { showError($('settings-error'), formatError(error)); }
  });
  if (automatic && autoChanged) checkUpdate(true);
}
$('group-setting').onchange = savePreferences;
$('auto-setting').onchange = savePreferences;
$('theme-setting').onchange = savePreferences;
$('memory-setting').onchange = savePreferences;
$('battery-setting').onchange = savePreferences;
$('subscription-refresh-setting').onchange = savePreferences;

async function handleDeepLink() {
  if (!platform) return;
  try { queuedLink = importPayload(await call('deeplink')) || queuedLink; } catch { return; }
  if (!queuedLink || busy || dialog.open || settingsDialog.open) return;
  showImport(queuedLink, 'Импорт по ссылке');
  queuedLink = '';
}

const decimal = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });
function applyAppearance() {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#151515' : '#fbfbfa';
  renderMetrics();
}

function renderMetrics() {
  $('resources').hidden = !showMemory && !showBattery;
  $('memory-reading').hidden = !showMemory;
  $('battery-reading').hidden = !showBattery;
  $('resource-divider').hidden = !showMemory || !showBattery;
  const connected = vpn.state === 'connected';
  const memory = connected && metricsSnapshot.memory != null
    ? decimal.format(metricsSnapshot.memory / 1048576) + ' МБ' : '—';
  const memoryText = 'ОЗУ Xray ' + memory;
  if ($('memory-reading').textContent !== memoryText) $('memory-reading').textContent = memoryText;
  $('memory-reading').title = platform === 'android' ? 'Текущая память Go-кучи Xray-core' : 'Резидентная память процесса xray.exe';
  const rate = connected && metricsSnapshot.batteryRate != null ? decimal.format(metricsSnapshot.batteryRate) : '—';
  const battery = $('battery-reading');
  const batteryText = 'Разряд ≈ ' + rate + ' %/ч';
  if (battery.textContent !== batteryText) battery.textContent = batteryText;
  battery.title = rate !== '—' ? 'Оценка разряда устройства во время сеанса'
    : platform === 'windows' ? 'Оценка появится при активном VPN и наличии датчика разряда батареи'
    : 'Для оценки нужны минимум пять минут VPN от батареи и показания датчика заряда';
}

async function refreshMetrics() {
  if (!platform || document.hidden) return;
  const request = ++metricsRequest;
  try {
    const metrics = await call('metrics', { showMemory, showBattery });
    if (request !== metricsRequest || !metrics) return;
    metricsSnapshot = metrics;
    renderMetrics();
  } catch { /* next sample can recover */ }
}
search.addEventListener('input', () => { list.scrollTop = 0; position = 0; rebuild(); });
list.addEventListener('scroll', scheduleRows, { passive: true });
list.addEventListener('focus', redraw);
list.addEventListener('blur', redraw);
list.addEventListener('click', ({ target }) => {
  const row = target.closest('.row');
  if (row) choose(Number(row.dataset.index));
});
list.addEventListener('keydown', (event) => {
  const options = { ArrowDown: position + 1, ArrowUp: position - 1, Home: 0, End: filtered.length - 1,
    PageDown: position + Math.floor(list.clientHeight / rowHeight), PageUp: position - Math.floor(list.clientHeight / rowHeight) };
  if (event.target !== list) return;
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    const entry = filtered[position];
    if (event.key === 'Enter' && event.altKey && entry?.group) connectCountry(entry);
    else choose(position);
  } else if (Object.hasOwn(options, event.key)) {
    event.preventDefault();
    position = Math.min(filtered.length - 1, Math.max(0, options[event.key]));
    const top = position * rowHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    if (top + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + rowHeight - list.clientHeight;
    redraw();
  }
});
const sizeObserver = new ResizeObserver(() => {
  updateRowHeight();
  scheduleRows();
});
sizeObserver.observe(list);
sizeObserver.observe(document.documentElement);

try {
  const info = await call('init');
  platform = info.platform;
  grouped = $('group-setting').checked = Boolean(info.grouped);
  automatic = $('auto-setting').checked = info.automatic !== false;
  const refreshSetting = $('subscription-refresh-setting');
  if ([...refreshSetting.options].some(option => Number(option.value) === info.subscriptionRefreshMinutes)) {
    refreshSetting.value = info.subscriptionRefreshMinutes;
  }
  subscriptionRefreshMinutes = Number(refreshSetting.value);
  theme = $('theme-setting').value = info.theme === 'dark' ? 'dark' : 'light';
  showMemory = $('memory-setting').checked = info.showMemory !== false;
  showBattery = $('battery-setting').checked = info.showBattery !== false;
  applyAppearance();
  $('app-version').textContent = info.version ?? '—';
  $('core-version').textContent = info.coreVersion ?? '—';
  renderVpn(info.vpn);
  refreshMetrics();
  handleDeepLink();
  if (automatic) setTimeout(() => checkUpdate(true), 1500);
  if (info.sources.length) {
    setBusy(true);
    const failures = [];
    for (const source of info.sources) {
      try { await load(source); }
      catch (error) { sources.set(source, []); failures.push(formatError(error)); }
    }
    refreshedAt = Date.now();
    setBusy(false);
    setNotice(failures[0]);
  }
} catch (error) { setNotice(formatError(error)); }

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    scheduleSubscriptionRefresh();
    measureTunnelPing();
  }
});
window.addEventListener('focus', scheduleSubscriptionRefresh);

setInterval(async () => {
  if (!platform) return;
  handleDeepLink();
  if (!switching) {
    try { renderVpn(await call('status')); } catch { /* next poll can recover */ }
  }
  if (update.state === 'downloading') {
    try { updateNotice(await call('updateStatus')); } catch { /* next poll can recover */ }
  }
}, 1100);
setInterval(refreshMetrics, 5000);
setInterval(() => { if (!document.hidden) measureTunnelPing(); }, 15_000);
setInterval(() => { if (automatic) checkUpdate(true); }, 6 * 60 * 60 * 1000);
