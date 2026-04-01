import { type FC } from "react";

type Beat = "up" | "down" | "slow";

interface HeartbeatStripProps {
  beats: Beat[];
}

const beatConfig: Record<Beat, { colorClass: string; heightClass: string }> = {
  up:   { colorClass: "bg-s-ok",   heightClass: "h-5" },
  down: { colorClass: "bg-s-crit", heightClass: "h-5" },
  slow: { colorClass: "bg-s-warn", heightClass: "h-[10px]" },
};

const STRIP_LENGTH = 20;

const HeartbeatStrip: FC<HeartbeatStripProps> = ({ beats }) => {
  // Design system: always 20 bars. Pad with 'up' if shorter, truncate if longer.
  const normalized: Beat[] = beats.length >= STRIP_LENGTH
    ? beats.slice(-STRIP_LENGTH)
    : [...Array<Beat>(STRIP_LENGTH - beats.length).fill('up'), ...beats];

  return (
    <div className="flex gap-[1px] h-5 items-end">
      {normalized.map((beat, i) => {
        const { colorClass, heightClass } = beatConfig[beat];
        return (
          <div
            key={i}
            className={`w-[3px] rounded-[1px] ${colorClass} ${heightClass}`}
          />
        );
      })}
    </div>
  );
};

export default HeartbeatStrip;
