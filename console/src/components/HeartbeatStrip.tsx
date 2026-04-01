import { type FC } from "react";

type Beat = "up" | "down" | "slow";

interface HeartbeatStripProps {
  beats: Beat[];
}

const beatConfig: Record<Beat, { colorClass: string; height: string; opacity: number }> = {
  up:   { colorClass: "bg-s-ok",   height: "14px", opacity: 0.55 },
  down: { colorClass: "bg-s-crit", height: "20px", opacity: 0.85 },
  slow: { colorClass: "bg-s-warn", height: "10px", opacity: 0.6 },
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
        const { colorClass, height, opacity } = beatConfig[beat];
        return (
          <div
            key={i}
            className={`w-[3px] rounded-[1px] ${colorClass}`}
            style={{ height, opacity }}
          />
        );
      })}
    </div>
  );
};

export default HeartbeatStrip;
