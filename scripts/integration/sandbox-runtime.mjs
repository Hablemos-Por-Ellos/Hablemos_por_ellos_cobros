import fs from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';

// Reads only the already-authorized private configs; never exports or logs their contents.
export async function sandboxRuntime() {
  const environments = [];
  for (const name of ['.env.sandbox.local','.env.local']) {
    try { environments.push(parseEnv(await fs.readFile(path.resolve(name),'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('PRIVATE_SANDBOX_CONFIG_INVALID'); }
  }
  const pick = (names,prefix) => {
    for (const environment of environments) for (const name of names) {
      const value = environment[name];
      if (typeof value === 'string' && new RegExp(`^${prefix}[A-Za-z0-9_-]+$`).test(value)) return value;
    }
    throw new Error('SANDBOX_ONLY_KEYS_REQUIRED');
  };
  return {
    publicKey: pick(['NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX','NEXT_PUBLIC_WOMPI_PUBLIC_KEY','NEXT_PUBLIC_WOMPI_PUBLIC_KEY_PROD'],'pub_test_'),
    privateKey: pick(['WOMPI_PRIVATE_KEY_SANDBOX','WOMPI_PRIVATE_KEY','WOMPI_PRIVATE_KEY_PROD'],'prv_test_'),
    integritySecret: pick(['WOMPI_INTEGRITY_SECRET_SANDBOX','WOMPI_INTEGRITY_SECRET','WOMPI_INTEGRITY_SECRET_PROD'],'test_integrity_'),
    eventsSecret: pick(['WOMPI_EVENTS_SECRET_SANDBOX','WOMPI_EVENTS_SECRET','WOMPI_EVENTS_SECRET_PROD'],'test_events_'),
    server: { wompiEnvironment: 'sandbox',supabaseUrl: 'http://127.0.0.1:54321' },
  };
}
