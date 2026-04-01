import { type FC, useState } from "react";
import { Pause, Play } from "lucide-react";

type Mode = "passive" | "chat" | "agent";

interface FeedEvent {
  time: string;
  mode: Mode;
  text: string;
  isError?: boolean;
}

interface ActivityFeedProps {
  events: FeedEvent[];
}

const modeDotColor: Record<Mode, string> = {
  passive: "bg-m-pas",
  chat: "bg-m-cht",
  agent: "bg-m-agt",
};

const ActivityFeed: FC<ActivityFeedProps> = ({ events }) => {
  const [paused, setPaused] = useState(false);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--b1)" }}
      >
        <span
          className="font-mono uppercase text-t4 font-medium"
          style={{ fontSize: "0.65rem", letterSpacing: "0.08em" }}
        >
          Live Activity
        </span>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="flex items-center gap-1 text-t5 hover:text-t3 font-mono transition-colors duration-200 cursor-pointer"
          style={{ fontSize: "0.65rem" }}
        >
          {paused ? <Play size={12} /> : <Pause size={12} />}
          {paused ? "resume" : "pause"}
        </button>
      </div>

      {/* Feed items */}
      <div className="flex-1 overflow-y-auto">
        {events.map((event, i) => {
          const isErr = event.isError;
          return (
            <div
              key={i}
              className={`
                flex items-start transition-colors duration-150
                ${isErr ? "" : "hover:bg-d4"}
              `}
              style={{
                gap: "10px",
                padding: "6px 0",
                borderBottom: "1px solid var(--b1)",
                fontSize: "0.72rem",
                ...(isErr
                  ? { backgroundColor: "rgba(252,129,129,0.08)" }
                  : {}),
              }}
            >
              {/* Time */}
              <span
                className={`font-mono flex-shrink-0 ${isErr ? "text-s-crit" : "text-t5"}`}
                style={{ fontSize: "0.6rem", lineHeight: "1.4", minWidth: "36px" }}
              >
                {event.time}
              </span>

              {/* Mode dot */}
              <span
                className={`inline-block rounded-full flex-shrink-0 mt-[5px] ${
                  isErr ? "bg-s-crit" : modeDotColor[event.mode]
                }`}
                style={{ width: "6px", height: "6px" }}
              />

              {/* Text */}
              <span
                className={`font-mono leading-snug ${isErr ? "text-s-crit" : "text-t3"}`}
                style={{ fontSize: "0.72rem" }}
              >
                {event.text}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ActivityFeed;
