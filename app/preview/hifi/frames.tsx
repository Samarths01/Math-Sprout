import type { ReactNode } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { ChildHomeFrame } from "@/components/child-home";
import { FlameMark, PieceMark, StarMark } from "@/components/fuel-mark";
import { FuelStrip } from "@/components/fuel-strip";
import { VerdictStrip } from "@/components/verdict-strip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { XP_AMOUNT } from "@/lib/attempt-contract";
import { feedbackFrames } from "@/lib/feedback-frame";
import { FLAME_CLASS, FLAME_TEXT_CLASS, FLAME_TINT_CLASS, stepClass } from "@/lib/palette";
import type { StreakState } from "@/lib/streak";

const CHILD = "preview-leo";

/**
 * A review lane mints `XP_AMOUNT.quietXp`.
 * `lib/economy-config.ts` sets how many review sessions fit in a week.
 * It does not set an XP amount, so this frame does not treat that cap as XP.
 */
const REVIEW_XP = XP_AMOUNT.quietXp;
const BEFORE_XP = 120;

export function HifiFrames() {
  return (
    <main className="flex flex-col items-center gap-10 bg-background px-4 py-8">
      <style>{`@keyframes hifi-fade{from{opacity:0}to{opacity:1}}`}</style>
      <Phone id="home" title="Child home">
        <div className="grid gap-6">
          <AppHeader />
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
            fuelText="4-day flame · 120 XP · 2/5"
          />
        </div>
      </Phone>
      <Phone id="question" title="Practice question">
        <PracticeCard
          fuel="3-day flame · 120 XP · 2/5"
          heat="warm"
          badge="Steady"
          grade={3}
          showHome
          concept="Adding two-digit numbers"
        >
          <Equation />
          <Button type="button" size="primary">
            Check
          </Button>
        </PracticeCard>
      </Phone>
      <Phone id="correct-mint" title="Correct with a mint">
        <PracticeCard
          fuel="4-day flame · 130 XP · 3/5"
          heat="hot"
          badge="Steady"
          grade={3}
          xp={130}
          pieces={3}
          dayCount={4}
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
      <Phone id="correct-review" title="Review">
        <PracticeCard
          fuel={`3-day flame · ${BEFORE_XP + REVIEW_XP} XP · 2/5`}
          heat="warm"
          badge="Steady"
          grade={3}
          xp={BEFORE_XP + REVIEW_XP}
        >
          <VerdictStrip correct />
          <p data-testid="review-xp" className="text-[13px] font-semibold text-xp-text">
            +{REVIEW_XP} XP
          </p>
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
          fuel="3-day flame · 120 XP · 2/5"
          heat="warm"
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
              <ToneChip
                tint={FLAME_TINT_CLASS.hot}
                icon={FLAME_CLASS.hot}
                text={FLAME_TEXT_CLASS.hot}
                mark={<FlameMark />}
                label="4-day flame"
              />
              <ToneChip
                tint="bg-xp-tint"
                icon="text-xp"
                text="text-xp-text"
                mark={<StarMark />}
                label="+30 XP today"
              />
              <ToneChip
                tint="bg-piece-tint"
                icon="text-piece"
                text="text-piece-text"
                mark={<PieceMark />}
                label="Piece 3 of 5"
              />
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
  xp = BEFORE_XP,
  pieces = 2,
  dayCount = 3,
  showHome = false,
  concept,
  children,
}: {
  fuel: string;
  heat: StreakState;
  badge: string;
  grade: number;
  xp?: number;
  pieces?: number;
  dayCount?: number;
  showHome?: boolean;
  concept?: string;
  children: ReactNode;
}) {
  const badgeNode = (
    <span
      data-testid="difficulty-badge"
      className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${badgeClass(badge, grade)}`}
    >
      {badge}
    </span>
  );
  return (
    <div className="grid gap-3">
      {showHome ? (
        <Link href={`/child/${CHILD}`} className="w-fit text-sm text-label">
          Home
        </Link>
      ) : null}
      <FuelStrip
        childId={CHILD}
        text={fuel}
        xp={xp}
        dayCount={dayCount}
        pieces={pieces}
        goal={5}
        flame="lit"
        heat={heat}
        sourceEventId="preview-day"
      />
      <Card>
        <CardContent className="grid gap-4">
          {concept ? (
            <div className="flex items-center gap-2">
              <p className="font-heading text-sm leading-5">{concept}</p>
              {badgeNode}
            </div>
          ) : (
            badgeNode
          )}
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

/** Warm-up is the light slate. Steady and Stretch use a darker word on the 12% tint. */
function badgeClass(badge: string, grade: number): string {
  if (badge === "Warm-up") return "bg-step-1 text-foreground";
  if (badge === "Steady") return "bg-steady-tint text-steady-text";
  if (badge === "Stretch") return "bg-stretch-tint text-stretch-text";
  return stepClass(grade);
}

function Equation() {
  return (
    <p className="flex items-center gap-2 font-heading text-[32px] leading-[40px] tabular-nums">
      <span>27 +</span>
      <span className="inline-block h-[52px] w-16 shrink-0 rounded-[10px] border-2 border-step-3" />
      <span>= 42</span>
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
    <div
      className="flex flex-nowrap items-center gap-1"
      style={{ animation: "hifi-fade 700ms ease both" }}
    >
      <ToneChip
        tight
        tint="bg-xp-tint"
        icon="text-xp"
        text="text-xp-text"
        mark={<StarMark />}
        label="+10 XP"
      />
      <ToneChip
        tight
        tint={FLAME_TINT_CLASS.hot}
        icon={FLAME_CLASS.hot}
        text={FLAME_TEXT_CLASS.hot}
        mark={<FlameMark />}
        label="Flame lit"
      />
      <ToneChip
        tight
        tint="bg-piece-tint"
        icon="text-piece"
        text="text-piece-text"
        mark={<PieceMark />}
        label="Piece 3/5"
      />
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
      <ToneChip
        tint={FLAME_TINT_CLASS[heat]}
        icon={FLAME_CLASS[heat]}
        text={FLAME_TEXT_CLASS[heat]}
        mark={<FlameMark />}
        label={label}
      />
      <p className="text-base leading-6 text-label">{caption}</p>
    </li>
  );
}

function ToneChip({
  tint,
  icon,
  text,
  mark,
  label,
  tight = false,
}: {
  tint: string;
  icon: string;
  text: string;
  mark: ReactNode;
  label: string;
  tight?: boolean;
}) {
  return (
    <span
      className={`inline-flex h-7 w-fit items-center rounded-full text-[13px] font-semibold tabular-nums ${tight ? "gap-1 px-1.5" : "gap-1 px-2"} ${tint}`}
    >
      <span className={icon}>{mark}</span>
      <span className={text}>{label}</span>
    </span>
  );
}
