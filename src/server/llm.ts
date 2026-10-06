import "server-only";
import { ApiError } from "./http";
import { env } from "./env";

/** Minimal OpenRouter (OpenAI-compatible) chat client with tool calling. No SDK dependency. */
export type LlmMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type LlmTool = { type: "function"; function: { name: string; description: string; parameters: unknown } };
export type LlmToolCall = { id: string; name: string; arguments: string };
export type LlmResult = { content: string | null; toolCalls: LlmToolCall[] };

export const assistantEnabled = () => !!env.OPENROUTER_API_KEY;

export async function chatCompletion(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmResult> {
  if (!assistantEnabled()) throw new ApiError(503, "ASSISTANT_DISABLED", "The assistant is not configured", "Set OPENROUTER_API_KEY to enable it.");
  let res: Response;
  try {
    res = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.APP_URL,
        "X-Title": "Baby Health",
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0,
        max_tokens: 1500,
        // Health data: only route to providers that support tools and do not retain/train on prompts.
        provider: { require_parameters: true, data_collection: "deny" },
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new ApiError(502, "ASSISTANT_UNAVAILABLE", "The assistant is not reachable right now", "Please try again, or use the forms.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[openrouter]", res.status, text.slice(0, 500));
    throw new ApiError(502, "ASSISTANT_UNAVAILABLE", "The assistant is not reachable right now", "Please try again, or use the forms.");
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  };
  const msg = data.choices?.[0]?.message;
  return {
    content: msg?.content?.trim() || null,
    toolCalls: (msg?.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments || "{}" })),
  };
}
