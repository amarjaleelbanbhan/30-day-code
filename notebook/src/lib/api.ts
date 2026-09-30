import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { currentUser, type User } from "./auth";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const notFound = () => new HttpError(404, "Not found");

type Ctx<P> = { params: Promise<P> };
type Handler<P> = (req: NextRequest, user: User, params: P) => Promise<Response | unknown>;

/** Same-origin check for state-changing requests (defence in depth on top of SameSite cookies). */
export function sameOrigin(req: NextRequest): boolean {
  if (["GET", "HEAD"].includes(req.method)) return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Wraps an authenticated route handler: auth, CSRF-origin check, JSON + error mapping. */
export function route<P = Record<string, never>>(fn: Handler<P>) {
  return async (req: NextRequest, ctx: Ctx<P>): Promise<Response> => {
    try {
      if (!sameOrigin(req)) throw new HttpError(403, "Bad origin");
      const user = await currentUser();
      if (!user) throw new HttpError(401, "Not signed in");
      const out = await fn(req, user, await ctx.params);
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof ZodError) return NextResponse.json({ error: "Invalid input", issues: e.issues }, { status: 400 });
      if ((e as { code?: string })?.code === "22P02") return NextResponse.json({ error: "Not found" }, { status: 404 }); // malformed uuid in a path
      console.error(e);
      return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
    }
  };
}

export async function body(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
