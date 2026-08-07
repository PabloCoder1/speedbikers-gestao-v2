import type {
  ReactNode,
} from "react";

type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
};

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
      <div>
        {eyebrow ? (
          <p className="text-sm font-medium text-gray-500">
            {eyebrow}
          </p>
        ) : null}

        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-gray-950">
          {title}
        </h1>

        {description ? (
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-600">
            {description}
          </p>
        ) : null}
      </div>

      {actions ? (
        <div className="flex shrink-0 items-center gap-3">
          {actions}
        </div>
      ) : null}
    </header>
  );
}