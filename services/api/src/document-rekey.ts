// PRESENCE-2: re-seal government ID files and bank details. Idempotent; prints counts and key IDs, never a key.
//  * Legacy (once, before migration 0152): what 0149 encrypted inside the database with pulse_priv.identity_key is
//    decrypted there a last time and sealed here with the keyring. 0152 then drops the in-database key.
//  * Rotation: data keys wrapped by an older master key are wrapped again by the active one. Files do not change.
//    Afterwards the older key may leave the keyring.
// Run with the migration login (it works as the database owner role, like pulse-migrate):
//   PULSE_DOCUMENT_KEY_FILE=<keyring> MIGRATE_DATABASE_URL=<url> node services/api/dist/document-rekey.js [--check]
// --check changes nothing: the keyring's state and active key ID, and with a database URL how many sealed values each
// master key ID holds. Root steps: docs/ops/DOCUMENT-KEYS.md.
import { Client, type ClientBase } from "pg";
import { bankContext, documentContext, DocumentKeyError, loadKeyring, rewrap, seal, type Keyring } from "./document-keys.js";

export type Rekeyed = { legacyFiles: number; legacyBank: number; rewrapped: number };

/** Every organisation's sealed values (or only `orgs`'), in the caller's transaction. The client must already act as
 *  the owner role. The command line always does every organisation; a test with its own keyring passes its own. */
export async function rekeyDocuments(c: ClientBase, ring: Keyring, orgs?: readonly string[]): Promise<Rekeyed> {
  const done: Rekeyed = { legacyFiles: 0, legacyBank: 0, rewrapped: 0 };
  const legacy = (await c.query("select to_regclass('pulse_priv.identity_key') is not null x")).rows[0].x as boolean;
  for (const { id: org } of (await c.query("select id from pulse.org where $1::uuid[] is null or id = any($1::uuid[]) order by id", [orgs ?? null])).rows as { id: string }[]) {
    await c.query("select set_config('pulse.org_id',$1,true)", [org]);
    if (legacy) {
      const files = await c.query(`select d.id,d.person_id,d.kind,public.pgp_sym_decrypt_bytea(d.file,encode(k.key,'hex')) plain
        from pulse_priv.identity_document d join pulse_priv.identity_key k on k.org_id=d.org_id where d.file is not null and d.key_id is null for update of d`);
      for (const r of files.rows) {
        const s = seal(ring, r.plain, documentContext(org, r.person_id, r.kind));
        await c.query("update pulse_priv.identity_document set file=$2,file_key=$3,key_id=$4 where id=$1", [r.id, s.data, s.dataKey, s.keyId]);
        done.legacyFiles++;
      }
      const banks = await c.query(`select o.person_id,public.pgp_sym_decrypt_bytea(o.bank,encode(k.key,'hex')) plain
        from pulse_priv.person_onboarding o join pulse_priv.identity_key k on k.org_id=o.org_id where o.bank is not null and o.bank_key_id is null for update of o`);
      for (const r of banks.rows) {
        const s = seal(ring, r.plain, bankContext(org, r.person_id));
        await c.query("update pulse_priv.person_onboarding set bank=$2,bank_key=$3,bank_key_id=$4 where person_id=$1", [r.person_id, s.data, s.dataKey, s.keyId]);
        done.legacyBank++;
      }
    }
    for (const r of (await c.query("select id,person_id,kind,key_id,file_key from pulse_priv.identity_document where file is not null and key_id<>$1 for update", [ring.active])).rows) {
      const w = rewrap(ring, r.key_id, r.file_key, documentContext(org, r.person_id, r.kind));
      await c.query("update pulse_priv.identity_document set file_key=$2,key_id=$3 where id=$1", [r.id, w.dataKey, w.keyId]);
      done.rewrapped++;
    }
    for (const r of (await c.query("select person_id,bank_key_id,bank_key from pulse_priv.person_onboarding where bank is not null and bank_key_id<>$1 for update", [ring.active])).rows) {
      const w = rewrap(ring, r.bank_key_id, r.bank_key, bankContext(org, r.person_id));
      await c.query("update pulse_priv.person_onboarding set bank_key=$2,bank_key_id=$3 where person_id=$1", [r.person_id, w.dataKey, w.keyId]);
      done.rewrapped++;
    }
  }
  return done;
}

/** How many sealed values each master key ID holds ("legacy": still under the in-database key). */
export async function sealedByKey(c: ClientBase): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { id: org } of (await c.query("select id from pulse.org order by id")).rows as { id: string }[]) {
    await c.query("select set_config('pulse.org_id',$1,true)", [org]);
    const rows = (await c.query(`select coalesce(key_id,'legacy') k,count(*)::int n from (
      select key_id from pulse_priv.identity_document where file is not null union all
      select bank_key_id from pulse_priv.person_onboarding where bank is not null) s group by 1`)).rows;
    for (const r of rows) counts[r.k] = (counts[r.k] ?? 0) + r.n;
  }
  return counts;
}

async function main() {
  const check = process.argv.includes("--check");
  const state = await loadKeyring();
  if (!state.ok) { console.error(`Document keyring unavailable (${state.reason}): ${process.env.PULSE_DOCUMENT_KEY_FILE || "/etc/pulse/document-master.key"}`); process.exitCode = 1; return; }
  console.log(`Document keyring: ${state.ring.keys.size} key(s) [${[...state.ring.keys.keys()].join(", ")}], new files sealed with "${state.ring.active}"`);
  const url = process.env.PULSE_DATABASE_URL_MIGRATE || process.env.MIGRATE_DATABASE_URL;
  if (!url) { if (!check) { console.error("No migration database URL (PULSE_DATABASE_URL_MIGRATE or MIGRATE_DATABASE_URL)"); process.exitCode = 2; } return; }
  const client = new Client({ connectionString: url, application_name: "pulse-document-rekey" });
  await client.connect();
  try {
    await client.query("begin");
    const owner = process.env.PULSE_DB_OWNER || (await client.query("select r.rolname from pg_database d join pg_roles r on r.oid=d.datdba where d.datname=current_database()")).rows[0].rolname;
    await client.query("select set_config('role',$1,true)", [owner]);
    if (check) { console.log(`Sealed values by master key ID: ${JSON.stringify(await sealedByKey(client))}`); await client.query("rollback"); return; }
    const done = await rekeyDocuments(client, state.ring);
    await client.query("commit");
    console.log(`Re-sealed ${done.legacyFiles} ID file(s) and ${done.legacyBank} bank detail(s) from the in-database key; re-wrapped ${done.rewrapped} data key(s) to "${state.ring.active}".`);
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    // A database error's text can quote values; only its code is printed.
    console.error(e instanceof DocumentKeyError ? e.message : `Re-sealing failed (${(e as { code?: string }).code ?? "error"}); nothing was changed.`);
    process.exitCode = 1;
  } finally { await client.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
