import "server-only";

import {
  createHash,
  randomBytes,
} from "node:crypto";

export function createOAuthState() {
  return randomBytes(32)
    .toString("base64url");
}

export function hashOAuthState(
  state: string,
) {
  return createHash("sha256")
    .update(state)
    .digest("hex");
}

export function createPkceVerifier() {
  return randomBytes(64)
    .toString("base64url");
}

export function createPkceChallenge(
  verifier: string,
) {
  return createHash("sha256")
    .update(verifier)
    .digest("base64url");
}