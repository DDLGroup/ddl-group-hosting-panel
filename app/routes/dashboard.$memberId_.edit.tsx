
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import Button from "~/components/Button";
import { GlobalErrorBoundary } from "~/components/GlobalErrorBoundary";
import TextField from "~/components/TextField";
import { getSession } from "~/session.server";
import { getSupabaseClient } from "~/utils/getSupabaseClient";

export const meta: MetaFunction = () => [
  {
    title: "Edit Member | DDL Group Hosting Panel",
  },
];

function isValidMemberId(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await getSession(request.headers.get("Cookie"));
  const accessToken = session.get("__session");

  if (!accessToken || typeof accessToken !== "string") {
    throw redirect("/login");
  }

  const memberId = params.memberId;

  if (!memberId || !isValidMemberId(memberId)) {
    throw new Response("Invalid member ID.", { status: 400 });
  }

  const supabase = getSupabaseClient(accessToken);

  const { data: member, error } = await supabase
    .from("members")
    .select("id, name, email, location, avatar_url")
    .eq("id", memberId)
    .maybeSingle();

  if (error) {
    console.error("Member fetch failed:", error.message);
    throw new Response("Unable to load member.", { status: 500 });
  }

  if (!member) {
    throw new Response("Member not found or access denied.", {
      status: 404,
    });
  }

  return Response.json({ member });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const session = await getSession(request.headers.get("Cookie"));
  const accessToken = session.get("__session");

  if (!accessToken || typeof accessToken !== "string") {
    throw redirect("/login");
  }

  const memberId = params.memberId;

  if (!memberId || !isValidMemberId(memberId)) {
    throw new Response("Invalid member ID.", { status: 400 });
  }

  const formData = await request.formData();

  const name = formData.get("name");
  const email = formData.get("email");
  const location = formData.get("location");
  const avatarUrl = formData.get("avatar_url");

  if (
    typeof name !== "string" ||
    typeof email !== "string" ||
    typeof location !== "string" ||
    typeof avatarUrl !== "string"
  ) {
    return Response.json(
      { error: "Invalid form submission." },
      { status: 400 }
    );
  }

  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  const cleanLocation = location.trim();
  const cleanAvatarUrl = avatarUrl.trim();

  if (!cleanName || !cleanEmail || !cleanLocation) {
    return Response.json(
      { error: "Name, email and location are required." },
      { status: 400 }
    );
  }

  if (
    cleanName.length > 150 ||
    cleanEmail.length > 254 ||
    cleanLocation.length > 150
  ) {
    return Response.json(
      { error: "One or more fields exceed the allowed length." },
      { status: 400 }
    );
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return Response.json(
      { error: "Please enter a valid email address." },
      { status: 400 }
    );
  }

  if (cleanAvatarUrl) {
    try {
      const url = new URL(cleanAvatarUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Invalid URL");
      }
    } catch {
      return Response.json(
        { error: "Please enter a valid avatar URL." },
        { status: 400 }
      );
    }
  }

  const supabase = getSupabaseClient(accessToken);

  const { data: existingMember, error: checkError } = await supabase
    .from("members")
    .select("id")
    .eq("email", cleanEmail)
    .neq("id", memberId)
    .maybeSingle();

  if (checkError) {
    console.error("Email check failed:", checkError.message);
    throw new Response("Unable to verify email address.", { status: 500 });
  }

  if (existingMember) {
    return Response.json(
      { error: "Another member already uses this email address." },
      { status: 400 }
    );
  }

  const { data: updatedMember, error: updateError } = await supabase
    .from("members")
    .update({
      name: cleanName,
      email: cleanEmail,
      location: cleanLocation,
      avatar_url: cleanAvatarUrl || null,
    })
    .eq("id", memberId)
    .select("id")
    .maybeSingle();

  if (updateError) {
    console.error("Member update failed:", updateError.message);
    throw new Response("Unable to update member.", { status: 500 });
  }

  if (!updatedMember) {
    throw new Response("Member not found or access denied.", {
      status: 404,
    });
  }

  return redirect(`/dashboard/${memberId}`);
}

export default function EditMember() {
  const { member } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <>
      <div className="flex flex-col gap-2 mb-8">
        <h1 className="text-2xl font-semibold text-slate-900 lg:text-3xl">
          Edit Member
        </h1>

        <Link to="/dashboard" className="text-sm hover:underline">
          &larr; Back to member list
        </Link>
      </div>

      <div className="w-full px-8 py-10 bg-white shadow-md rounded-xl lg:px-10 lg:py-12">
        <Form method="POST">
          {actionData?.error && (
            <p className="p-3 mb-4 text-sm rounded-md bg-rose-50 text-rose-700">
              {actionData.error}
            </p>
          )}

          <fieldset
            className="w-full space-y-4 lg:space-y-6 disabled:opacity-70"
            disabled={isSubmitting}
          >
            <TextField
              id="name"
              name="name"
              type="text"
              label="Name"
              required
              defaultValue={member.name}
            />

            <TextField
              id="email"
              name="email"
              type="email"
              label="Email"
              required
              defaultValue={member.email}
            />

            <TextField
              id="location"
              name="location"
              type="text"
              label="Location"
              required
              defaultValue={member.location}
            />

            <TextField
              id="avatar_url"
              name="avatar_url"
              type="url"
              label="Avatar URL"
              defaultValue={member.avatar_url ?? ""}
            />

            <div className="flex items-center justify-center w-full gap-4 md:justify-end">
              <Button to="/dashboard" variant="outlined">
                Cancel
              </Button>

              <Button type="submit" loading={isSubmitting}>
                Save Changes
              </Button>
            </div>
          </fieldset>
        </Form>
      </div>
    </>
  );
}

export function ErrorBoundary() {
  return <GlobalErrorBoundary />;
}
