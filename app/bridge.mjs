const desktop = globalThis.shareSub;
const android = globalThis.ShareSubAndroid;
const pending = new Map();
let sequence = 0;

if (android) {
  globalThis.resolveShareSub = (id, response) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (response.ok) request.resolve(response.value);
    else request.reject(new Error(response.error));
  };
}

export function call(method, payload = null) {
  if (desktop) return desktop.call(method, payload);
  if (!android) return Promise.reject(new Error('Откройте приложение ShareSub.'));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    android.request(id, method, JSON.stringify(payload));
  });
}
