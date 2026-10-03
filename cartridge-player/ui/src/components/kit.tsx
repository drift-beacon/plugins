import { LoaderCircle } from "lucide-react";
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cx } from "../lib/cx.ts";

type Tone = "primary" | "flat" | "light" | "danger" | "danger-light";

const TONES: Record<Tone, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  flat: "bg-default-100 text-foreground hover:bg-default-200",
  light: "text-default-600 hover:bg-default-100 hover:text-foreground",
  danger: "bg-danger text-danger-foreground hover:bg-danger/90",
  "danger-light": "text-danger hover:bg-danger/10",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly tone?: Tone;
  readonly size?: "sm" | "md";
  readonly pending?: boolean;
  readonly icon?: ReactNode;
}

/**
 * The interface's button: HeroUI's look (radius, weights, tokens) without its runtime. It stays a plain `<button>`, so
 * it works with every form of input, presses in a touch (none under reduced motion), and reaches 44 px on touch
 * screens. A pending button keeps its label (for its size and name) and shows a spinner over it; it ignores presses
 * but isn't `disabled`, which would drop keyboard focus to the page while the request runs.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = "flat", size = "md", pending = false, icon, className, children, disabled, type = "button", onClick, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      onClick={pending ? undefined : onClick}
      className={cx(
        "cp-press cp-touch relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium",
        "disabled:cursor-default disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-xs" : "h-10 px-4 text-sm",
        TONES[tone],
        className,
      )}
      {...props}
    >
      <span className={cx("inline-flex items-center gap-1.5", pending && "invisible")}>
        {icon}
        {children}
      </span>
      {pending && (
        <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
          <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" />
        </span>
      )}
    </button>
  );
});

/** A small all-caps line above a heading: what kind of moment this is. */
export function Eyebrow({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  return (
    <span
      className={cx(
        "flex w-fit items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em]",
        tone === "success" && "text-success",
        tone === "warning" && "text-warning",
        tone === "danger" && "text-danger",
        tone === "default" && "text-default-500",
      )}
    >
      {children}
    </span>
  );
}

/** A failure under the control that caused it; read out once when it appears. */
export function InlineError({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cx("text-xs leading-snug text-danger", className)}>
      {children}
    </p>
  );
}
