// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { dockerCompose, launchGateway, localJwt, validateLabConfig } from './local-auth-lab.mjs';

describe('local fixture configuration isolation', () => {
  const secret = 'local-unit-fixture-only-not-a-real-secret';
  const config = () => ({ fixture: 'hpe-auth-integration-030',url: 'http://127.0.0.1:54321',jwtSecret: secret,
    anonKey: localJwt(secret,'anon'),serviceKey: localJwt(secret,'service_role') });
  it('accepts matching fixture keys without changing them', () => {
    const value = config();
    expect(validateLabConfig(value)).toBe(value);
  });
  it.each(['anonKey','serviceKey'])('rejects missing or foreign %s', (name) => {
    for (const key of [undefined,'fixture-but-not-jwt',localJwt('different-local-fixture-secret-only',name === 'anonKey' ? 'anon' : 'service_role')]) {
      expect(() => validateLabConfig({ ...config(),[name]: key })).toThrow('LOCAL_LAB_KEYS_MUST_MATCH_FIXTURE');
    }
  });
  it.each(['role','iss','aud','exp','iat'])('rejects signed but incorrect %s', (field) => {
    const value = config();
    const [header,payload] = value.serviceKey.split('.');
    const claims = JSON.parse(Buffer.from(payload,'base64url').toString());
    claims[field] = ({ role: 'anon',iss: 'supabase',aud: 'other',exp: 1,iat: claims.exp + 1 })[field];
    const body = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    value.serviceKey = `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
    expect(() => validateLabConfig(value)).toThrow('LOCAL_LAB_KEYS_MUST_MATCH_FIXTURE');
  });
  it('rejects a production destination', () => {
    expect(() => validateLabConfig({ ...config(),url: 'https://example.test' })).toThrow('LOCAL_LAB_CONFIG_REQUIRED');
  });
  it.each(['win32','linux'])('pins Docker locally on %s without invoking it', async (platform) => {
    let observed;
    const child = new EventEmitter();
    const pending = dockerCompose(config(),['up','-d'],{ platform,
      environment: { DOCKER_HOST: 'tcp://remote.example.test:2375',DOCKER_CONTEXT: 'remote',
        DOCKER_TLS_VERIFY: '1',DOCKER_CERT_PATH: '/remote-certs',KEEP_FIXTURE: 'yes' },
      spawnProcess: (...args) => { observed = args; return child; } });
    child.emit('close',0);
    await pending;
    expect(observed[1].slice(0,3)).toEqual(['--host',platform === 'win32'
      ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock','compose']);
    expect(observed[2].env.KEEP_FIXTURE).toBe('yes');
    for (const name of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']) {
      expect(observed[2].env[name]).toBeUndefined();
    }
  });
});

describe('loopback Auth gateway CORS', () => {
  let server;
  let url;
  beforeAll(async () => {
    server = launchGateway({ anonKey: 'fixture-anon-only',serviceKey: 'fixture-service-only' },{ port: 0 });
    await new Promise((resolve) => server.once('listening',resolve));
    url = `http://127.0.0.1:${server.address().port}/auth/v1/token?grant_type=password`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  it.each(['http://localhost:3001','http://127.0.0.1:3001'])('allows only the local app: %s',async (origin) => {
    const response = await fetch(url,{ method: 'OPTIONS',headers: { origin,
      'access-control-request-method': 'POST','access-control-request-headers': 'apikey,content-type,x-client-info' } });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  });
  it.each(['https://example.test','http://localhost:3000','http://localhost:3001.evil.test'])('rejects other origins: %s',async (origin) => {
    const response = await fetch(url,{ method: 'OPTIONS',headers: { origin,'access-control-request-method': 'POST' } });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
  it.each([{ method: 'TRACE',headers: 'apikey' },{ method: 'POST',headers: 'x-untrusted' }])('rejects unexpected preflight: %j',async (input) => {
    const response = await fetch(url,{ method: 'OPTIONS',headers: { origin: 'http://localhost:3001',
      'access-control-request-method': input.method,'access-control-request-headers': input.headers } });
    expect(response.status).toBe(403);
  });
  it('does not remove the API key requirement',async () => {
    const response = await fetch(url,{ method: 'POST',headers: { origin: 'http://localhost:3001' } });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3001');
  });
});
