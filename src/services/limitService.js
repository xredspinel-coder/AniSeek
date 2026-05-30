import { db, FieldValue } from "../firebaseAdmin.js";
import { userRef } from "./userService.js";

export function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

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

function parseNonNegativeInteger(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const numericValue = typeof value === "number" ? value : Number(String(value).trim());

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return fallback;
  }

  return Math.floor(numericValue);
}

export function resolveDailyLimit(user, settings) {
  const override = parseNonNegativeInteger(user.dailyLimitOverride);

  if (override !== null) {
    return override;
  }

  return parseNonNegativeInteger(settings.dailyLimit, 0);
}

function resolveDailyUsed(user) {
  return parseNonNegativeInteger(user.dailyUsed, 0);
}

export async function prepareUserDailyWindow(user) {
  const currentDay = todayKey();

  if (user.dailyUsedDate === currentDay) {
    return user;
  }

  await userRef(user.telegramId).set(
    {
      dailyUsed: 0,
      dailyUsedDate: currentDay,
      lastDailyResetAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  return {
    ...user,
    dailyUsed: 0,
    dailyUsedDate: currentDay
  };
}

export async function checkAnalysisAccess(user, settings) {
  const normalizedUser = await prepareUserDailyWindow(user);

  if (settings.maintenanceMode && !normalizedUser.isAdmin) {
    return {
      allowed: false,
      reason: "AniSeek is in maintenance mode. Please try again later."
    };
  }

  if (normalizedUser.isBlocked) {
    return {
      allowed: false,
      reason: "Your account is blocked from using AniSeek."
    };
  }

  const unlimitedUntil = toDate(normalizedUser.unlimitedUntil);
  const hasUnlimited = unlimitedUntil && unlimitedUntil.getTime() > Date.now();

  if (normalizedUser.isAdmin || hasUnlimited) {
    return {
      allowed: true,
      dailyLimit: null,
      remaining: null
    };
  }

  const dailyLimit = resolveDailyLimit(normalizedUser, settings);
  const dailyUsed = resolveDailyUsed(normalizedUser);

  if (dailyUsed >= dailyLimit) {
    return {
      allowed: false,
      dailyLimit,
      dailyUsed,
      remaining: 0,
      reason: `Daily limit reached (${dailyUsed}/${dailyLimit}).`
    };
  }

  return {
    allowed: true,
    dailyLimit,
    dailyUsed,
    remaining: Math.max(0, dailyLimit - dailyUsed)
  };
}

export async function incrementDailyUsage(telegramId) {
  const ref = userRef(telegramId);
  const currentDay = todayKey();

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.exists ? snapshot.data() : {};
    const sameDay = data.dailyUsedDate === currentDay;
    const currentUsed = sameDay ? resolveDailyUsed(data) : 0;

    transaction.set(
      ref,
      {
        dailyUsed: currentUsed + 1,
        dailyUsedDate: currentDay,
        lastSeenAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });
}
