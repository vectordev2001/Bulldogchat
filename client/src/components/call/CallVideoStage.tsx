/**
 * CallVideoStage — renders the participant tiles for the active call in one
 * of three layouts: Grid (equal tiles), Speaker (active speaker large with a
 * filmstrip), or Sidebar (one large tile + small thumbnails column).
 */
import { CallTile } from "./CallTile";
import type { RoomParticipantState } from "@/lib/useLiveKitRoom";

export type CallLayout = "grid" | "speaker" | "sidebar";

export interface StageParticipant {
  key: string;
  name: string;
  hue: number;
  participant: RoomParticipantState | null;
  isMe: boolean;
  muted?: boolean;
  videoOff?: boolean;
}

export function CallVideoStage({
  layout,
  me,
  others,
}: {
  layout: CallLayout;
  me: StageParticipant;
  others: StageParticipant[];
}) {
  const all = [...others, me];

  // Pick the focused participant: first remote that's speaking, else first
  // remote, else me (solo call).
  const speaking = others.find((o) => o.participant?.isSpeaking && !o.participant?.micMuted);
  const focused = speaking ?? others[0] ?? me;
  const rest = all.filter((p) => p.key !== focused.key);

  if (layout === "grid") {
    const cols = all.length <= 1 ? 1 : all.length <= 4 ? 2 : 3;
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div
          className="w-full max-w-5xl grid gap-3"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {all.map((p) => (
            <div key={p.key} className="aspect-video">
              <CallTile {...p} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (layout === "speaker") {
    return (
      <div className="w-full h-full flex flex-col gap-3 p-1">
        <div className="flex-1 min-h-0">
          <CallTile {...focused} />
        </div>
        {rest.length > 0 && (
          <div className="h-24 shrink-0 flex gap-2 overflow-x-auto">
            {rest.map((p) => (
              <div key={p.key} className="h-full aspect-video shrink-0">
                <CallTile {...p} compact />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // sidebar
  return (
    <div className="w-full h-full flex gap-3 p-1">
      <div className="flex-1 min-h-0">
        <CallTile {...focused} />
      </div>
      {rest.length > 0 && (
        <div className="w-40 shrink-0 flex flex-col gap-2 overflow-y-auto">
          {rest.map((p) => (
            <div key={p.key} className="w-full aspect-video shrink-0">
              <CallTile {...p} compact />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
