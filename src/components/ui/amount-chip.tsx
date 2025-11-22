import { cn, formatCurrencyCOP } from "@/lib/utils";

type AmountChipProps = {
  value: number;
  selected: boolean;
  description: string;
  onSelect: (value: number) => void;
};

export function AmountChip({ value, description, selected, onSelect }: AmountChipProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={cn(
        "flex w-full flex-col rounded-2xl border px-5 py-4 text-left transition",
        selected
          ? "border-foundation-blue bg-foundation-blue/10 text-foundation-blue"
          : "border-transparent bg-white text-slate-700 hover:border-foundation-blue/30"
      )}
    >
      <span className="text-lg font-semibold">{formatCurrencyCOP(value)}</span>
      <span className="text-sm text-slate-500">{description}</span>
    </button>
  );
}
