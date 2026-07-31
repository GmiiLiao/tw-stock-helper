// ============================================================
// Firebase Admin (server-only). Used for privileged Firestore writes
// (history store, after-close analysis) that bypass security rules.
//
// Credentials: Application Default Credentials (ADC).
//   • On Firebase App Hosting / Cloud Run: ADC is provided automatically.
//   • Locally: run `gcloud auth application-default login` once, OR set
//     GOOGLE_APPLICATION_CREDENTIALS to a service-account key path.
//
// getAdminDb() returns null when no credentials are available, so callers
// degrade gracefully instead of crashing.
// ============================================================

import { getApps, initializeApp, applicationDefault, cert, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

let cached: Firestore | null | undefined;

function initAdminApp(): App | null {
  if (getApps().length) return getApps()[0];

  // Prefer an explicit service-account JSON if provided (FIREBASE_SERVICE_ACCOUNT),
  // otherwise fall back to ADC (App Hosting / gcloud login).
  try {
    const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (svc) {
      const parsed = JSON.parse(svc);
      return initializeApp({ credential: cert(parsed), projectId: parsed.project_id || PROJECT_ID });
    }
    return initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  } catch (e) {
    console.warn('[firebase-admin] init failed — admin writes disabled:', (e as Error).message);
    return null;
  }
}

/** Lazily initialise and return the Admin Firestore, or null if unavailable. */
export function getAdminDb(): Firestore | null {
  if (cached !== undefined) return cached;
  const app = initAdminApp();
  cached = app ? getFirestore(app) : null;
  return cached;
}
