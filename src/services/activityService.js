import { db, FieldValue } from "../firebaseAdmin.js";
import { todayKey } from "./limitService.js";

const TECHNICAL_FAILURE_TYPES = new Set([
  "invalid_media",
  "unsupported_source",
  "invalid_url",
  "processing_error",
  "telegram_download_error",
  "trace_api_error"
]);

const SUCCESS_STATUSES = new Set(["success", "success_trusted_low_similarity", "trusted_low_similarity"]);
const REJECTED_STATUSES = new Set(["rejected", "low_similarity"]);

export function isTechnicalFailureType(type) {
  return TECHNICAL_FAILURE_TYPES.has(type);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function firstPresent(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }

    if (value !== null && value !== undefined && typeof value !== "string") {
      return value;
    }
  }

  return null;
}

function mediaValue(activity, key, ...fallbacks) {
  const media = activity.media && typeof activity.media === "object" ? activity.media : null;

  if (media && hasOwn(media, key)) {
    return firstPresent(media[key]);
  }

  return firstPresent(...fallbacks);
}

function normalizeMedia(activity) {
  return {
    inputTelegramFileId: mediaValue(activity, "inputTelegramFileId", activity.inputTelegramFileId, activity.inputFileId),
    sentPhotoFileId: mediaValue(activity, "sentPhotoFileId", activity.sentPhotoFileId),
    sentVideoFileId: mediaValue(activity, "sentVideoFileId", activity.sentVideoFileId),
    sentAnimationFileId: mediaValue(activity, "sentAnimationFileId", activity.sentAnimationFileId),
    inputImageUrl: mediaValue(
      activity,
      "inputImageUrl",
      activity.inputImageUrl,
      activity.inputPreview,
      activity.inputThumbnail,
      activity.inputUrl
    ),
    inputTelegramFileUrl: mediaValue(activity, "inputTelegramFileUrl", activity.inputTelegramFileUrl),
    resultImageUrl: mediaValue(activity, "resultImageUrl", activity.resultImageUrl, activity.botResponse?.imageUrl, activity.imageUrl),
    resultVideoUrl: mediaValue(activity, "resultVideoUrl", activity.resultVideoUrl, activity.botResponse?.videoUrl, activity.videoUrl),
    botVideoUrl: mediaValue(activity, "botVideoUrl", activity.botVideoUrl),
    botImageUrl: mediaValue(activity, "botImageUrl", activity.botImageUrl)
  };
}

function normalizeActivityBucket(status) {
  if (SUCCESS_STATUSES.has(status)) {
    return "success";
  }

  if (REJECTED_STATUSES.has(status)) {
    return "rejected";
  }

  return "failed";
}

