import { access, requireOwner } from "@/lib/access";
import { checkOrigin } from "@/lib/store";
import { env } from "cloudflare:workers";
import { z } from "zod";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  // SDP is a wire format: preserve its terminating CRLF and all other bytes.
  sdp: z.string().min(1).max(64_000).refine((value) => value.startsWith("v=0") && value.endsWith("\r\n"), "Invalid WebRTC offer. Please reconnect."),
});

async function safetyIdentifier(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(req: Request) {
  try {
    checkOrigin(req);
    if (Number(req.headers.get("content-length") || 0) > 80_000)
      throw new Error("Voice request too large.");

    const auth = await access(req);
    requireOwner(auth);
    const { sdp } = requestSchema.parse(await req.json());
    const runtimeEnv = env as unknown as { OPENAI_API_KEY?: string };
    const apiKey = req.headers.get("x-model-key") || runtimeEnv.OPENAI_API_KEY;
    if (!apiKey)
      return Response.json(
        { error: "Connect your OpenAI API key in Settings first." },
        { status: 503 },
      );

    const response = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": await safetyIdentifier(auth.userId),
      },
      body: JSON.stringify({
        session: {
          model: "gpt-live-1",
          instructions: [
            "You are the warm, concise voice of Constellation, a collaborative agent office.",
            "Be a conversational teammate. Welcome casual chat, brainstorming, questions, feedback and role-specific advice. Conversation is the default, not task creation. Do not repeatedly steer discussion toward task briefs. If the user tells you a teammate's name and role, remember that within this conversation and offer to speak from that role's perspective. Do not pretend to know a roster or task progress that you have not been given.",
            "Keep spoken replies to one or two short sentences.",
            "Only delegate when the user explicitly requests an actionable task to be created or carried out. Greetings, asking to speak to someone, brainstorming and asking for advice are conversation, not task requests. Clarify ambiguous execution requests before delegating.",
            "Do not claim that you created, started, changed, or completed anything in the office.",
            "The interface will offer the user a reviewable task draft from their own transcript.",
          ].join(" "),
          delegation: { type: "client" },
        },
        transport: { type: "webrtc", sdp },
      }),
    });

    const result = await response.text();
    if (!response.ok) {
      let detail = "";
      try {
        const payload = JSON.parse(result) as { error?: { message?: string } };
        detail = typeof payload.error?.message === "string" ? payload.error.message : "";
      } catch {
        // Non-JSON gateway responses should never be rendered in the interface.
      }
      detail = detail.split(apiKey).join("[redacted]").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 400);
      console.error("GPT-Live session creation failed", response.status);
      return Response.json(
        { error: `GPT-Live could not connect (${response.status}).${detail ? ` ${detail}` : " Please try again."}` },
        { status: response.status },
      );
    }

    return new Response(result, {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      { error: (error as Error).message },
      { status: (error as { status?: number }).status || 400 },
    );
  }
}
