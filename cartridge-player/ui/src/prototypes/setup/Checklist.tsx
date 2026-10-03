// Direction 3 — Checklist: the whole journey is visible as five short lines, and only the one you're on is open. Done
// lines tick themselves (the hub's address when the page already knows it, the last one when the player reports), so
// the list reads as progress rather than as instructions.
import { Check } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "../../components/kit.tsx";
import { cx } from "../../lib/cx.ts";
import { CodeCopy, Connected, HubFields, KeyField, NETWORK, Page, PLAYER_NAME, Scene, useProto, useSetup } from "./shared.tsx";

type ItemId = "hub" | "key" | "code" | "phone" | "online";

interface Item {
  readonly id: ItemId;
  readonly title: string;
  readonly done: boolean;
  /** What a finished line says it settled on. */
  readonly summary?: ReactNode;
  readonly body?: ReactNode;
}

export function Checklist() {
  const { connected, phone } = useProto();
  const setup = useSetup();
  const [hubConfirmed, setHubConfirmed] = useState(setup.hubKnown);
  const [keyDecided, setKeyDecided] = useState(false);
  const [copied, setCopied] = useState(false);
  // A finished line reopened by hand; otherwise the first unfinished one is open.
  const [reopened, setReopened] = useState<ItemId | null>(null);

  const items: Item[] = [
    {
      id: "hub",
      title: "Hub address",
      done: hubConfirmed && setup.hubKnown,
      summary: (
        <span className="font-mono">
          {setup.host.trim()}:{setup.port.trim()}
        </span>
      ),
      body: (
        <div className="space-y-2.5">
          <HubFields setup={setup} />
          <Button
            size="sm"
            tone="primary"
            disabled={!setup.hubKnown}
            onClick={() => {
              setHubConfirmed(true);
              setReopened(null);
            }}
          >
            Use this address
          </Button>
        </div>
      ),
    },
    {
      id: "key",
      title: "API key",
      done: keyDecided,
      summary: setup.hasKey ? "Included in the code" : "Skipped: the player will ask",
      body: (
        <div className="space-y-2.5">
          <KeyField setup={setup} hideLabel hint="Make one under Workspace settings → API Keys. It stays on this page." />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              tone="primary"
              disabled={!setup.hasKey}
              onClick={() => {
                setKeyDecided(true);
                setReopened(null);
              }}
            >
              Add to the code
            </Button>
            <Button
              size="sm"
              tone="light"
              onClick={() => {
                setup.setKey("");
                setKeyDecided(true);
                setReopened(null);
              }}
            >
              Skip
            </Button>
          </div>
        </div>
      ),
    },
    {
      id: "code",
      title: "Copy the setup code",
      done: copied,
      summary: "Copied",
      body: (
        <div className="space-y-2">
          <CodeCopy
            code={setup.code}
            onCopied={() => {
              setCopied(true);
              setReopened(null);
            }}
          />
          <p className="text-xs leading-snug text-default-500">Do this before the next step: on the player's Wi-Fi, your phone can't reach this page.</p>
        </div>
      ),
    },
    {
      id: "phone",
      title: "Set the player up from your phone",
      done: connected,
      summary: "Done",
      body: (
        <p className="text-sm leading-snug text-default-500">
          Plug the player in (its light breathes blue), join the Wi-Fi{" "}
          <span className="whitespace-nowrap font-mono text-foreground">{NETWORK}</span>, pick your own Wi-Fi, paste the code and press Connect.
        </p>
      ),
    },
    {
      id: "online",
      title: connected ? `${PLAYER_NAME} is online` : "Player online",
      done: connected,
    },
  ];

  const current = items.find((item) => !item.done)?.id ?? null;
  const open = reopened ?? current;

  const list = (
    <ol>
      {items.map((item, i) => {
        const isOpen = open === item.id && item.body !== undefined;
        const isCurrent = current === item.id;
        const last = i === items.length - 1;
        return (
          <li key={item.id} className={cx("relative flex gap-3", !last && "pb-4")}>
            {!last && (
              <span
                aria-hidden="true"
                className={cx("absolute top-7 bottom-0.5 left-[11px] w-px", item.done ? "bg-success/50" : "bg-default-200")}
              />
            )}
            <span
              aria-hidden="true"
              className={cx(
                "mt-px grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums transition-colors duration-200",
                item.done
                  ? "bg-success text-success-foreground"
                  : isCurrent
                    ? "bg-background text-foreground ring-2 ring-primary"
                    : "bg-default-100 text-default-400",
              )}
            >
              {item.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <button
                type="button"
                disabled={!item.done || item.body === undefined || connected}
                onClick={() => setReopened((r) => (r === item.id ? null : item.id))}
                className={cx(
                  "flex w-full items-baseline justify-between gap-3 text-left",
                  item.done && item.body !== undefined && !connected && "cursor-pointer hover:text-foreground",
                )}
              >
                <span
                  className={cx(
                    "text-sm leading-6",
                    isCurrent ? "font-semibold" : item.done ? "text-default-600" : "text-default-400",
                    isCurrent && item.id === "online" && "font-normal text-default-400",
                  )}
                >
                  {item.title}
                </span>
                {item.done && !isOpen && item.summary && <span className="truncate text-xs text-default-500">{item.summary}</span>}
              </button>
              {isOpen && !connected && <div className="pt-2 pb-1">{item.body}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );

  const panel = connected ? (
    <div className="space-y-6">
      <Connected />
      {list}
    </div>
  ) : (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold leading-tight">Set up your player</h2>
        <p className="mt-1 text-sm leading-snug text-default-500">Once, and then the cartridges do the rest.</p>
      </div>
      {list}
    </div>
  );

  const light = connected ? "online" : current === "phone" ? "setup" : "off";
  return (
    <Page>
      <section aria-label="Set up your player" className="cp-stage overflow-hidden rounded-3xl">
        {phone ? (
          <div>
            <div className="mx-auto w-3/5 pt-2">
              <Scene light={light} compact />
            </div>
            <div className="p-5 pt-2">{panel}</div>
          </div>
        ) : (
          <div className="grid grid-cols-[1.1fr_1fr] items-center">
            <div className="px-4 pt-2">
              <div className="mx-auto max-w-[520px]">
                <Scene light={light} />
              </div>
            </div>
            <div className="flex min-h-[420px] min-w-0 flex-col justify-center py-8 pr-8 pl-2">{panel}</div>
          </div>
        )}
      </section>
    </Page>
  );
}
