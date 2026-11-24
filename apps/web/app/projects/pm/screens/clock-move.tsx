// PM-UI 11 clock move (`clock-move`): Kavya moves Orchid Towers' Day 0 from 21 Nov to 24 Nov over the dimmed project
// page. States: default (reason filled, green note), empty-reason (red "Reason is required", no note, button off), saved.
// The sheet and the page behind live in ./clock-move-client (the date and reason are live there).
import type { ClockMoveVM } from "../contract/clock-move";
import type { ScreenProps } from "../contract/shared";
import { ClockMoveView } from "./clock-move-client";

export default function ClockMoveScreen({ vm }: ScreenProps<ClockMoveVM>) {
  return <ClockMoveView vm={vm} />;
}
