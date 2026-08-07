import {
  isAppRole,
  type AppRole,
} from "@/features/auth/roles";
import { requireAdminAccess } from "@/features/auth/require-admin-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type OrganizationUser = {
  userId: string;
  fullName: string | null;
  email: string | null;
  role: AppRole;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  emailConfirmedAt: string | null;
};

export async function getOrganizationUsers() {
  const access =
    await requireAdminAccess();

  const supabase =
    await createClient();

  const {
    data: memberships,
    error: membershipsError,
  } = await supabase
    .from("organization_members")
    .select(
      "user_id, role, is_active, created_at",
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .order("created_at", {
      ascending: true,
    });

  if (membershipsError) {
    throw new Error(
      "Não foi possível carregar os membros da organização.",
    );
  }

  if (
    !memberships ||
    memberships.length === 0
  ) {
    return {
      access,
      users: [] as OrganizationUser[],
    };
  }

  const userIds =
    memberships.map(
      (membership) =>
        membership.user_id,
    );

  const {
    data: profiles,
    error: profilesError,
  } = await supabase
    .from("profiles")
    .select(
      "id, full_name, must_change_password",
    )
    .in("id", userIds);

  if (profilesError) {
    throw new Error(
      "Não foi possível carregar os perfis dos usuários.",
    );
  }

  const admin =
    createAdminClient();

  const authUsers = [];

  let page = 1;
  const perPage = 1000;

  while (true) {
    const {
      data,
      error,
    } = await admin.auth.admin.listUsers({
      page,
      perPage,
    });

    if (error) {
      throw new Error(
        "Não foi possível carregar os usuários de autenticação.",
      );
    }

    authUsers.push(...data.users);

    if (
      data.users.length < perPage
    ) {
      break;
    }

    page += 1;
  }

  const profilesById =
    new Map(
      (profiles ?? []).map(
        (profile) => [
          profile.id,
          profile,
        ],
      ),
    );

  const authUsersById =
    new Map(
      authUsers.map(
        (user) => [
          user.id,
          user,
        ],
      ),
    );

  const users: OrganizationUser[] =
    memberships.flatMap(
      (membership) => {
        if (
          !isAppRole(
            membership.role,
          )
        ) {
          return [];
        }

        const profile =
          profilesById.get(
            membership.user_id,
          );

        const authUser =
          authUsersById.get(
            membership.user_id,
          );

        return [
          {
            userId:
              membership.user_id,

            fullName:
              profile?.full_name ??
              null,

            email:
              authUser?.email ??
              null,

            role:
              membership.role,

            isActive:
              membership.is_active,

            mustChangePassword:
              profile
                ?.must_change_password ??
              true,

            createdAt:
              membership.created_at,

            lastSignInAt:
              authUser
                ?.last_sign_in_at ??
              null,

            emailConfirmedAt:
              authUser
                ?.email_confirmed_at ??
              null,
          },
        ];
      },
    );

  return {
    access,
    users,
  };
}