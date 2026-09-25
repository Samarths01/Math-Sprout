import type { AttemptResult, PublicItem } from "@/lib/attempt-contract";
import { feedbackFrames } from "@/lib/feedback-frame";
import { interfaceCopy } from "@/lib/interface-copy";
import { showResumeCelebration } from "@/lib/pause-hold";
import { MintToast } from "@/components/mint-toast";
import { VerdictStrip } from "@/components/verdict-strip";

export function PracticeFeedback({
  feedback,
  item,
}: {
  feedback: AttemptResult;
  item: PublicItem;
}) {
  const frames = feedbackFrames(feedback);
  return (
    <>
      <VerdictStrip correct={feedback.correct} />
      <dl className="grid gap-3">
        {frames.map((frame) => (
          <div key={frame.key} className="grid gap-1">
            <dt
              className="text-[13px] font-medium tracking-[0.04em] text-label uppercase"
              data-beat-label={frame.label}
            >
              {frame.label}
            </dt>
            <dd data-testid={`beat-${frame.key}`} className="text-sm leading-6">
              {frame.text}
            </dd>
          </div>
        ))}
      </dl>
      {showResumeCelebration(feedback) ? (
        <MintToast
          tier={feedback.clientView.celebrationTier}
          credit={feedback.fuel.credit}
          eventCount={feedback.eventIds.length}
          pieceEventIds={feedback.fuel.pieceEventIds}
          replayed={feedback.replayed}
        />
      ) : (
        <p
          data-testid="quiet-resume"
          data-presentation="quiet"
          role="status"
          className="text-sm leading-6"
        >
          {interfaceCopy("pause.resume.quiet")}
        </p>
      )}
      <div data-testid="client-view" className="grid gap-2">
        <p data-band-label={feedback.clientView.bandLabel}>{feedback.clientView.bandLabel}</p>
        {feedback.clientView.showConceptChip ? (
          <p data-testid="concept-chip" className="text-sm text-muted-foreground">
            {item.skill}
          </p>
        ) : null}
      </div>
    </>
  );
}
