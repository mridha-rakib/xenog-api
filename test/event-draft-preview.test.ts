import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventModel } from "../src/modules/events/event.model.js";
import { EventRepository } from "../src/modules/events/event.repository.js";
import { EventService } from "../src/modules/events/event.service.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

test.afterEach(async () => {
  const { RedisClient } = await import("../src/config/redis.js");
  await RedisClient.disconnect().catch(() => undefined);
});

const now = new Date("2026-07-15T10:00:00.000Z");
const eventId = new Types.ObjectId();
const ownerId = new Types.ObjectId();
const otherUserId = new Types.ObjectId();

const owner = {
  id: ownerId.toString(),
  name: "Owner",
  username: "owner",
  email: "owner@example.com",
  accountType: "business",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const otherUser = {
  ...owner,
  id: otherUserId.toString(),
  name: "Other",
  username: "other",
  email: "other@example.com",
};

const host = {
  _id: ownerId,
  name: "Owner",
  username: "owner",
  email: "owner@example.com",
  accountType: "business",
  avatarKey: null,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const createEvent = (overrides: Record<string, unknown> = {}) => ({
  _id: eventId,
  userId: ownerId,
  status: "draft",
  name: "Draft Preview",
  description: "Preview copy",
  bannerImageKey: null,
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Music",
  categories: ["Music"],
  hashtags: [],
  scheduledAt: now,
  endAt: new Date("2026-07-15T12:00:00.000Z"),
  location: null,
  tickets: [],
  rewards: [],
  privacy: "public",
  memberUserIds: [],
  joinRequests: [],
  publishedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const createEventService = (overrides: {
  eventRepository?: Record<string, unknown>;
  userRepository?: Record<string, unknown>;
  userFollowRepository?: Record<string, unknown>;
  eventSaveRepository?: Record<string, unknown>;
  liveRoomRepository?: Record<string, unknown>;
  momentRepository?: Record<string, unknown>;
  checkoutPaymentRepository?: Record<string, unknown>;
  ticketShareRepository?: Record<string, unknown>;
  eventWindowRepository?: Record<string, unknown>;
} = {}) => new EventService(
  overrides.eventRepository as never,
  (overrides.userRepository ?? { findById: async () => host }) as never,
  (overrides.userFollowRepository ?? {
    countFollowers: async () => 0,
    isFollowing: async () => false,
  }) as never,
  { createDownloadUrl: async () => ({ url: "" }) } as never,
  {} as never,
  {} as never,
  (overrides.checkoutPaymentRepository ?? {
    hasUserPaidTicketForEvent: async () => false,
  }) as never,
  {} as never,
  {} as never,
  (overrides.ticketShareRepository ?? {
    hasActiveShareForRecipientAtEvent: async () => false,
  }) as never,
  {} as never,
  {} as never,
  overrides.eventSaveRepository as never,
  overrides.liveRoomRepository as never,
  overrides.momentRepository as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  (overrides.eventWindowRepository ?? {
    findConflictingForEventSchedule: async () => [],
  }) as never,
  () => now,
);

test("saving a new event through draft API stores draft status", async () => {
  const draft = createEvent();
  let createdPayload: Record<string, unknown> | null = null;
  const service = createEventService({
    eventRepository: {
      create: async (payload: Record<string, unknown>) => {
        createdPayload = payload;
        return { ...draft, ...payload };
      },
    },
  });

  const response = await service.saveDraft(owner as never, { name: "Draft Preview" } as never);

  assert.equal(createdPayload?.status, "draft");
  assert.equal(createdPayload?.userId, owner.id);
  assert.equal(response.status, "draft");
});

test("updating a draft preserves the same event id", async () => {
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent(),
      updateDraftByIdForUser: async (requestedId: string, requestedUserId: string) => {
        assert.equal(requestedId, eventId.toString());
        assert.equal(requestedUserId, owner.id);
        return createEvent({ name: "Updated Draft" });
      },
    },
  });

  const response = await service.saveDraft(
    owner as never,
    { name: "Updated Draft" } as never,
    eventId.toString(),
  );

  assert.equal(response.id, eventId.toString());
  assert.equal(response.status, "draft");
  assert.equal(response.name, "Updated Draft");
});

test("draft schedule update is blocked when existing windows would fall outside the new event time", async () => {
  let updateCalled = false;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent(),
      updateDraftByIdForUser: async () => {
        updateCalled = true;
        throw new Error("conflicting draft schedule should not be saved");
      },
    },
    eventWindowRepository: {
      findConflictingForEventSchedule: async (
        requestedEventId: string,
        requestedStart: Date | null,
        requestedEnd: Date | null,
      ) => {
        assert.equal(requestedEventId, eventId.toString());
        assert.equal(requestedStart?.toISOString(), "2026-07-15T10:30:00.000Z");
        assert.equal(requestedEnd?.toISOString(), "2026-07-15T11:00:00.000Z");
        return [{ _id: new Types.ObjectId() }];
      },
    },
  });

  await assert.rejects(
    () => service.saveDraft(
      owner as never,
      {
        scheduledAt: new Date("2026-07-15T10:30:00.000Z"),
        endAt: new Date("2026-07-15T11:00:00.000Z"),
      } as never,
      eventId.toString(),
    ),
    { statusCode: 422 },
  );
  assert.equal(updateCalled, false);
});

