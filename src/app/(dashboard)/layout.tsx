import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { getCurrentAccess } from "@/features/auth/get-current-access";

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const access =
    await getCurrentAccess();

  if (!access) {
    redirect("/login");
  }

  if (access.mustChangePassword) {
    redirect("/trocar-senha");
  }

  const userName =
    access.fullName ||
    access.email ||
    "Usuário";

  return (
    <div className="min-h-screen bg-gray-50">
      <AppSidebar
        organizationName={
          access.organizationName
        }
        userName={userName}
        email={access.email}
        role={access.role}
      />

      <div className="lg:pl-72">
        <main className="min-h-screen">
          {children}
        </main>
      </div>
    </div>
  );
}