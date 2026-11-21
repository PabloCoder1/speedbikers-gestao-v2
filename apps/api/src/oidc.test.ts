import type { OAuth2Client } from "google-auth-library";
import { describe, expect, it, vi } from "vitest";

import { createOidcVerifier } from "./oidc.js";

function fakeOidcClient(payload: { email?: string; email_verified?: boolean } | undefined) {
  const verifyIdToken = vi.fn(() =>
    Promise.resolve({
      getPayload: () => payload,
    }),
  );

  return {
    client: { verifyIdToken } as unknown as OAuth2Client,
    verifyIdToken,
  };
}

describe("createOidcVerifier (D-775)", () => {
  const ALLOWED_EMAIL = "scheduler@projeto.iam.gserviceaccount.com";
  const ALLOWED = [ALLOWED_EMAIL];

  it("aceita service account autorizada com email_verified=true", async () => {
    const { client } = fakeOidcClient({ email: ALLOWED_EMAIL, email_verified: true });
    const verifier = createOidcVerifier({ audience: "https://api.example.com", allowedServiceAccounts: ALLOWED }, client);

    await expect(verifier.verify("Bearer jwt.valido.sig")).resolves.toEqual({
      ok: true,
      email: ALLOWED_EMAIL,
    });
  });

  it("recusa token cujo email_verified não é true mesmo se o e-mail estiver na allowlist", async () => {
    for (const emailVerified of [false, undefined]) {
      const { client } = fakeOidcClient({
        email: ALLOWED_EMAIL,
        ...(emailVerified === undefined ? {} : { email_verified: emailVerified }),
      });
      const verifier = createOidcVerifier({ audience: "https://api.example.com", allowedServiceAccounts: ALLOWED }, client);

      await expect(verifier.verify("Bearer jwt.nao-verificado.sig")).resolves.toEqual({
        ok: false,
        reason: "e-mail do token não verificado",
      });
    }
  });

  it("recusa Bearer vazio ou com espaços antes de chamar verifyIdToken", async () => {
    const { client, verifyIdToken } = fakeOidcClient({ email: ALLOWED_EMAIL, email_verified: true });
    const verifier = createOidcVerifier({ audience: "https://api.example.com", allowedServiceAccounts: ALLOWED }, client);

    await expect(verifier.verify("Bearer    ")).resolves.toMatchObject({ ok: false });
    await expect(verifier.verify("Bearer token extra")).resolves.toMatchObject({ ok: false });
    expect(verifyIdToken).not.toHaveBeenCalled();
  });
});
