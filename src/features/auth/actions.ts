"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type LoginState = {
  error: string | null;
};

export type PasswordChangeState = {
  error: string | null;
};

export async function login(
  _previousState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const rawEmail = formData.get("email");
  const rawPassword = formData.get("password");

  if (
    typeof rawEmail !== "string" ||
    typeof rawPassword !== "string"
  ) {
    return {
      error: "Informe seu e-mail e sua senha.",
    };
  }

  const email = rawEmail.trim().toLowerCase();
  const password = rawPassword;

  if (!email || !password) {
    return {
      error: "Informe seu e-mail e sua senha.",
    };
  }

  const supabase = await createClient();

  const { data, error } =
    await supabase.auth.signInWithPassword({
      email,
      password,
    });

  if (error || !data.user) {
    return {
      error: "E-mail ou senha inválidos.",
    };
  }

  const {
    data: membership,
    error: membershipError,
  } = await supabase
    .from("organization_members")
    .select("id")
    .eq("user_id", data.user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (membershipError) {
    await supabase.auth.signOut();

    return {
      error:
        "Não foi possível verificar seu acesso agora. Tente novamente em instantes.",
    };
  }

  if (!membership) {
    await supabase.auth.signOut();

    return {
      error:
        "Este usuário não possui acesso ativo ao Speed Bikers Gestão.",
    };
  }

  const {
    data: profile,
    error: profileError,
  } = await supabase
    .from("profiles")
    .select("must_change_password")
    .eq("id", data.user.id)
    .single();

  if (profileError || !profile) {
    await supabase.auth.signOut();

    return {
      error:
        "Não foi possível validar o perfil deste usuário.",
    };
  }

  revalidatePath("/", "layout");

  if (profile.must_change_password) {
    redirect("/trocar-senha");
  }

  redirect("/");
}

export async function changePassword(
  _previousState: PasswordChangeState,
  formData: FormData,
): Promise<PasswordChangeState> {
  const currentPassword =
    formData.get("currentPassword");

  const newPassword =
    formData.get("newPassword");

  const confirmPassword =
    formData.get("confirmPassword");

  if (
    typeof currentPassword !== "string" ||
    typeof newPassword !== "string" ||
    typeof confirmPassword !== "string"
  ) {
    return {
      error: "Preencha todos os campos.",
    };
  }

  if (
    !currentPassword ||
    !newPassword ||
    !confirmPassword
  ) {
    return {
      error: "Preencha todos os campos.",
    };
  }

  if (newPassword !== confirmPassword) {
    return {
      error:
        "A confirmação da nova senha não corresponde.",
    };
  }

  if (newPassword === currentPassword) {
    return {
      error:
        "A nova senha precisa ser diferente da senha atual.",
    };
  }

  if (newPassword.length < 12) {
    return {
      error:
        "A nova senha deve possuir pelo menos 12 caracteres.",
    };
  }

  if (!/[a-z]/.test(newPassword)) {
    return {
      error:
        "A nova senha deve possuir pelo menos uma letra minúscula.",
    };
  }

  if (!/[A-Z]/.test(newPassword)) {
    return {
      error:
        "A nova senha deve possuir pelo menos uma letra maiúscula.",
    };
  }

  if (!/[0-9]/.test(newPassword)) {
    return {
      error:
        "A nova senha deve possuir pelo menos um número.",
    };
  }

  if (!/[^A-Za-z0-9]/.test(newPassword)) {
    return {
      error:
        "A nova senha deve possuir pelo menos um caractere especial.",
    };
  }

  const supabase = await createClient();

  const { data: authData } =
    await supabase.auth.getClaims();

  const claims = authData?.claims;

  if (
    !claims?.sub ||
    typeof claims.email !== "string"
  ) {
    redirect("/login");
  }

  const {
    error: reauthenticationError,
  } = await supabase.auth.signInWithPassword({
    email: claims.email,
    password: currentPassword,
  });

  if (reauthenticationError) {
    return {
      error: "A senha atual está incorreta.",
    };
  }

  const { error: passwordError } =
    await supabase.auth.updateUser({
      password: newPassword,
    });

  if (passwordError) {
    return {
      error:
        "Não foi possível atualizar a senha. Tente novamente.",
    };
  }

  const admin = createAdminClient();

  const { error: profileError } = await admin
    .from("profiles")
    .update({
      must_change_password: false,
    })
    .eq("id", claims.sub);

  if (profileError) {
    return {
      error:
        "A senha foi alterada, mas não foi possível concluir o primeiro acesso. Entre novamente e tente concluir a configuração.",
    };
  }

  await supabase.auth.signOut();

  revalidatePath("/", "layout");

  redirect("/login?passwordChanged=1");
}

export async function logout() {
  const supabase = await createClient();

  await supabase.auth.signOut();

  revalidatePath("/", "layout");

  redirect("/login");
}