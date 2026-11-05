/**
 * Netlify API helper for fully automated custom domain & SSL management.
 * When a client or admin connects a domain in DDL Group Hosting Panel,
 * this automatically registers the domain with Netlify's edge router and
 * provisions SSL certificates, so clients NEVER have to touch Netlify.
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
    // 1. Fetch current site configuration
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

    const siteData = (await getRes.json()) as { custom_domain?: string | null; domain_aliases?: string[] };
    const currentPrimary = siteData.custom_domain;
    const currentAliases: string[] = siteData.domain_aliases || [];

    if (currentPrimary === domain || currentAliases.includes(domain)) {
      return { success: true, message: "Domain already registered on Netlify." };
    }

    let patchPayload: { custom_domain?: string; domain_aliases?: string[] } = {};

    if (!currentPrimary) {
      patchPayload = {
        custom_domain: "panel.ddlg.in",
        domain_aliases: [...currentAliases, domain],
      };
    } else {
      patchPayload = {
        domain_aliases: [...currentAliases, domain],
      };
    }

    // 2. Patch site with updated domain configuration
    const patchRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patchPayload),
    });

    if (!patchRes.ok) {
      const patchErr = await patchRes.text();
      console.error("[Netlify API] Failed to update domain:", patchErr);
      return { success: false, message: `Netlify patch failed: ${patchErr}` };
    }

    // 3. Trigger automated SSL certificate provisioning
    try {
      await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/ssl`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (sslErr) {
      console.warn("[Netlify API] SSL trigger note:", sslErr);
    }

    console.log(`[Netlify API] Successfully added domain: ${domain}`);
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

    const siteData = (await getRes.json()) as { custom_domain?: string | null; domain_aliases?: string[] };
    const currentPrimary = siteData.custom_domain;
    const currentAliases: string[] = siteData.domain_aliases || [];

    const updatedAliases = currentAliases.filter((alias) => alias !== domain);

    let patchPayload: { custom_domain?: string | null; domain_aliases?: string[] } = {};

    if (currentPrimary === domain) {
      if (updatedAliases.length > 0) {
        patchPayload = {
          custom_domain: updatedAliases[0],
          domain_aliases: updatedAliases.slice(1),
        };
      } else {
        patchPayload = {
          custom_domain: null,
          domain_aliases: [],
        };
      }
    } else {
      patchPayload = {
        domain_aliases: updatedAliases,
      };
    }

    const patchRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patchPayload),
    });

    if (!patchRes.ok) {
      return { success: false, message: "Failed to update domain on Netlify." };
    }

    console.log(`[Netlify API] Successfully removed domain: ${domain}`);
    return { success: true };
  } catch (err: any) {
    console.error("[Netlify API] Exception while removing domain alias:", err);
    return { success: false, message: err?.message || "Unknown error" };
  }
}
