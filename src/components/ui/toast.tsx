import { useEffect } from "react";
import { cn } from "@/lib/utils";

type ToastProps = {
  message: string;
  type?: "success" | "error" | "info";
  onDismiss: () => void;
  duration?: number;
};

export function Toast({ message, type = "info", onDismiss, duration = 4000 }: ToastProps) {
  useEffect(() => {
    const id = setTimeout(onDismiss, duration);
    return () => clearTimeout(id);
  }, [duration, onDismiss]);

  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-6 z-50 mx-auto flex w-fit items-center gap-3 rounded-3xl px-6 py-3 text-sm font-medium text-white shadow-lg",
        type === "success" && "bg-foundation-green",
        type === "error" && "bg-foundation-warm",
        type === "info" && "bg-foundation-blue"
      )}
    >
      <span>{message}</span>
      <button onClick={onDismiss} className="text-white/80">
        ✕
      </button>
    </div>
  );
}
