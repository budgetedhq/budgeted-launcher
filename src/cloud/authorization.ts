export function assertOwnerClaims(claims: Record<string, unknown> | undefined, ownerEmail: string) {
  const email = typeof claims?.email === "string" ? claims.email : "";
  const verified = claims?.email_verified === true || claims?.email_verified === "true";
  if (!verified || email.toLowerCase() !== ownerEmail.toLowerCase()) throw new Error("Only the verified launcher owner may use this application.");
}
