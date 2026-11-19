const { app, BrowserWindow, clipboard, ipcMain, net, powerMonitor, protocol, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const socket = require('node:net');
const { pathToFileURL } = require('node:url');
const createUpdater = require('./updates.cjs');

const MAX_BODY = 8 * 1024 * 1024;
const origin = 'sharesub://app';
const uiPath = path.join(__dirname, '..', 'app');
const settingsPath = () => path.join(app.getPath('userData'), 'subscriptions.json');
const isShareSub = (host) => host === 'sharesub.ru' || host.endsWith('.sharesub.ru');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let window, settings, session, quitting = false, lastError;
let pendingLink = process.argv.find(isImportLink) || '';
let lastPowerQuery = 0, batteryRate = null;
let settingsWrites = Promise.resolve();
const updater = createUpdater(app, async () => { if (session) await disconnect(); });

function isImportLink(value) {
  return typeof value === 'string' && /^sharesub:\/\/(?:import|add)(?=[/?#]|$)/i.test(value) && value.length <= 32768;
}

async function coreVersion() {
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'vendor');
  const binary = path.join(resources, app.isPackaged ? 'xray' : 'windows', 'xray.exe');
  return new Promise(resolve => {
    const child = spawn(binary, ['version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', text => { output += text; });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(/Xray\s+([\d.]+)/.exec(output)?.[1] ?? null));
  });
}

async function metrics() {
  const saved = await getSettings();
  const xray = saved.showMemory && session?.state === 'connected'
    ? Number(await fs.readFile(path.join(session.directory, 'memory'), 'utf8').catch(() => '0')) : 0;
  const onBattery = saved.showBattery && powerMonitor.isOnBatteryPower();
  if (!onBattery || session?.state !== 'connected') {
    batteryRate = null;
    lastPowerQuery = 0;
  } else if (Date.now() - lastPowerQuery > 60000) {
    lastPowerQuery = Date.now();
    const query = `$b=Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -OperationTimeoutSec 4 | Where-Object Discharging
$f=Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity -OperationTimeoutSec 4
$rate=($b | Measure-Object DischargeRate -Sum).Sum; $full=($f | Measure-Object FullChargedCapacity -Sum).Sum
if($rate -gt 0 -and $full -gt 0 -and $rate -lt 1000000){[Console]::WriteLine(($rate*100/$full).ToString([Globalization.CultureInfo]::InvariantCulture))}`;
    const child = spawn(powershell, ['-NoProfile', '-EncodedCommand', encodeCommand(query)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 9000);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', () => clearTimeout(timer));
    child.on('close', () => {
      clearTimeout(timer);
      const rate = Number(output.trim());
      batteryRate = session?.state === 'connected' && powerMonitor.isOnBatteryPower() && rate > 0 && rate <= 100 ? rate : null;
    });
  }
  return { memory: xray > 0 && Number.isFinite(xray) ? xray : null, onBattery, batteryRate };
}

protocol.registerSchemesAsPrivileged([{ scheme: 'sharesub', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true,
} }]);

async function writeSettings(value) {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flush: true });
  await fs.rename(temporary, file);
  settings = value;
}

async function getSettings() {
  if (settings) return settings;
  const data = await fs.readFile(settingsPath(), 'utf8').then(JSON.parse).catch(() => ({}));
  const id = typeof data.id === 'string' && /^[a-f0-9-]{36}$/i.test(data.id) ? data.id : crypto.randomUUID();
  await writeSettings({ id, sources: Array.isArray(data.sources) ? data.sources.filter(s => typeof s === 'string') : [],
    grouped: Boolean(data.grouped), automatic: data.automatic !== false, theme: data.theme === 'dark' ? 'dark' : 'light',
    showMemory: data.showMemory !== false, showBattery: data.showBattery !== false });
  return settings;
}

function updateSettings(fields) {
  const write = settingsWrites.then(async () => writeSettings({ ...await getSettings(), ...fields }));
  settingsWrites = write.catch(() => {});
  return write;
}

