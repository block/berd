import { useState } from "react";

import type {
  AvatarChoice,
  AvatarState,
} from "@/features/desktop-agent/lib/avatarState";
import type { BerdyPose } from "@/features/desktop-agent/lib/berdyClips";
import { AvatarView } from "@/features/desktop-agent/ui/AvatarView";
import { BerdyView } from "@/features/desktop-agent/ui/BerdyView";

/** Keep the outgoing renderer until the incoming one has real pixels. */
export function AgentAvatar({
  character,
  choice,
  state,
  target,
  hidden,
}: {
  character: boolean;
  choice: AvatarChoice;
  state: AvatarState;
  target: BerdyPose;
  hidden: boolean;
}) {
  // Even an initially enabled character must warm before replacing the chip.
  const [presented, setPresented] = useState(false);
  const switching = presented !== character;
  return (
    <div style={{ position: "relative", width: 92, height: 92 }}>
      {(!presented || !character) && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: presented ? 0 : 1,
          }}
        >
          <AvatarView
            choice={choice}
            state={state}
            size={92}
            onReady={() => {
              if (switching && !character) setPresented(false);
            }}
          />
        </div>
      )}
      {(presented || character) && (
        <div
          style={{ position: "absolute", inset: 0, opacity: presented ? 1 : 0 }}
        >
          <BerdyView
            target={target}
            errored={state === "error"}
            hidden={hidden}
            size={92}
            onReady={() => {
              if (switching && character) setPresented(true);
            }}
          />
        </div>
      )}
    </div>
  );
}
