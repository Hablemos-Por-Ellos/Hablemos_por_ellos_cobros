import { cn } from "@/lib/utils";

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  error?: string;
}

export function SelectField({ label, error, className, children, id, ...props }: SelectProps) {
  const selectId = id ?? props.name;

  return (
    <label className="flex flex-col gap-1 text-sm font-medium text-slate-700" htmlFor={selectId}>
      <span>
        {label}
        {props.required && <span className="text-foundation-warm"> *</span>}
      </span>
      <div className="relative">
        <select
          id={selectId}
          className={cn(
            "h-12 w-full appearance-none rounded-2xl border border-slate-200 bg-white px-4 text-base text-slate-900 shadow-sm transition focus:border-foundation-blue focus:outline-none",
            error && "border-foundation-warm focus:border-foundation-warm",
            className
          )}
          {...props}
        >
          {children}
        </select>
        <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-slate-400">⌄</span>
      </div>
      {error && <span className="text-xs text-foundation-warm">{error}</span>}
    </label>
  );
}