test("draft owner can create, update, and delete tickets without changing ticket ids", async () => {
  const existingTicket = {
    id: "ticket-1",
    name: "Early Bird",
    description: "Original",
    salesEndAt: new Date("2026-07-15T09:30:00.000Z"),
    type: "free",
    price: 0,
    capacity: 10,
    availableCount: null,
  };
  const draft = createEvent({ tickets: [existingTicket] });
  const updatePayloads: Record<string, unknown>[] = [];
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async (_requestedEventId: string, requestedUserId: string) =>
        requestedUserId === owner.id ? draft : null,
      updateDraftByIdForUser: async (_requestedEventId: string, _requestedUserId: string, payload: Record<string, unknown>) => {
        updatePayloads.push(payload);
        return createEvent({ tickets: payload.tickets });
      },
    },
  });

  const created = await service.createDraftTicket(owner as never, eventId.toString(), {
    name: "VIP",
    description: "VIP ticket",
    salesEndAt: new Date("2026-07-15T09:45:00.000Z"),
    type: "pay",
    price: 25,
    capacity: 5,
  } as never);
  assert.equal(created.tickets.length, 2);

  const updated = await service.updateDraftTicket(owner as never, eventId.toString(), "ticket-1", {
    name: "Early Bird Updated",
  } as never);
  assert.equal(updated.tickets[0]?.id, "ticket-1");
  assert.equal(updated.tickets[0]?.name, "Early Bird Updated");

  const deleted = await service.deleteDraftTicket(owner as never, eventId.toString(), "ticket-1");
  assert.equal(deleted.tickets.some((ticket) => ticket.id === "ticket-1"), false);
  assert.equal(updatePayloads.length, 3);
});

test("non-owner cannot manage draft tickets", async () => {
  let updateCalled = false;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async (_requestedEventId: string, requestedUserId: string) =>
        requestedUserId === owner.id ? createEvent() : null,
      updateDraftByIdForUser: async () => {
        updateCalled = true;
        throw new Error("non-owner draft ticket mutation should not update");
      },
    },
  });

  await assert.rejects(
    () => service.createDraftTicket(otherUser as never, eventId.toString(), {
      name: "VIP",
      description: "VIP ticket",
      salesEndAt: new Date("2026-07-15T09:45:00.000Z"),
      type: "free",
      price: 0,
      capacity: 5,
    } as never),
    { statusCode: 404 },
  );
  assert.equal(updateCalled, false);
});

test("locked draft owner can manage tickets", async () => {
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent({ privacy: "locked" }),
      updateDraftByIdForUser: async (_requestedEventId: string, _requestedUserId: string, payload: Record<string, unknown>) =>
        createEvent({ privacy: "locked", tickets: payload.tickets }),
    },
  });

  const response = await service.createDraftTicket(owner as never, eventId.toString(), {
    name: "Locked Ticket",
    description: "Ticket",
    salesEndAt: new Date("2026-07-15T09:45:00.000Z"),
    type: "free",
    price: 0,
    capacity: 5,
  } as never);

  assert.equal(response.privacy, "locked");
  assert.equal(response.tickets[0]?.name, "Locked Ticket");
});

