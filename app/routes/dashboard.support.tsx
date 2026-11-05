import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import Button from "~/components/Button";
import TextField from "~/components/TextField";
import { requireUserProfile } from "~/utils/auth.server";
import { formatDate } from "~/utils/formatDate";
import { getSupabaseAdminClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [{ title: "Support Helpdesk | DDL Group Hosting Panel" }];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const supabaseAdmin = getSupabaseAdminClient();

  let query = supabaseAdmin
    .from("support_tickets")
    .select("*, hosting_projects(name)")
    .order("created_at", { ascending: false });

  if (profile.role === "customer") {
    query = query.eq("customer_id", profile.id);
  }

  const { data: tickets } = await query;

  return Response.json({ tickets: tickets || [], profile });
}

export async function action({ request }: ActionFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const supabaseAdmin = getSupabaseAdminClient();

  if (intent === "create_ticket") {
    const subject = formData.get("subject");
    const message = formData.get("message");
    const priority = formData.get("priority") || "medium";

    if (typeof subject !== "string" || !subject.trim() || typeof message !== "string" || !message.trim()) {
      return Response.json({ error: "Subject and message details are required." }, { status: 400 });
    }

    const ticketNumber = `TICK-${Math.floor(100000 + Math.random() * 900000)}`;

    const { data: ticket, error: ticketError } = await supabaseAdmin
      .from("support_tickets")
      .insert({
        customer_id: profile.id,
        ticket_number: ticketNumber,
        subject: subject.trim(),
        priority: priority as string,
        status: "open",
      })
      .select()
      .single();

    if (ticketError) {
      return Response.json({ error: ticketError.message }, { status: 500 });
    }

    if (ticket) {
      await supabaseAdmin.from("support_messages").insert({
        ticket_id: ticket.id,
        sender_id: profile.id,
        message: message.trim(),
      });
    }

    return Response.json({ success: `Support ticket ${ticketNumber} opened successfully!` });
  }

  return Response.json({ error: "Invalid intent." }, { status: 400 });
}

export default function Support() {
  const { tickets } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; success?: string }>();
  const navigation = useNavigation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const isSubmitting = navigation.state === "submitting";

  const priorityColors: Record<string, string> = {
    low: "bg-slate-100 text-slate-700",
    medium: "bg-blue-100 text-blue-800",
    high: "bg-amber-100 text-amber-800",
    urgent: "bg-rose-100 text-rose-800",
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Technical Support Helpdesk
          </h1>
          <p className="text-sm text-slate-500">
            Submit inquiry tickets or get rapid assistance from our 24/7 technical team
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="inline-flex items-center justify-center px-4 py-2.5 text-sm font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 shadow-sm transition"
        >
          + Open Support Ticket
        </button>
      </div>

      {actionData?.error && (
        <div className="p-4 text-sm font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-xl">
          {actionData.error}
        </div>
      )}

      {actionData?.success && (
        <div className="p-4 text-sm font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl">
          {actionData.success}
        </div>
      )}

      <div className="overflow-hidden bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-slate-50 text-slate-400 font-semibold text-xs uppercase border-b border-slate-200">
              <tr>
                <th className="py-3.5 px-4">Ticket #</th>
                <th className="py-3.5 px-4">Subject</th>
                <th className="py-3.5 px-4">Priority</th>
                <th className="py-3.5 px-4">Status</th>
                <th className="py-3.5 px-4">Opened Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tickets.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">
                    No active support tickets found.
                  </td>
                </tr>
              ) : (
                tickets.map((t: any) => (
                  <tr key={t.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-4 font-mono font-semibold text-xs text-slate-900">
                      {t.ticket_number}
                    </td>
                    <td className="py-3.5 px-4 font-semibold text-slate-800">
                      {t.subject}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-block px-2 py-0.5 text-xs font-semibold rounded-md ${priorityColors[t.priority] || "bg-slate-100"}`}>
                        {t.priority}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="inline-block px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800">
                        {t.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-400">
                      {formatDate(t.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-lg p-6 bg-white rounded-2xl shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
              <h2 className="text-lg font-bold text-slate-900">Open New Support Ticket</h2>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 font-bold"
              >
                ✕
              </button>
            </div>

            <Form
              method="POST"
              onSubmit={() => setIsModalOpen(false)}
              className="space-y-4"
            >
              <input type="hidden" name="intent" value="create_ticket" />

              <TextField
                id="subject"
                name="subject"
                label="Ticket Subject"
                type="text"
                required
                placeholder="Database connection issue / DNS question"
              />

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Priority Level
                </label>
                <select
                  name="priority"
                  defaultValue="medium"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  <option value="low">Low - General Inquiry</option>
                  <option value="medium">Medium - Configuration Request</option>
                  <option value="high">High - Degraded Service</option>
                  <option value="urgent">Urgent - Website Down</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Detailed Description
                </label>
                <textarea
                  name="message"
                  required
                  rows={4}
                  placeholder="Please describe the issue or inquiry in detail..."
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                ></textarea>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => setIsModalOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={isSubmitting}>
                  Submit Ticket
                </Button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </div>
  );
}
