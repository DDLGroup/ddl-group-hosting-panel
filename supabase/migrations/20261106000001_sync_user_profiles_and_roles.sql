-- ==============================================================================
-- DDL GROUP HOSTING PANEL: Core Identity, Roles, Security & Super Admin Safeguards
-- Migration: 20261106000001_sync_user_profiles_and_roles.sql
-- ==============================================================================

-- 1. Ensure user_profiles table structure and role check constraints
CREATE TABLE IF NOT EXISTS public.user_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    status TEXT NOT NULL DEFAULT 'active',
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Apply role check constraint
ALTER TABLE public.user_profiles
    DROP CONSTRAINT IF EXISTS check_user_profile_role;

ALTER TABLE public.user_profiles
    ADD CONSTRAINT check_user_profile_role
    CHECK (role IN ('super_admin', 'staff_admin', 'technical_staff', 'support_staff', 'customer'));

-- Apply status check constraint
ALTER TABLE public.user_profiles
    DROP CONSTRAINT IF EXISTS check_user_profile_status;

ALTER TABLE public.user_profiles
    ADD CONSTRAINT check_user_profile_status
    CHECK (status IN ('active', 'suspended', 'pending'));

-- 2. Create Audit Logs table
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Create Staff Permissions table
CREATE TABLE IF NOT EXISTS public.staff_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    permission_key TEXT NOT NULL,
    granted_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_user_permission UNIQUE (user_id, permission_key)
);

-- 4. Critical Safeguard Trigger: NEVER allow deleting or locking out the only Super Admin
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

-- 5. Helper function for RLS checks
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT AS $$
    SELECT role FROM public.user_profiles WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 6. Enable Row Level Security (RLS)
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_permissions ENABLE ROW LEVEL SECURITY;

-- 7. RLS Policies for user_profiles
DROP POLICY IF EXISTS "Users can view their own profile" ON public.user_profiles;
CREATE POLICY "Users can view their own profile"
    ON public.user_profiles FOR SELECT
    TO authenticated
    USING (auth.uid() = id);

DROP POLICY IF EXISTS "Staff and Admins can view all profiles" ON public.user_profiles;
CREATE POLICY "Staff and Admins can view all profiles"
    ON public.user_profiles FOR SELECT
    TO authenticated
    USING (public.current_user_role() IN ('super_admin', 'staff_admin', 'technical_staff', 'support_staff'));

DROP POLICY IF EXISTS "Only Super Admin and Staff Admin can update profiles" ON public.user_profiles;
CREATE POLICY "Only Super Admin and Staff Admin can update profiles"
    ON public.user_profiles FOR UPDATE
    TO authenticated
    USING (public.current_user_role() IN ('super_admin', 'staff_admin'))
    WITH CHECK (public.current_user_role() IN ('super_admin', 'staff_admin'));

-- 8. RLS Policies for audit_logs
DROP POLICY IF EXISTS "Super Admin can view all audit logs" ON public.audit_logs;
CREATE POLICY "Super Admin can view all audit logs"
    ON public.audit_logs FOR SELECT
    TO authenticated
    USING (public.current_user_role() = 'super_admin');

-- 9. RLS Policies for staff_permissions
DROP POLICY IF EXISTS "Staff can view their permissions" ON public.staff_permissions;
CREATE POLICY "Staff can view their permissions"
    ON public.staff_permissions FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id OR public.current_user_role() = 'super_admin');

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
