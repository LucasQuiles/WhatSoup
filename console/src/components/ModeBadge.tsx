import { type FC } from "react";

type Mode = "passive" | "chat" | "agent";

interface ModeBadgeProps {
  mode: Mode;
}

const config: Record<Mode, { label: string; textClass: string; dotClass: string; washVar: string }> = {
  passive: {
    label: "passive",
    textClass: "text-m-pas",
    dotClass: "bg-m-pas",
    washVar: "var(--m-pas-soft)",
  },
  chat: {
    label: "chat",
    textClass: "text-m-cht",
    dotClass: "bg-m-cht",
    washVar: "var(--m-cht-soft)",
  },
  agent: {
    label: "agent",
    textClass: "text-m-agt",
    dotClass: "bg-m-agt",
    washVar: "var(--m-agt-soft)",
  },
};

const ModeBadge: FC<ModeBadgeProps> = ({ mode }) => {
  const { label, textClass, dotClass, washVar } = config[mode];

  return (
    <span
      className={`text-[var(--font-size-label)] inline-flex items-center gap-1.5 font-mono font-medium rounded-sm tracking-[var(--tracking-pill)] ${textClass}`}
      style={{
        padding: "var(--sp-0h) var(--sp-2h) var(--sp-0h) var(--sp-2)",
        backgroundColor: washVar,
      }}
    >
      <span
        className={`inline-block rounded-full flex-shrink-0 w-[var(--dot-badge)] h-[var(--dot-badge)] ${dotClass}`}
      />
      {label}
    </span>
  );
};

export default ModeBadge;
