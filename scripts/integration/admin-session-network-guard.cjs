// Local Auth integration only: no provider, production or external TCP traffic.
const net = require('node:net');
const ports = new Set([3001, 54321, 54327, 54328, 54329]);
const hosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const deny = () => { throw new Error('LOCAL_AUTH_EXTERNAL_NETWORK_DISABLED'); };
const allowed = (input) => {
  try {
    const url = typeof input === 'string' || input instanceof URL
      ? new URL(input) : input?.url ? new URL(input.url) : null;
    return url ? url.protocol === 'http:' && hosts.has(url.hostname) && ports.has(Number(url.port))
      : (input?.protocol ?? 'http:') === 'http:' && hosts.has(input?.hostname ?? input?.host)
        && ports.has(Number(input?.port));
  } catch { return false; }
};
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object' && hosts.has(address.address)) ports.add(address.port);
  });
  return originalListen.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => allowed(input) ? originalFetch(input, ...args) : deny();
for (const name of ['node:http', 'node:https']) {
  const network = require(name);
  for (const method of ['request', 'get']) {
    const original = network[method];
    network[method] = function (input, ...args) {
      if (!allowed(input)) return deny();
      return original.call(this, input, ...args);
    };
  }
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const value = normalized[0];
  const ipc = typeof value === 'string' && value.startsWith('\\\\.\\pipe\\')
    || value && typeof value === 'object' && typeof value.path === 'string';
  const local = value && typeof value === 'object' && hosts.has(value.host ?? value.hostname)
    && ports.has(Number(value.port))
    || typeof value === 'number' && hosts.has(normalized[1] ?? 'localhost') && ports.has(value);
  if (!ipc && !local) return deny();
  return originalConnect.apply(this, args);
};
