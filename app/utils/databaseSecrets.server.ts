import mysql from "mysql2/promise";
import { getSupabaseAdminClient } from "./supabase.server";

export const DEFAULT_CLUSTER_HOST = "gateway01.ap-southeast-1.prod.aws.tidbcloud.com";
export const DEFAULT_CLUSTER_PORT = 4000;
export const TIDB_CLUSTER_PREFIX = "27pffwAy1357PEU";
export const TIDB_ROOT_USER = process.env.TIDB_ROOT_USER || "27pffwAy1357PEU.root";
export const TIDB_ROOT_PASSWORD = process.env.TIDB_ROOT_PASSWORD || "9ZUa1ZFPVPv56ck5";

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

export function formatTiDBUser(rawUser: string): string {
  const clean = rawUser.replace(/[^a-zA-Z0-9_\-]/g, "");
  if (clean.startsWith(`${TIDB_CLUSTER_PREFIX}.`)) {
    return clean;
  }
  return `${TIDB_CLUSTER_PREFIX}.${clean}`;
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
  formatted_user: string;
  host: string;
  port: number;
  error?: string;
}> {
  const cleanDb = params.database_name.replace(/[^a-zA-Z0-9_\-]/g, "");
  const fullUser = formatTiDBUser(params.database_user);
  const pass = params.database_password;

  try {
    const conn = await mysql.createConnection({
      host: DEFAULT_CLUSTER_HOST,
      port: DEFAULT_CLUSTER_PORT,
      user: TIDB_ROOT_USER,
      password: TIDB_ROOT_PASSWORD,
      ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });

    // 1. Create database
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${cleanDb}\`;`);

    // 2. Create isolated client user
    await conn.query(`CREATE USER IF NOT EXISTS '${fullUser}'@'%' IDENTIFIED BY '${pass}';`);

    // 3. Grant full privileges on the created database
    await conn.query(`GRANT ALL PRIVILEGES ON \`${cleanDb}\`.* TO '${fullUser}'@'%';`);
    await conn.query("FLUSH PRIVILEGES;");

    await conn.end();

    return {
      success: true,
      formatted_user: fullUser,
      host: DEFAULT_CLUSTER_HOST,
      port: DEFAULT_CLUSTER_PORT,
    };
  } catch (err: any) {
    return {
      success: false,
      formatted_user: fullUser,
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
  const fullUser = params.database_user ? formatTiDBUser(params.database_user) : null;

  try {
    const conn = await mysql.createConnection({
      host: DEFAULT_CLUSTER_HOST,
      port: DEFAULT_CLUSTER_PORT,
      user: TIDB_ROOT_USER,
      password: TIDB_ROOT_PASSWORD,
      ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });

    await conn.query(`DROP DATABASE IF EXISTS \`${cleanDb}\`;`);

    if (fullUser) {
      try {
        await conn.query(`DROP USER IF EXISTS '${fullUser}'@'%';`);
      } catch {
        // user might not exist or already dropped
      }
    }

    await conn.query("FLUSH PRIVILEGES;");
    await conn.end();

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
  const fullUser = formatTiDBUser(username);
  try {
    const conn = await mysql.createConnection({
      host: DEFAULT_CLUSTER_HOST,
      port: DEFAULT_CLUSTER_PORT,
      user: TIDB_ROOT_USER,
      password: TIDB_ROOT_PASSWORD,
      ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });

    await conn.query(`ALTER USER '${fullUser}'@'%' IDENTIFIED BY '${newPassword}';`);
    await conn.query("FLUSH PRIVILEGES;");
    await conn.end();

    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || "Failed to update password on TiDB Cloud.",
    };
  }
}

/**
 * Tests live MySQL connection either via TiDB Cloud or ServerByte fallback
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
    const fullUser = formatTiDBUser(params.user);
    try {
      const conn = await mysql.createConnection({
        host,
        port: params.port || DEFAULT_CLUSTER_PORT,
        user: fullUser,
        password: params.pass,
        database: params.db || "sys",
        ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
      });

      const [rows]: any = await conn.query("SELECT VERSION() as v;");
      const version = Array.isArray(rows) && rows[0]?.v ? rows[0].v : "8.0.11-TiDB-Serverless";

      let tablesCount = 0;
      if (params.db) {
        try {
          const [tables]: any = await conn.query(`SHOW TABLES FROM \`${params.db}\`;`);
          tablesCount = Array.isArray(tables) ? tables.length : 0;
        } catch {
          // ignore table count error
        }
      }

      await conn.end();

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

/**
 * Executes a client SQL query safely on their provisioned database
 */
export async function executeDatabaseQuery(params: {
  database_name: string;
  sql: string;
}): Promise<{
  success: boolean;
  columns?: string[];
  rows?: any[];
  affectedRows?: number;
  executionTimeMs?: number;
  error?: string;
}> {
  const cleanDb = params.database_name.replace(/[^a-zA-Z0-9_\-]/g, "");
  const trimmedSql = params.sql.trim();

  if (!trimmedSql) {
    return { success: false, error: "SQL query cannot be empty." };
  }

  const startTime = Date.now();
  try {
    const conn = await mysql.createConnection({
      host: DEFAULT_CLUSTER_HOST,
      port: DEFAULT_CLUSTER_PORT,
      user: TIDB_ROOT_USER,
      password: TIDB_ROOT_PASSWORD,
      database: cleanDb,
      ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });

    const [result]: any = await conn.query(trimmedSql);
    await conn.end();

    const executionTimeMs = Date.now() - startTime;

    if (Array.isArray(result)) {
      const columns = result.length > 0 ? Object.keys(result[0]) : [];
      return {
        success: true,
        columns,
        rows: result.slice(0, 100), // limit preview to 100 rows for speed
        executionTimeMs,
      };
    }

    return {
      success: true,
      affectedRows: result.affectedRows,
      executionTimeMs,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || "Failed to execute SQL query on database.",
    };
  }
}
