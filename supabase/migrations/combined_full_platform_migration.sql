-- ==============================================================================
-- DDL GROUP HOSTING PANEL: Complete Platform Schema & Security Policies
-- Combined Migration Script
-- Execute this script in Supabase Dashboard -> SQL Editor -> New Query
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. CORE IDENTITY, ROLES & SUPER ADMIN SAFEGUARDS
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.user_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    status TEXT NOT NULL DEFAULT 'active',
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.user_profiles
    DROP CONSTRAINT IF EXISTS check_user_profile_role;

ALTER TABLE public.user_profiles
    ADD CONSTRAINT check_user_profile_role
    CHECK (role IN ('super_admin', 'staff_admin', 'technical_staff', 'support_staff', 'customer'));

ALTER TABLE public.user_profiles
    DROP CONSTRAINT IF EXISTS check_user_profile_status;

ALTER TABLE public.user_profiles
    ADD CONSTRAINT check_user_profile_status
    CHECK (status IN ('active', 'suspended', 'pending'));

CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.staff_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    permission_key TEXT NOT NULL,
    granted_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_user_permission UNIQUE (user_id, permission_key)
);

-- Critical Safeguard Trigger: Never delete or downgrade the active Super Admin
CREATE OR REPLACE FUNCTION public.safeguard_super_admin()
RETURNS TRIGGER AS $$
DECLARE
    super_admin_count INT;
BEGIN
    IF (TG_OP = 'DELETE' AND OLD.role = 'super_admin') THEN
        SELECT COUNT(*) INTO super_admin_count FROM public.user_profiles WHERE role = 'super_admin' AND status = 'active';
        IF super_admin_count <= 1 THEN
            RAISE EXCEPTION 'CRITICAL SECURITY REJECTION: Cannot delete the only active Super Admin account.';
        END IF;
    END IF;

    IF (TG_OP = 'UPDATE' AND OLD.role = 'super_admin') THEN
        IF (NEW.role <> 'super_admin' OR NEW.status <> 'active') THEN
            SELECT COUNT(*) INTO super_admin_count FROM public.user_profiles WHERE role = 'super_admin' AND status = 'active' AND id <> OLD.id;
            IF super_admin_count < 1 THEN
                RAISE EXCEPTION 'CRITICAL SECURITY REJECTION: Cannot downgrade or deactivate the only active Super Admin account.';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_safeguard_super_admin ON public.user_profiles;

CREATE TRIGGER trg_safeguard_super_admin
    BEFORE UPDATE OR DELETE ON public.user_profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.safeguard_super_admin();

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT AS $$
    SELECT role FROM public.user_profiles WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ------------------------------------------------------------------------------
-- 2. HOSTING INFRASTRUCTURE, PROJECTS, DOMAINS & DATABASES
-- ------------------------------------------------------------------------------

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

CREATE TABLE IF NOT EXISTS public.hosting_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hosting_account_id UUID REFERENCES public.hosting_accounts(id) ON DELETE CASCADE,
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

-- ------------------------------------------------------------------------------
-- 3. BILLING, PAYMENTS & SUPPORT TICKETS
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    hosting_account_id UUID REFERENCES public.hosting_accounts(id) ON DELETE SET NULL,
    invoice_number TEXT NOT NULL UNIQUE,
    amount_cents INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid', 'void', 'overdue')),
    due_date DATE NOT NULL,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    amount_cents INT NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'card' CHECK (payment_method IN ('card', 'bank_transfer', 'upi', 'manual')),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed', 'refunded')),
    transaction_reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.support_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    project_id UUID REFERENCES public.hosting_projects(id) ON DELETE SET NULL,
    ticket_number TEXT NOT NULL UNIQUE,
    subject TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting_customer', 'resolved', 'closed')),
    assigned_to UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.support_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    is_internal_note BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY (RLS) POLICIES
-- ------------------------------------------------------------------------------

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hosting_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hosting_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hosting_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.databases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

-- user_profiles policies
DROP POLICY IF EXISTS "Users can view their own profile" ON public.user_profiles;
CREATE POLICY "Users can view their own profile" ON public.user_profiles FOR SELECT TO authenticated USING (auth.uid() = id);

