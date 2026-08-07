"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";
import { navigationSections } from "@/config/navigation";
import { logout } from "@/features/auth/actions";
import {
  ROLE_LABELS,
  type AppRole,
} from "@/features/auth/roles";

type AppSidebarProps = {
  organizationName: string;
  userName: string;
  email: string | null;
  role: AppRole;
};

export function AppSidebar({
  organizationName,
  userName,
  email,
  role,
}: AppSidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="border-b border-gray-200 bg-white lg:fixed lg:inset-y-0 lg:left-0 lg:w-72 lg:border-r lg:border-b-0">
      <div className="flex min-h-full flex-col">
        <div className="border-b border-gray-200 px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gray-950 text-sm font-bold text-white">
              SB
            </div>

            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-gray-950">
                Speed Bikers
              </p>

              <p className="truncate text-xs text-gray-500">
                Gestão V2
              </p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-4 py-5">
          <div className="space-y-7">
            {navigationSections.map(
              (section) => {
                const visibleItems =
                  section.items.filter(
                    (item) =>
                      !item.allowedRoles ||
                      item.allowedRoles.includes(
                        role,
                      ),
                  );

                if (
                  visibleItems.length === 0
                ) {
                  return null;
                }

                return (
                  <section
                    key={section.label}
                  >
                    <p className="px-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
                      {section.label}
                    </p>

                    <div className="mt-2 space-y-1">
                      {visibleItems.map(
                        (item) => {
                          if (!item.href) {
                            return (
                              <div
                                key={
                                  item.label
                                }
                                className="flex cursor-not-allowed items-center justify-between rounded-xl px-3 py-2.5 text-sm text-gray-400"
                              >
                                <span>
                                  {
                                    item.label
                                  }
                                </span>

                                <span className="rounded-md bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                                  Em breve
                                </span>
                              </div>
                            );
                          }

                          const isActive =
                            item.href === "/"
                              ? pathname === "/"
                              : pathname.startsWith(
                                  item.href,
                                );

                          return (
                            <Link
                              key={
                                item.label
                              }
                              href={
                                item.href
                              }
                              aria-current={
                                isActive
                                  ? "page"
                                  : undefined
                              }
                              className={`block rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                                isActive
                                  ? "bg-gray-950 text-white"
                                  : "text-gray-700 hover:bg-gray-100 hover:text-gray-950"
                              }`}
                            >
                              {
                                item.label
                              }
                            </Link>
                          );
                        },
                      )}
                    </div>
                  </section>
                );
              },
            )}
          </div>
        </nav>

        <div className="border-t border-gray-200 p-4">
          <div className="rounded-xl bg-gray-50 p-4">
            <p className="truncate text-sm font-semibold text-gray-950">
              {userName}
            </p>

            {email ? (
              <p className="mt-1 truncate text-xs text-gray-500">
                {email}
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-md bg-white px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-700 ring-1 ring-inset ring-gray-200">
                {ROLE_LABELS[role]}
              </span>

              <span className="max-w-full truncate rounded-md bg-white px-2 py-1 text-[11px] text-gray-500 ring-1 ring-inset ring-gray-200">
                {organizationName}
              </span>
            </div>

            <form
              action={logout}
              className="mt-4"
            >
              <Button
                type="submit"
                variant="secondary"
                className="w-full"
              >
                Sair
              </Button>
            </form>
          </div>
        </div>
      </div>
    </aside>
  );
}