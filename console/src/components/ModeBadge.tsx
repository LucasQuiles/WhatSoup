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
      className={`inline-flex items-center gap-1.5 font-mono font-medium ${textClass}`}
      style={{
        fontSize: "0.65rem",
        letterSpacing: "0.03em",
        padding: "2px 10px 2px 8px",
        borderRadius: "3px",
        backgroundColor: washVar,
      }}
    >
      <span
        className={`inline-block rounded-full flex-shrink-0 ${dotClass}`}
        style={{ width: "5px", height: "5px" }}
      />
      {label}
    </span>
  );
};

export default ModeBadge;
