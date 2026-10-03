import { Switch } from "@heroui/react";
import { useId } from "react";

/**
 * A setting with a switch: the label says what, the description what it does to the wall. The whole row is the
 * switch's own <label>, so clicking the words toggles it; the input is named by the label text alone and described by
 * the description (HeroUI 2.2's Switch has no describedby prop, so the input ref sets it).
 */
export function SwitchRow(props: {
  label: string;
  description: string;
  value: boolean;
  onChange(value: boolean): void;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  return (
    <Switch
      size="sm"
      aria-labelledby={labelId}
      ref={(input) => input?.setAttribute("aria-describedby", descriptionId)}
      isSelected={props.value}
      onValueChange={props.onChange}
      classNames={{
        base: "flex w-full max-w-none flex-row-reverse items-start justify-between gap-4",
        wrapper: "me-0 mt-0.5 shrink-0",
        label: "ms-0 min-w-0",
      }}
    >
      <span id={labelId} className="block font-medium text-foreground text-sm">
        {props.label}
      </span>
      <span id={descriptionId} className="mt-0.5 block text-default-500 text-xs leading-snug">
        {props.description}
      </span>
    </Switch>
  );
}
