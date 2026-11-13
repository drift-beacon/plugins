import { ControllerCard } from "../ControllerCard.tsx";
import { NowCard } from "../NowCard.tsx";
import { SettingsCard } from "../SettingsPanel.tsx";
import { Starfield } from "../Starfield.tsx";
import { Horizon, HORIZON_OVERLAP } from "../wall/Horizon.tsx";
import { LitWall } from "../wall/LitWall.tsx";
import { ZoneCards } from "../zones/ZoneCards.tsx";

/**
 * The phone's everyday tab, as the board's wall: the wall lit in a patch of night sky (its numbers are the Order
 * tab's), its light lying under it as a horizon with what it shows now sitting on the line, then the two brightnesses
 * and the controller. Tapping the wall opens the Order tab, where the drawing is full size. On a split wall the zone
 * cards sit under the wall in place of what it shows now (and of "This wall follows" in the controller card).
 */
export function WallTab({ onOpenWall, split }: { onOpenWall(): void; split: boolean }) {
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
        {/* Over the wall's foot only as words and light: a press there still opens the wall. On a split wall what
            shows now is each zone card's, under the wall. */}
        {!split && (
          <div className="pointer-events-none relative" style={{ marginTop: -HORIZON_OVERLAP }}>
            <NowCard bare />
          </div>
        )}
      </div>
      {/* Mounted while unsplit too (it renders nothing then), so a zone removed under focus can hand it on. */}
      <ZoneCards className="relative pt-2" />
      <SettingsCard title="Brightness" groups={["brightness", "pinnedBrightness"]} />
      <ControllerCard />
    </div>
  );
}
