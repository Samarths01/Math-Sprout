import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { ChildHomeFrame } from "@/components/child-home";
import { FlameMark, PieceMark, StarMark } from "@/components/fuel-mark";
import { FuelStrip } from "@/components/fuel-strip";
import { VerdictStrip } from "@/components/verdict-strip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { feedbackFrames } from "@/lib/feedback-frame";
import { FLAME_CHIP_CLASS, stepClass } from "@/lib/palette";
import type { StreakState } from "@/lib/streak";

const CHILD = "preview-leo";

export function HifiFrames() {
  return (
    <main className="flex flex-col items-center gap-10 bg-background px-4 py-8">
      <style>{`@keyframes hifi-fade{from{opacity:0}to{opacity:1}}`}</style>
      <Phone id="home" title="Child home">
        <div className="grid gap-6">
          <AppHeader eyebrow="Child home" />
          <ChildHomeFrame
            childId={CHILD}
            displayName="Leo"
            concept="Adding two-digit numbers"
            bandLabel="Getting it"
            consentStatus="granted"
            glance={{ xp: 120, dayCount: 4, pieces: 2, goal: 5 }}
            started
            sourceEventId="preview-day"
            heat="hot"
            fuelText="4-day flame · 120 · 2/5"
          />
        </div>
      </Phone>
      <Phone id="question" title="Practice question">
        <PracticeCard
          fuel="3-day flame · 120 · 2/5"
          heat="hot"
          badge="Steady"
          grade={3}
        >
          <Equation />
          <Button type="button" size="primary">
            Check
          </Button>
        </PracticeCard>
      </Phone>
      <Phone id="correct-mint" title="Correct with a mint">
        <PracticeCard
          fuel="3-day flame · 130 · 3/5"
          heat="hot"
          badge="Steady"
          grade={3}
          xp={130}
          pieces={3}
        >
          <VerdictStrip correct />
          <RewardLine />
          <Beats
            correct
            whatWentWell="You counted up from 27 to find the missing number."
            oneFocus=""
            tryNext=""
            lockIn="27 + 15 = 42"
          />
          <Button type="button" size="primary">
            Next problem
          </Button>
        </PracticeCard>
      </Phone>
      <Phone id="correct-review" title="Correct without a mint">
        <PracticeCard
          fuel="3-day flame · 120 · 2/5"
          heat="hot"
          badge="Steady"
          grade={3}
        >
          <VerdictStrip correct />
          <Beats
            correct
            whatWentWell="You counted up from 27 to find the missing number."
            oneFocus=""
            tryNext=""
            lockIn="27 + 15 = 42"
          />
          <Button type="button" size="primary">
            Next problem
          </Button>
        </PracticeCard>
      </Phone>
      <Phone id="not-yet" title="Not yet">
        <PracticeCard
          fuel="3-day flame · 120 · 2/5"
          heat="hot"
          badge="Steady"
          grade={3}
        >
          <VerdictStrip correct={false} />
          <Beats
            correct={false}
            whatWentWell="You wrote 25."
            oneFocus="Count up from 27 to 42. The jump is 15."
            tryNext=""
            lockIn="27 + 15 = 42"
          />
          <Button type="button" size="primary">
            Next problem
          </Button>
        </PracticeCard>
      </Phone>
      <Phone id="flames" title="Flame states">
        <ul className="grid gap-4">
          <FlameState heat="hot" label="4-day flame" caption="Practiced today" />
          <FlameState heat="warm" label="3-day flame" caption="Keep it going today" />
          <FlameState
            heat="ember"
            label="3-day flame"
            caption="Your flame is low. One practice relights it."
          />
          <FlameState heat="dormant" label="Flame resting" caption="Practice to light it again" />
        </ul>
      </Phone>
      <Phone id="session-end" title="End of session">
        <Card>
          <CardContent className="grid gap-4">
            <h1 className="font-heading text-[22px] leading-[28px]">Nice practice today</h1>
            <div className="flex flex-wrap gap-2">
              <Chip className={FLAME_CHIP_CLASS.hot}>
                <FlameMark />
                4-day flame
              </Chip>
              <Chip className="bg-xp/12 text-xp">
                <StarMark />
                +30 XP today
              </Chip>
              <Chip className="bg-piece/12 text-piece">
                <PieceMark />
                Piece 3 of 5
              </Chip>
            </div>
            <Button type="button" size="primary">
              Back home
            </Button>
          </CardContent>
        </Card>
      </Phone>
    </main>
  );
}

