import admin from "firebase-admin";

function normalizePrivateKey(privateKey) {
  if (!privateKey) {
    return "";
  }

  return privateKey.replace(/^"|"$/g, "").replace(/\\n/g, "\n");
}

function createCredential() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);

  if (projectId && clientEmail && privateKey) {
    return admin.credential.cert({
      projectId,
      clientEmail,
      privateKey
    });
  }

  return admin.credential.applicationDefault();
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: createCredential(),
    projectId: process.env.FIREBASE_PROJECT_ID || undefined
  });
}

export const db = admin.firestore();
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;
