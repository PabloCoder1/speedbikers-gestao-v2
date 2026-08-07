import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

const [emailArgument, ...nameParts] = process.argv.slice(2);

if (!emailArgument) {
  console.error(
    'Uso: node --env-file=.env.local scripts/bootstrap-admin.mjs "email@exemplo.com" "Nome Completo"',
  );

  process.exit(1);
}

const email = emailArgument.trim().toLowerCase();
const fullName = nameParts.join(" ").trim();

if (!email.includes("@")) {
  console.error("Informe um endereço de e-mail válido.");
  process.exit(1);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL não está configurada em .env.local.",
  );

  process.exit(1);
}

if (!supabaseSecretKey) {
  console.error(
    "SUPABASE_SECRET_KEY não está configurada em .env.local.",
  );

  process.exit(1);
}

const supabase = createClient(
  supabaseUrl,
  supabaseSecretKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  },
);

async function findUserByEmail(targetEmail) {
  const perPage = 1000;
  let page = 1;

  while (true) {
    const { data, error } =
      await supabase.auth.admin.listUsers({
        page,
        perPage,
      });

    if (error) {
      throw error;
    }

    const user = data.users.find(
      (candidate) =>
        candidate.email?.toLowerCase() === targetEmail,
    );

    if (user) {
      return user;
    }

    if (data.users.length < perPage) {
      return null;
    }

    page += 1;
  }
}

async function main() {
  console.log("");
  console.log("Speed Bikers Gestão V2");
  console.log("Bootstrap do primeiro administrador");
  console.log("------------------------------------");
  console.log("");

  const { data: organization, error: organizationError } =
    await supabase
      .from("organizations")
      .select("id, name, slug")
      .eq("slug", "speed-bikers")
      .single();

  if (organizationError || !organization) {
    throw new Error(
      `Não foi possível localizar a organização Speed Bikers: ${
        organizationError?.message ?? "organização não encontrada"
      }`,
    );
  }

  let user = await findUserByEmail(email);
  let createdUser = false;
  let temporaryPassword = null;

  if (!user) {
    temporaryPassword =
      `${randomBytes(18).toString("base64url")}Aa1!`;

    const { data, error } =
      await supabase.auth.admin.createUser({
        email,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: fullName
          ? {
              full_name: fullName,
            }
          : {},
      });

    if (error) {
      throw error;
    }

    user = data.user;
    createdUser = true;
  }

  if (!user) {
    throw new Error(
      "Não foi possível obter o usuário administrativo.",
    );
  }

  const { data: existingProfile, error: profileLookupError } =
    await supabase
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

  if (profileLookupError) {
    throw profileLookupError;
  }

  if (!existingProfile) {
    const { error } = await supabase
      .from("profiles")
      .insert({
        id: user.id,
        full_name: fullName || null,
      });

    if (error) {
      if (createdUser) {
        await supabase.auth.admin.deleteUser(user.id);
      }

      throw error;
    }
  } else if (fullName) {
    const { error } = await supabase
      .from("profiles")
      .update({
        full_name: fullName,
      })
      .eq("id", user.id);

    if (error) {
      throw error;
    }
  }

  const { error: membershipError } = await supabase
    .from("organization_members")
    .upsert(
      {
        organization_id: organization.id,
        user_id: user.id,
        role: "admin",
        is_active: true,
      },
      {
        onConflict: "organization_id,user_id",
      },
    );

  if (membershipError) {
    if (createdUser) {
      await supabase.auth.admin.deleteUser(user.id);
    }

    throw membershipError;
  }

  console.log("Bootstrap concluído com sucesso.");
  console.log("");
  console.log(`Organização: ${organization.name}`);
  console.log(`Usuário: ${email}`);
  console.log("Papel: admin");
  console.log("Status: ativo");

  if (createdUser && temporaryPassword) {
    console.log("");
    console.log("SENHA TEMPORÁRIA:");
    console.log(temporaryPassword);
    console.log("");
    console.log(
      "Salve essa senha em um gerenciador de senhas.",
    );
    console.log(
      "Ela será substituída posteriormente pela sua senha definitiva.",
    );
  } else {
    console.log("");
    console.log(
      "O usuário já existia. A senha existente não foi alterada.",
    );
  }

  console.log("");
}

main().catch((error) => {
  console.error("");
  console.error("Falha no bootstrap do administrador.");
  console.error(error);
  console.error("");

  process.exit(1);
});