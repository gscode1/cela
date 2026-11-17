import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** The platform `<select>` in the shadcn field style: it is keyboard and screen reader friendly without a popover. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