DROP POLICY IF EXISTS "Staff and Admins can view all profiles" ON public.user_profiles;
CREATE POLICY "Staff and Admins can view all profiles" ON public.user_profiles FOR SELECT TO authenticated USING (public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff', 'support_staff'));

-- audit_logs & permissions policies
DROP POLICY IF EXISTS "Super Admin can view all audit logs" ON public.audit_logs;
CREATE POLICY "Super Admin can view all audit logs" ON public.audit_logs FOR SELECT TO authenticated USING (public.current_user_role() = 'super_admin');

DROP POLICY IF EXISTS "Staff can view their permissions" ON public.staff_permissions;
CREATE POLICY "Staff can view their permissions" ON public.staff_permissions FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.current_user_role() = 'super_admin');

-- Hosting & tenant isolation policies
DROP POLICY IF EXISTS "Server nodes viewable by authenticated" ON public.server_nodes;
CREATE POLICY "Server nodes viewable by authenticated" ON public.server_nodes FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS "Hosting plans viewable by authenticated" ON public.hosting_plans;
CREATE POLICY "Hosting plans viewable by authenticated" ON public.hosting_plans FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS "Customer view own hosting accounts" ON public.hosting_accounts;
CREATE POLICY "Customer view own hosting accounts" ON public.hosting_accounts FOR ALL TO authenticated USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff'));

DROP POLICY IF EXISTS "Customer view own projects" ON public.hosting_projects;
CREATE POLICY "Customer view own projects" ON public.hosting_projects FOR ALL TO authenticated USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff'));

DROP POLICY IF EXISTS "Customer view own domains" ON public.domains;
CREATE POLICY "Customer view own domains" ON public.domains FOR ALL TO authenticated USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff'));

DROP POLICY IF EXISTS "Customer view own databases" ON public.databases;
CREATE POLICY "Customer view own databases" ON public.databases FOR ALL TO authenticated USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff'));

DROP POLICY IF EXISTS "Customer view own deployments" ON public.deployments;
CREATE POLICY "Customer view own deployments" ON public.deployments FOR SELECT TO authenticated USING (
    EXISTS (
        SELECT 1 FROM public.hosting_projects
        WHERE id = project_id AND (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff'))
    )
);

DROP POLICY IF EXISTS "Customer view own backups" ON public.backups;
CREATE POLICY "Customer view own backups" ON public.backups FOR ALL TO authenticated USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff'));

DROP POLICY IF EXISTS "Customer view own invoices" ON public.invoices;
CREATE POLICY "Customer view own invoices" ON public.invoices FOR SELECT TO authenticated USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin'));

DROP POLICY IF EXISTS "Customer view own payments" ON public.payments;
CREATE POLICY "Customer view own payments" ON public.payments FOR SELECT TO authenticated USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin'));

DROP POLICY IF EXISTS "Customer view and manage own tickets" ON public.support_tickets;
CREATE POLICY "Customer view and manage own tickets" ON public.support_tickets FOR ALL TO authenticated USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'support_staff', 'technical_staff'));

DROP POLICY IF EXISTS "Support message access" ON public.support_messages;
CREATE POLICY "Support message access" ON public.support_messages FOR ALL TO authenticated USING (
    EXISTS (
        SELECT 1 FROM public.support_tickets
        WHERE id = ticket_id AND (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'support_staff', 'technical_staff'))
    )
);

-- Seed Starter Hosting Plan
INSERT INTO public.hosting_plans (name, slug, description, price_cents, billing_period, max_websites, max_storage_mb, max_bandwidth_mb, max_databases)
VALUES ('Starter Cloud', 'starter-cloud', 'High-performance hosting for small websites and blogs.', 999, 'monthly', 3, 2048, 10240, 2)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.hosting_plans (name, slug, description, price_cents, billing_period, max_websites, max_storage_mb, max_bandwidth_mb, max_databases)
VALUES ('Pro Cloud', 'pro-cloud', 'For growing applications requiring PHP, Python and MySQL.', 1999, 'monthly', 10, 10240, 51200, 5)
ON CONFLICT (slug) DO NOTHING;

-- Seed Initial Worker Node
INSERT INTO public.server_nodes (name, ip_address, hostname, region, status)
VALUES ('node-01-prod', '142.93.18.22', 'worker01.ddlgroup.host', 'ap-south-1', 'active')
ON CONFLICT DO NOTHING;

-- Reload Schema Cache
NOTIFY pgrst, 'reload schema';
