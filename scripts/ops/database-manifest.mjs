export function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export const MANIFEST_METADATA_SECTIONS = ["dependencies", "extensions", "indexes", "triggers", "views", "policies", "grants",
  "columnPermissions", "sequences", "functions", "tableDefinitions", "columns", "schemas", "memberships", "financialTotals",
  "functionPermissions", "eventTriggers", "defaultPrivileges"];

function canonicalAcl(expression) {
  return `(select coalesce(jsonb_agg(jsonb_build_object('grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
    'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
    order by a.grantee::regrole::text,a.grantor::regrole::text,a.privilege_type,a.is_grantable),'[]'::jsonb)
    from aclexplode(case when cardinality(${expression})>0 then ${expression} end) a)`;
}

export async function databaseManifest(client, { original = null } = {}) {
  await client.query("set local search_path=pg_catalog");
  const inventory = original?.tables ?? (await client.query(`
    select n.nspname as schema, c.relname as name,
      array(select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped order by a.attnum) as columns,
      array(select a.attname::text from pg_index i cross join lateral unnest(i.indkey) with ordinality key(attnum, ord)
        join pg_attribute a on a.attrelid=i.indrelid and a.attnum=key.attnum
        where i.indrelid=c.oid and i.indisprimary order by key.ord) as keys
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind='r' and n.nspname !~ '^pg_' and n.nspname<>'information_schema'
    order by n.nspname,c.relname`)).rows;
  const tables = [];
  for (const table of inventory) {
    const qualified = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    const projection = table.columns.map(quoteIdentifier).join(",");
    const rowKey = table.keys.length
      ? `jsonb_build_array(${table.keys.map((key) => `projected.${quoteIdentifier(key)}`).join(",")})::text`
      : "null::text";
    const receipt = table.schema === "public" && table.name === "webhook_events" && table.columns.includes("raw")
      ? "coalesce(projected.raw->>'receipt_version'='1',false)" : "false";
    const result = await client.query(`select ${rowKey} as key,
      ${receipt} as receipt,
      encode(sha256(convert_to(to_jsonb(projected)::text,'UTF8')),'hex') as hash
      from (select ${projection} from ${qualified}) projected order by key,hash`);
    tables.push({ ...table, rows: result.rows, count: result.rowCount });
  }
  const dependencies = (await client.query(`select n.nspname as schema,c.relname as table_name,
    con.conname as name,pg_get_constraintdef(con.oid) as definition
    from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname !~ '^pg_' order by 1,2,3`)).rows;
  const extensions = (await client.query(`select e.extname,e.extversion,pg_get_userbyid(e.extowner) as owner,n.nspname as schema
    from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by e.extname`)).rows;
  const roles = (await client.query(`select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls
    from pg_roles where rolname !~ '^pg_' order by rolname`)).rows;
  const storage = tables.filter((table) => table.schema === "storage").map(({ name, count }) => ({ name, count }));
  const indexes = (await client.query("select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname !~ '^pg_' order by 1,2,3")).rows;
  const triggers = (await client.query(`select n.nspname as schema,c.relname as table_name,t.tgname as name,pg_get_triggerdef(t.oid) as definition
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname !~ '^pg_' order by 1,2,3`)).rows;
  const views = (await client.query("select schemaname,viewname,definition from pg_views where schemaname !~ '^pg_' and schemaname<>'information_schema' order by 1,2")).rows;
  const policies = (await client.query("select * from pg_policies order by schemaname,tablename,policyname")).rows;
  const grants = (await client.query(`select case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
    n.nspname as table_schema,c.relname as table_name,a.privilege_type,a.is_grantable,pg_get_userbyid(a.grantor) as grantor
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    cross join lateral aclexplode(case when c.relacl is null then
      acldefault(case when c.relkind='S' then 'S'::"char" else 'r'::"char" end,c.relowner)
      when cardinality(c.relacl)>0 then c.relacl end) a
    where c.relkind in ('r','p','v','m','S') and n.nspname !~ '^pg_' and n.nspname<>'information_schema' order by 1,2,3,4,5,6`)).rows;
  const columnPermissions = (await client.query(`select n.nspname as schema,c.relname as table_name,a.attname as name,
    ${canonicalAcl("coalesce(a.attacl,'{}'::aclitem[])")} as acl
    from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    where a.attnum>0 and not a.attisdropped and c.relkind in ('r','p','v','m')
      and n.nspname !~ '^pg_' and n.nspname<>'information_schema' order by 1,2,a.attnum`)).rows;
  const sequences = (await client.query("select * from pg_sequences where schemaname !~ '^pg_' order by schemaname,sequencename")).rows;
  const functions = (await client.query(`select n.nspname as schema,p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,
    pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and p.prokind in ('f','p')
      and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e') order by 1,2,3`)).rows;
  const tableDefinitions = (await client.query(`select n.nspname as schema,c.relname as name,
    pg_get_userbyid(c.relowner) as owner,c.relrowsecurity as rls,c.relforcerowsecurity as forced_rls,
    ${canonicalAcl("coalesce(c.relacl,acldefault(case when c.relkind='S' then 'S'::\"char\" else 'r'::\"char\" end,c.relowner))")} as acl from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind in ('r','p','v','m','S') and n.nspname !~ '^pg_' and n.nspname<>'information_schema'
    order by 1,2`)).rows;
  const columns = (await client.query(`select n.nspname as schema,c.relname as table_name,a.attname as name,
    format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as not_null,a.attidentity as identity,
    pg_get_expr(d.adbin,d.adrelid) as default_expression
    from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attnum>0 and not a.attisdropped and c.relkind in ('r','p') and n.nspname !~ '^pg_' and n.nspname<>'information_schema'
      and not exists(select 1 from pg_depend dep where dep.classid='pg_class'::regclass and dep.objid=c.oid and dep.deptype='e') order by 1,2,a.attnum`)).rows;
  const schemas = (await client.query(`select nspname as name,pg_get_userbyid(nspowner) as owner,${canonicalAcl("coalesce(n.nspacl,acldefault('n',n.nspowner))")} as acl
    from pg_namespace n where nspname !~ '^pg_' and nspname<>'information_schema'
    order by 1`)).rows;
  const memberships = (await client.query(`select pg_get_userbyid(roleid) as role,pg_get_userbyid(member) as member,admin_option,
    coalesce((to_jsonb(m)->>'inherit_option')::boolean,true) as inherit_option,
    coalesce((to_jsonb(m)->>'set_option')::boolean,true) as set_option
    from pg_auth_members m order by 1,2`)).rows;
  const functionPermissions = (await client.query(`select n.nspname as schema,p.proname as name,
    pg_get_function_identity_arguments(p.oid) as arguments,pg_get_userbyid(p.proowner) as owner,${canonicalAcl("coalesce(p.proacl,acldefault('f',p.proowner))")} as acl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and p.prokind in ('f','p')
    order by 1,2,3`)).rows;
  const eventTriggers = (await client.query(`select t.evtname as name,t.evtevent as event,t.evtenabled as enabled,
    t.evttags::text[] as tags,pg_get_userbyid(t.evtowner) as owner,n.nspname as function_schema,p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as function_arguments,pg_get_userbyid(p.proowner) as function_owner,${canonicalAcl("coalesce(p.proacl,acldefault('f',p.proowner))")} as function_acl
    from pg_event_trigger t join pg_proc p on p.oid=t.evtfoid join pg_namespace n on n.oid=p.pronamespace order by 1`)).rows;
  const defaultPrivileges = (await client.query(`select pg_get_userbyid(d.defaclrole) as owner,
    coalesce(n.nspname,'') as schema,d.defaclobjtype as object_type,${canonicalAcl("d.defaclacl")} as acl
    from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace order by 1,2,3`)).rows;
  const financialTotals = [];
  for (const name of ["subscriptions", "payments"]) {
    const table = inventory.find((entry) => entry.schema === "public" && entry.name === name);
    if (table?.columns.includes("amount") && table.columns.includes("status")) {
      const totals = (await client.query(`select status,count(*)::text as count,coalesce(sum(amount),0)::text as total
        from public.${quoteIdentifier(name)} group by status order by status`)).rows;
      financialTotals.push({ table: name, totals });
    }
  }
  return { format: 5, createdAt: new Date().toISOString(), tables, dependencies, extensions, roles, storage,
    indexes, triggers, views, policies, grants, columnPermissions, sequences, functions, tableDefinitions, columns, schemas, memberships, financialTotals, functionPermissions, eventTriggers, defaultPrivileges };
}

