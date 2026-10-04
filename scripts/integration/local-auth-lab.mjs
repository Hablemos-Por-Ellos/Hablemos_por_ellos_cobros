import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const configPath = path.resolve('.env.integration-lab.local');
export function localJwt(secret, role) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'HS256',typ: 'JWT' })}.${encode({ role,iss: 'hpe-local-fixture',
    aud: 'authenticated',iat: Math.floor(Date.now() / 1000),exp: Math.floor(Date.now() / 1000) + 86400 * 7 })}`;
  return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
export function validateLabConfig(config, now = Date.now()) {
  if (config?.fixture !== 'hpe-auth-integration-030' || config.url !== 'http://127.0.0.1:54321'
    || typeof config.jwtSecret !== 'string' || config.jwtSecret.length < 32) throw new Error('LOCAL_LAB_CONFIG_REQUIRED');
  for (const [name,role] of [['anonKey','anon'],['serviceKey','service_role']]) {
    try {
      const token = config[name];
      if (typeof token !== 'string' || token.length > 4096) throw new Error();
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)
        || Buffer.from(part,'base64url').toString('base64url') !== part)) throw new Error();
      const header = JSON.parse(Buffer.from(parts[0],'base64url').toString());
      const claims = JSON.parse(Buffer.from(parts[1],'base64url').toString());
      const signature = Buffer.from(parts[2],'base64url');
      const expected = createHmac('sha256',config.jwtSecret).update(`${parts[0]}.${parts[1]}`).digest();
      if (header.alg !== 'HS256' || header.typ !== 'JWT' || claims.role !== role
        || claims.iss !== 'hpe-local-fixture' || claims.aud !== 'authenticated'
        || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
        || !Number.isFinite(now) || claims.iat > Math.floor(now / 1000)
        || claims.exp <= Math.floor(now / 1000) || claims.exp <= claims.iat
        || signature.length !== expected.length || !timingSafeEqual(signature,expected)) throw new Error();
    } catch { throw new Error('LOCAL_LAB_KEYS_MUST_MATCH_FIXTURE'); }
  }
  return config;
}
export async function labConfig() {
  let config;
  try { config = JSON.parse(await fs.readFile(configPath,'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('INVALID_LOCAL_LAB_CONFIG');
    const secret = randomBytes(48).toString('base64url');
    config = { fixture: 'hpe-auth-integration-030',url: 'http://127.0.0.1:54321',
      jwtSecret: secret,anonKey: localJwt(secret,'anon'),serviceKey: localJwt(secret,'service_role') };
    await fs.writeFile(configPath,JSON.stringify(config),{ flag: 'wx',mode: 0o600 });
  }
  return validateLabConfig(config);
}
export function launchGateway(config, { port = 54321 } = {}) {
  const allowedOrigins = new Set(['http://localhost:3001','http://127.0.0.1:3001']);
  const allowedMethods = new Set(['GET','POST','PATCH','PUT','DELETE','HEAD']);
  const allowedHeaders = new Set(['apikey','authorization','content-type','x-client-info','x-supabase-api-version']);
  const server = http.createServer((request,response) => {
    const source = request.url ?? '/';
    const prefix = source.startsWith('/auth/v1/') ? '/auth/v1' : source.startsWith('/rest/v1/') ? '/rest/v1' : null;
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      response.writeHead(403).end('LOCAL_ORIGIN_REJECTED');
      return;
    }
    const cors = origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    if (request.method === 'OPTIONS') {
      const headers = String(request.headers['access-control-request-headers'] ?? '')
        .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
      if (!prefix || !origin || !allowedMethods.has(request.headers['access-control-request-method'])
        || headers.some((header) => !allowedHeaders.has(header))) {
        response.writeHead(403,cors).end('LOCAL_PREFLIGHT_REJECTED');
        return;
      }
      response.writeHead(204,{ ...cors,'access-control-allow-methods': [...allowedMethods].join(', '),
        'access-control-allow-headers': [...allowedHeaders].join(', '),'access-control-max-age': '300' }).end();
      return;
    }
    const key = request.headers.apikey;
    if (!prefix || ![config.anonKey,config.serviceKey].includes(key)) {
      response.writeHead(403,{ ...cors,'content-type': 'application/json' }).end('{"error":"LOCAL_GATEWAY_REJECTED"}');
      return;
    }
    const target = http.request({ hostname: '127.0.0.1',port: prefix === '/auth/v1' ? 54328 : 54329,
      method: request.method,path: source.slice(prefix.length),headers: { ...request.headers,host: '127.0.0.1' } },
    (upstream) => { response.writeHead(upstream.statusCode ?? 502,{ ...upstream.headers,...cors }); upstream.pipe(response); });
    target.on('error',() => {
      if (!response.headersSent) response.writeHead(502,cors);
      response.end('LOCAL_UPSTREAM_UNAVAILABLE');
    });
    request.pipe(target);
  });
  server.listen(port,'127.0.0.1');
  return server;
}
export function dockerCompose(config,args,{ spawnProcess = spawn,environment = process.env,platform = process.platform } = {}) {
  const host = platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock';
  const env = { ...environment,HPE_LAB_JWT_SECRET: config.jwtSecret };
  for (const name of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']) delete env[name];
  return new Promise((resolve,reject) => {
    const child = spawnProcess('docker',['--host',host,'compose','-f',path.resolve('scripts/integration/lab/compose.yml'),...args],
      { env,windowsHide: true,stdio: 'ignore' });
    child.on('error',() => reject(new Error('DOCKER_LAB_EXECUTION_FAILED')));
    child.on('close',(code) => code === 0 ? resolve({ code }) : reject(new Error('DOCKER_LAB_COMMAND_FAILED')));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = await labConfig();
    const action = process.argv[2];
    if (action === 'start') {
      await dockerCompose(config,['up','-d']);
      console.log('LOCAL_AUTH_LAB_STARTED_LOOPBACK_ONLY');
    } else if (action === 'gateway') {
      launchGateway(config);
      console.log('LOCAL_AUTH_GATEWAY_LOOPBACK_ONLY');
    } else throw new Error('EXPLICIT_LOCAL_LAB_ACTION_REQUIRED');
  } catch (error) {
    console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_AUTH_LAB_FAILED');
    process.exitCode = 1;
  }
}
