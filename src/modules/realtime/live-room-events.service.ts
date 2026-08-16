/**
 * Single shared "message created" side-effect path for Event Chat / live-room
 * messages, mirroring chat-events.service.ts's role for DM/group messages:
 * both the REST controller and the Socket.IO gateway create a message
 * through this one function, so persistence and realtime broadcast happen
 * exactly once regardless of entry point (previously, REST-created live-room
 * messages persisted but never broadcast — see live-room.controller.ts).
 *
 * Unlike chat-events.service.ts, there is no dual-transport concern here:
 * Event Chat's realtime delivery lives solely on the Socket.IO gateway
 * (registerLiveRoomBroadcastTarget is set exactly once, by
 * socketio.gateway.ts's attach()). The legacy raw-ws live:* handlers in
 * realtime.gateway.ts are unrelated — they back the separate standalone
 * Live Room (audio room) feature and call LiveRoomService.createMessage
 * directly, not this module.
 */
import type { AuthUser } from "../auth/auth.interface.js";
import type { CreateLiveRoomMessageDto, LiveRoomMessageResponse } from "../live-rooms/live-room.interface.js";
import { LiveRoomService } from "../live-rooms/live-room.service.js";

const liveRoomService = new LiveRoomService();

export type LiveRoomBroadcastTarget = {
  broadcast(liveRoomId: string, event: string, payload: unknown): void;
};

let broadcastTarget: LiveRoomBroadcastTarget | null = null;

export const registerLiveRoomBroadcastTarget = (target: LiveRoomBroadcastTarget): void => {
  broadcastTarget = target;
};

export const createLiveRoomMessageWithSideEffects = async (
  sender: AuthUser,
  liveRoomId: string,
  payload: CreateLiveRoomMessageDto,
): Promise<LiveRoomMessageResponse> => {
  const savedMessage = await liveRoomService.createMessage(sender, liveRoomId, payload);

  broadcastTarget?.broadcast(liveRoomId, "live:message", {
    liveRoomId,
    message: savedMessage,
  });

  return savedMessage;
};