function topAnimeDocumentId(activity) {
  if (activity.anilistId) {
    return `anilist-${activity.anilistId}`;
  }

  return String(activity.animeTitle || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "unknown";
}

export async function recordActivity(activity) {
  const failureType = activity.failureType || activity.rejectionReason || null;

  if (isTechnicalFailureType(failureType)) {
    return recordError({
      ...activity,
      status: "failed",
      failureType,
      message: activity.error || activity.botResponse?.message || failureType
    });
  }

  const normalizedStatus = activity.status === "error" ? "failed" : activity.status;
  const media = normalizeMedia(activity);
  const payload = {
    userId: String(activity.userId),
    user: activity.user || null,
    source: activity.source,
    inputUrl: activity.inputUrl || null,
    inputType: activity.inputType || activity.source || null,
    inputFileId: activity.inputFileId || null,
    inputTelegramFileId: activity.inputTelegramFileId || media.inputTelegramFileId || null,
    inputTelegramFileUrl: activity.inputTelegramFileUrl || media.inputTelegramFileUrl,
    inputImageUrl: activity.inputImageUrl || media.inputImageUrl,
    inputThumbnail: activity.inputThumbnail || null,
    inputPreview: activity.inputPreview || media.inputImageUrl || null,
    userInput: activity.userInput || null,
    animeTitle: activity.animeTitle || null,
    anilistId: activity.anilistId || null,
    anilistUrl: activity.anilistUrl || null,
    episode: activity.episode ?? null,
    from: activity.from ?? null,
    to: activity.to ?? null,
    formattedTime: activity.formattedTime || null,
    similarity: activity.similarity ?? null,
    videoUrl: media.resultVideoUrl || activity.videoUrl || null,
    imageUrl: media.resultImageUrl || activity.imageUrl || null,
    media,
    status: normalizedStatus || "success",
    rejectionReason: activity.rejectionReason || null,
    botResponse: activity.botResponse || null,
    error: activity.error || null,
    createdAt: FieldValue.serverTimestamp()
  };

  const activityRef = activity.id
    ? db.collection("activities").doc(String(activity.id))
    : db.collection("activities").doc();

  await activityRef.set(payload);
  await updateDailyAnalytics(payload);
  await updateUserStats(payload);
  await updateTopAnimeAnalytics(payload);

  return {
    id: activityRef.id,
    ...payload
  };
}

export async function recordError(error, { countAnalytics = true } = {}) {
  const media = normalizeMedia(error);
  const payload = {
    userId: error.userId ? String(error.userId) : null,
    user: error.user || null,
    source: error.source || null,
    inputUrl: error.inputUrl || null,
    inputType: error.inputType || error.source || null,
    inputFileId: error.inputFileId || null,
    inputTelegramFileId: error.inputTelegramFileId || media.inputTelegramFileId || null,
    userInput: error.userInput || null,
    message: error.message || "Unknown error",
    failureType: error.failureType || error.rejectionReason || error.errorType || null,
    status: error.status || "failed",
    rejectionReason: error.rejectionReason || null,
    media,
    botResponse: error.botResponse || null,
    stack: error.stack || null,
    createdAt: FieldValue.serverTimestamp()
  };

  const errorRef = await db.collection("errors").add(payload);

  if (countAnalytics) {
    await updateDailyAnalytics({
      userId: payload.userId,
      status: "failed"
    });
    await updateUserStats({
      userId: payload.userId,
      status: "failed"
    });
  }

  return {
    id: errorRef.id,
    ...payload
  };
}

export function newActivityId() {
  return db.collection("activities").doc().id;
}

export async function updateActivitySentMedia(activityId, sentMedia = {}) {
  const patch = {
    updatedAt: FieldValue.serverTimestamp()
  };

  [
    "sentPhotoFileId",
    "sentVideoFileId",
    "sentAnimationFileId",
    "botVideoUrl",
    "botImageUrl"
  ].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(sentMedia, key)) {
      patch[`media.${key}`] = sentMedia[key] || null;
    }
  });

  await db.collection("activities").doc(String(activityId)).set(patch, { merge: true });
}

async function updateDailyAnalytics(activity) {
  const date = todayKey();
  const ref = db.collection("analytics").doc("daily").collection("days").doc(date);
  const patch = {
    date,
    total: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp()
  };

  const bucket = normalizeActivityBucket(activity.status);

  if (bucket === "success") {
    patch.success = FieldValue.increment(1);
  } else if (bucket === "rejected") {
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

async function updateUserStats(activity) {
  if (!activity.userId) {
    return;
  }

  const ref = db.collection("userStats").doc(String(activity.userId));
  const bucket = normalizeActivityBucket(activity.status);
  const similarity = Number(activity.similarity);
  const hasSimilarity = Number.isFinite(similarity);
  const animeTitle = bucket === "success" ? activity.animeTitle || activity.botResponse?.title || null : null;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() : {};
    const animeCounts = {
      ...(current.animeCounts || {})
    };

    if (animeTitle) {
      animeCounts[animeTitle] = Number(animeCounts[animeTitle] || 0) + 1;
    }

    const topAnimeEntry = Object.entries(animeCounts).sort((a, b) => Number(b[1]) - Number(a[1]))[0] || null;
    const similarityTotal = Number(current.similarityTotal || 0) + (hasSimilarity ? similarity : 0);
    const similarityCount = Number(current.similarityCount || 0) + (hasSimilarity ? 1 : 0);

    transaction.set(
      ref,
      {
        userId: String(activity.userId),
        totalSearches: Number(current.totalSearches || 0) + 1,
        successfulSearches: Number(current.successfulSearches || 0) + (bucket === "success" ? 1 : 0),
        rejectedSearches: Number(current.rejectedSearches || 0) + (bucket === "rejected" ? 1 : 0),
        failedSearches: Number(current.failedSearches || 0) + (bucket === "failed" ? 1 : 0),
        similarityTotal,
        similarityCount,
        averageSimilarity: similarityCount ? Math.round((similarityTotal / similarityCount) * 10) / 10 : 0,
        animeCounts,
        topAnime: topAnimeEntry
          ? {
              animeTitle: topAnimeEntry[0],
              count: Number(topAnimeEntry[1])
            }
          : null,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });
}

async function updateTopAnimeAnalytics(activity) {
  if (normalizeActivityBucket(activity.status) !== "success" || !activity.animeTitle) {
    return;
  }

  const ref = db.collection("analytics").doc("topAnime").collection("items").doc(topAnimeDocumentId(activity));

  await ref.set(
    {
      animeTitle: activity.animeTitle,
      anilistId: activity.anilistId || null,
      anilistUrl: activity.anilistUrl || null,
      count: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}
