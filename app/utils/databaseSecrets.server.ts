import { getSupabaseAdminClient } from "./supabase.server";

export const DEFAULT_CLUSTER_HOST = "sdb-90.hosting.stackcp.net";
export const DEFAULT_CLUSTER_PORT = 3306;

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
 * Tests live MySQL connection via the ServerByte execution bridge
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
  const bridgeUrl = "https://panel.ddlg.in/ddl-agent.php";
  const token = "DDL_SECRET_KEY_999RS_SECURE_TOKEN_2026";

  const form = new FormData();
  form.append("action", "test_mysql");
  form.append("host", params.host || DEFAULT_CLUSTER_HOST);
  form.append("user", params.user);
  form.append("pass", params.pass);
  form.append("db", params.db || "");
  form.append("port", String(params.port || DEFAULT_CLUSTER_PORT));

  try {
    const res = await fetch(bridgeUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
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
      error: err.message || "Failed to communicate with ServerByte database node.",
    };
  }
}
