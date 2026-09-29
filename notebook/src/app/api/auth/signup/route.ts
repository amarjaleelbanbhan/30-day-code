import { NextResponse, type NextRequest } from "next/server";
import { sameOrigin } from "@/lib/api";
import { createSession, hashPassword } from "@/lib/auth";
import { q1 } from "@/lib/db";
import { credentialsSchema } from "@/lib/validation";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const parsed = credentialsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  const { email, password } = parsed.data;
  const user = await q1<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id",
    [email, await hashPassword(password)]);
  if (!user) return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 });
  await createSession(user.id);
  return NextResponse.json({ ok: true });
}
