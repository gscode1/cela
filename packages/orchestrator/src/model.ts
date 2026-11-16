import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";

/** The JSON object a scripted tool call carries as its arguments. */
type ToolArgs = Parameters<typeof fauxToolCall>[1];

/**
 * A session's script, carried as the JSON text of its first user message. The model has no state of
 * its own: every reply is a pure function of the transcript, so a restarted orchestrator continues
 * the script exactly where the stored transcript stopped.
 */
export interface Script {
  /**
   * One tool call per step, in order: `bash` (`timeout` is the bash tool's own limit in seconds), or any named tool
   * with its arguments (e2e uses it to call `tool_search` and `mcp__*` tools).
   */
  steps: ({ bash: string; timeout?: number } | { tool: string; args: ToolArgs })[];
  /** Final answer once every step has a tool result. */
  final?: string;
  /**
   * Instead of a final answer, the model request fails with this text once every step has a result. Test-only way to
   * simulate a provider error such as `401 Unauthorized` without a real provider.
   */
  error?: string;
}

function textOf(message: Message): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

export function parseScript(text: string): Script {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("steps" in parsed) ||
    !Array.isArray(parsed.steps)
  ) {
    throw new Error("script must be an object with a steps array");
  }
  const steps = (parsed.steps as unknown[]).map((step): Script["steps"][number] => {
    if (
      typeof step === "object" &&
      step !== null &&
      "tool" in step &&
      typeof step.tool === "string" &&
      "args" in step &&
      typeof step.args === "object" &&
      step.args !== null &&
      !Array.isArray(step.args)
    ) {
      return { tool: step.tool, args: step.args as ToolArgs };
    }
    if (
      typeof step !== "object" ||
      step === null ||
      !("bash" in step) ||
      typeof step.bash !== "string"
    ) {
      throw new Error("every step needs a bash string, or a tool name and an args object");
    }
    const timeout =
      "timeout" in step && typeof step.timeout === "number" ? step.timeout : undefined;
    return { bash: step.bash, ...(timeout === undefined ? {} : { timeout }) };
  });
  const final = "final" in parsed && typeof parsed.final === "string" ? parsed.final : undefined;
  const error = "error" in parsed && typeof parsed.error === "string" ? parsed.error : undefined;
  return {
    steps,
    ...(final === undefined ? {} : { final }),
    ...(error === undefined ? {} : { error }),
  };
}

/** A script, or undefined when the text is anything else (the session API carries plain chat text too). */
export function tryParseScript(text: string): Script | undefined {
  try {
    return parseScript(text);
  } catch {
    return undefined;
  }
}

/**
 * The scripted reply for a transcript: the next unfinished step, else the final answer. A user message that
 * is not a script is plain chat text and is answered with `echo: <text>`, so message order shows in answers.
 */
export const scriptedReply: FauxResponseFactory = (context) => {
  const messages = context.messages;
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const lastText = textOf(
    messages[lastUser] ?? messages[0] ?? { role: "user", content: "{}", timestamp: 0 },
  );
  const script = tryParseScript(lastText);
  if (script === undefined) return fauxAssistantMessage(fauxText(`echo: ${lastText}`));
  const done = messages
    .slice(lastUser + 1)
    .filter((message) => message.role === "toolResult").length;
  const step = script.steps[done];
  if (step === undefined) {
    if (script.error !== undefined) {
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: script.error });
    }
    return fauxAssistantMessage(fauxText(script.final ?? "done"));
  }
  // A stable id per (user message, step): a retried request after a restart repeats the same call.
  const id = `step-${String(lastUser)}-${String(done)}`;
  const call =
    "tool" in step
      ? fauxToolCall(step.tool, step.args, { id })
      : fauxToolCall(
          "bash",
          { command: step.bash, ...(step.timeout === undefined ? {} : { timeout: step.timeout }) },
          { id },
        );
  return fauxAssistantMessage(call, { stopReason: "toolUse" });
};

const QUEUED_REPLIES = 100_000;

/**
 * Pi's own faux provider, loaded with enough copies of the stateless script for any number of requests.
 * `faux` / `faux-1` is the Phase 3 /control surface; `scripted` has two models so e2e can tell sessions apart.
 */
export function scriptedProvider(
  options?: Parameters<typeof fauxProvider>[0],
): ReturnType<typeof fauxProvider> {
  const faux = fauxProvider(options);
  faux.setResponses(Array.from({ length: QUEUED_REPLIES }, () => scriptedReply));
  return faux;
}
