// Direction 4 — Storyboard: the journey laid out by place, left to right: this screen, your phone, the player. Pictures
// carry what the prose used to (which network to pick, where the code goes, what the light does), and each place has
// one short caption.
import { ArrowDown, ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx.ts";
import { CodeCopy, Connected, Ingredients, Listening, NETWORK, Page, PhoneMock, Scene, ShelfTeaser, useProto, useSetup } from "./shared.tsx";

function Place({ n, where, title, children, className }: { n: number; where: string; title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-w-0 flex-col", className)}>
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-default-500">
        <span aria-hidden="true" className="grid h-5 w-5 place-items-center rounded-full bg-default-100 text-[10px] tabular-nums tracking-normal">
          {n}
        </span>
        {where}
      </div>
      <div className="grid min-h-0 flex-1 place-items-center py-4">{children}</div>
      <p className="text-sm font-medium leading-snug">{title}</p>
    </div>
  );
}

function Then({ phone }: { phone: boolean }) {
  const Icon = phone ? ArrowDown : ArrowRight;
  return (
    <div aria-hidden="true" className={cx("grid shrink-0 place-items-center text-default-300", phone ? "py-1" : "px-1")}>
      <Icon className="h-5 w-5" />
    </div>
  );
}

export function Storyboard() {
  const { connected, phone } = useProto();
  const setup = useSetup();
  const light = connected ? "online" : "setup";

  return (
    <Page below={<ShelfTeaser />}>
      <section aria-label="Set up your player" className={cx("cp-stage overflow-hidden rounded-3xl", phone ? "p-5" : "p-8")}>
        <div className={cx("flex items-end justify-between gap-6", phone && "flex-col items-start gap-2")}>
          {connected ? (
            <Connected />
          ) : (
            <div>
              <h2 className="text-2xl font-bold leading-tight">Connect your player</h2>
              <p className="mt-1 text-sm leading-snug text-default-500">One code, carried from this screen to the player by your phone.</p>
            </div>
          )}
          <Listening className="shrink-0" />
        </div>

        <div className={cx("mt-6 flex", phone ? "flex-col gap-2" : "items-stretch gap-3")}>
          <Place n={1} where="On this screen" title="Copy the setup code" className={phone ? "" : "flex-[1.25]"}>
            <div className="w-full space-y-3">
              <CodeCopy code={setup.code} label="Copy" />
              <Ingredients setup={setup} />
            </div>
          </Place>
          <Then phone={phone} />
          <Place
            n={2}
            where="On your phone"
            title={
              <>
                Join <span className="whitespace-nowrap font-mono">{NETWORK}</span>, then paste and Connect
              </>
            }
            className={phone ? "" : "flex-1"}
          >
            <div className="flex items-end gap-3">
              <PhoneMock screen="wifi" className="origin-bottom scale-90 opacity-70" />
              <PhoneMock screen="page" />
            </div>
          </Place>
          <Then phone={phone} />
          <Place n={3} where="The player" title={connected ? "Its light is steady: it's online" : "Its light breathes blue until it's connected"} className={phone ? "" : "flex-1"}>
            <div className="w-full max-w-[300px]">
              <Scene light={light} compact />
            </div>
          </Place>
        </div>
      </section>
    </Page>
  );
}