test("draft ticket sales end after event end is rejected", async () => {
  let updateCalled = false;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent(),
      updateDraftByIdForUser: async () => {
        updateCalled = true;
        throw new Error("invalid draft ticket should not update");
      },
    },
  });

  await assert.rejects(
    () => service.createDraftTicket(owner as never, eventId.toString(), {
      name: "Late Ticket",
      description: "Ticket",
      salesEndAt: new Date("2026-07-15T12:30:00.000Z"),
      type: "free",
      price: 0,
      capacity: 5,
    } as never),
    { statusCode: 422 },
  );
  assert.equal(updateCalled, false);
});

test("draft owner can create, update, and delete rewards without changing reward ids", async () => {
  const ticket = {
    id: "ticket-1",
    name: "Early Bird",
    description: "Ticket",
    salesEndAt: new Date("2026-07-15T09:30:00.000Z"),
    type: "free",
    price: 0,
    capacity: 10,
    availableCount: null,
  };
  const secondTicket = {
    ...ticket,
    id: "ticket-2",
    name: "General Admission",
  };
  const reward = {
    id: "reward-1",
    rewardType: "ticket",
    ticketId: "ticket-1",
    productId: null,
    targetName: "Early Bird",
    imageKeys: [],
    name: "Existing Reward",
    description: "Original",
    expiresAt: new Date("2026-07-15T11:30:00.000Z"),
    discountPercent: 0,
    buyQuantity: 1,
    freeQuantity: 1,
    capacity: 10,
  };
  const draft = createEvent({ tickets: [ticket, secondTicket], rewards: [reward] });
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async (_requestedEventId: string, requestedUserId: string) =>
        requestedUserId === owner.id ? draft : null,
      updateDraftByIdForUser: async (_requestedEventId: string, _requestedUserId: string, payload: Record<string, unknown>) =>
        createEvent({ tickets: [ticket, secondTicket], rewards: payload.rewards }),
      updateRewardsIfTicketAvailable: async (_requestedEventId: string, _requestedUserId: string, rewards: unknown[]) =>
        createEvent({ tickets: [ticket, secondTicket], rewards }),
    },
  });

  const created = await service.createDraftReward(owner as never, eventId.toString(), {
    rewardType: "ticket",
    ticketId: "ticket-2",
    name: "New Reward",
    description: "Reward",
    expiresAt: new Date("2026-07-15T11:30:00.000Z"),
    discountPercent: 0,
    buyQuantity: 1,
    freeQuantity: 1,
    capacity: 5,
  } as never);
  assert.equal(created.rewards.length, 2);

  const updated = await service.updateDraftReward(owner as never, eventId.toString(), "reward-1", {
    name: "Updated Reward",
  } as never);
  assert.equal(updated.rewards[0]?.id, "reward-1");
  assert.equal(updated.rewards[0]?.name, "Updated Reward");

  const deleted = await service.deleteDraftReward(owner as never, eventId.toString(), "reward-1");
  assert.equal(deleted.rewards.some((item) => item.id === "reward-1"), false);
});

test("non-owner cannot manage draft rewards", async () => {
  let updateCalled = false;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async (_requestedEventId: string, requestedUserId: string) =>
        requestedUserId === owner.id ? createEvent() : null,
      updateDraftByIdForUser: async () => {
        updateCalled = true;
        throw new Error("non-owner draft reward mutation should not update");
      },
    },
  });

  await assert.rejects(
    () => service.createDraftReward(otherUser as never, eventId.toString(), {
      rewardType: "ticket",
      ticketId: "ticket-1",
      name: "Reward",
      description: "Reward",
      expiresAt: new Date("2026-07-15T11:30:00.000Z"),
      discountPercent: 0,
      buyQuantity: 1,
      freeQuantity: 1,
      capacity: 5,
    } as never),
    { statusCode: 404 },
  );
  assert.equal(updateCalled, false);
});

test("locked draft owner can manage rewards", async () => {
  const ticket = {
    id: "ticket-1",
    name: "Early Bird",
    description: "Ticket",
    salesEndAt: new Date("2026-07-15T09:30:00.000Z"),
    type: "free",
    price: 0,
    capacity: 10,
    availableCount: null,
  };
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent({ privacy: "locked", tickets: [ticket] }),
      updateRewardsIfTicketAvailable: async (_requestedEventId: string, _requestedUserId: string, rewards: unknown[]) =>
        createEvent({ privacy: "locked", tickets: [ticket], rewards }),
    },
  });

  const response = await service.createDraftReward(owner as never, eventId.toString(), {
    rewardType: "ticket",
    ticketId: "ticket-1",
    name: "Locked Reward",
    description: "Reward",
    expiresAt: new Date("2026-07-15T11:30:00.000Z"),
    discountPercent: 0,
    buyQuantity: 1,
    freeQuantity: 1,
    capacity: 5,
  } as never);

  assert.equal(response.privacy, "locked");
  assert.equal(response.rewards[0]?.name, "Locked Reward");
});

