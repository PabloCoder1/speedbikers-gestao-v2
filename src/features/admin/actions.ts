"use server";

import { randomBytes } from "node:crypto";

import {
  revalidatePath,
} from "next/cache";

import {
  isAppRole,
} from "@/features/auth/roles";
import { requireAdminAccess } from "@/features/auth/require-admin-access";
import { createAdminClient } from "@/lib/supabase/admin";

export type CreateUserState = {
  error: string | null;
  success: string | null;
  temporaryPassword: string | null;
};

export async function createOrganizationUser(
  _previousState: CreateUserState,
  formData: FormData,
): Promise<CreateUserState> {
  const access =
    await requireAdminAccess();

  const rawName =
    formData.get("fullName");

  const rawEmail =
    formData.get("email");

  const rawRole =
    formData.get("role");

  if (
    typeof rawName !== "string" ||
    typeof rawEmail !== "string" ||
    typeof rawRole !== "string"
  ) {
    return {
      error:
        "Preencha todos os campos.",
      success: null,
      temporaryPassword: null,
    };
  }

  const fullName =
    rawName.trim();

  const email =
    rawEmail
      .trim()
      .toLowerCase();

  if (
    fullName.length < 2 ||
    fullName.length > 120
  ) {
    return {
      error:
        "Informe um nome válido.",
      success: null,
      temporaryPassword: null,
    };
  }

  if (
    !email ||
    !email.includes("@")
  ) {
    return {
      error:
        "Informe um e-mail válido.",
      success: null,
      temporaryPassword: null,
    };
  }

  if (!isAppRole(rawRole)) {
    return {
      error:
        "Selecione um papel válido.",
      success: null,
      temporaryPassword: null,
    };
  }

  const admin =
    createAdminClient();

  const perPage = 1000;
  let page = 1;
  let existingUser = null;

  while (true) {
    const {
      data,
      error,
    } =
      await admin.auth.admin.listUsers({
        page,
        perPage,
      });

    if (error) {
      return {
        error:
          "Não foi possível verificar os usuários existentes.",
        success: null,
        temporaryPassword: null,
      };
    }

    existingUser =
      data.users.find(
        (user) =>
          user.email?.toLowerCase() ===
          email,
      ) ?? null;

    if (
      existingUser ||
      data.users.length < perPage
    ) {
      break;
    }

    page += 1;
  }

  if (existingUser) {
    return {
      error:
        "Já existe um usuário de autenticação com este e-mail.",
      success: null,
      temporaryPassword: null,
    };
  }

  const temporaryPassword =
    `${randomBytes(18).toString(
      "base64url",
    )}Aa1!`;

  const {
    data: created,
    error: createError,
  } =
    await admin.auth.admin.createUser({
      email,
      password:
        temporaryPassword,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
      },
    });

  if (
    createError ||
    !created.user
  ) {
    return {
      error:
        "Não foi possível criar o usuário.",
      success: null,
      temporaryPassword: null,
    };
  }

  const userId =
    created.user.id;

  const {
    error: profileError,
  } = await admin
    .from("profiles")
    .upsert({
      id: userId,
      full_name: fullName,
      must_change_password: true,
    });

  if (profileError) {
    await admin.auth.admin.deleteUser(
      userId,
    );

    return {
      error:
        "Não foi possível criar o perfil do usuário.",
      success: null,
      temporaryPassword: null,
    };
  }

  const {
    error: membershipError,
  } = await admin
    .from("organization_members")
    .insert({
      organization_id:
        access.organizationId,
      user_id: userId,
      role: rawRole,
      is_active: true,
    });

  if (membershipError) {
    await admin.auth.admin.deleteUser(
      userId,
    );

    return {
      error:
        "Não foi possível vincular o usuário à organização.",
      success: null,
      temporaryPassword: null,
    };
  }

  revalidatePath(
    "/administracao",
  );

  return {
    error: null,

    success:
      `${fullName} foi adicionado com sucesso.`,

    temporaryPassword,
  };
}