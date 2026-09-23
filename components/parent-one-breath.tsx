import type { ParentSummary } from "@/lib/parent-summary";
import { glanceBand, glanceFocus, glanceMinutes } from "@/lib/parent-summary";

/**
 * Parent glance for one local day. Facts only: minutes, focus concept, band.
 * No link to a session, an attempt, or an answer.
 */
export function ParentOneBreathCard({ summary }: { summary: ParentSummary }) {
  return (
    <section
      data-testid="parent-one-breath"
      data-practiced={summary.practiced ? "true" : "false"}
      data-moved={summary.bandMovement.moved ? "true" : "false"}
      className="grid gap-1 rounded-lg bg-muted/60 px-3 py-3"
    >
      {summary.practiced ? (
        <>
          <p className="text-sm font-medium" data-testid="parent-one-breath-minutes">
            {glanceMinutes(summary)}
          </p>
          <p className="text-sm" data-testid="parent-one-breath-focus">
            {glanceFocus(summary.focusConcept)}
          </p>
          <p className="text-sm" data-testid="parent-one-breath-band">
            {glanceBand(summary.bandMovement)}
          </p>
        </>
      ) : (
        <p className="text-sm leading-6" data-testid="parent-one-breath-story">
          {summary.story}
        </p>
      )}
    </section>
  );
}
