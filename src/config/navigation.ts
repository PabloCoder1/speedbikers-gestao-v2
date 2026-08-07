export type NavigationItem = {
  label: string;
  href: string | null;
};

export type NavigationSection = {
  label: string;
  items: NavigationItem[];
};

export const navigationSections: NavigationSection[] = [
  {
    label: "Análise",
    items: [
      {
        label: "Visão Geral",
        href: "/",
      },
      {
        label: "Contas",
        href: null,
      },
      {
        label: "Produtos",
        href: null,
      },
    ],
  },
  {
    label: "Operação",
    items: [
      {
        label: "Estoque",
        href: null,
      },
      {
        label: "Alertas",
        href: null,
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
        href: null,
      },
    ],
  },
];