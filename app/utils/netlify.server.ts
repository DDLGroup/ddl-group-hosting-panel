/**
 * Netlify API helper for fully automated custom domain & SSL management.
 * When a client or admin connects a domain in DDL Group Hosting Panel,
 * this automatically registers the domain alias with Netlify's edge router
 * so clients NEVER have to touch Netlify.
 */

export async function addNetlifyDomainAlias(domain: string): Promise<{ success: boolean; message?: string }> {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || "ddl-group-hosting-panel.netlify.app";

  if (!token) {
    console.warn("[Netlify API] NETLIFY_AUTH_TOKEN not set. Automatic Netlify domain sync skipped.");
    return {
      success: false,
      message: "NETLIFY_AUTH_TOKEN not configured yet. Domain saved in database.",
    };
  }

  try {
    // 1. Fetch current domain aliases to prevent overwriting
    const getRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!getRes.ok) {
      const errText = await getRes.text();
      console.error("[Netlify API] Failed to fetch site:", errText);
      return { success: false, message: `Netlify API error: ${getRes.statusText}` };
    }

    const siteData = (await getRes.json()) as { domain_aliases?: string[] };
    const currentAliases: string[] = siteData.domain_aliases || [];

    if (currentAliases.includes(domain)) {
      return { success: true, message: "Domain alias already registered on Netlify." };
    }

    const updatedAliases = [...currentAliases, domain];

    // 2. Patch site with updated domain aliases
    const patchRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ domain_aliases: updatedAliases }),
    });

    if (!patchRes.ok) {
      const patchErr = await patchRes.text();
      console.error("[Netlify API] Failed to update domain aliases:", patchErr);
      return { success: false, message: `Netlify patch failed: ${patchErr}` };
    }

    console.log(`[Netlify API] Successfully added domain alias: ${domain}`);
    return { success: true };
  } catch (err: any) {
    console.error("[Netlify API] Exception while adding domain alias:", err);
    return { success: false, message: err?.message || "Unknown error" };
  }
}

export async function removeNetlifyDomainAlias(domain: string): Promise<{ success: boolean; message?: string }> {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || "ddl-group-hosting-panel.netlify.app";

  if (!token) {
    return { success: false, message: "NETLIFY_AUTH_TOKEN not configured." };
  }

  try {
    const getRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!getRes.ok) {
      return { success: false, message: "Failed to fetch site from Netlify." };
    }

    const siteData = (await getRes.json()) as { domain_aliases?: string[] };
    const currentAliases: string[] = siteData.domain_aliases || [];

    const updatedAliases = currentAliases.filter((alias) => alias !== domain);

    const patchRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ domain_aliases: updatedAliases }),
    });

    if (!patchRes.ok) {
      return { success: false, message: "Failed to update domain aliases on Netlify." };
    }

    console.log(`[Netlify API] Successfully removed domain alias: ${domain}`);
    return { success: true };
  } catch (err: any) {
    console.error("[Netlify API] Exception while removing domain alias:", err);
    return { success: false, message: err?.message || "Unknown error" };
  }
}
