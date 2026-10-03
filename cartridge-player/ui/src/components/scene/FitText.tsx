import { type SVGProps, useLayoutEffect, useRef } from "react";

/**
 * SVG text cut to fit `width` user units, measured rather than counted: twelve "W"s and twelve "i"s differ by a lot.
 * It cuts on whole characters and adds an ellipsis. The text node is this component's alone (React renders no
 * children into it), so measuring by trying shorter strings never fights React's own update.
 */
export function FitText({ text, width, ...props }: { text: string; width: number } & Omit<SVGProps<SVGTextElement>, "ref">) {
  const ref = useRef<SVGTextElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.textContent = text;
    if (node.getComputedTextLength() <= width) return;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      node.textContent = `${text.slice(0, mid).trimEnd()}…`;
      if (node.getComputedTextLength() <= width) lo = mid;
      else hi = mid - 1;
    }
    node.textContent = `${text.slice(0, lo).trimEnd()}…`;
  }, [text, width]);

  return <text ref={ref} {...props} />;
}
