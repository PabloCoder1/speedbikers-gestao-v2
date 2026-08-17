import {
  isAppRole,
  type AppRole,
} from "@/features/auth/roles";
import { createClient } from "@/lib/supabase/server";

export type CurrentAccess = {
  userId: string;
  email: string | null;
  fullName: string | null;
  mustChangePassword: boolean;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: AppRole;
};

export async function getCurrentAccess(): Promise<
  CurrentAccess | null
> {
  const supabase = await createClient();

  const { data: authData } =
    await supabase.auth.getClaims();

  const claims = authData?.claims;

  if (!claims?.sub) {
    return null;
  }

  const [profileResult, membershipResult] = await Promise.all([
    supabase
      .from("profiles")
      .select("full_name, must_change_password")
      .eq("id", claims.sub)
      .single(),
    supabase
      .from("organization_members")
      .select("organization_id, role")
      .eq("user_id", claims.sub)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle(),
  ]);
  const { data: profile, error: profileError } = profileResult;
  const { data: membership, error: membershipError } = membershipResult;

  if (profileError || !profile) {
    return null;
  }

  if (
    membershipError ||
    !membership ||
    !isAppRole(membership.role)
  ) {
    return null;
  }

  const {
    data: organization,
    error: organizationError,
  } = await supabase
    .from("organizations")
    .select("name, slug")
    .eq(
      "id",
      membership.organization_id,
    )
    .single();

  if (
    organizationError ||
    !organization
  ) {
    return null;
  }

  return {
    userId: claims.sub,

    email:
      typeof claims.email === "string"
        ? claims.email
        : null,

    fullName: profile.full_name,

    mustChangePassword:
      profile.must_change_password,

    organizationId:
      membership.organization_id,

    organizationName:
      organization.name,

    organizationSlug:
      organization.slug,

    role: membership.role,
  };
}
