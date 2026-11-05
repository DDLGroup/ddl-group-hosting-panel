-- ==============================================================================
-- DDL GROUP HOSTING PANEL: Hosting Infrastructure, Projects, Domains & Backups
-- Migration: 20261106000002_create_hosting_domain_schema.sql
-- ==============================================================================

-- 1. Server Nodes (Isolated execution backend nodes)
CREATE TABLE IF NOT EXISTS public.server_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    hostname TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'offline')),
    region TEXT NOT NULL DEFAULT 'ap-south-1',
    capabilities JSONB NOT NULL DEFAULT '["php", "python", "mysql", "nginx"]'::jsonb,
    current_load INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Hosting Plans
CREATE TABLE IF NOT EXISTS public.hosting_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    price_cents INT NOT NULL DEFAULT 0,
    billing_period TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_period IN ('monthly', 'yearly')),
    max_websites INT NOT NULL DEFAULT 1,
    max_storage_mb INT NOT NULL DEFAULT 1024,
    max_bandwidth_mb INT NOT NULL DEFAULT 10240,
    max_databases INT NOT NULL DEFAULT 1,
    supported_runtimes JSONB NOT NULL DEFAULT '["static", "php", "python"]'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Customer Hosting Accounts (Tenant Subscription / Grouping)
CREATE TABLE IF NOT EXISTS public.hosting_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES public.hosting_plans(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'cancelled')),
    storage_used_mb INT NOT NULL DEFAULT 0,
    bandwidth_used_mb INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Hosting Projects (Individual Websites)
CREATE TABLE IF NOT EXISTS public.hosting_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hosting_account_id UUID NOT NULL REFERENCES public.hosting_accounts(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    server_node_id UUID REFERENCES public.server_nodes(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    subdomain TEXT NOT NULL UNIQUE,
    runtime TEXT NOT NULL DEFAULT 'static' CHECK (runtime IN ('static', 'php', 'python')),
    runtime_version TEXT NOT NULL DEFAULT '8.2',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deploying', 'suspended', 'error')),
    document_root TEXT NOT NULL DEFAULT '/public',
    env_vars JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Custom Domains & Subdomains
CREATE TABLE IF NOT EXISTS public.domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.hosting_projects(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    domain_name TEXT NOT NULL UNIQUE,
    ssl_status TEXT NOT NULL DEFAULT 'pending' CHECK (ssl_status IN ('pending', 'active', 'failed', 'expired')),
    ssl_issuer TEXT,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    verification_token TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. MySQL Databases
CREATE TABLE IF NOT EXISTS public.databases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES public.hosting_projects(id) ON DELETE SET NULL,
    customer_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    server_node_id UUID REFERENCES public.server_nodes(id) ON DELETE SET NULL,
    database_name TEXT NOT NULL UNIQUE,
    database_user TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Deployments (Deployment History & Rollback)
CREATE TABLE IF NOT EXISTS public.deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.hosting_projects(id) ON DELETE CASCADE,
    version_number INT NOT NULL DEFAULT 1,
    runtime TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'zip_upload' CHECK (source_type IN ('zip_upload', 'git', 'manual')),
    archive_url TEXT,
    commit_message TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'building', 'deployed', 'failed', 'cancelled')),
    logs TEXT,
    deployed_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Backups & Snapshots
CREATE TABLE IF NOT EXISTS public.backups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.hosting_projects(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    backup_name TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL DEFAULT 0,
    storage_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('creating', 'completed', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS on all hosting tables
ALTER TABLE public.server_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hosting_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hosting_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hosting_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.databases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backups ENABLE ROW LEVEL SECURITY;

-- Server nodes & Plans viewable by all authenticated users
CREATE POLICY "Server nodes viewable by authenticated" ON public.server_nodes FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "Hosting plans viewable by authenticated" ON public.hosting_plans FOR SELECT TO authenticated USING (TRUE);

-- Tenant isolation: Customers only see their own records, Staff/Admins see all
CREATE POLICY "Customer view own hosting accounts" ON public.hosting_accounts FOR SELECT TO authenticated
    USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff'));

CREATE POLICY "Customer view own projects" ON public.hosting_projects FOR ALL TO authenticated
    USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff'));

CREATE POLICY "Customer view own domains" ON public.domains FOR ALL TO authenticated
    USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff'));

CREATE POLICY "Customer view own databases" ON public.databases FOR ALL TO authenticated
    USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff'));

CREATE POLICY "Customer view own deployments" ON public.deployments FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.hosting_projects
            WHERE id = project_id AND (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff'))
        )
    );

CREATE POLICY "Customer view own backups" ON public.backups FOR ALL TO authenticated
    USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff'));

-- Notify PostgREST
NOTIFY pgrst, 'reload schema';
