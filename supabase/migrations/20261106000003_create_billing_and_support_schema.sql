-- ==============================================================================
-- DDL GROUP HOSTING PANEL: Invoices, Billing, Payments & Support Tickets
-- Migration: 20261106000003_create_billing_and_support_schema.sql
-- ==============================================================================

-- 1. Invoices
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

-- 2. Payments
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

-- 3. Support Tickets
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

-- 4. Support Messages (Ticket Thread)
CREATE TABLE IF NOT EXISTS public.support_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    is_internal_note BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

-- Billing policies: Customer views own, Super Admin & Staff Admin view all
CREATE POLICY "Customer view own invoices" ON public.invoices FOR SELECT TO authenticated
    USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin'));

CREATE POLICY "Customer view own payments" ON public.payments FOR SELECT TO authenticated
    USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin'));

-- Support ticket policies: Customer views and creates own, Support/Staff/Super Admin manage
CREATE POLICY "Customer view and manage own tickets" ON public.support_tickets FOR ALL TO authenticated
    USING (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'support_staff', 'technical_staff'));

CREATE POLICY "Support message access" ON public.support_messages FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.support_tickets
            WHERE id = ticket_id AND (customer_id = auth.uid() OR public.current_user_role() IN ('super_admin', 'staff_admin', 'support_staff', 'technical_staff'))
        )
    );

NOTIFY pgrst, 'reload schema';
