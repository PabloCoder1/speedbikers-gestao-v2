const GENERATE_ROLES = new Set(["admin", "gestor", "analista"]);

/** ADMIN/GESTOR/ANALISTA may trigger (and pay for) an Anthropic call; OPERADOR/VISUALIZADOR only ever view. */
export function canGenerateProductDiagnostics(role: string, mustChangePassword: boolean): boolean {
  return !mustChangePassword && GENERATE_ROLES.has(role);
}

/** force=true bypasses the evidence-hash cache — restricted to the same generate-tier roles, never to a viewer. */
export function canForceProductDiagnostic(role: string, mustChangePassword: boolean): boolean {
  return canGenerateProductDiagnostics(role, mustChangePassword);
}
