import { NextResponse, type NextRequest } from "next/server";
import { sameOrigin } from "@/lib/api";
import { destroySession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  await destroySession();
  return NextResponse.json({ ok: true });
}
