import { setTimeout as pause } from "node:timers/promises";

async function reloadSetting(client, expected) {
  await client.query("select pg_reload_conf()");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await client.query("select current_setting('supautils.privileged_extensions') as setting")).rows[0].setting === expected) return;
    await pause(50);
  }
  throw new Error("LOCAL_EXTENSION_CONFIGURATION_NOT_CONFIRMED");
}

export async function withOriginalExtensionInstaller(client, install) {
  const guard = (await client.query("select current_database() as database,current_user as operator,(select rolsuper from pg_roles where rolname=current_user) as superuser")).rows[0];
  if (!guard?.superuser || !/^hpe_(restore_[a-z0-9]+|lab)$/.test(guard.database)
    || !["hpe_lab_operator", "postgres"].includes(guard.operator)) throw new Error("EXPLICIT_OFFLINE_INSTALLER_REQUIRED");
  await client.query("select pg_advisory_lock(hashtextextended('hpe-isolated-extension-installer',0))");
  let elevated = false;
  let adjusted = false;
  let config;
  try {
    const role = (await client.query("select rolsuper from pg_roles where rolname='postgres'")).rows[0];
    config = (await client.query("select setting,context,source,sourcefile from pg_settings where name='supautils.privileged_extensions'")).rows[0];
    if (!role || !config || config.context !== "sighup" || !["default", "configuration file"].includes(config.source)) throw new Error("LOCAL_EXTENSION_INSTALLER_NOT_VALIDATED");
    if (!role.rolsuper) { elevated = true; await client.query("alter role postgres superuser"); }
    // This image otherwise delegates even SUPERUSER extension installation to
    // supabase_admin. Disable delegation in the isolated lab, then restore it.
    adjusted = true;
    await client.query("alter system set supautils.privileged_extensions=''");
    await reloadSetting(client, "");
    return await install();
  } finally {
    try {
      if (adjusted) {
        if (config.sourcefile?.endsWith("postgresql.auto.conf")) {
          const ddl = (await client.query("select format('alter system set supautils.privileged_extensions=%L',$1) as ddl", [config.setting])).rows[0].ddl;
          await client.query(ddl);
        } else await client.query("alter system reset supautils.privileged_extensions");
        await reloadSetting(client, config.setting);
      }
    } finally {
      try {
        if (elevated) {
          await client.query("alter role postgres nosuperuser");
          if ((await client.query("select rolsuper from pg_roles where rolname='postgres'")).rows[0]?.rolsuper !== false) throw new Error("LOCAL_INSTALLER_PRIVILEGE_NOT_REVOKED");
        }
      } finally { await client.query("select pg_advisory_unlock(hashtextextended('hpe-isolated-extension-installer',0))"); }
    }
  }
}
