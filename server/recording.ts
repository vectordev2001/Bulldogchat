// LiveKit egress integration for call recording. All operations are best-effort —
// if LiveKit Cloud isn't configured (or egress fails), we log and return.

import { storage } from "./storage";

function recordingsBucket(): string | null { return process.env.S3_BUCKET || null; }
function liveKitEgressConfigured(): boolean {
  return !!(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET && process.env.LIVEKIT_WS_URL);
}

export function recordingStorageConfigured(): boolean {
  return !!(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY);
}

export interface StartRecordingOpts {
  channelId: number;
  channelName: string;
  startedByUserId: number;
  roomName: string;
}

export async function startRoomRecording(opts: StartRecordingOpts) {
  const existing = storage.getActiveRecordingForChannel(opts.channelId);
  if (existing) return { recording: existing, started: false as const };

  if (!liveKitEgressConfigured() || !recordingStorageConfigured()) {
    // Create a stub recording row so the UI shows REC, even without S3 + egress.
    const rec = storage.createRecording({
      channelId: opts.channelId,
      startedByUserId: opts.startedByUserId,
      egressId: null,
    });
    storage.updateRecording(rec.id, { status: "failed" });
    return { recording: rec, started: false as const, reason: "Recording requires LiveKit Cloud + S3 storage" };
  }

  try {
    const sdk = await import("livekit-server-sdk");
    const EgressClient = (sdk as any).EgressClient;
    const EncodedFileType = (sdk as any).EncodedFileType ?? { MP4: 1 };
    const wsToHttp = (process.env.LIVEKIT_WS_URL || "").replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");

    const client = new EgressClient(wsToHttp, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filepath = `recordings/channel-${opts.channelId}/${ts}.mp4`;
    const output = {
      fileType: EncodedFileType.MP4 ?? 1,
      filepath,
      s3: {
        accessKey: process.env.S3_ACCESS_KEY!,
        secret: process.env.S3_SECRET_KEY!,
        region: process.env.S3_REGION || "us-east-1",
        bucket: recordingsBucket()!,
        endpoint: process.env.S3_ENDPOINT || undefined,
        forcePathStyle: !!process.env.S3_ENDPOINT,
      },
    };

    const info = await client.startRoomCompositeEgress(opts.roomName, { file: output }, { layout: "grid" });
    const egressId: string | undefined = info?.egressId;
    const rec = storage.createRecording({
      channelId: opts.channelId,
      startedByUserId: opts.startedByUserId,
      egressId: egressId ?? null,
    });
    storage.updateRecording(rec.id, { storageKey: filepath });
    return { recording: { ...rec, egressId, storageKey: filepath }, started: true as const };
  } catch (err: any) {
    console.warn("[recording] startRoomCompositeEgress failed:", err?.message ?? err);
    const rec = storage.createRecording({
      channelId: opts.channelId,
      startedByUserId: opts.startedByUserId,
      egressId: null,
    });
    storage.updateRecording(rec.id, { status: "failed" });
    return { recording: rec, started: false as const, reason: err?.message ?? "egress failed" };
  }
}

export async function stopRecording(recordingId: number) {
  const rec = storage.getRecording(recordingId);
  if (!rec || rec.status !== "recording") return rec;
  if (rec.egressId && liveKitEgressConfigured()) {
    try {
      const sdk = await import("livekit-server-sdk");
      const EgressClient = (sdk as any).EgressClient;
      const wsToHttp = (process.env.LIVEKIT_WS_URL || "").replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
      const client = new EgressClient(wsToHttp, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);
      await client.stopEgress(rec.egressId);
    } catch (err: any) {
      console.warn("[recording] stopEgress failed:", err?.message ?? err);
    }
  }
  // Mark as processing — webhook will finalize.
  const updated = storage.updateRecording(rec.id, { status: "processing", endedAt: new Date() });
  return updated ?? rec;
}
