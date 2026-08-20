import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "../../../lib/supabase/server";

/**
 * Sair.
 *
 * POST e não GET de propósito: um `GET /auth/sign-out` seria disparado por
 * qualquer `<img>` numa página de terceiro, derrubando a sessão de quem
 * apenas abriu um e-mail.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  await supabase.auth.signOut();

  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
