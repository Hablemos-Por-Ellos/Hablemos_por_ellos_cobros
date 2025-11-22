import { forwardRef } from "react";
import { cn } from "@/lib/utils";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", loading, disabled, children, ...props }, ref) => {
    const base =
      "inline-flex items-center justify-center rounded-full px-6 py-3 font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foundation-blue focus-visible:ring-offset-2";

    const variants = {
      primary: "bg-foundation-blue text-white shadow-lg hover:-translate-y-0.5 hover:bg-foundation-blue/90 disabled:opacity-50",
      secondary:
        "bg-foundation-green/10 text-foundation-green hover:bg-foundation-green/20 border border-foundation-green/40 disabled:opacity-50",
      ghost: "text-slate-600 hover:text-foundation-blue disabled:opacity-50",
    } as const;

    return (
      <button
        ref={ref}
        className={cn(base, variants[variant], className)}
        disabled={disabled || loading}
        {...props}
      >
        {loading && (
          <span className="mr-2 inline-flex h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
