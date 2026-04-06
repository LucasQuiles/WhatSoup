import { type FC } from "react";

type Beat = "up" | "down" | "slow";

interface HeartbeatStripProps {
  beats: Beat[];
}

const beatConfig: Record<Beat, { colorClass: string; height: string; opacity: string }> = {
  up:   { colorClass: "bg-s-ok",   height: "var(--dot-header)", opacity: "var(--opacity-disabled)" },
  down: { colorClass: "bg-s-crit", height: "var(--sep-h)", opacity: "var(--opacity-muted)" },
  slow: { colorClass: "bg-s-warn", height: "var(--dot-header)", opacity: "var(--opacity-muted)" },
};

const STRIP_LENGTH = 20;

const HeartbeatStrip: FC<HeartbeatStripProps> = ({ beats }) => {
  // Design system: always 20 bars. Pad with 'up' if shorter, truncate if longer.
  const normalized: Beat[] = beats.length >= STRIP_LENGTH
    ? beats.slice(-STRIP_LENGTH)
    : [...Array<Beat>(STRIP_LENGTH - beats.length).fill('up'), ...beats];

  return (
    <div
      className="flex gap-[var(--bw)] h-5 items-end"
      role="img"
      aria-label={`Health: ${beats.filter(b => b === 'up').length} of ${beats.length} heartbeats healthy`}
    >
      {normalized.map((beat, i) => {
        const { colorClass, height, opacity } = beatConfig[beat];
        return (
          <div
            key={i}
            className={`w-[var(--bw-accent)] rounded-sm ${colorClass}`}
            style={{ height, opacity: opacity as unknown as React.CSSProperties['opacity'] }}
          />
        );
      })}
    </div>
  );
};

export default HeartbeatStrip;
