// "Finish your profile": shown on My desk until the onboarding wizard has everything payroll and HR need.
import Link from "next/link";
import { styles } from "../ui";
import { HelpHint } from "../kit";
import type { OnboardingState } from "../welcome/types";
import { missingText } from "../welcome/types";
import css from "./presence.module.css";

export function ProfileBanner({ state }: { state: OnboardingState }) {
  if (state.percent >= 100) return null;
  const left = state.missing.length;
  return (
    <section className={css.banner} aria-label="Finish your profile">
      {/* UX-5A: one line; what is missing sits behind "?" instead of a sentence on My desk. */}
      <span className={css.bannerText}><b>Your profile is {state.percent}% done</b><small className={css.bannerLeft}>{left === 1 ? "One thing left" : `${left} things left`} · about 3 minutes
        <HelpHint label="What is missing">{missingText(state)}.</HelpHint></small></span>
      <span className={css.meter} aria-hidden="true"><i style={{ width: `${state.percent}%` }} /></span>
      <Link href="/welcome" className={`${styles.btn} ${styles.btnPrimary}`}>Finish my profile</Link>
    </section>
  );
}
