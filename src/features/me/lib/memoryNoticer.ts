import {
  runZeroToolOneShot,
  type OneShotExecutionTarget,
} from "@/shared/api/zeroToolOneShot";
import { appendMemoryProposals } from "@/shared/api/system";
import { logRendererEvent } from "@/shared/api/rendererTelemetry";
import { isMemoryEnabledByPolicy } from "./memoryPolicyFile";
import { listTopics } from "./meTopics";
import { looksLikeCredential } from "./memoryCredentialGuard";
import {
  buildNoticerSystemPrompt,
  MAX_NOTICER_PROPOSALS_PER_PASS,
  NOTICER_VOCABULARY,
} from "./noticerPrompt";

/**
 * The memory noticer — the reliability floor for memory proposals.
 *
 * Live testing showed in-conversation proposing is prompt-flaky: the
 * primary model is busy doing the task, and noticing durable facts is a
 * second job it does only when the stars align (it quoted the proposing
 * rules back and still didn't act on them in the same chat). So, after a
 * conversation goes idle, this runs a hidden one-shot extraction pass
 * over the user's own messages and appends candidates to the same
 * queue the MCP server writes. Candidates stay local and non-recallable
 * until the person reviews and approves them in Settings → Memory.
 *
 * The extractor has zero tools (it can only emit text we parse), its
 * output lands in the queue (never memory files), and the memory toggle
 * gates the whole pass. Modeled on the security-explanation one-shot
 * (`inferExplanation.ts`).
 */

const EXTRACTION_TIMEOUT_MS = 20_000;

export { buildNoticerSystemPrompt, NOTICER_VOCABULARY };

export interface NoticedCandidate {
  content: string;
  /** Topic name from the allowed set, or null for the spine. */
  topic: string | null;
}

/**
 * Parse the extractor's output. Tolerates code fences and surrounding
 * prose; validates every candidate against the allowed topic set and
 * drops the rest. `NONE`, junk, or an unparseable reply all mean no
 * candidates — the pass is best-effort end to end.
 */
export function parseNoticerOutput(
  text: string | null,
  existingTopics: string[],
): NoticedCandidate[] {
  if (!text) return [];
  const trimmed = text.trim();
  if (!trimmed || /^NONE\b/i.test(trimmed)) return [];

  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const allowed = new Set(
    [...existingTopics, ...NOTICER_VOCABULARY].map((t) => t.toLowerCase()),
  );

  const candidates: NoticedCandidate[] = [];
  for (const item of parsed) {
    if (candidates.length >= MAX_NOTICER_PROPOSALS_PER_PASS) break;
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const content =
      typeof record.content === "string" ? record.content.trim() : "";
    if (!content || content.length > 300 || looksLikeCredential(content))
      continue;
    const rawTopic =
      typeof record.topic === "string" ? record.topic.trim() : null;
    if (rawTopic && !allowed.has(rawTopic.toLowerCase())) {
      // An out-of-vocabulary topic name means the extractor ignored its
      // bounds; dropping the candidate is safer than guessing a home.
      continue;
    }
    candidates.push({ content, topic: rawTopic || null });
  }
  return candidates;
}

export async function queueNoticedProposals(
  candidates: NoticedCandidate[],
  sessionId?: string,
): Promise<number> {
  return appendMemoryProposals(
    candidates.map((candidate) => ({
      content: candidate.content,
      topic: candidate.topic,
      sessionId: sessionId ?? null,
    })),
  );
}

async function runExtraction(
  transcript: string,
  existingTopics: string[],
  target: OneShotExecutionTarget,
): Promise<NoticedCandidate[]> {
  const userPrompt = `The person's messages from the conversation:

${transcript}`;
  const output = await runZeroToolOneShot({
    userPrompt,
    systemPrompt: buildNoticerSystemPrompt(existingTopics),
    target,
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  });
  const candidates = parseNoticerOutput(output, existingTopics);
  void logRendererEvent(
    "info",
    `[me:noticer] extraction returned ${output ? `${output.length} chars` : "null"}, parsed ${candidates.length} candidate(s)`,
  );
  return candidates;
}

/**
 * The full pass: gated on the memory toggle, extraction over the given
 * transcript, dedupe, queue. Returns the number of proposals queued.
 * Never throws — noticing is best-effort by contract.
 */
export async function noticeFromTranscript(
  transcript: string,
  sessionId: string,
  target: OneShotExecutionTarget,
): Promise<number> {
  try {
    if (!(await isMemoryEnabledByPolicy())) return 0;
    const trimmed = transcript.trim();
    if (!trimmed) return 0;

    const topics = await listTopics().catch(() => []);
    const topicLabels = topics.map((topic) => topic.label);
    const candidates = await runExtraction(trimmed, topicLabels, target);
    // The extraction is a round trip to a model, so the user can turn memory
    // off while this pass is in flight. Re-check before writing: the off state
    // must mean nothing new enters the queue, not "nothing new starts".
    if (!(await isMemoryEnabledByPolicy())) {
      void logRendererEvent(
        "info",
        "[me:noticer] pass discarded: memory turned off mid-extraction",
      );
      return 0;
    }
    return await queueNoticedProposals(candidates, sessionId);
  } catch (error) {
    console.warn("[me] memory noticer pass failed", error);
    return 0;
  }
}
