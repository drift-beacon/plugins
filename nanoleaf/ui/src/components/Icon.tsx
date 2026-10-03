import type { ComponentPropsWithoutRef } from "react";

/** An icon from a model's `iconPath` (SVG path data, viewBox 0 0 24 24). Null renders an empty placeholder. */
export function Icon({ path, ...props }: { path: string | null } & Omit<ComponentPropsWithoutRef<"svg">, "path">) {
  if (path === null) return <span className={props.className} />;
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d={path} />
    </svg>
  );
}
