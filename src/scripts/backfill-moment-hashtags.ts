import dotenv from "dotenv";
import mongoose from "mongoose";
import { extractHashtags } from "../modules/moments/moment-hashtag.js";
import { MomentModel } from "../modules/moments/moment.model.js";

dotenv.config();

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) throw new Error("MONGODB_URI is required");

const run = async () => {
  await mongoose.connect(mongoUri);

  let scanned = 0;
  let updated = 0;
  const operations: Parameters<typeof MomentModel.bulkWrite>[0] = [];
  const cursor = MomentModel.find({
    caption: /#/,
    $or: [{ hashtags: { $exists: false } }, { hashtags: { $size: 0 } }],
  }).select({ _id: 1, caption: 1 }).lean().cursor();

  for await (const moment of cursor) {
    scanned += 1;
    const hashtags = extractHashtags(moment.caption);
    if (hashtags.length === 0) continue;

    operations.push({ updateOne: { filter: { _id: moment._id }, update: { $set: { hashtags } } } });

    if (operations.length >= 500) {
      const result = await MomentModel.bulkWrite(operations, { ordered: false });
      updated += result.modifiedCount;
      operations.length = 0;
    }
  }

  if (operations.length > 0) {
    const result = await MomentModel.bulkWrite(operations, { ordered: false });
    updated += result.modifiedCount;
  }

  await MomentModel.createIndexes();
  console.log(JSON.stringify({ scanned, updated }));
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error("Moment hashtag backfill failed", error);
  await mongoose.disconnect().catch(() => undefined);
  process.exitCode = 1;
});
