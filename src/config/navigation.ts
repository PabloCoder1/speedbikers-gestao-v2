import type { AppRole } from "@/features/auth/roles";

export type NavigationItem = {
  label: string;
  href: string | null;
  allowedRoles?: readonly AppRole[];
};

export type NavigationSection = {
  label: string;
  items: NavigationItem[];
};

export const navigationSections: NavigationSection[] =
  [
    {
      label: "Análise",
      items: [
        {
          label: "Visão Geral",
          href: "/",
        },
        {
          label: "Contas",
          href: "/contas",
        },
        {
          label: "Produtos",
          href: "/produtos",
        },
      ],
    },
    {
      label: "Operação",
      items: [
        {
          label: "Pedidos de venda",
          href: "/pedidos",
        },
        {
          label: "Estoque",
          href: "/estoque",
        },
        {
          label: "Compras",
          href: "/compras",
        },
        {
          label: "Pedidos de compra",
          href: "/pedidos-compra",
        },
        {
          label: "Alertas",
          href: "/alertas",
        },
        {
          label: "Oportunidades",
          href: null,
        },
      ],
    },
    {
      label: "Sistema",
      items: [
        {
          label: "Administração",
          href: "/administracao",
          allowedRoles: ["admin"],
        },
      ],
    },
  ];
