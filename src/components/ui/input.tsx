import { forwardRef } from "react";
import { cn } from "@/lib/utils";

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  description?: string;
  error?: string;
};

export const TextInput = forwardRef<HTMLInputElement, InputProps>(
  ({ label, description, error, className, id, ...props }, ref) => {
    const inputId = id ?? props.name;

    return (
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700" htmlFor={inputId}>
        <span>
          {label}
          {props.required && <span className="text-foundation-warm"> *</span>}
        </span>
        <input
          ref={ref}
          id={inputId}
          className={cn(
            "h-12 rounded-2xl border border-slate-200 bg-white px-4 text-base font-normal text-slate-900 shadow-sm transition placeholder:text-slate-400 focus:border-foundation-blue focus:outline-none",
            error && "border-foundation-warm focus:border-foundation-warm",
            className
          )}
          {...props}
        />
        {description && !error && <span className="text-xs text-slate-500">{description}</span>}
        {error && <span className="text-xs text-foundation-warm">{error}</span>}
      </label>
    );
  }
);

TextInput.displayName = "TextInput";
