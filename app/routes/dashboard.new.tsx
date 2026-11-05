
import type { ActionFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  Form,
  useActionData,
  useNavigation,
} from "@remix-run/react";

import Button from "~/components/Button";
import TextField from "~/components/TextField";
import { getSession } from "~/session.server";
import { getSupabaseClient } from "~/utils/getSupabaseClient";

export const meta: MetaFunction = () => {
  return [
    {
      title: "Create New Member | DDL Group Hosting Panel",
    },
  ];
};

export async function action({ request }: ActionFunctionArgs) {
  // 1. Verify authenticated session
  const session = await getSession(request.headers.get("Cookie"));
  const accessToken = session.get("__session");

  if (!accessToken || typeof accessToken !== "string") {
    throw redirect("/login");
  }

  // 2. Read and validate submitted form data
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

  if (cleanName.length > 150 || cleanEmail.length > 254 || cleanLocation.length > 150) {
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
      const parsedUrl = new URL(cleanAvatarUrl);

      if (
        !["http:", "https:"].includes(parsedUrl.protocol) ||
        !parsedUrl.hostname
      ) {
        throw new Error("Invalid URL");
      }
    } catch {
      return Response.json(
        { error: "Please enter a valid HTTP or HTTPS avatar URL." },
        { status: 400 }
      );
    }
  }

  // 3. Connect using the logged-in user's access token
  const supabase = getSupabaseClient(accessToken);

  // 4. Check whether email already exists
  const { data: existingMember, error: fetchError } = await supabase
    .from("members")
    .select("id")
    .eq("email", cleanEmail)
    .maybeSingle();

  if (fetchError) {
    console.error("Member email check failed:", fetchError.message);

    return Response.json(
      { error: "Unable to verify the email address. Please try again." },
      { status: 500 }
    );
  }

  if (existingMember) {
    return Response.json(
      { error: "A member with this email already exists." },
      { status: 400 }
    );
  }

  // 5. Insert the new member
  const { data: newMember, error: insertError } = await supabase
    .from("members")
    .insert({
      name: cleanName,
      email: cleanEmail,
      location: cleanLocation,
      avatar_url: cleanAvatarUrl || null,
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("Member creation failed:", insertError.message);

    return Response.json(
      { error: "Unable to create the member. Please try again." },
      { status: 500 }
    );
  }

  // 6. Redirect to the new member's details
  return redirect(`/dashboard/${newMember.id}`);
}

export default function NewMember() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();

  const isSubmitting = navigation.state === "submitting";

  return (
    <>
      <h1 className="mb-8 text-2xl font-semibold text-slate-900 lg:text-3xl">
        New Member
      </h1>

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
              placeholder="Name Surname"
            />

            <TextField
              id="email"
              name="email"
              type="email"
              label="Email"
              required
              placeholder="Email address"
            />

            <TextField
              id="location"
              name="location"
              type="text"
              label="Location"
              required
              placeholder="Country"
            />

            <TextField
              id="avatar_url"
              name="avatar_url"
              type="url"
              label="Avatar URL"
              placeholder="https://example.com/avatar.jpg"
            />

            <div className="flex items-center justify-center w-full gap-4 md:justify-end">
              <Button to="/dashboard" variant="outlined">
                Cancel
              </Button>

              <Button type="submit" loading={isSubmitting}>
                Create Member
              </Button>
            </div>
          </fieldset>
        </Form>
      </div>
    </>
  );
}
