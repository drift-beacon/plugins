// Direction 2 — Ticket: the code is the hero. Everything is on one screen, ranked: the thing you take with you is
// large and ready to copy, what it is made of is two quiet chips, and the rest of the journey is three short captions.
import { ClipboardPaste, Plug, Wifi } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx.ts";
import { CodeCopy, Connected, Ingredients, Listening, NETWORK, Page, Scene, ShelfTeaser, useProto, useSetup } from "./shared.tsx";

function Leg({ n, icon, title, children }: { n: number; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="min-w-0 flex-1 space-y-1.5">
      <div className="flex items-center gap-2 text-default-500">
        <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-default-100">
          {icon}
        </span>
        <span className="text-[11px] font-semibold tabular-nums tracking-wider">0{n}</span>
      </div>
      <div className="text-sm font-semibold leading-snug">{title}</div>
      <p className="text-xs leading-snug text-default-500">{children}</p>
    </li>
  );
}

export function Ticket() {
  const { connected, phone } = useProto();
  const setup = useSetup();

  const panel = connected ? (
    <Connected />
  ) : (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold leading-tight">Connect your player</h2>
        <p className="mt-1 text-sm leading-snug text-default-500">Take this code to the player. It does the rest.</p>
      </div>

      <div className="rounded-2xl bg-content2 ring-1 ring-default-100">
        <div className="space-y-3 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-default-500">Setup code</div>
          <CodeCopy code={setup.code} size="lg" />
        </div>
        <div className="setup-tear" />
        <div className="p-4">
          <Ingredients setup={setup} />
        </div>
      </div>

      <div className="space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-default-500">Then, on your phone</div>
        <ol className={cx("flex gap-4", phone && "flex-col")}>
          <Leg n={1} icon={<Plug className="h-3.5 w-3.5" />} title="Plug it in">
            Its light breathes blue.
          </Leg>
          <Leg n={2} icon={<Wifi className="h-3.5 w-3.5" />} title="Join its Wi-Fi">
            <span className="font-mono">{NETWORK}</span>, no password.
          </Leg>
          <Leg n={3} icon={<ClipboardPaste className="h-3.5 w-3.5" />} title="Paste and Connect">
            Pick your Wi-Fi first.
          </Leg>
        </ol>
      </div>

      <Listening />
    </div>
  );

  const light = connected ? "online" : "setup";
  return (
    <Page below={<ShelfTeaser />}>
      <section aria-label="Set up your player" className="cp-stage overflow-hidden rounded-3xl">
        {phone ? (
          <div>
            <div className="mx-auto w-3/5 pt-2">
              <Scene light={light} compact />
            </div>
            <div className="p-5 pt-2">{panel}</div>
          </div>
        ) : (
          <div className="grid grid-cols-[1fr_1.1fr] items-center">
            <div className="px-4 pt-2">
              <div className="mx-auto max-w-[480px]">
                <Scene light={light} />
              </div>
            </div>
            <div className="min-w-0 py-8 pr-8 pl-2">{panel}</div>
          </div>
        )}
      </section>
    </Page>
  );
}
