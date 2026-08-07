import { getCurrentAccess } from "@/features/auth/get-current-access";
import { createClient } from "@/lib/supabase/server";

export type MlAccountConnectionStatus =
  | "not_connected"
  | "connected"
  | "reauthorization_required"
  | "disabled";

type MlAccountRow = {
  id: string;
  code: string;
  display_name: string;
  seller_id: string | null;
  nickname: string | null;
  site_id: string;
  connection_status: unknown;
  is_active: boolean;
  connected_at: string | null;
  last_synced_at: string | null;
};

export type MlAccount = {
  id: string;
  code: string;
  displayName: string;
  sellerId: string | null;
  nickname: string | null;
  siteId: string;
  connectionStatus:
    MlAccountConnectionStatus;
  isActive: boolean;
  connectedAt: string | null;
  lastSyncedAt: string | null;
};

function isConnectionStatus(
  value: unknown,
): value is MlAccountConnectionStatus {
  return (
    value === "not_connected" ||
    value === "connected" ||
    value ===
      "reauthorization_required" ||
    value === "disabled"
  );
}

export async function getMlAccounts() {
  const access =
    await getCurrentAccess();

  if (!access) {
    return {
      access: null,
      accounts: [] as MlAccount[],
    };
  }

  const supabase =
    await createClient();

  const {
    data,
    error,
  } = (await supabase
    .from("ml_accounts")
    .select(
      [
        "id",
        "code",
        "display_name",
        "seller_id",
        "nickname",
        "site_id",
        "connection_status",
        "is_active",
        "connected_at",
        "last_synced_at",
      ].join(","),
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .order("display_name")) as {
      data: MlAccountRow[] | null;
      error: unknown;
    };

  if (error) {
    throw new Error(
      "Não foi possível carregar as contas do Mercado Livre.",
    );
  }

  const accounts: MlAccount[] =
    (data ?? []).flatMap(
      (account) => {
        if (
          !isConnectionStatus(
            account.connection_status,
          )
        ) {
          return [];
        }

        return [
          {
            id: account.id,
            code: account.code,

            displayName:
              account.display_name,

            sellerId:
              account.seller_id,

            nickname:
              account.nickname,

            siteId:
              account.site_id,

            connectionStatus:
              account.connection_status,

            isActive:
              account.is_active,

            connectedAt:
              account.connected_at,

            lastSyncedAt:
              account.last_synced_at,
          },
        ];
      },
    );

  return {
    access,
    accounts,
  };
}