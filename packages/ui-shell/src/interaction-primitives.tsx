/// <reference path="./styles.d.ts" />
import type { ComponentProps, ReactNode } from "react";
import styles from "./interaction-primitives.module.css";

export type ActionVariant = "primary" | "secondary" | "quiet" | "icon";

/** Shared action treatment for native buttons and router links in every app. */
export function actionClassName(
  variant: ActionVariant = "primary",
  className = "",
) {
  return `${styles.action} ${styles[variant]} ${className}`.trim();
}

export function ActionButton({
  variant = "primary",
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: ActionVariant }) {
  return (
    <button
      type={type}
      className={actionClassName(variant, className)}
      {...props}
    />
  );
}

/** Native radios retain keyboard/fieldset semantics; stable slots prevent layout jumps. */
export function ChoiceOption({
  label,
  marker,
  checked,
  ...props
}: Omit<ComponentProps<"input">, "type" | "className"> & {
  label: ReactNode;
  marker: ReactNode;
}) {
  return (
    <label className={styles.choice} data-selected={Boolean(checked)}>
      <input type="radio" checked={checked} {...props} />
      <span className={styles.choiceMarker} aria-hidden="true">
        {marker}
      </span>
      <span className={styles.choiceText}>{label}</span>
      <span className={styles.choiceCheck} aria-hidden="true">
        {checked ? "✓" : ""}
      </span>
    </label>
  );
}

/** Focused tasks have no application chrome. Only the task body may overflow. */
export function FocusSession({
  header,
  children,
}: {
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <main id="main-content" className={styles.session} tabIndex={-1}>
      <header className={styles.sessionHeader}>{header}</header>
      <div className={styles.sessionContent}>{children}</div>
    </main>
  );
}

/** The primary action never sits below the scrollable prompt or behind an overlay. */
export function SessionStep({
  children,
  footer,
  labelledBy,
  className = "",
}: {
  children: ReactNode;
  footer: ReactNode;
  labelledBy: string;
  className?: string;
}) {
  return (
    <section
      className={`${styles.step} ${className}`.trim()}
      aria-labelledby={labelledBy}
    >
      <div className={styles.stepBody} data-session-scroll="body">
        {children}
      </div>
      <footer className={styles.stepFooter}>{footer}</footer>
    </section>
  );
}