function Phone({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <figure className="grid gap-2">
      <figcaption className="text-[13px] font-medium tracking-[0.04em] text-label uppercase">
        {title}
      </figcaption>
      <div
        data-frame={id}
        className="h-[844px] w-[390px] overflow-hidden bg-background px-5 py-6"
      >
        {children}
      </div>
    </figure>
  );
}

function PracticeCard({
  fuel,
  heat,
  badge,
  grade,
  xp = 120,
  pieces = 2,
  children,
}: {
  fuel: string;
  heat: StreakState;
  badge: string;
  grade: number;
  xp?: number;
  pieces?: number;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3">
      <FuelStrip
        childId={CHILD}
        text={fuel}
        xp={xp}
        dayCount={3}
        pieces={pieces}
        goal={5}
        flame="lit"
        heat={heat}
        sourceEventId="preview-day"
      />
      <Card>
        <CardContent className="grid gap-4">
          <span
            data-testid="difficulty-badge"
            className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${badgeClass(badge, grade)}`}
          >
            {badge}
          </span>
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

/** Warm-up is the light slate, Steady the middle, Stretch the darkest with white text. */
function badgeClass(badge: string, grade: number): string {
  if (badge === "Warm-up") return "bg-step-1 text-foreground";
  if (badge === "Steady") return "bg-step-3 text-foreground";
  if (badge === "Stretch") return "bg-step-5 text-white";
  return stepClass(grade);
}

function Equation() {
  return (
    <p className="font-heading text-[32px] leading-[40px] tabular-nums">
      27 +{" "}
      <span className="mx-1 inline-block h-[52px] w-16 rounded-[10px] border-2 border-step-3 align-baseline" />{" "}
      = 42
    </p>
  );
}

function Beats({
  correct,
  whatWentWell,
  oneFocus,
  tryNext,
  lockIn,
}: {
  correct: boolean;
  whatWentWell: string;
  oneFocus: string;
  tryNext: string;
  lockIn: string;
}) {
  const frames = feedbackFrames({ correct, whatWentWell, oneFocus, tryNext, lockIn });
  return (
    <dl className="grid gap-3">
      {frames.map((frame) => (
        <div key={frame.key} className="grid gap-1">
          <dt className="text-[13px] font-medium tracking-[0.04em] text-label uppercase">
            {frame.label}
          </dt>
          <dd className="text-base leading-6">{frame.text}</dd>
        </div>
      ))}
    </dl>
  );
}

function RewardLine() {
  return (
    <div className="flex flex-wrap gap-2" style={{ animation: "hifi-fade 700ms ease both" }}>
      <Chip className="bg-xp/12 text-xp">
        <StarMark />
        +10 XP
      </Chip>
      <Chip className={FLAME_CHIP_CLASS.hot}>
        <FlameMark />
        Flame lit today
      </Chip>
      <Chip className="bg-piece/12 text-piece">
        <PieceMark />
        Piece 3 of 5
      </Chip>
    </div>
  );
}

function FlameState({
  heat,
  label,
  caption,
}: {
  heat: StreakState;
  label: string;
  caption: string;
}) {
  return (
    <li className="grid gap-1">
      <Chip className={FLAME_CHIP_CLASS[heat]}>
        <FlameMark />
        {label}
      </Chip>
      <p className="text-base leading-6 text-label">{caption}</p>
    </li>
  );
}

function Chip({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-7 w-fit items-center gap-1 rounded-full px-2 text-[13px] font-semibold tabular-nums ${className}`}
    >
      {children}
    </span>
  );
}
