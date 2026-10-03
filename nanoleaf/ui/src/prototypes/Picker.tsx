import { type ComponentType, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./picker.css";

export interface Variant {
  name: string;
  Component: ComponentType;
}

function initialIndex(count: number) {
  const v = parseInt(new URLSearchParams(location.search).get("v") ?? "", 10);
  return v >= 1 && v <= count ? v - 1 : 0;
}

/** Harness chrome, as in the siblings: one variant at a time, full size, keyed so switching (or R) re-mounts it. */
export function PickerHarness({ variants, replay = true }: { variants: Variant[]; replay?: boolean }) {
  const [current, setCurrent] = useState(() => initialIndex(variants.length));
  const [mountKey, setMountKey] = useState(0);
  const [ready, setReady] = useState(false);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const highlightRef = useRef<HTMLSpanElement>(null);

  const moveHighlight = () => {
    const el = itemRefs.current[current];
    const hl = highlightRef.current;
    if (!el || !hl) return;
    hl.style.width = `${el.offsetWidth}px`;
    hl.style.transform = `translateX(${el.offsetLeft}px)`;
  };

  useLayoutEffect(moveHighlight);

  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("v", String(current + 1));
    history.replaceState(null, "", url);
  }, [current]);

  useEffect(() => {
    // Enable the slide only after first paint, so load doesn't animate.
    requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
  }, []);

  const setActive = (i: number) => {
    if (i < 0 || i >= variants.length) return;
    setCurrent(i);
    setMountKey((k) => k + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= variants.length) setActive(num - 1);
      else if (e.key === "ArrowRight") setActive((current + 1) % variants.length);
      else if (e.key === "ArrowLeft") setActive((current - 1 + variants.length) % variants.length);
      else if (replay && (e.key === "r" || e.key === "R")) setMountKey((k) => k + 1);
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", moveHighlight);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", moveHighlight);
    };
  });

  const Active = variants[current].Component;
  return (
    <>
      <Active key={`${current}-${mountKey}`} />
      <nav className="proto-picker" aria-label="Prototype variants" data-ready={ready ? "" : undefined}>
        <span ref={highlightRef} className="proto-picker-highlight" aria-hidden="true" />
        {variants.map((v, i) => (
          <button
            key={v.name}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            className="proto-picker-item"
            data-active={i === current ? "" : undefined}
            aria-current={i === current ? "true" : undefined}
            onClick={() => setActive(i)}
          >
            {v.name}
          </button>
        ))}
        {replay && (
          <>
            <span className="proto-picker-divider" aria-hidden="true" />
            <button
              className="proto-picker-item proto-picker-replay"
              aria-label="Replay animation (R)"
              onClick={() => setMountKey((k) => k + 1)}
            >
              ↻
            </button>
          </>
        )}
      </nav>
    </>
  );
}