test("draft reward expiry after event end is rejected", async () => {
  const ticket = {
    id: "ticket-1",
    name: "Early Bird",
    description: "Ticket",
    salesEndAt: new Date("2026-07-15T09:30:00.000Z"),
    type: "free",
    price: 0,
    capacity: 10,
    availableCount: null,
  };
  let updateCalled = false;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent({ tickets: [ticket] }),
      updateDraftByIdForUser: async () => {
        updateCalled = true;
        throw new Error("invalid draft reward should not update");
      },
      updateRewardsIfTicketAvailable: async () => {
        updateCalled = true;
        throw new Error("invalid draft reward should not update");
      },
    },
  });

  await assert.rejects(
    () => service.createDraftReward(owner as never, eventId.toString(), {
      rewardType: "ticket",
      ticketId: "ticket-1",
      name: "Late Reward",
      description: "Reward",
      expiresAt: new Date("2026-07-15T12:30:00.000Z"),
      discountPercent: 0,
      buyQuantity: 1,
      freeQuantity: 1,
      capacity: 5,
    } as never),
    { statusCode: 422 },
  );
  assert.equal(updateCalled, false);
});

test("event schedule update is blocked when existing ticket or reward dates exceed the new event end", async () => {
  const ticket = {
    id: "ticket-1",
    name: "Early Bird",
    description: "Ticket",
    salesEndAt: new Date("2026-07-15T09:30:00.000Z"),
    type: "free",
    price: 0,
    capacity: 10,
    availableCount: null,
  };
  const reward = {
    id: "reward-1",
    rewardType: "ticket",
    ticketId: "ticket-1",
    productId: null,
    targetName: "Early Bird",
    imageKeys: [],
    name: "Reward",
    description: "Reward",
    expiresAt: new Date("2026-07-15T11:30:00.000Z"),
    discountPercent: 0,
    buyQuantity: 1,
    freeQuantity: 1,
    capacity: 10,
  };
  let updateCalled = false;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent({ tickets: [ticket], rewards: [reward] }),
      updateDraftByIdForUser: async () => {
        updateCalled = true;
        throw new Error("conflicting child dates should not update");
      },
    },
  });

  await assert.rejects(
    () => service.saveDraft(
      owner as never,
      { endAt: new Date("2026-07-15T11:00:00.000Z") } as never,
      eventId.toString(),
    ),
    { statusCode: 422 },
  );
  assert.equal(updateCalled, false);
});

test("publishing a draft preserves ticket and reward ids without duplicate child records", async () => {
  const ticket = {
    id: "ticket-1",
    name: "Early Bird",
    description: "Ticket",
    salesEndAt: new Date("2026-07-15T09:30:00.000Z"),
    type: "free",
    price: 0,
    capacity: 10,
    availableCount: null,
  };
  const reward = {
    id: "reward-1",
    rewardType: "ticket",
    ticketId: "ticket-1",
    productId: null,
    targetName: "Early Bird",
    imageKeys: [],
    name: "Reward",
    description: "Reward",
    expiresAt: new Date("2026-07-15T11:30:00.000Z"),
    discountPercent: 0,
    buyQuantity: 1,
    freeQuantity: 1,
    capacity: 10,
  };
  let publishPayload: Record<string, unknown> | null = null;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent({ tickets: [ticket], rewards: [reward] }),
      publishDraftByIdForUser: async (_requestedEventId: string, _requestedUserId: string, payload: Record<string, unknown>) => {
        publishPayload = payload;
        return createEvent({
          status: "published",
          publishedAt: now,
          tickets: payload.tickets,
          rewards: [reward],
        });
      },
      create: async () => {
        throw new Error("draft publish should not create duplicate event");
      },
    },
  });

  const response = await service.publish(
    owner as never,
    {
      name: "Draft Preview",
      ageRestriction: "all_ages",
      category: "Music",
      categories: ["Music"],
      scheduledAt: now,
      endAt: new Date("2026-07-15T12:00:00.000Z"),
      privacy: "public",
      tickets: [ticket],
    } as never,
    eventId.toString(),
  );

  assert.equal(response.id, eventId.toString());
  assert.equal(response.tickets.length, 1);
  assert.equal(response.tickets[0]?.id, "ticket-1");
  assert.equal(response.rewards.length, 1);
  assert.equal(response.rewards[0]?.id, "reward-1");
  assert.equal(publishPayload?.rewards, undefined);
});

