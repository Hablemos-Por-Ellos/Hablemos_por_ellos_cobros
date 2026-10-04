import { randomUUID } from "node:crypto";
import { quoteIdentifier } from "./database-manifest.mjs";

export async function restoreSchemaPermissions(client, manifest) {
  let restored = 0;
  for (const schema of manifest.schemas) {
    const actual = await client.query(`select pg_get_userbyid(n.nspowner) as owner,
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
      pg_get_userbyid(a.grantor) as grantor,a.privilege_type as privilege,a.is_grantable as grantable
      from pg_namespace n left join lateral aclexplode(case when n.nspacl is null then acldefault('n',n.nspowner)
        when cardinality(n.nspacl)>0 then n.nspacl end) a on true
      where n.nspname=$1 order by 2,3,4,5`, [schema.name]);
    const acl = actual.rows.filter((row) => row.privilege != null)
      .map(({ grantee, grantor, privilege, grantable }) => ({ grantee, grantor, privilege, grantable }));
    const sorted = (entries) => entries.map(({ grantee, grantor, privilege, grantable }) => JSON.stringify([grantee, grantor, privilege, grantable])).sort();
    if (actual.rowCount && actual.rows.every((row) => row.owner === schema.owner)
      && JSON.stringify(sorted(acl)) === JSON.stringify(sorted(schema.acl))) continue;
    if (!actual.rowCount || actual.rows.some((row) => row.owner !== schema.owner)) throw new Error("RESTORED_SCHEMA_OWNER_MISMATCH");
    if ([...acl, ...schema.acl].some((entry) => entry.grantor !== schema.owner
      || !["USAGE", "CREATE"].includes(entry.privilege))) throw new Error("SCHEMA_ACL_REQUIRES_MANUAL_REVIEW");
    await client.query("begin");
    try {
      await client.query(`set local role ${quoteIdentifier(schema.owner)}`);
      for (const grantee of new Set([...acl, ...schema.acl].map((entry) => entry.grantee))) {
        await client.query(`revoke all on schema ${quoteIdentifier(schema.name)} from ${grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(grantee)}`);
      }
      for (const entry of schema.acl) {
        await client.query(`grant ${entry.privilege} on schema ${quoteIdentifier(schema.name)} to ${entry.grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(entry.grantee)}${entry.grantable ? " with grant option" : ""}`);
      }
      await client.query("commit");
      restored += 1;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
  return restored;
}

// pg_dump reparses CHECK expressions, which can move identical casts into array
// elements. Compare both expressions after parsing in the same isolated engine.
export async function reparseCheckDefinitions(client, manifest) {
  const dependencies = [];
  let changed = 0;
  await client.query("begin");
  try {
    await client.query("set local search_path=pg_catalog");
    for (const constraint of manifest.dependencies) {
      if (!constraint.definition.startsWith("CHECK (")) { dependencies.push(constraint); continue; }
      const name = `hpe_verify_${randomUUID().replaceAll("-", "")}`;
      await client.query(`create temporary table ${quoteIdentifier(name)} (like ${quoteIdentifier(constraint.schema)}.${quoteIdentifier(constraint.table_name)})`);
      await client.query(`alter table pg_temp.${quoteIdentifier(name)} add constraint hpe_check ${constraint.definition}`);
      const result = await client.query(`select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid=$1::regclass and conname='hpe_check'`, [`pg_temp.${quoteIdentifier(name)}`]);
      if (result.rowCount !== 1) throw new Error("CHECK_REPARSE_NOT_VERIFIED");
      const definition = result.rows[0].definition;
      if (definition !== constraint.definition) changed += 1;
      dependencies.push({ ...constraint, definition });
    }
  } finally {
    // Only temporary verification objects were created; preserve the restoration.
    await client.query("rollback");
  }
  return { manifest: { ...manifest, dependencies }, changed };
}