async function download(input) {
  const options = await getSettings();
  let address;
  try { address = new URL(input); } catch { throw new Error('Некорректная ссылка на подписку.'); }
  const fromShareSub = address.protocol === 'https:' && isShareSub(address.hostname);
  if (fromShareSub) address.searchParams.set('format', 'base64');
  const providerOrigin = address.origin;
  const providerId = fromShareSub ? options.id
    : crypto.createHmac('sha256', options.id).update(providerOrigin).digest('hex');
  const signal = AbortSignal.timeout(22_000);
  for (let redirects = 0; redirects < 6; redirects++) {
    if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password) break;
    const headers = { 'User-Agent': 'ShareSub/' + app.getVersion() + ' (Windows)', Accept: 'text/plain, application/json, */*' };
    if (address.protocol === 'https:' && (address.origin === providerOrigin || (fromShareSub && isShareSub(address.hostname)))) {
      Object.assign(headers, { 'X-HWID': providerId, 'X-Device-OS': 'Windows', 'X-Ver-OS': os.release(), 'X-Device-Model': 'PC' });
    }
    let response;
    try { response = await fetch(address, { headers, redirect: 'manual', signal }); }
    catch { throw new Error('Не удалось загрузить подписку. Проверьте сеть и ссылку.'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) break;
      const next = new URL(location, address);
      if (address.protocol === 'https:' && next.protocol !== 'https:') break;
      address = next;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if (response.status === 403 && fromShareSub) throw new Error('ShareSub отклонил доступ. Проверьте лимит устройств в @sharesubot.');
      if (response.status === 403 && address.protocol === 'http:') throw new Error('Провайдер отклонил доступ. Если нужен HWID, используйте HTTPS-ссылку.');
      throw new Error('Сервер подписки ответил HTTP ' + response.status + '.');
    }
    if (Number(response.headers.get('content-length')) > MAX_BODY) {
      await response.body.cancel();
      throw new Error('Подписка слишком большая.');
    }
    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BODY) throw new Error('Подписка слишком большая.');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (size > MAX_BODY) throw error;
      throw new Error('Загрузка подписки прервалась.');
    }
    return Buffer.concat(chunks, size).toString('utf8');
  }
  throw new Error('Сервер подписки перенаправил запрос на недоступный адрес.');
}

function ping({ host, port }) {
  if (typeof host !== 'string' || host.length > 253 || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return new Promise(resolve => {
    const start = performance.now();
    const client = socket.createConnection({ host, port });
    client.setTimeout(2400);
    function finish(value) {
      client.destroy();
      resolve(value);
    }
    client.once('connect', () => finish(Math.max(1, Math.round(performance.now() - start))));
    client.once('timeout', () => finish(null));
    client.once('error', () => finish(null));
  });
}

function childResult(child) {
  return new Promise(resolve => {
    child.once('error', () => resolve(-1));
    child.once('exit', code => resolve(code));
  });
}

const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const quote = (text) => "'" + String(text).replaceAll("'", "''") + "'";
const encodeCommand = (command) => Buffer.from(command, 'utf16le').toString('base64');
const winError = 'Не удалось запустить туннель Xray. Проверьте права администратора и доступность Wintun.';

async function status() {
  if (session) {
    const current = session;
    const signal = await fs.readFile(path.join(current.directory, 'state'), 'utf8').catch(() => '');
    if (current.state === 'connected' && (signal.trim() === 'failed' || !await fs.stat(current.directory).catch(() => null))) {
      lastError = 'Туннель Xray остановился.';
      session = null;
    }
    if (session === current) return { state: current.state, name: current.name };
  }
  return { state: 'idle', error: lastError };
}

async function connect({ name, config }) {
  if (session || process.platform !== 'win32') throw new Error('Туннель уже запущен или недоступен на этой платформе.');
  if (typeof name !== 'string' || config?.inbounds?.[0]?.protocol !== 'tun') throw new Error('Некорректная конфигурация.');
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'vendor');
  const binary = path.join(resources, app.isPackaged ? 'xray' : 'windows', 'xray.exe');
  const script = path.join(app.isPackaged ? resources : __dirname, 'tunnel.ps1');
  if (!await fs.stat(binary).catch(() => null)) throw new Error('В сборке отсутствует Xray.');
  const directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'sharesub-tunnel-'));
  const current = { directory, name, state: 'connecting' };
  lastError = undefined;
  session = current;
  let launched = false;
  try {
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    const command = '& ' + [script, binary, directory, process.pid].map(quote).join(' ');
    const elevation = `try {
      Start-Process -FilePath ${quote(powershell)} -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encodeCommand(command)}') -Verb RunAs -WindowStyle Hidden -ErrorAction Stop
    } catch { exit 1223 }`;
    const launcher = spawn(powershell, ['-NoProfile', '-EncodedCommand', encodeCommand(elevation)], { windowsHide: true, stdio: 'ignore' });
    const code = await childResult(launcher);
    if (code === 1223) throw new Error('Для системного VPN нужно подтвердить запрос Windows.');
    if (code !== 0) throw new Error(winError);
    launched = true;
    const deadline = Date.now() + 23_000;
    while (Date.now() < deadline && session === current && current.state === 'connecting' && !quitting) {
      const signal = (await fs.readFile(path.join(directory, 'state'), 'utf8').catch(() => '')).trim();
      if (signal === 'ready') {
        current.state = 'connected';
        return status();
      }
      if (signal === 'failed') break;
      await sleep(150);
    }
    throw new Error(winError);
  } catch (error) {
    if (launched) await fs.writeFile(path.join(directory, 'stop'), '').catch(() => {});
    else await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    if (session === current && current.state !== 'disconnecting') session = null;
    throw error;
  }
}

