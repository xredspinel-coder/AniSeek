import { db, FieldValue } from "../firebaseAdmin.js";
import { prepareUserDailyWindow, resolveDailyLimit, todayKey } from "./limitService.js";

const SUCCESS_STATUSES = new Set(["success", "success_trusted_low_similarity", "trusted_low_similarity"]);
const REJECTED_STATUSES = new Set(["rejected", "low_similarity"]);

export const WRONG_MATCH_REASONS = {
  anime: "Wrong anime",
  episode: "Wrong episode",
  timestamp: "Wrong timestamp",
  confidence: "Low confidence",
  other: "Other"
};

function toDate(value) {
  if (!value) {
    return null;
  }

  if (typeof value.toDate === "function") {
    return value.toDate();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timestampMillis(value) {
  const date = toDate(value);
  return date ? date.getTime() : 0;
}

function isActiveUntil(value) {
  const date = toDate(value);
  return !date || date.getTime() > Date.now();
}

function userName(user = {}) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || user.telegramId || "Unknown";
}

function normalizeStatus(status) {
  if (SUCCESS_STATUSES.has(status)) {
    return "success";
  }

  if (REJECTED_STATUSES.has(status)) {
    return "rejected";
  }

  return status === "error" ? "failed" : status || "unknown";
}

function activityTitle(activity = {}) {
  return activity.animeTitle || activity.botResponse?.title || null;
}

function activitySimilarity(activity = {}) {
  const value = Number(activity.similarity ?? activity.botResponse?.similarity);
  return Number.isFinite(value) ? value : null;
}

function successfulActivities(snapshot) {
  return snapshot.docs
    .map((documentSnapshot) => ({
      id: documentSnapshot.id,
      ...documentSnapshot.data()
    }))
    .filter((activity) => normalizeStatus(activity.status) === "success" && activityTitle(activity));
}

function rankAnime(activities) {
  const counts = new Map();

  activities.forEach((activity) => {
    const title = activityTitle(activity);

    if (!title) {
      return;
    }

    const key = String(activity.anilistId || title);
    const current = counts.get(key) || {
      animeTitle: title,
      anilistId: activity.anilistId || null,
      anilistUrl: activity.anilistUrl || null,
      count: 0
    };

    current.count += 1;
    counts.set(key, current);
  });

  return [...counts.values()].sort((a, b) => b.count - a.count || a.animeTitle.localeCompare(b.animeTitle));
}

function periodStart(period) {
  const date = new Date();

  if (period === "today") {
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  if (period === "week") {
    date.setDate(date.getDate() - 7);
    return date.getTime();
  }

  return 0;
}

export function isTrustedUser(user = {}) {
  return Boolean(user.trustedUser) && isActiveUntil(user.trustedUntil);
}

export function canTrustedUserBypass(user = {}, settings = {}) {
  return Boolean(settings.allowTrustedBypass) && isTrustedUser(user);
}

export async function getUsageSummary(user, settings) {
  const normalizedUser = await prepareUserDailyWindow(user);
  const dailyLimit = resolveDailyLimit(normalizedUser, settings);
  const dailyUsed = Number(normalizedUser.dailyUsed || 0);
  const unlimitedUntil = toDate(normalizedUser.unlimitedUntil);
  const hasUnlimited = Boolean(unlimitedUntil && unlimitedUntil.getTime() > Date.now());

  return {
    user: normalizedUser,
    dailyUsed,
    dailyLimit,
    remaining: hasUnlimited || normalizedUser.isAdmin ? null : Math.max(0, dailyLimit - dailyUsed),
    resetLabel: "tomorrow",
    dailyLimitOverride: normalizedUser.dailyLimitOverride ?? null,
    hasUnlimited,
    unlimitedUntil,
    trustedUser: isTrustedUser(normalizedUser),
    trustedUntil: toDate(normalizedUser.trustedUntil)
  };
}

export async function getUserStatsSummary(telegramId) {
  const userId = String(telegramId);
  const snapshot = await db.collection("userStats").doc(userId).get();

  if (snapshot.exists) {
    const data = snapshot.data();
    return {
      totalSearches: Number(data.totalSearches || 0),
      successfulSearches: Number(data.successfulSearches || 0),
      rejectedSearches: Number(data.rejectedSearches || 0),
      failedSearches: Number(data.failedSearches || 0),
      averageSimilarity: Number(data.averageSimilarity || 0),
      topAnime: data.topAnime || null
    };
  }

  const [activities, errors] = await Promise.all([
    db.collection("activities").where("userId", "==", userId).limit(500).get(),
    db.collection("errors").where("userId", "==", userId).limit(500).get()
  ]);
  const animeCounts = new Map();
  let successfulSearches = 0;
  let rejectedSearches = 0;
  let similarityTotal = 0;
  let similarityCount = 0;

  activities.docs.forEach((documentSnapshot) => {
    const activity = documentSnapshot.data();
    const status = normalizeStatus(activity.status);
    const similarity = activitySimilarity(activity);
    const title = activityTitle(activity);

    if (status === "success") {
      successfulSearches += 1;
      if (title) {
        animeCounts.set(title, (animeCounts.get(title) || 0) + 1);
      }
    } else if (status === "rejected") {
      rejectedSearches += 1;
    }

    if (similarity !== null) {
      similarityTotal += similarity;
      similarityCount += 1;
    }
  });

  const topAnimeEntry = [...animeCounts.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const failedSearches = errors.size;

  return {
    totalSearches: activities.size + failedSearches,
    successfulSearches,
    rejectedSearches,
    failedSearches,
    averageSimilarity: similarityCount ? Math.round((similarityTotal / similarityCount) * 10) / 10 : 0,
    topAnime: topAnimeEntry ? { animeTitle: topAnimeEntry[0], count: topAnimeEntry[1] } : null
  };
}

export async function getTrendingSearches({ hours = 24, limit = 5 } = {}) {
  const cutoff = Date.now() - Math.max(1, Number(hours) || 24) * 60 * 60 * 1000;
  const snapshot = await db.collection("activities").orderBy("createdAt", "desc").limit(500).get();
  const activities = successfulActivities(snapshot).filter((activity) => {
    const createdAt = timestampMillis(activity.createdAt);
    return createdAt && createdAt >= cutoff;
  });

  return rankAnime(activities).slice(0, limit);
}

export async function getTopAnime({ period = "all", limit = 5 } = {}) {
  const snapshot = await db.collection("activities").orderBy("createdAt", "desc").limit(period === "all" ? 1000 : 500).get();
  const cutoff = periodStart(period);
  const activities = successfulActivities(snapshot).filter((activity) => !cutoff || timestampMillis(activity.createdAt) >= cutoff);

  return rankAnime(activities).slice(0, limit);
}

export async function getRandomAnime() {
  const snapshot = await db.collection("activities").orderBy("createdAt", "desc").limit(500).get();
  const candidates = successfulActivities(snapshot).filter((activity) => activity.anilistId);

  if (!candidates.length) {
    return null;
  }

  const activity = candidates[Math.floor(Math.random() * candidates.length)];

  return {
    animeTitle: activityTitle(activity),
    anilistId: activity.anilistId || null,
    anilistUrl: activity.anilistUrl || null,
    activityId: activity.id
  };
}

export async function createWrongMatchReport(activityId, from = {}) {
  const normalizedActivityId = String(activityId || "").trim();

  if (!normalizedActivityId) {
    throw new Error("Missing activity ID.");
  }

  const activitySnapshot = await db.collection("activities").doc(normalizedActivityId).get();

  if (!activitySnapshot.exists) {
    throw new Error("Linked activity was not found.");
  }

  const activity = activitySnapshot.data();
  const reportRef = db.collection("wrongMatchReports").doc();
  const telegramId = from.id ? String(from.id) : String(activity.userId || "");
  const report = {
    reportId: reportRef.id,
    activityId: normalizedActivityId,
    userId: String(activity.userId || telegramId || ""),
    telegramId,
    username: from.username || activity.user?.username || null,
    displayName: userName({
      telegramId,
      username: from.username || activity.user?.username,
      firstName: from.first_name || activity.user?.firstName,
      lastName: from.last_name || activity.user?.lastName
    }),
    animeTitle: activity.animeTitle || null,
    anilistId: activity.anilistId || null,
    anilistUrl: activity.anilistUrl || null,
    similarity: activity.similarity ?? null,
    episode: activity.episode ?? null,
    formattedTime: activity.formattedTime || null,
    inputUrl: activity.inputUrl || null,
    inputType: activity.inputType || activity.source || null,
    media: activity.media || null,
    userInput: activity.userInput || null,
    botResponse: activity.botResponse || null,
    reason: null,
    reasonKey: null,
    status: "open",
    createdAt: FieldValue.serverTimestamp(),
    resolvedAt: null,
    resolvedBy: null
  };

  await reportRef.set(report);
  return report;
}

export async function setWrongMatchReason(reportId, reasonKey) {
  const reason = WRONG_MATCH_REASONS[reasonKey] || WRONG_MATCH_REASONS.other;

  await db.collection("wrongMatchReports").doc(String(reportId)).set(
    {
      reason,
      reasonKey: WRONG_MATCH_REASONS[reasonKey] ? reasonKey : "other",
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  return reason;
}

export async function recordBotEvent(type, { user = {}, chatId = null, activityId = null, reportId = null, metadata = null } = {}) {
  try {
    await db.collection("botEvents").add({
      type,
      userId: user.telegramId || (user.id ? String(user.id) : null),
      username: user.username || null,
      chatId: chatId ? String(chatId) : null,
      activityId,
      reportId,
      metadata,
      day: todayKey(),
      createdAt: FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.warn("Bot event logging failed.", error.message);
  }
}
