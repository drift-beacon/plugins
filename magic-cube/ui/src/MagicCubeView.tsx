import { LayoutGroup, motion } from "motion/react";
import { CubeEditor } from "./components/setup/CubeEditor";
import { useMediaQuery } from "./components/setup/live";
import { PhoneView } from "./components/setup/PhoneView";
import { PresetTray } from "./components/setup/PresetTray";
import { useTiming } from "./components/setup/preset-controls";
import { useWorkspace } from "./components/setup/workspace";
import "./components/setup/setup.css";

export function MagicCubeView() {
  const ws = useWorkspace();
  const timing = useTiming();
  const phone = useMediaQuery("(max-width: 599px)");
  if (phone) return <PhoneView ws={ws} />;
  return <LayoutGroup><div className="ps-study mx-auto max-w-[1072px]">
    {ws.error && <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-danger/10 p-3 text-sm text-danger"><span>{ws.error}</span><button onClick={ws.clearError} aria-label="Dismiss error">Dismiss</button></div>}
    <PresetTray ws={ws} />
    <motion.div layout="position" transition={timing}><CubeEditor ws={ws} /></motion.div>
  </div></LayoutGroup>;
}
