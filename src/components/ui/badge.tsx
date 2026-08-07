import type {
  HTMLAttributes,
} from "react";

import { cn } from "@/lib/utils/cn";

type BadgeVariant =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info";

type BadgeProps =
  HTMLAttributes<HTMLSpanElement> & {
    variant?: BadgeVariant;
  };

const variantClasses: Record<
  BadgeVariant,
  string
> = {
  neutral:
    "bg-gray-100 text-gray-700",

  success:
    "bg-green-50 text-green-700 ring-green-600/10",

  warning:
    "bg-amber-50 text-amber-700 ring-amber-600/10",

  danger:
    "bg-red-50 text-red-700 ring-red-600/10",

  info:
    "bg-blue-50 text-blue-700 ring-blue-600/10",
};

export function Badge({
  className,
  variant = "neutral",
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}