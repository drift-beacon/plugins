import { ControllerCard } from "../ControllerCard.tsx";
import { NowCard } from "../NowCard.tsx";
import { SettingsCard } from "../SettingsPanel.tsx";
import { Starfield } from "../Starfield.tsx";
import { Horizon, HORIZON_OVERLAP } from "../wall/Horizon.tsx";
import { LitWall } from "../wall/LitWall.tsx";

/**
 * The phone's everyday tab, as the board's wall: the wall lit in a patch of night sky (its numbers are the Order
 * tab's), its light lying under it as a horizon with what it shows now sitting on the line, then the two brightnesses
 * and the controller. Tapping the wall opens the Order tab, where the drawing is full size.
 */
export function WallTab({ onOpenWall }: { onOpenWall(): void }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="relative">
          <div className="night-sky pointer-events-none absolute -inset-x-3 -top-3 -bottom-2">
            <Starfield />
          </div>
          <Horizon />
          <button
            type="button"
            aria-label="Your wall: open it with its fill order"
            onClick={onOpenWall}
            className="wall-stage relative block h-48 w-full transition-transform duration-150 ease-out active:scale-[0.98]"
          >
            <LitWall pad={18} floor={false} />
          </button>
        </div>
        {/* Over the wall's foot only as words and light: a press there still opens the wall. */}
        <div className="pointer-events-none relative" style={{ marginTop: -HORIZON_OVERLAP }}>
          <NowCard bare />
        </div>
      </div>
      <SettingsCard title="Brightness" groups={["brightness", "pinnedBrightness"]} />
      <ControllerCard />
    </div>
  );
}
