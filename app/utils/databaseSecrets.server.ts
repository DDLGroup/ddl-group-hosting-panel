import { connect } from "@tidbcloud/serverless";
import { getSupabaseAdminClient } from "./supabase.server";

export const DEFAULT_CLUSTER_HOST = "gateway01.ap-southeast-1.prod.aws.tidbcloud.com";
export const DEFAULT_CLUSTER_PORT = 4000;

export const TIDB_ROOT_USER = process.env.TIDB_ROOT_USER || "27pffWay1357PEU.root";
export const TIDB_ROOT_PASSWORD = process.env.TIDB_ROOT_PASSWORD || "DfT1c4AMwJe0Vplb";
export const TIDB_DATABASE_URL =
  process.env.TIDB_DATABASE_URL ||
  `mysql://${TIDB_ROOT_USER}:${TIDB_ROOT_PASSWORD}@${DEFAULT_CLUSTER_HOST}/sys`;

export interface DatabaseSecretMeta {
  database_id: string;
  database_password: string;
  database_host?: string;
  database_port?: number;
  updated_at: string;
}

export function generateSecurePassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*";
  let pass = "Ddl_";
  for (let i = 0; i < 12; i++) {
    pass += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pass;
}

export async function getDatabaseSecret(databaseId: string): Promise<string> {
  const details = await getDatabaseDetails(databaseId);
  return details.database_password;
}

export async function getDatabaseDetails(databaseId: string): Promise<{
  database_password: string;
  database_host: string;
  database_port: number;
}> {
  const supabaseAdmin = getSupabaseAdminClient();
  const filePath = `_system_db_meta/${databaseId}.json`;

  try {
    const { data: fileBlob, error } = await supabaseAdmin.storage
      .from("client-websites")
      .download(filePath);

    if (!error && fileBlob) {
      const text = await fileBlob.text();
      const meta = JSON.parse(text) as DatabaseSecretMeta;
      return {
        database_password: meta.database_password || generateSecurePassword(),
        database_host: meta.database_host || DEFAULT_CLUSTER_HOST,
        database_port: meta.database_port || DEFAULT_CLUSTER_PORT,
      };
    }
  } catch {
    // If download or parse fails, proceed to create fallback
  }

  // Auto-generate, persist and return default secure password
  const defaultPass = generateSecurePassword();
  await setDatabaseDetails(databaseId, {
    database_password: defaultPass,
    database_host: DEFAULT_CLUSTER_HOST,
    database_port: DEFAULT_CLUSTER_PORT,
  });

  return {
    database_password: defaultPass,
    database_host: DEFAULT_CLUSTER_HOST,
    database_port: DEFAULT_CLUSTER_PORT,
  };
}

export async function setDatabaseSecret(databaseId: string, password: string): Promise<void> {
  const current = await getDatabaseDetails(databaseId);
  await setDatabaseDetails(databaseId, {
    ...current,
    database_password: password,
  });
}

export async function setDatabaseDetails(
  databaseId: string,
  details: {
    database_password: string;
    database_host?: string;
    database_port?: number;
  }
): Promise<void> {
  const supabaseAdmin = getSupabaseAdminClient();
  const filePath = `_system_db_meta/${databaseId}.json`;
  const payload: DatabaseSecretMeta = {
    database_id: databaseId,
    database_password: details.database_password,
    database_host: details.database_host || DEFAULT_CLUSTER_HOST,
    database_port: details.database_port || DEFAULT_CLUSTER_PORT,
    updated_at: new Date().toISOString(),
  };

  await supabaseAdmin.storage
    .from("client-websites")
    .upload(filePath, Buffer.from(JSON.stringify(payload)), {
      contentType: "application/json",
      upsert: true,
    });
}

export async function deleteDatabaseSecret(databaseId: string): Promise<void> {
  const supabaseAdmin = getSupabaseAdminClient();
  const filePath = `_system_db_meta/${databaseId}.json`;
  await supabaseAdmin.storage.from("client-websites").remove([filePath]);
}

/**
 * Automatically provisions an isolated MySQL database and dedicated user on TiDB Cloud
 */
