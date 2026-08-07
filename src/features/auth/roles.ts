export const APP_ROLES = [
  "admin",
  "gestor",
  "analista",
  "operador",
  "visualizador",
] as const;

export type AppRole =
  (typeof APP_ROLES)[number];

export const ROLE_LABELS: Record<
  AppRole,
  string
> = {
  admin: "Admin",
  gestor: "Gestor",
  analista: "Analista",
  operador: "Operador",
  visualizador: "Visualizador",
};

export function isAppRole(
  value: unknown,
): value is AppRole {
  return (
    typeof value === "string" &&
    APP_ROLES.some(
      (role) => role === value,
    )
  );
}