import { db, FieldValue } from "../firebaseAdmin.js";
import { todayKey } from "./limitService.js";

export async function recordActivity(activity) {
  const normalizedStatus = activity.status === "error" ? "failed" : activity.status;
  const payload = {
    userId: String(activity.userId),
    user: activity.user || null,
    source: activity.source,
    inputUrl: activity.inputUrl || null,
    inputType: activity.inputType || activity.source || null,
    inputFileId: activity.inputFileId || null,
    inputThumbnail: activity.inputThumbnail || null,
    inputPreview: activity.inputPreview || activity.imageUrl || null,
    userInput: activity.userInput || null,
    animeTitle: activity.animeTitle || null,
    anilistId: activity.anilistId || null,
    anilistUrl: activity.anilistUrl || null,
    episode: activity.episode ?? null,
    from: activity.from ?? null,
    to: activity.to ?? null,
    formattedTime: activity.formattedTime || null,
    similarity: activity.similarity ?? null,
    videoUrl: activity.videoUrl || null,
    imageUrl: activity.imageUrl || null,
    status: normalizedStatus || "success",
    rejectionReason: activity.rejectionReason || null,
    botResponse: activity.botResponse || null,
    error: activity.error || null,
    createdAt: FieldValue.serverTimestamp()
  };

  const activityRef = await db.collection("activities").add(payload);
  await updateDailyAnalytics(payload);
  return {
    id: activityRef.id,
    ...payload
  };
}

export async function recordError(error, { countAnalytics = true } = {}) {
  const payload = {
    userId: error.userId ? String(error.userId) : null,
    source: error.source || null,
    inputUrl: error.inputUrl || null,
    message: error.message || "Unknown error",
    stack: error.stack || null,
    createdAt: FieldValue.serverTimestamp()
  };

  await db.collection("errors").add(payload);

  if (countAnalytics) {
    await updateDailyAnalytics({
      userId: payload.userId,
      status: "error"
    });
  }
}

async function updateDailyAnalytics(activity) {
  const date = todayKey();
  const ref = db.collection("analytics").doc("daily").collection("days").doc(date);
  const patch = {
    date,
    total: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp()
  };

  if (activity.status === "success") {
    patch.success = FieldValue.increment(1);
  } else if (activity.status === "rejected" || activity.status === "low_similarity") {
    patch.rejected = FieldValue.increment(1);
  } else {
    patch.failed = FieldValue.increment(1);
  }

  if (Number.isFinite(activity.similarity)) {
    patch.similarityTotal = FieldValue.increment(activity.similarity);
    patch.similarityCount = FieldValue.increment(1);
  }

  await ref.set(patch, { merge: true });
}
