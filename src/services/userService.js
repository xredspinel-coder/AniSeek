import { db, FieldValue } from "../firebaseAdmin.js";

function getContactPhone(message) {
  if (!message.contact || !message.from) {
    return undefined;
  }

  return String(message.contact.user_id) === String(message.from.id)
    ? message.contact.phone_number || null
    : undefined;
}

function buildTelegramProfile(message) {
  const from = message.from || {};
  const phoneNumber = getContactPhone(message);
  const profile = {
    telegramId: String(from.id),
    username: from.username || null,
    firstName: from.first_name || null,
    lastName: from.last_name || null,
    languageCode: from.language_code || null,
    lastSeenAt: FieldValue.serverTimestamp()
  };

  if (phoneNumber !== undefined) {
    profile.phoneNumber = phoneNumber;
  }

  return profile;
}

export async function getOrCreateUser(message) {
  const telegramId = String(message.from?.id || "");

  if (!telegramId) {
    throw new Error("Telegram message has no sender id.");
  }

  const ref = db.collection("users").doc(telegramId);
  const profile = buildTelegramProfile(message);
  let resolvedUser;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);

    if (!snapshot.exists) {
      resolvedUser = {
        ...profile,
        phoneNumber: profile.phoneNumber ?? null,
        photoUrl: null,
        dailyUsed: 0,
        dailyUsedDate: null,
        dailyLimitOverride: null,
        unlimitedUntil: null,
        trustedUser: false,
        trustedUntil: null,
        isBlocked: false,
        isAdmin: false
      };

      transaction.set(ref, {
        ...resolvedUser,
        createdAt: FieldValue.serverTimestamp()
      });
      return;
    }

    resolvedUser = {
      telegramId,
      phoneNumber: null,
      photoUrl: null,
      dailyUsed: 0,
      dailyUsedDate: null,
      dailyLimitOverride: null,
      unlimitedUntil: null,
      trustedUser: false,
      trustedUntil: null,
      isBlocked: false,
      isAdmin: false,
      ...snapshot.data(),
      ...Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined))
    };

    transaction.set(ref, profile, { merge: true });
  });

  return resolvedUser;
}

export function userRef(telegramId) {
  return db.collection("users").doc(String(telegramId));
}
