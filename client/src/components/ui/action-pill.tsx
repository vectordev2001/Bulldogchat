import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

type Variant = "primary" | "success" | "danger" | "warning" | "neutral";
type Size = "sm" | "md";

interface ActionPillProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: React.ReactNode;
  asChild?: boolean;
}

const VARIANT: Record<Variant, string> = {
  primary: "bg-blue-500/15 hover:bg-blue-500/25 text-blue-300",
  success: "bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300",
  danger: "bg-red-500/15 hover:bg-red-500/25 text-red-300",
  warning: "bg-amber-500/15 hover:bg-amber-500/25 text-amber-300",
  neutral: "bg-white/8 hover:bg-white/15 text-white/85",
};

const SIZE: Record<Size, string> = {
  sm: "rounded-full px-3.5 py-1.5 text-xs",
  md: "rounded-2xl px-4 py-2 text-sm",
};

const ICON_SIZE: Record<Size, string> = {
  sm: "[&_svg]:h-3.5 [&_svg]:w-3.5",
  md: "[&_svg]:h-4 [&_svg]:w-4",
};

export const ActionPill = React.forwardRef<HTMLButtonElement, ActionPillProps>(
  ({ variant = "neutral", size = "sm", icon, asChild = false, className, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref as any}
        className={cn(
          "inline-flex items-center gap-1.5 font-medium border border-transparent",
          "active:scale-[0.97] transition-transform duration-100",
          "disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100",
          SIZE[size],
          ICON_SIZE[size],
          VARIANT[variant],
          className,
        )}
        {...props}
      >
        {icon}
        {children}
      </Comp>
    );
  },
);
ActionPill.displayName = "ActionPill";