test("draft owner can read draft detail without creating interaction moment or chat room", async () => {
  let interactionMomentCreated = false;
  let chatRoomCreated = false;
  const service = createEventService({
    eventRepository: {
      findById: async () => createEvent(),
      countByUserId: async () => 0,
    },
    liveRoomRepository: {
      ensureById: async () => {
        chatRoomCreated = true;
      },
    },
    momentRepository: {
      ensureEventAnnouncement: async () => {
        interactionMomentCreated = true;
        throw new Error("draft detail must not create announcement moments");
      },
    },
  });

  const response = await service.getEventById(owner as never, eventId.toString());

  assert.equal(response.id, eventId.toString());
  assert.equal(response.status, "draft");
  assert.equal(response.interactionMomentId, undefined);
  assert.equal(response.likesCount, 0);
  assert.equal(response.canReport, false);
  assert.equal(interactionMomentCreated, false);
  assert.equal(chatRoomCreated, false);
});

test("non-owner cannot read draft detail", async () => {
  const service = createEventService({
    eventRepository: {
      findById: async () => createEvent(),
      countByUserId: async () => 0,
    },
  });

  await assert.rejects(
    () => service.getEventById(otherUser as never, eventId.toString()),
    { statusCode: 404 },
  );
});

test("drafts cannot be saved or used for generic ticket access", async () => {
  let saveToggled = false;
  let ticketAccessChecked = false;
  const service = createEventService({
    eventRepository: {
      findById: async () => createEvent(),
    },
    eventSaveRepository: {
      toggleSave: async () => {
        saveToggled = true;
        return { isSaved: true };
      },
    },
    checkoutPaymentRepository: {
      hasUserPaidTicketForEvent: async () => {
        ticketAccessChecked = true;
        return true;
      },
    },
  });

  await assert.rejects(
    () => service.toggleSaveEvent(owner as never, eventId.toString()),
    { statusCode: 404 },
  );
  await assert.rejects(
    () => service.getTicketAccess(owner as never, eventId.toString()),
    { statusCode: 404 },
  );
  assert.equal(saveToggled, false);
  assert.equal(ticketAccessChecked, false);
});

test("owner can publish a draft without creating a duplicate event", async () => {
  let createCalled = false;
  let publishCalled = false;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent(),
      publishDraftByIdForUser: async () => {
        publishCalled = true;
        return createEvent({ status: "published", publishedAt: now });
      },
      create: async () => {
        createCalled = true;
        throw new Error("publish retry must not create another event");
      },
    },
  });

  const response = await service.publish(
    owner as never,
    {
      name: "Draft Preview",
      ageRestriction: "all_ages",
      category: "Music",
      categories: ["Music"],
      scheduledAt: now,
      endAt: new Date("2026-07-15T12:00:00.000Z"),
      privacy: "public",
      tickets: [],
    } as never,
    eventId.toString(),
  );

  assert.equal(response.id, eventId.toString());
  assert.equal(response.status, "published");
  assert.equal(publishCalled, true);
  assert.equal(createCalled, false);
});

test("publishing a draft is blocked when existing windows would fall outside the published schedule", async () => {
  let publishCalled = false;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent(),
      publishDraftByIdForUser: async () => {
        publishCalled = true;
        throw new Error("conflicting draft schedule should not be published");
      },
    },
    eventWindowRepository: {
      findConflictingForEventSchedule: async () => [{ _id: new Types.ObjectId() }],
    },
  });

  await assert.rejects(
    () => service.publish(
      owner as never,
      {
        name: "Draft Preview",
        ageRestriction: "all_ages",
        category: "Music",
        categories: ["Music"],
        scheduledAt: new Date("2026-07-15T10:30:00.000Z"),
        endAt: new Date("2026-07-15T11:00:00.000Z"),
        privacy: "public",
        tickets: [],
      } as never,
      eventId.toString(),
    ),
    { statusCode: 422 },
  );
  assert.equal(publishCalled, false);
});

