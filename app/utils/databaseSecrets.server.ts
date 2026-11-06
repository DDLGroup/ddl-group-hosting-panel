import { getSupabaseAdminClient } from "./supabase.server";

export interface DatabaseSecretMeta {
  database_id: string;
  database_password: string;
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
  const supabaseAdmin = getSupabaseAdminClient();
  const filePath = `_system_db_meta/${databaseId}.json`;

  try {
    const { data: fileBlob, error } = await supabaseAdmin.storage
      .from("client-websites")
      .download(filePath);

    if (!error && fileBlob) {
      const text = await fileBlob.text();
      const meta = JSON.parse(text) as DatabaseSecretMeta;
      if (meta.database_password) {
        return meta.database_password;
      }
    }
  } catch {
    // If download or parse fails, generate a fallback
  }

  // Auto-generate, persist and return default secure password
  const defaultPass = generateSecurePassword();
  await setDatabaseSecret(databaseId, defaultPass);
  return defaultPass;
}

export async function setDatabaseSecret(databaseId: string, password: string): Promise<void> {
  const supabaseAdmin = getSupabaseAdminClient();
  const filePath = `_system_db_meta/${databaseId}.json`;
  const payload: DatabaseSecretMeta = {
    database_id: databaseId,
    database_password: password,
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
