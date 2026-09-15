import { cache } from "react";

import { currentMembership as readMembership } from "./membership";
import { createClient } from "./supabase/server";

/** Cache de uma renderização RSC. Nunca persiste papel/sessão entre requests. */
export const currentMembership = cache(async () => readMembership(await createClient()));
