import { cn } from "@/lib/utils";

const steps = [
  { id: 1, label: "Tus datos" },
  { id: 2, label: "Pago seguro" },
  { id: 3, label: "Confirmación" },
];

export function Stepper({ currentStep }: { currentStep: number }) {
  return (
    <ol className="flex w-full flex-col gap-4 md:flex-row md:items-center">
      {steps.map((step, index) => {
        const isActive = currentStep === step.id;
        const isCompleted = currentStep > step.id;
        return (
          <li key={step.id} className="flex flex-1 items-center gap-3">
            <div
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-full border text-sm font-semibold",
                isActive && "border-foundation-blue bg-white text-foundation-blue",
                isCompleted && "border-foundation-green bg-foundation-green text-white",
                !isActive && !isCompleted && "border-slate-300 bg-white text-slate-400"
              )}
            >
              {isCompleted ? "✓" : step.id}
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-slate-800">Paso {step.id}</span>
              <span className="text-sm text-slate-500">{step.label}</span>
            </div>
            {index < steps.length - 1 && (
              <div className="hidden flex-1 border-t border-dashed border-slate-200 md:block" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
