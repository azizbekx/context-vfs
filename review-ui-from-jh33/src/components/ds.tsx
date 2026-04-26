/**
 * Qontext design-system primitives — thin wrappers around the CSS utilities
 * defined in `src/index.css`. Kept in a single file because each component is
 * just a className-forwarder; consolidating makes the surface easier to scan.
 */

import { ButtonHTMLAttributes, forwardRef, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- */
/* Button                                                            */
/* ---------------------------------------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost";

interface DSButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export const DSButton = forwardRef<HTMLButtonElement, DSButtonProps>(
  ({ className, variant = "secondary", children, ...rest }, ref) => {
    const cls =
      variant === "primary" ? "cta-primary" :
      variant === "secondary" ? "cta-secondary" :
      "cta-ghost";
    return (
      <button ref={ref} className={cn(cls, className)} {...rest}>
        {children}
      </button>
    );
  }
);
DSButton.displayName = "DSButton";

/* ---------------------------------------------------------------- */
/* Cards                                                             */
/* ---------------------------------------------------------------- */

export const DSCard = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...rest }, ref) => (
    <div ref={ref} className={cn("surface-card", className)} {...rest} />
  )
);
DSCard.displayName = "DSCard";

export const DSNestedCard = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...rest }, ref) => (
    <div ref={ref} className={cn("surface-nested", className)} {...rest} />
  )
);
DSNestedCard.displayName = "DSNestedCard";

/* ---------------------------------------------------------------- */
/* Badges                                                            */
/* ---------------------------------------------------------------- */

export function MonoBadge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("badge-mono", className)}>[{children}]</span>;
}

export function SeverityBadge({ sev }: { sev: "HIGH" | "MED" | "LOW" }) {
  const cls = sev === "HIGH" ? "severity-high" : sev === "MED" ? "severity-med" : "severity-low";
  return <span className={cls}>{sev}</span>;
}

/* ---------------------------------------------------------------- */
/* Breadcrumb                                                        */
/* ---------------------------------------------------------------- */

export function Breadcrumb({ segments }: { segments: string[] }) {
  return (
    <span className="breadcrumb-mono">
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const sep = i === 0 ? null : i === segments.length - 1 ? <span className="sep">·</span> : <span className="sep">/</span>;
        return (
          <span key={`${seg}-${i}`}>
            {sep}
            <span className={isLast ? "last" : ""}>{seg}</span>
          </span>
        );
      })}
    </span>
  );
}

/* ---------------------------------------------------------------- */
/* Kbd, Divider, AvatarChip                                          */
/* ---------------------------------------------------------------- */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn("hairline", className)} />;
}

export function AvatarChip({ initials = "JM" }: { initials?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="badge-mono">{initials}</span>
      <span className="w-6 h-6 rounded-full bg-surface-2 border border-hairline" />
    </span>
  );
}
