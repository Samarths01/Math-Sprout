import type { BuildGoalProjection, ProjectedPiece } from "@/lib/build-goal";
import { interfaceCopy } from "@/lib/interface-copy";

function pieceLabel(piece: ProjectedPiece): string {
  const name = interfaceCopy(piece.copyKey);
  if (piece.role === "badge" && piece.skill) return `${name} · ${piece.skill}`;
  return name;
}

/** Pot and build detail. Lives on the badges screen, not the child home. */
export function BuildGoalPanel({ build }: { build: BuildGoalProjection }) {
  const { active, completed } = build;
  const slots = active.complete
    ? active.pieces.length
    : Math.max(active.pieceTarget, active.pieces.length);

  return (
    <section
      className="grid gap-2"
      data-testid="build-goal"
      data-fuel="pieces"
      data-fuel-source="qualifying-event"
      data-goal-id={active.id}
      data-goal-active="true"
      data-piece-count={active.pieces.length}
      data-piece-target={active.pieceTarget}
      data-goal-complete={active.complete ? "true" : "false"}
    >
      <h2 className="font-heading text-xl">{active.title}</h2>
      {active.pieces.length === 0 ? (
        <p className="text-sm leading-6 text-muted-foreground" data-copy-key="build.empty">
          {interfaceCopy("build.empty")}
        </p>
      ) : null}
      {active.complete ? (
        <p className="text-sm leading-6" data-copy-key="build.complete">
          {interfaceCopy("build.complete")}
        </p>
      ) : null}
      <ol className="grid gap-2">
        {Array.from({ length: slots }, (_, index) => {
          const piece = active.pieces[index];
          return (
            <li
              key={piece?.eventId ?? `open-${index}`}
              data-testid="build-slot"
              data-piece-role={piece?.role ?? "open"}
              data-event-id={piece?.eventId ?? ""}
              className={
                piece
                  ? "rounded-lg bg-piece/15 px-3 py-2 text-sm text-piece"
                  : "rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
              }
            >
              {piece ? pieceLabel(piece) : "Still open"}
            </li>
          );
        })}
      </ol>
      {completed.length > 0 ? (
        <ul className="grid gap-1">
          {completed.map((goal) => (
            <li
              key={goal.id}
              data-testid="build-goal-complete"
              data-goal-id={goal.id}
              className="text-sm text-muted-foreground"
            >
              {goal.title}. {interfaceCopy("build.complete")}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