export async function provisionTiDBDatabase(params: {
  database_name: string;
  database_user: string;
  database_password: string;
}): Promise<{
  success: boolean;
  host: string;
  port: number;
  error?: string;
}> {
  const cleanDb = params.database_name.replace(/[^a-zA-Z0-9_\-]/g, "");
  const cleanUser = params.database_user.replace(/[^a-zA-Z0-9_\-]/g, "");
  const pass = params.database_password;

  try {
    const conn = connect({ url: TIDB_DATABASE_URL });

    // 1. Create database
    await conn.execute(`CREATE DATABASE IF NOT EXISTS \`${cleanDb}\`;`);

    // 2. Create isolated client user
    await conn.execute(`CREATE USER IF NOT EXISTS '${cleanUser}'@'%' IDENTIFIED BY '${pass}';`);

    // 3. Grant full privileges on the created database
    await conn.execute(`GRANT ALL PRIVILEGES ON \`${cleanDb}\`.* TO '${cleanUser}'@'%';`);

    return {
      success: true,
      host: DEFAULT_CLUSTER_HOST,
      port: DEFAULT_CLUSTER_PORT,
    };
  } catch (err: any) {
    return {
      success: false,
      host: DEFAULT_CLUSTER_HOST,
      port: DEFAULT_CLUSTER_PORT,
      error: err.message || "Failed to provision database on TiDB Cloud.",
    };
  }
}

/**
 * Drops a database and associated user on TiDB Cloud
 */
export async function dropTiDBDatabase(params: {
  database_name: string;
  database_user?: string;
}): Promise<{ success: boolean; error?: string }> {
  const cleanDb = params.database_name.replace(/[^a-zA-Z0-9_\-]/g, "");
  const cleanUser = params.database_user ? params.database_user.replace(/[^a-zA-Z0-9_\-]/g, "") : null;

  try {
    const conn = connect({ url: TIDB_DATABASE_URL });
    await conn.execute(`DROP DATABASE IF EXISTS \`${cleanDb}\`;`);

    if (cleanUser) {
      try {
        await conn.execute(`DROP USER IF EXISTS '${cleanUser}'@'%';`);
      } catch {
        // user might not exist or already dropped
      }
    }

    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || "Failed to drop database on TiDB Cloud.",
    };
  }
}

/**
 * Updates a database user's password on TiDB Cloud
 */
export async function updateTiDBUserPassword(
  username: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const cleanUser = username.replace(/[^a-zA-Z0-9_\-]/g, "");
  try {
    const conn = connect({ url: TIDB_DATABASE_URL });
    await conn.execute(`ALTER USER '${cleanUser}'@'%' IDENTIFIED BY '${newPassword}';`);
    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || "Failed to update password on TiDB Cloud.",
    };
  }
}

/**
 * Tests live MySQL connection either via TiDB Cloud Serverless or ServerByte fallback
 */
export async function testMySQLConnection(params: {
  host?: string;
  user: string;
  pass: string;
  db?: string;
  port?: number;
}): Promise<{
  success: boolean;
  version?: string;
  tables_count?: number;
  host_used?: string;
  error?: string;
}> {
  const host = params.host || DEFAULT_CLUSTER_HOST;
  const isTiDB = host.includes("tidbcloud.com");

  if (isTiDB) {
    try {
      const url = `mysql://${params.user}:${params.pass}@${host}/${params.db || "sys"}`;
      const conn = connect({ url });
      const versionResult: any = await conn.execute("SELECT VERSION() as v;");
      const version = Array.isArray(versionResult) && versionResult[0]?.v ? versionResult[0].v : "TiDB Cloud Serverless";

      let tablesCount = 0;
      if (params.db) {
        try {
          const tablesResult: any = await conn.execute(`SHOW TABLES FROM \`${params.db}\`;`);
          tablesCount = Array.isArray(tablesResult) ? tablesResult.length : 0;
        } catch {
          // ignore table count error
        }
      }

      return {
        success: true,
        version,
        tables_count: tablesCount,
        host_used: host,
      };
    } catch (err: any) {
      return {
        success: false,
        host_used: host,
        error: err.message || "Failed to connect to TiDB Cloud cluster.",
      };
    }
  }

  // Fallback: test via ServerByte bridge for internal cluster hosts
  const bridgeUrl = "https://panel.ddlg.in/ddl-agent.php";
  const token = "DDL_SECRET_KEY_999RS_SECURE_TOKEN_2026";

  const form = new FormData();
  form.append("action", "test_mysql");
  form.append("host", host);
  form.append("user", params.user);
  form.append("pass", params.pass);
  form.append("db", params.db || "");
  form.append("port", String(params.port || DEFAULT_CLUSTER_PORT));

  try {
    const res = await fetch(bridgeUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    if (!res.ok) {
      return {
        success: false,
        error: `Server node returned HTTP ${res.status}: ${res.statusText}`,
      };
    }

    const data = (await res.json()) as any;
    return {
      success: !!data.success,
      version: data.version,
      tables_count: data.tables_count,
      host_used: data.host_used,
      error: data.error,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || "Failed to communicate with database server.",
    };
  }
}