export function compareManifests(expected, actual, { allowAdditionalReceipts = false, compareMetadata = false, compareInventory = false,
  offlineNoLoginRoles = [], localOperator = null } = {}) {
  const differences = [];
  if (compareInventory) {
    for (const table of actual.tables) {
      if (!expected.tables.some((before) => before.schema === table.schema && before.name === table.name)) {
        differences.push({ table: `${table.schema}.${table.name}`, kind: "unexpected_table" });
      }
    }
  }
  for (const before of expected.tables) {
    const after = actual.tables.find((table) => table.schema === before.schema && table.name === before.name);
    if (!after) { differences.push({ table: `${before.schema}.${before.name}`, kind: "missing_table" }); continue; }
    if (compareInventory && (JSON.stringify(before.columns) !== JSON.stringify(after.columns)
      || JSON.stringify(before.keys) !== JSON.stringify(after.keys))) {
      differences.push({ table: `${before.schema}.${before.name}`, kind: "table_definition_difference" });
    }
    const remaining = new Map();
    const receiptRows = new Set(after.rows.filter((row) => row.receipt === true).map((row) => `${row.key ?? ""}:${row.hash}`));
    for (const row of after.rows) {
      const key = `${row.key ?? ""}:${row.hash}`;
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    let missing = 0;
    for (const row of before.rows) {
      const key = `${row.key ?? ""}:${row.hash}`;
      if ((remaining.get(key) ?? 0) === 0) missing += 1;
      else remaining.set(key, remaining.get(key) - 1);
    }
    const added = [...remaining.values()].reduce((sum, count) => sum + count, 0);
    const allowed = allowAdditionalReceipts && before.schema === "public" && before.name === "webhook_events"
      && [...remaining].every(([key, count]) => !count || receiptRows.has(key));
    if (missing || (added && !allowed)) differences.push({ table: `${before.schema}.${before.name}`, kind: "row_difference", missing, added });
  }
  if (compareMetadata) {
    for (const section of MANIFEST_METADATA_SECTIONS) {
      if (JSON.stringify(expected[section]) !== JSON.stringify(actual[section])) differences.push({ section, kind: "metadata_difference" });
    }
    const expectedRoles = (expected.roles ?? []).map((role) => offlineNoLoginRoles.includes(role.rolname) ? { ...role, rolcanlogin: false } : role);
    if (localOperator) {
      if (localOperator.rolname !== "hpe_lab_operator" || !localOperator.rolsuper || !localOperator.rolcanlogin
        || expectedRoles.some((role) => role.rolname === localOperator.rolname)) throw new Error("INVALID_OFFLINE_OPERATOR_OVERRIDE");
      expectedRoles.push(localOperator);
    }
    const ordered = (roles) => [...roles].sort((a, b) => a.rolname.localeCompare(b.rolname, "en"));
    if (JSON.stringify(ordered(expectedRoles)) !== JSON.stringify(ordered(actual.roles ?? []))) differences.push({ section: "roles", kind: "metadata_difference" });
  }
  return differences;
}
