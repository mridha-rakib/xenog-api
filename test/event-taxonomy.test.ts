import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventModel } from "../src/modules/events/event.model.js";
import {
  eventCategories,
  eventCategoryMetadata,
} from "../src/modules/events/event.interface.js";
import { eventValidation } from "../src/modules/events/event.validation.js";
import {
  EVENT_CATEGORIES as mobileEventCategories,
  EVENT_CATEGORY_METADATA as mobileEventCategoryMetadata,
} from "../../app/constants/eventCategories.ts";
import {
  CATEGORY_COLORS as dashboardCategoryColors,
  EVENT_CATEGORIES as dashboardEventCategories,
  EVENT_CATEGORY_METADATA as dashboardEventCategoryMetadata,
} from "../../xenog-dashboard/src/shared/eventCategories.ts";

const finalizedCategoryMetadata = [
  ["Parties & Celebrations", "#FF1493", "🎉"],
  ["Nightlife & Clubs", "#8A2BE2", "🍻"],
  ["Social Meetups", "#00F0FF", "💬"],
  ["College & Campus", "#1F51FF", "🎓"],
  ["Live Music & Concerts", "#FF6B00", "🎸"],
  ["Entertainment & Shows", "#E50914", "🎭"],
  ["Arts & Culture", "#DDA0DD", "🎨"],
  ["Community & Movements", "#580F24", "✊"],
  ["Food & Drinks", "#FFC700", "🍹"],
  ["Markets & Shopping", "#FF7F50", "🛍️"],
  ["Sports & Outdoors", "#00A86B", "🏃"],
  ["Games & Recreation", "#39FF14", "🎮"],
  ["Workshops & Classes", "#8B5A2B", "🧶"],
  ["Conferences & Talks", "#708090", "🎤"],
  ["Family & Gathering", "#AAF0D1", "🏡"],
  ["Wellness & Spirituality", "#C0C0C0", "🧘"],
  ["Travel & Experiences", "#008080", "✈️"],
  ["Pop-Ups & Exclusives", "#D4AF37", "✨"],
] as const;

const legacyCategoryNames = [
  "Music",
  "Nightlife",
  "Shows & Entertainment",
  "Dining Experiences",
  "Food Trucks",
  "Social Pop-ups",
  "Sports & Outdoor",
  "Games & Leisure",
  "Learning & Classes",
  "Markets & Trade",
  "Street Performances",
  "Religious & Spiritual",
  "College Events",
  "Premium Experiences",
  "Family & Community",
  "Other",
] as const;

const publishBody = (categories: string[], category?: string | null) => ({
  body: {
    name: "Finalized Taxonomy Event",
    description: "Test event",
    ageRestriction: "all_ages",
    ...(category === undefined ? {} : { category }),
    categories,
    scheduledAt: "2026-08-01T19:00:00.000Z",
    endAt: "2026-08-01T21:00:00.000Z",
    location: {
      venue: "Venue",
      address: "123 Main St",
      searchLabel: "Venue",
    },
    tickets: [],
    privacy: "public",
  },
});

test("API event taxonomy matches the finalized PDF category order, colors, and emoji metadata", () => {
  assert.equal(eventCategoryMetadata.length, 18);
  assert.deepEqual(eventCategories, finalizedCategoryMetadata.map(([name]) => name));
  assert.deepEqual(eventCategoryMetadata.map((category) => category.order), Array.from({ length: 18 }, (_, index) => index + 1));
  assert.deepEqual(eventCategoryMetadata.map((category) => category.hexColor), finalizedCategoryMetadata.map(([, hex]) => hex));
  assert.deepEqual(eventCategoryMetadata.map((category) => category.emoji), finalizedCategoryMetadata.map(([, , emoji]) => emoji));
  assert.equal(new Set(eventCategories).size, eventCategories.length);

  for (const category of eventCategoryMetadata) {
    assert.equal(category.value, category.displayName);
    assert.match(category.hexColor, /^#[\dA-F]{6}$/);
  }

  for (const legacyCategoryName of legacyCategoryNames) {
    assert.equal(eventCategories.includes(legacyCategoryName as never), false);
  }
});

test("category taxonomy stays synchronized across API, mobile, and dashboard", () => {
  assert.deepEqual(mobileEventCategories, eventCategories);
  assert.deepEqual(dashboardEventCategories, eventCategories);
  assert.deepEqual(mobileEventCategoryMetadata, eventCategoryMetadata);
  assert.deepEqual(dashboardEventCategoryMetadata, eventCategoryMetadata);

  for (const category of eventCategoryMetadata) {
    assert.equal(dashboardCategoryColors[category.value], category.hexColor);
  }
});

test("event validation preserves draft zero-category autosave and publish category enforcement", () => {
  assert.equal(eventValidation.saveDraft.safeParse({ body: { categories: [] } }).success, true);
  assert.equal(eventValidation.saveDraft.safeParse({ body: { category: null, categories: [] } }).success, true);
  assert.equal(eventValidation.saveDraft.safeParse({ body: { categories: ["Food Trucks"] } }).success, false);
  assert.equal(eventValidation.saveDraft.safeParse({ body: { categories: ["Food & Drinks", "Food & Drinks"] } }).success, false);
  assert.equal(eventValidation.saveDraft.safeParse({ body: { categories: ["Unknown"] } }).success, false);
  assert.equal(eventValidation.saveDraft.safeParse({ body: { categories: eventCategories.slice(0, 4) } }).success, false);

  assert.equal(eventValidation.publish.safeParse(publishBody(["Food & Drinks"])).success, true);
  assert.equal(eventValidation.publish.safeParse(publishBody(["Food & Drinks", "Markets & Shopping", "Social Meetups"])).success, true);
  assert.equal(eventValidation.publish.safeParse(publishBody([])).success, false);
  assert.equal(eventValidation.publish.safeParse(publishBody(eventCategories.slice(0, 4))).success, false);
  assert.equal(eventValidation.publish.safeParse(publishBody(["Food & Drinks", "Food & Drinks"])).success, false);
  assert.equal(eventValidation.publish.safeParse(publishBody(["Unknown"])).success, false);
  assert.equal(eventValidation.publish.safeParse(publishBody(["Food Trucks"])).success, false);
});

test("event model keeps category equal to categories[0] while allowing empty draft categories only", async () => {
  const draft = new EventModel({
    userId: new Types.ObjectId(),
    status: "draft",
    category: null,
    categories: [],
  });
  await draft.validate();
  assert.equal(draft.category, null);
  assert.deepEqual(draft.categories, []);

  const categoryOnlyDraft = new EventModel({
    userId: new Types.ObjectId(),
    status: "draft",
    category: "Food & Drinks",
    categories: [],
  });
  await categoryOnlyDraft.validate();
  assert.equal(categoryOnlyDraft.category, "Food & Drinks");
  assert.deepEqual(categoryOnlyDraft.categories, ["Food & Drinks"]);

  const published = new EventModel({
    userId: new Types.ObjectId(),
    status: "published",
    category: "Food & Drinks",
    categories: ["Markets & Shopping", "Food & Drinks"],
  });
  await published.validate();
  assert.equal(published.category, "Markets & Shopping");

  const uncategorizedPublished = new EventModel({
    userId: new Types.ObjectId(),
    status: "published",
    category: null,
    categories: [],
  });
  await assert.rejects(
    () => uncategorizedPublished.validate(),
    /Select at least 1 category/,
  );
});
