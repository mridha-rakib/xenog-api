import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { AppError } from "../src/core/errors/app-error.js";
import type { AuthUser } from "../src/modules/auth/auth.interface.js";
import { EventChatAccessService } from "../src/modules/events/event-chat-access.service.js";
import { LiveRoomService } from "../src/modules/live-rooms/live-room.service.js";
import { RealtimeGateway } from "../src/modules/realtime/realtime.gateway.js";

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const eventId = new Types.ObjectId();
const hostId = new Types.ObjectId();
const attendeeId = new Types.ObjectId();
const otherUserId = new Types.ObjectId();
const orderId = new Types.ObjectId();
const shareId = new Types.ObjectId();
const usageId = new Types.ObjectId();
const ticketId = "ticket-general";
const now = new Date("2026-07-08T20:30:00.000Z");

const attendee: AuthUser = {
  id: attendeeId.toString(),
  name: "Checked Attendee",
  username: "checked",
  email: "checked@example.com",
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const event = {
  _id: eventId,
  userId: hostId,
  status: "live",
  name: "Event Chat",
  description: null,
  bannerImageKey: null,
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Music",
  categories: ["Music"],
  scheduledAt: new Date("2026-07-08T20:00:00.000Z"),
  endAt: new Date("2026-07-08T22:00:00.000Z"),
  location: null,
  tickets: [
    { id: ticketId, name: "General", description: null, type: "paid", price: 10, capacity: 100 },
  ],
  rewards: [],
  privacy: "public",
  memberUserIds: [],
  joinRequests: [],
  publishedAt: now,
  startedAt: now,
  completedAt: null,
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
};

const attendance = {
  _id: usageId,
  ownerUserId: attendeeId,
  holderUserId: attendeeId,
  usedByUserId: hostId,
  shareId: null,
  orderId,
  eventId: eventId.toString(),
  ticketId,
  ticketIndex: 1,
  source: "owned",
  usedAt: now,
  createdAt: now,
  updatedAt: now,
};

const order = {
  _id: orderId,
  userId: attendeeId,
  kind: "ticket",
  paymentMethod: "card",
  paymentStatus: "paid",
  payoutStatus: "held",
  currency: "usd",
  subtotalAmount: 1000,
  platformFeeAmount: 0,
  taxAmount: 0,
  totalAmount: 1000,
  amountMinor: 1000,
  lineItems: [
    {
      itemType: "ticket",
      itemId: ticketId,
      eventId: eventId.toString(),
      name: "General",
      quantity: 1,
      unitAmount: 1000,
      totalAmount: 1000,
    },
  ],
  ticketPasses: [
    {
      eventId: eventId.toString(),
      ticketId,
      ticketIndex: 1,
      checkInCode: "MOM-26-AAAA-BBBB",
    },
  ],
  anonymous: false,
  createdAt: now,
  updatedAt: now,
};

const activeShare = {
  _id: shareId,
  ownerUserId: otherUserId,
  recipientUserId: attendeeId,
  orderId,
  eventId: eventId.toString(),
  ticketId,
  ticketIndex: 1,
  status: "active",
  sharedAt: now,
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
};

const createAccessService = (
  overrides: {
    event?: unknown;
    attendance?: unknown;
    order?: unknown;
    activeShare?: unknown;
  } = {},
) => {
  const hasOverride = (key: keyof typeof overrides) =>
    Object.prototype.hasOwnProperty.call(overrides, key);
  const eventRepository = {
    findById: async () => (hasOverride("event") ? overrides.event : event),
  };
  const checkoutPaymentRepository = {
    findById: async () => (hasOverride("order") ? overrides.order : order),
  };
  const ticketShareRepository = {
    findActiveByTicketPass: async () => (hasOverride("activeShare") ? overrides.activeShare : null),
  };
  const ticketUsageRepository = {
    findByEventIdAndHolderUserId: async () =>
      hasOverride("attendance") ? overrides.attendance : attendance,
  };

  return new EventChatAccessService(
    eventRepository as never,
    checkoutPaymentRepository as never,
    ticketShareRepository as never,
    ticketUsageRepository as never,
  );
};

const assertForbidden = async (fn: () => Promise<unknown>) => {
  await assert.rejects(fn, (error) => error instanceof AppError && error.statusCode === 403);
};

test("checked-in attendee can access public event chat during active event", async () => {
  const service = createAccessService();
  const result = await service.assertEventChatAccess(
    eventId.toString(),
    attendeeId.toString(),
    now,
  );

  assert.equal(result.event._id.toString(), eventId.toString());
  assert.equal(result.attendance._id.toString(), usageId.toString());
});

test("checked-in attendee can access private and locked event chat by the same rule", async () => {
  for (const privacy of ["private", "locked", "public"] as const) {
    const service = createAccessService({ event: { ...event, privacy, memberUserIds: [] } });
    const result = await service.assertEventChatAccess(
      eventId.toString(),
      attendeeId.toString(),
      now,
    );

    assert.equal(result.event.privacy, privacy);
  }
});

test("shared checked-in attendee can access chat only while the share is active for the same ticket pass", async () => {
  const service = createAccessService({
    attendance: {
      ...attendance,
      ownerUserId: otherUserId,
      holderUserId: attendeeId,
      shareId,
      source: "shared",
    },
    order: {
      ...order,
      userId: otherUserId,
    },
    activeShare,
  });

  const result = await service.assertEventChatAccess(
    eventId.toString(),
    attendeeId.toString(),
    now,
  );

  assert.equal(result.attendance.source, "shared");
});

test("paid ticket holder without check-in cannot access event chat", async () => {
  const service = createAccessService({ attendance: null });

  await assertForbidden(() =>
    service.assertEventChatAccess(eventId.toString(), attendeeId.toString(), now),
  );
});

test("non-attendee authenticated user cannot access event chat by event id", async () => {
  const service = createAccessService({ attendance: null, order: null });

  await assertForbidden(() =>
    service.assertEventChatAccess(eventId.toString(), otherUserId.toString(), now),
  );
});

test("completed, cancelled, and ended events reject event chat access", async () => {
  await assertForbidden(() =>
    createAccessService({
      event: { ...event, status: "completed", completedAt: now },
    }).assertEventChatAccess(eventId.toString(), attendeeId.toString(), now),
  );
  await assertForbidden(() =>
    createAccessService({
      event: { ...event, status: "cancelled", cancelledAt: now },
    }).assertEventChatAccess(eventId.toString(), attendeeId.toString(), now),
  );
  await assertForbidden(() =>
    createAccessService({
      event: { ...event, endAt: new Date("2026-07-08T20:30:00.000Z") },
    }).assertEventChatAccess(eventId.toString(), attendeeId.toString(), now),
  );
});

test("event chat access rejects invalid checked-in ticket context", async () => {
  await assertForbidden(() =>
    createAccessService({ order: { ...order, paymentStatus: "refunded" } }).assertEventChatAccess(
      eventId.toString(),
      attendeeId.toString(),
      now,
    ),
  );
  await assertForbidden(() =>
    createAccessService({
      activeShare: { ...activeShare, recipientUserId: otherUserId },
    }).assertEventChatAccess(eventId.toString(), attendeeId.toString(), now),
  );
});

const createLiveRoomService = (
  overrides: {
    accessError?: Error;
    liveRoom?: unknown;
  } = {},
) => {
  const liveRoom = overrides.liveRoom ?? {
    _id: eventId,
    hostUserId: hostId,
    title: "Event Chat",
    allowAllParticipantsToSpeak: true,
    speakerIds: [],
    status: "live",
    createdAt: now,
    updatedAt: now,
  };
  const liveRoomRepository = {
    findById: async () => liveRoom,
  };
  const participantRepository = {
    join: async () => ({}),
    findActiveByLiveRoomId: async () => [],
    countActiveByLiveRoomId: async () => 0,
  };
  const messageRepository = {
    findByLiveRoomId: async () => [
      {
        _id: new Types.ObjectId(),
        liveRoomId: eventId,
        senderId: attendeeId,
        text: "Hello",
        createdAt: now,
        updatedAt: now,
      },
    ],
    create: async (payload: { text: string }) => ({
      _id: new Types.ObjectId(),
      liveRoomId: eventId,
      senderId: attendeeId,
      text: payload.text,
      createdAt: now,
      updatedAt: now,
    }),
  };
  const userRepository = {
    findById: async () => null,
  };
  const storageService = {
    createDownloadUrl: async () => ({ url: "" }),
  };
  const eventChatAccessService = {
    assertEventChatAccess: async () => {
      if (overrides.accessError) {
        throw overrides.accessError;
      }
    },
  };

  return new LiveRoomService(
    liveRoomRepository as never,
    participantRepository as never,
    messageRepository as never,
    userRepository as never,
    storageService as never,
    eventChatAccessService as never,
  );
};

test("checked-in attendee can fetch history and send during active event", async () => {
  const service = createLiveRoomService();

  const messages = await service.listMessages(attendee, eventId.toString(), { limit: 50 });
  const created = await service.createMessage(attendee, eventId.toString(), { text: "Hi" });

  assert.equal(messages.length, 1);
  assert.equal(created.text, "Hi");
});

test("paid ticket holder without check-in cannot fetch history or send", async () => {
  const service = createLiveRoomService({
    accessError: new AppError("Check in to join event chat.", 403),
  });

  await assertForbidden(() => service.listMessages(attendee, eventId.toString(), { limit: 50 }));
  await assertForbidden(() => service.createMessage(attendee, eventId.toString(), { text: "Hi" }));
});

const createSocket = () => {
  const sent: unknown[] = [];
  return {
    socket: {
      readyState: 1,
      send: (payload: string) => sent.push(JSON.parse(payload)),
    },
    sent,
  };
};

const createGateway = (
  overrides: {
    accessError?: Error;
    messageError?: Error;
  } = {},
) => {
  const liveRoomService = {
    assertEventChatAccess: async () => {
      if (overrides.accessError) {
        throw overrides.accessError;
      }
    },
    createMessage: async () => {
      if (overrides.messageError) {
        throw overrides.messageError;
      }

      return {
        id: new Types.ObjectId().toString(),
        liveRoomId: eventId.toString(),
        senderId: attendee.id,
        senderName: attendee.name,
        senderAvatarUrl: null,
        text: "Hello",
        createdAt: now,
        updatedAt: now,
      };
    },
  };

  return new RealtimeGateway(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    liveRoomService as never,
    { findMutualFriendIds: async () => [] } as never,
  );
};

const createRealtimeClient = () => {
  const { socket, sent } = createSocket();
  return {
    client: {
      isAlive: true,
      liveRooms: new Set<string>(),
      socket,
      user: attendee,
    },
    sent,
  };
};

test("checked-in attendee can join socket during active event", async () => {
  const gateway = createGateway();
  const { client } = createRealtimeClient();

  await (
    gateway as never as { handleMessage: (client: unknown, data: Buffer) => Promise<void> }
  ).handleMessage(
    client,
    Buffer.from(JSON.stringify({ type: "live:join", roomId: eventId.toString() })),
  );

  assert.equal(client.liveRooms.has(eventId.toString()), true);
  assert.equal(
    (gateway as never as { liveRooms: Map<string, Set<unknown>> }).liveRooms
      .get(eventId.toString())
      ?.has(client),
    true,
  );
});

test("checked-in attendee can send socket message during active event", async () => {
  const gateway = createGateway();
  const { client, sent } = createRealtimeClient();

  await (
    gateway as never as { handleMessage: (client: unknown, data: Buffer) => Promise<void> }
  ).handleMessage(
    client,
    Buffer.from(JSON.stringify({ type: "live:join", roomId: eventId.toString() })),
  );
  await (
    gateway as never as { handleMessage: (client: unknown, data: Buffer) => Promise<void> }
  ).handleMessage(
    client,
    Buffer.from(
      JSON.stringify({ type: "live:message", roomId: eventId.toString(), text: "Hello" }),
    ),
  );

  assert.equal(
    sent.some((payload) => (payload as { type?: string }).type === "live:message"),
    true,
  );
});

test("unauthorized socket join rejects without subscribing", async () => {
  const gateway = createGateway({ accessError: new AppError("Check in to join event chat.", 403) });
  const { client, sent } = createRealtimeClient();

  await (
    gateway as never as { handleMessage: (client: unknown, data: Buffer) => Promise<void> }
  ).handleMessage(
    client,
    Buffer.from(JSON.stringify({ type: "live:join", roomId: eventId.toString() })),
  );

  assert.equal(client.liveRooms.has(eventId.toString()), false);
  assert.equal(
    (gateway as never as { liveRooms: Map<string, Set<unknown>> }).liveRooms.has(
      eventId.toString(),
    ),
    false,
  );
  assert.equal((sent[0] as { code?: string }).code, "EVENT_CHAT_ACCESS_DENIED");
});

test("unauthorized socket message rejects and does not auto-join", async () => {
  const gateway = createGateway({
    messageError: new AppError("Check in to join event chat.", 403),
  });
  const { client, sent } = createRealtimeClient();

  await (
    gateway as never as { handleMessage: (client: unknown, data: Buffer) => Promise<void> }
  ).handleMessage(
    client,
    Buffer.from(
      JSON.stringify({ type: "live:message", roomId: eventId.toString(), text: "Hello" }),
    ),
  );

  assert.equal(client.liveRooms.has(eventId.toString()), false);
  assert.equal(
    (gateway as never as { liveRooms: Map<string, Set<unknown>> }).liveRooms.has(
      eventId.toString(),
    ),
    false,
  );
  assert.equal((sent[0] as { code?: string }).code, "EVENT_CHAT_ACCESS_DENIED");
});