test("published event schedule update is blocked when existing windows conflict", async () => {
  let updateCalled = false;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent({ status: "published", publishedAt: now }),
      updateByIdForUser: async () => {
        updateCalled = true;
        throw new Error("conflicting published schedule should not be updated");
      },
    },
    eventWindowRepository: {
      findConflictingForEventSchedule: async () => [{ _id: new Types.ObjectId() }],
    },
  });

  await assert.rejects(
    () => service.updateEvent(
      owner as never,
      eventId.toString(),
      {
        scheduledAt: new Date("2026-07-15T10:30:00.000Z"),
        endAt: new Date("2026-07-15T11:00:00.000Z"),
      } as never,
    ),
    { statusCode: 422 },
  );
  assert.equal(updateCalled, false);
});

test("completed and cancelled events cannot be republished through publish retry path", async () => {
  for (const status of ["completed", "cancelled"]) {
    const service = createEventService({
      eventRepository: {
        findByIdForUser: async () => createEvent({ status }),
        updateByIdForUser: async () => {
          throw new Error(`${status} event should not be updated by publish`);
        },
        publishDraftByIdForUser: async () => {
          throw new Error(`${status} event should not be published as a draft`);
        },
      },
    });

    await assert.rejects(
      () => service.publish(
        owner as never,
        {
          name: "Draft Preview",
          ageRestriction: "all_ages",
          category: "Music",
          categories: ["Music"],
          scheduledAt: now,
          endAt: new Date("2026-07-15T12:00:00.000Z"),
          privacy: "public",
          tickets: [],
        } as never,
        eventId.toString(),
      ),
      { statusCode: 422 },
    );
  }
});

test("auto-start scheduler only queries and updates published events", async () => {
  const originalFind = EventModel.find.bind(EventModel);
  const originalUpdateMany = EventModel.updateMany.bind(EventModel);
  const publishedEvent = createEvent({
    _id: new Types.ObjectId(),
    status: "published",
    scheduledAt: new Date("2026-07-15T09:00:00.000Z"),
    endAt: new Date("2026-07-15T12:00:00.000Z"),
  });
  let capturedFindQuery: Record<string, unknown> | null = null;
  let capturedUpdateFilter: Record<string, unknown> | null = null;

  EventModel.find = ((query: Record<string, unknown>) => {
    capturedFindQuery = query;
    return Promise.resolve([publishedEvent]);
  }) as typeof EventModel.find;
  EventModel.updateMany = ((filter: Record<string, unknown>) => {
    capturedUpdateFilter = filter;
    return Promise.resolve({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });
  }) as typeof EventModel.updateMany;

  try {
    const started = await new EventRepository().autoStartScheduled(now);

    assert.equal(capturedFindQuery?.status, "published");
    assert.equal(capturedUpdateFilter?.status, "published");
    assert.equal(started.length, 1);
    assert.equal(started[0]?._id.toString(), publishedEvent._id.toString());
  } finally {
    EventModel.find = originalFind as typeof EventModel.find;
    EventModel.updateMany = originalUpdateMany as typeof EventModel.updateMany;
  }
});

test("auto-complete scheduler excludes drafts from expiration query", async () => {
  const originalFind = EventModel.find.bind(EventModel);
  const originalUpdateMany = EventModel.updateMany.bind(EventModel);
  let capturedFindQuery: Record<string, unknown> | null = null;
  let updateCalled = false;

  EventModel.find = ((query: Record<string, unknown>) => {
    capturedFindQuery = query;
    return Promise.resolve([]);
  }) as typeof EventModel.find;
  EventModel.updateMany = (() => {
    updateCalled = true;
    return Promise.resolve({ acknowledged: true, matchedCount: 0, modifiedCount: 0 });
  }) as typeof EventModel.updateMany;

  try {
    const completed = await new EventRepository().findAndAutoComplete(now);

    assert.deepEqual(capturedFindQuery?.status, { $in: ["live", "published"] });
    assert.equal(completed.length, 0);
    assert.equal(updateCalled, false);
  } finally {
    EventModel.find = originalFind as typeof EventModel.find;
    EventModel.updateMany = originalUpdateMany as typeof EventModel.updateMany;
  }
});
