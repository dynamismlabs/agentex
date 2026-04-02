import { useState } from "react";
import { useApp } from "../AppContext";
import { api } from "../api";
import { HelpCircle, Check, ChevronRight } from "lucide-react";
import type { AgentQuestion } from "../../types";

function QuestionCard({ question, onAnswered }: { question: AgentQuestion; onAnswered: () => void }) {
  const { state } = useApp();
  const agent = state.agents.find((a) => a.id === question.agentId);

  // Track selected answers per question index
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [currentIdx, setCurrentIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const q = question.questions[currentIdx];
  if (!q) return null;

  const isMulti = q.multiSelect ?? false;
  const selected = selections[currentIdx] ?? [];
  const isLast = currentIdx === question.questions.length - 1;
  const allAnswered = question.questions.every((_, i) => (selections[i] ?? []).length > 0);

  function toggleOption(label: string) {
    setSelections((prev) => {
      const current = prev[currentIdx] ?? [];
      if (isMulti) {
        const next = current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label];
        return { ...prev, [currentIdx]: next };
      }
      return { ...prev, [currentIdx]: [label] };
    });
  }

  async function submit() {
    setSubmitting(true);
    const answers: Record<string, string> = {};
    for (let i = 0; i < question.questions.length; i++) {
      const qText = question.questions[i]!.question;
      answers[qText] = (selections[i] ?? []).join(", ");
    }
    try {
      await api("POST", `/api/questions/${question.requestId}/answer`, { answers });
      onAnswered();
    } finally {
      setSubmitting(false);
    }
  }

  function handleNext() {
    if (isLast) {
      submit();
    } else {
      setCurrentIdx((i) => i + 1);
    }
  }

  return (
    <div className="bg-surface border border-amber-500/30 rounded-2xl shadow-[0_8px_40px_rgba(0,0,0,0.4),0_0_20px_rgba(245,158,11,0.08)] overflow-hidden animate-slide-up">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3.5 bg-amber-500/5 border-b border-amber-500/20">
        <div className="w-7 h-7 rounded-full bg-amber-500/15 flex items-center justify-center">
          <HelpCircle size={16} className="text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-text-primary truncate">
            {agent?.name ?? "Agent"} needs your input
          </div>
          {question.questions.length > 1 && (
            <div className="text-[11px] text-text-tertiary mt-0.5">
              Question {currentIdx + 1} of {question.questions.length}
            </div>
          )}
        </div>
        {isMulti && (
          <span className="text-[10px] uppercase tracking-wider text-amber-400/70 font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20">
            multi-select
          </span>
        )}
      </div>

      {/* Question */}
      <div className="px-5 pt-4 pb-3">
        <div className="text-base font-medium text-text-primary leading-snug mb-1">
          {q.header || q.question}
        </div>
        {q.header && q.header !== q.question && (
          <div className="text-sm text-text-secondary mb-1">{q.question}</div>
        )}
      </div>

      {/* Options */}
      <div className="px-5 pb-4 flex flex-col gap-2">
        {q.options.map((opt) => {
          const isSelected = selected.includes(opt.label);
          return (
            <button
              key={opt.label}
              onClick={() => toggleOption(opt.label)}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all duration-150 border ${
                isSelected
                  ? "bg-primary/10 border-primary/40 text-text-primary shadow-[0_0_12px_rgba(99,102,241,0.1)]"
                  : "bg-background border-border hover:border-zinc-600 hover:bg-surface-hover text-text-secondary"
              }`}
            >
              <div
                className={`w-5 h-5 rounded-${isMulti ? "md" : "full"} border-2 flex items-center justify-center shrink-0 transition-colors ${
                  isSelected ? "border-primary bg-primary" : "border-zinc-600"
                }`}
              >
                {isSelected && <Check size={12} className="text-white" strokeWidth={3} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{opt.label}</div>
                {opt.description && (
                  <div className="text-xs text-text-tertiary mt-0.5">{opt.description}</div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Progress dots + action */}
      <div className="flex items-center justify-between px-5 py-3.5 border-t border-border bg-background/50">
        {/* Step dots */}
        {question.questions.length > 1 ? (
          <div className="flex gap-1.5">
            {question.questions.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrentIdx(i)}
                className={`w-2 h-2 rounded-full transition-colors ${
                  i === currentIdx
                    ? "bg-primary"
                    : (selections[i] ?? []).length > 0
                      ? "bg-emerald-500"
                      : "bg-zinc-600"
                }`}
              />
            ))}
          </div>
        ) : (
          <div />
        )}

        <button
          disabled={selected.length === 0 || submitting || (isLast && !allAnswered)}
          onClick={handleNext}
          className="flex items-center gap-1.5 px-5 py-2 bg-primary hover:bg-primary/90 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded-xl transition-colors shadow-sm"
        >
          {submitting ? (
            "Sending..."
          ) : isLast ? (
            <>
              Submit
              <Check size={14} />
            </>
          ) : (
            <>
              Next
              <ChevronRight size={14} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export default function QuestionOverlay() {
  const { pendingQuestions, activeAgentId } = useApp();

  // Show only questions for the active agent
  const agentQuestions = pendingQuestions.filter((q) => q.agentId === activeAgentId);
  if (agentQuestions.length === 0) return null;

  // Show the most recent question
  const question = agentQuestions[agentQuestions.length - 1]!;

  return (
    <div className="absolute inset-x-0 bottom-0 z-20 p-4 pointer-events-none">
      <div className="pointer-events-auto max-w-md mx-auto">
        <QuestionCard
          key={question.requestId}
          question={question}
          onAnswered={() => {}}
        />
      </div>
    </div>
  );
}
