import type { UserInputRequest } from "../types.js";

/**
 * Structured option within an AskUserQuestion prompt.
 */
export interface QuestionOption {
  label: string;
  description: string;
  /** Optional preview/detail content for the option. */
  preview?: string;
}

/**
 * A single question from the AskUserQuestion tool.
 *
 * Claude uses this tool to ask the user structured questions — for example,
 * choosing between implementation approaches in plan mode. Each question has
 * 2-4 predefined options. Apps typically add a freeform "Other" option when
 * rendering.
 */
export interface AskUserQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  /** When true, the user can select multiple options. */
  multiSelect?: boolean;
}

/**
 * Parse an AskUserQuestion tool call from a UserInputRequest.
 *
 * Returns the structured questions array if this is an AskUserQuestion request,
 * or `null` if it's a regular tool request.
 *
 * @example
 * ```ts
 * onUserInputRequest: async (req) => {
 *   const questions = parseAskUserQuestion(req);
 *   if (questions) {
 *     // Render choices UI, collect answers
 *     const answers: Record<string, string> = {};
 *     for (const q of questions) {
 *       answers[q.question] = await showChoiceUI(q.options);
 *     }
 *     return { allow: true, updatedInput: { ...req.input, answers } };
 *   }
 *   // Handle as regular tool request
 *   return { allow: true };
 * }
 * ```
 */
export function parseAskUserQuestion(req: UserInputRequest): AskUserQuestion[] | null {
  if (req.toolName !== "AskUserQuestion") return null;
  const questions = (req.input as Record<string, unknown>)["questions"];
  if (!Array.isArray(questions) || questions.length === 0) return null;
  return questions as AskUserQuestion[];
}
