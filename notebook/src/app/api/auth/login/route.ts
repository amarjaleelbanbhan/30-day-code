import { NextResponse, type NextRequest } from "next/server";
import { sameOrigin } from "@/lib/api";
import { createSession, verifyPassword } from "@/lib/auth";
import { q1 } from "@/lib/db";
import { credentialsSchema } from "@/lib/validation";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const parsed = credentialsSchema.safeParse(await req.json().catch(() => null));
  const fail = NextResponse.json({ error: "Wrong email or password" }, { status: 401 });
  if (!parsed.success) return fail;
  const user = await q1<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = $1", [parsed.data.email]);
  if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) return fail;
  await createSession(user.id);
  return NextResponse.json({ ok: true });
}
