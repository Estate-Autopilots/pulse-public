import type { Pool } from "pg";

export class Installation {
  private orgId: string | null = null;

  constructor(private readonly database: Pick<Pool, "query">) {}

  async readOrg(): Promise<string | null> {
    if (this.orgId) return this.orgId;
    const result = await this.database.query<{ org_id: string | null }>("select pulse.install_org() as org_id");
    this.orgId = result.rows[0]?.org_id ?? null;
    return this.orgId;
  }
}

const installations = new WeakMap<object, Installation>();

export function installationFor(database: Pick<Pool, "query">): Installation {
  const key = database as object;
  let installation = installations.get(key);
  if (!installation) {
    installation = new Installation(database);
    installations.set(key, installation);
  }
  return installation;
}

export function assertConfiguredOrg(configured: string | undefined, installed: string | null): void {
  if (configured && (!installed || configured.toLowerCase() !== installed.toLowerCase())) {
    const reason = installed ? "does not match pulse.install.org_id" : "is set but pulse.install is empty";
    throw new Error(`PULSE_ORG_ID ${reason}; refusing to start the API.`);
  }
}