async function disconnect() {
  const current = session;
  if (!current) return status();
  current.state = 'disconnecting';
  await fs.writeFile(path.join(current.directory, 'stop'), '');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!await fs.stat(current.directory).catch(() => null)) {
      if (session === current) session = null;
      return status();
    }
    await sleep(130);
  }
  current.state = 'connected';
  throw new Error('Windows ещё завершает работу туннеля.');
}

const actions = {
  init: async () => {
    const saved = await getSettings();
    return { platform: 'windows', sources: saved.sources, grouped: saved.grouped, automatic: saved.automatic,
      version: app.getVersion(), coreVersion: await coreVersion(), vpn: await status(),
      theme: saved.theme, showMemory: saved.showMemory, showBattery: saved.showBattery };
  },
  preferences: async ({ grouped, automatic, theme, showMemory, showBattery }) => {
    const appearance = theme === 'dark' ? 'dark' : 'light';
    await updateSettings({ grouped: Boolean(grouped), automatic: Boolean(automatic), theme: appearance,
      showMemory: showMemory !== false, showBattery: showBattery !== false });
    window?.setBackgroundColor(appearance === 'dark' ? '#151515' : '#fbfbfa');
    return true;
  },
  clipboard: () => clipboard.readText(),
  deeplink: () => { const link = pendingLink; pendingLink = ''; return link; },
  metrics,
  updateCheck: updater.check,
  updateAction: updater.install,
  updateStatus: updater.status,
  save: async (sources) => {
    if (!Array.isArray(sources) || sources.length > 100 || sources.some(s => typeof s !== 'string') ||
        sources.reduce((size, s) => size + s.length, 0) > MAX_BODY) throw new Error('Слишком много сохранённых данных.');
    await updateSettings({ sources });
    return true;
  },
  subscription: download, ping, status, connect, disconnect,
  bot: () => shell.openExternal('https://t.me/sharesubot'),
};

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, args) => {
    const link = args.find(isImportLink);
    if (link) pendingLink = link;
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    protocol.handle('sharesub', request => {
      const url = new URL(request.url);
      const asset = /^\/(?:[\w.-]+\.(?:html|css|mjs)|flags\/[a-z]{2}\.webp|fonts\/golos-text\.woff2)$/;
      if (url.hostname !== 'app' || !asset.test(url.pathname)) return new Response('', { status: 404 });
      return net.fetch(pathToFileURL(path.join(uiPath, url.pathname.slice(1))).href);
    });
    ipcMain.handle('sharesub:request', ({ senderFrame }, method, payload) => {
      if (senderFrame?.url !== origin + '/index.html' || !Object.hasOwn(actions, method)) return null;
      return actions[method](payload);
    });
    const appearance = (await getSettings()).theme;
    window = new BrowserWindow({
      title: 'ShareSub', width: 1160, height: 780, minWidth: 360, minHeight: 550, autoHideMenuBar: true,
      backgroundColor: appearance === 'dark' ? '#151515' : '#fbfbfa', show: false, icon: path.join(__dirname, 'icon.ico'),
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.once('ready-to-show', () => window.show());
    await window.loadURL(origin + '/index.html');
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !session) return;
    event.preventDefault();
    quitting = true;
    disconnect().catch(() => {}).finally(() => app.quit());
  });
}
