import { Switch } from "@heroui/react";
import { useId } from "react";

/**
 * A setting with a switch: the label says what, the description what it does to the wall. Only the switch takes a
 * press: the words beside it are plain text, so a finger that lands on them scrolls the page instead of toggling. The
 * input is named by the label text and described by the description (HeroUI 2.2's Switch has no describedby prop, so
 * the input ref sets it).
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
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <span id={labelId} className="block font-medium text-foreground text-sm">
          {props.label}
        </span>
        <span id={descriptionId} className="mt-0.5 block text-default-500 text-xs leading-snug">
          {props.description}
        </span>
      </div>
      <Switch
        size="sm"
        aria-labelledby={labelId}
        ref={(input) => input?.setAttribute("aria-describedby", descriptionId)}
        isSelected={props.value}
        onValueChange={props.onChange}
        classNames={{ base: "mt-0.5 shrink-0", wrapper: "me-0" }}
      />
    </div>
  );
}
