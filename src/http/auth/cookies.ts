export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!(name in out)) out[name] = value; // first one wins
  }
  return out;
}

export interface CookieOptions {
  maxAgeSec: number;
  secure: boolean;
}

/** Always HttpOnly, SameSite=Lax (Strict would drop the cookie on the redirect back from Discord), Path=/, no Domain. */
export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(o.maxAgeSec))}${o.secure ? "; Secure" : ""}`;
}
