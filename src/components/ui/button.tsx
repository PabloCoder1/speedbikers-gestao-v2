import type {
  ButtonHTMLAttributes,
} from "react";

import { cn } from "@/lib/utils/cn";

type ButtonVariant =
  | "primary"
  | "secondary"
  | "danger"
  | "ghost";

type ButtonSize =
  | "sm"
  | "md"
  | "lg";

export type ButtonProps =
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
  };

const variantClasses: Record<
  ButtonVariant,
  string
> = {
  primary:
    "bg-gray-950 text-white hover:bg-gray-800 disabled:bg-gray-400",

  secondary:
    "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 disabled:bg-gray-50 disabled:text-gray-400",

  danger:
    "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300",

  ghost:
    "bg-transparent text-gray-700 hover:bg-gray-100 disabled:text-gray-400",
};

const sizeClasses: Record<
  ButtonSize,
  string
> = {
  sm: "px-3 py-2 text-sm",
  md: "px-4 py-2.5 text-sm",
  lg: "px-5 py-3 text-base",
};

export function Button({
  className,
  variant = "primary",
  size = "md",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center rounded-xl font-semibold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-gray-200 disabled:cursor-not-allowed",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
}