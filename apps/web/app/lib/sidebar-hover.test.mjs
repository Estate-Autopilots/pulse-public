// SIDEBAR-HOVER (owner, 17 Nov 2026: "When we hover on the side ribbon (sales, money, HR, people), the sidebar should
// react in an animated way and open up what's listed under it … Messages and Chats have the same logo"). The timing
// (fake timers), less motion, touch, the keyboard, and the shell's wiring of them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { FLYOUT_EDGE, FLYOUT_FOOT, FOLD_MS, HOVER_CLOSE_MS, HOVER_MEDIA, HOVER_OPEN_MS, REDUCED_MEDIA, clickOpens, flyoutPlace, foldMs, headKey, hoverCapable, hoverIntent, itemKey, railKey } from "../../../../packages/ui-shell/src/sidebar-hover.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const shell = read("../../../../packages/ui-shell/src/shell.tsx");
const fold = read("../../../../packages/ui-shell/src/sidebar-fold.tsx");
const css = read("../../../../packages/ui-shell/src/nav.module.css");
const ORDER = ["home", "work", "chat", "sales", "money", "people", "growth", "ai", "settings"];

/** A controller on fake timers, and every list it reported. */
function setup() {
  mock.timers.enable({ apis: ["setTimeout"], now: 0 });
  const seen = [];
  const intent = hoverIntent({ rank: (k) => ORDER.indexOf(k), onChange: (open) => seen.push([...open]) });
  return { intent, seen, tick: (ms) => mock.timers.tick(ms) };
}
test.afterEach(() => mock.timers.reset());

test("the timing is the brief's: open after 120 ms of rest, close 250 ms after leaving, fold 200 ms", () => {
  assert.equal(HOVER_OPEN_MS, 120);
  assert.equal(HOVER_CLOSE_MS, 250);
  assert.equal(FOLD_MS, 200);
});

test("resting on a group opens it after 120 ms, not before", () => {
  const { intent, tick } = setup();
  intent.enter("sales", "panel");
  assert.equal(intent.pending, "sales");
  tick(119);
  assert.deepEqual(intent.open, []);
  tick(1);
  assert.deepEqual(intent.open, ["sales"]);
  assert.equal(intent.pending, null);
});

test("leaving closes a hover-opened group 250 ms later, not before", () => {
  const { intent, tick } = setup();
  intent.enter("money", "panel"); tick(120);
  intent.leave();
  tick(249);
  assert.deepEqual(intent.open, ["money"]);
  tick(1);
  assert.deepEqual(intent.open, []);
});

test("a pointer passing over a group opens nothing (no flicker)", () => {
  const { intent, seen, tick } = setup();
  for (const key of ["work", "chat", "sales", "money"]) { intent.enter(key, "panel"); tick(60); intent.leave(); }
  tick(1000);
  assert.deepEqual(seen, [], "no group opened or closed");
});

test("coming back within 250 ms keeps the group open", () => {
  const { intent, seen, tick } = setup();
  intent.enter("people", "panel"); tick(120);
  intent.leave(); tick(200);
  intent.enter("people", "panel"); tick(1000);
  assert.deepEqual(intent.open, ["people"]);
  assert.equal(seen.length, 1, "opened once, never closed in between");
});

test("in the sidebar a group opened below keeps the ones above (the list never moves under the pointer); one above closes those below", () => {
  const { intent, tick } = setup();
  intent.enter("sales", "panel"); tick(120);
  intent.leave(); intent.enter("people", "panel"); tick(120);
  assert.deepEqual(intent.open, ["sales", "people"], "Sales (above) stays while the pointer is on People");
  intent.leave(); intent.enter("work", "panel"); tick(120);
  assert.deepEqual(intent.open, ["work"], "opening Work (above both) closes Sales and People below it");
  intent.leave(); tick(250);
  assert.deepEqual(intent.open, []);
});

test("from the rail one group opens at a time", () => {
  const { intent, tick } = setup();
  intent.enter("sales", "rail"); tick(120);
  intent.leave(); intent.enter("money", "rail"); tick(119);
  assert.deepEqual(intent.open, ["sales"], "Sales until Money has had its 120 ms");
  tick(1);
  assert.deepEqual(intent.open, ["money"]);
});

test("the rail's flyout: the pointer on it keeps it, and a pass over another icon on the way opens nothing", () => {
  const { intent, tick } = setup();
  intent.enter("people", "rail"); tick(120);
  intent.leave(); intent.enter("growth", "rail"); tick(50); intent.leave(); intent.stay();
  tick(1000);
  assert.deepEqual(intent.open, ["people"]);
  intent.leave(); tick(250);
  assert.deepEqual(intent.open, []);
});

test("a click pins: the pointer's opening ends (the shell keeps it open by the person's choice), and a click before 120 ms cancels it", () => {
  const { intent, tick } = setup();
  intent.enter("sales", "panel"); tick(120);
  intent.drop("sales");
  assert.deepEqual(intent.open, []);
  intent.enter("money", "panel"); tick(40); intent.drop("money"); tick(1000);
  assert.deepEqual(intent.open, [], "the waiting opening was cancelled");
  // The click rule itself.
  assert.equal(clickOpens(true, true, true), true, "a mouse click on a group the pointer opened pins it open");
  assert.equal(clickOpens(true, false, true), false, "a mouse click on a pinned group folds it");
  assert.equal(clickOpens(false, false, true), true, "a mouse click on a folded group opens it");
});

test("focus inside keeps a hover-opened group open while the pointer is away; it closes once focus leaves", () => {
  const { intent, tick } = setup();
  intent.enter("money", "panel"); tick(120);
  intent.hold("money");
  intent.leave(); tick(1000);
  assert.deepEqual(intent.open, ["money"], "focus-within keeps it");
  intent.hold(null); tick(249);
  assert.deepEqual(intent.open, ["money"]);
  tick(1);
  assert.deepEqual(intent.open, []);
});

test("focus holds a group against the sidebar's own openings, not against the rail's (a folded rail shows one group)", () => {
  const { intent, tick } = setup();
  intent.enter("people", "panel"); tick(120); intent.hold("people");
  intent.leave(); intent.enter("growth", "panel"); tick(120);
  assert.deepEqual(intent.open, ["people", "growth"], "a group opened below keeps the one focus is in");
  intent.leave(); intent.enter("work", "panel"); tick(120);
  assert.deepEqual(intent.open, ["work", "people"], "one opened above closes the rest, not the one focus is in");
  intent.leave(); intent.enter("sales", "rail"); tick(120);
  assert.deepEqual(intent.open, ["sales"], "the rail's opening is the only one");
  intent.leave(); tick(250);
  assert.deepEqual(intent.open, [], "and the old hold does not bring People back");
  intent.show("money"); intent.hold("money"); intent.enter("ai", "rail"); tick(120);
  assert.deepEqual(intent.open, ["ai"], "a flyout the keyboard opened gives way to the pointer resting on another icon");
});

test("keyboard: Enter and Space are the head's own click; → and ↓ open a folded group and step into an open one; ← folds it", () => {
  assert.equal(headKey("Enter", false), null, "Enter: the button's click");
  assert.equal(headKey(" ", false), null, "Space: the button's click");
  assert.equal(headKey("ArrowRight", false), "open");
  assert.equal(headKey("ArrowDown", false), "open");
  assert.equal(headKey("ArrowRight", true), "first");
  assert.equal(headKey("ArrowDown", true), "first");
  assert.equal(headKey("ArrowLeft", true), "close");
  assert.equal(headKey("ArrowLeft", false), null);
  // Enter or Space is a click without a pointer (detail 0): it turns the group over, even one the pointer opened.
  assert.equal(clickOpens(false, false, false), true);
  assert.equal(clickOpens(true, true, false), false);
  // Inside a group or a flyout.
  assert.equal(itemKey("ArrowDown", false), "next");
  assert.equal(itemKey("ArrowUp", false), "prev");
  assert.equal(itemKey("ArrowLeft", false), "head");
  assert.equal(itemKey("Escape", false), null, "Escape in the sidebar is the shell's own");
  assert.equal(itemKey("Escape", true), "head", "Escape in a flyout goes back to its icon");
  // A folded rail's icon: Enter still opens its page; →, ↓ and Space show its group beside it.
  assert.equal(railKey("Enter"), null);
  for (const key of ["ArrowRight", "ArrowDown", " "]) assert.equal(railKey(key), "open", key);
  const { intent } = setup();
  intent.show("people");
  assert.deepEqual(intent.open, ["people"], "the keyboard opens a flyout at once");
});

test("keyboard: the shell wires the head's arrows, the pages' arrows and the rail's flyout; aria-expanded follows what shows", () => {
  assert.match(shell, /aria-expanded=\{isOpen\}/);
  assert.match(shell, /const isOpen = editing \|\| pinned \|\| peeked;/);
  assert.match(shell, /const act = headKey\(event\.key, isOpen\)/);
  assert.match(shell, /onKeyDown=\{\(event\) => itemKeys\(event, false,/);
  assert.match(shell, /onKeyDown=\{railKeys\(g\.key\)\}/);
  assert.match(shell, /aria-expanded=\{flies \? flyoutKey === g\.key : undefined\}/, "a folded rail's icon says whether its flyout shows");
  assert.match(shell, /onFocusIn=\{\(\) => railIntent\.hold\(flyoutGroup\.key\)\}/, "focus inside the flyout keeps it");
  assert.match(shell, /onFocus=\{\(\) => \{ if \(peeked\) intent\.hold\(g\.key\); \}\}/, "focus inside a hover-opened group keeps it");
  assert.match(fold, /if \(event\.shiftKey && i === 0\) \{ event\.preventDefault\(\); onLeave\("back"\); \}/, "Shift+Tab from the first page goes back to the icon");
});

test("less motion: no animation, the group opens and shuts at once", () => {
  assert.equal(REDUCED_MEDIA, "(prefers-reduced-motion: reduce)");
  assert.equal(foldMs(true), 0);
  assert.equal(foldMs(false), 200);
  assert.match(shell, /<Fold open=\{isOpen\} instant=\{lessMotion\}>/);
  assert.match(shell, /const lessMotion = useMatch\(REDUCED_MEDIA\);/);
  assert.match(fold, /if \(instant\) \{ setMounted\(false\); return; \}/, "an instant fold leaves at once");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.fold, \.group \{ transition: none; \} \.flyout \{ animation: none; \} \}/);
  assert.match(css, /\.fold \{ display: grid; grid-template-rows: 1fr; opacity: 1; transition: grid-template-rows 200ms ease-out, opacity 200ms ease-out; \}/, "200 ms, height and opacity, ease-out");
  assert.match(css, /\.fold\[data-state="closed"\] \{ grid-template-rows: 0fr; opacity: 0; \}/);
});

test("touch stays as it was: only a hover-capable fine pointer opens groups, and a tap still turns a group over", () => {
  assert.equal(HOVER_MEDIA, "(hover: hover) and (pointer: fine)");
  assert.equal(hoverCapable("mouse", true), true);
  assert.equal(hoverCapable("pen", true), true);
  assert.equal(hoverCapable("touch", true), false, "a finger never opens a group by hovering");
  assert.equal(hoverCapable("mouse", false), false, "a touch screen's emulated mouse neither");
  assert.equal(hoverCapable(undefined, true), false);
  // A tap is a click with a pointer on a group no hover opened: it opens a folded group and folds an open one.
  assert.equal(clickOpens(false, false, true), true);
  assert.equal(clickOpens(true, false, true), false);
  // Every pointer handler goes through hoverCapable, and the flyout needs a hover-capable pointer.
  const pointerCalls = [...shell.matchAll(/[^\n]*\b(?:intent|railIntent|which)\.(enter|leave|stay)\([^\n]*/g)].flatMap((m) => m[0].split(/(?=onPointer)/).filter((part) => /\b(?:intent|railIntent|which)\.(enter|leave|stay)\(/.test(part)));
  assert.ok(pointerCalls.length >= 4, `found the pointer handlers (${pointerCalls.length})`);
  for (const call of pointerCalls) assert.match(call, /hoverCapable\(event\.pointerType, canHover\)\) (?:intent|railIntent|which)\./, call.trim());
  assert.match(shell, /const flyoutKey = canHover && !editing \? railPeeks\[0\] \?\? null : null;/);
  assert.match(shell, /bare=\{pagesIn\(flyoutGroup\.key\) === 1\}/, "a one-page group: a compact card that is the link");
  assert.match(shell, /const canHover = useMatch\(HOVER_MEDIA\);/);
});

test("Messages and Chats each have their own icon; Chats is Messages' first page, then Calls", () => {
  const icon = (re) => shell.match(re)?.[1];
  const group = icon(/const GROUP_ICON[^=]*= \{[^}]*chat: (\w+)/);
  const chats = icon(/\{ label: "Chats", href: "\/chats", Icon: (\w+), group: "chat"/);
  const calls = icon(/\{ label: "Calls", href: "\/calls", Icon: (\w+), group: "chat"/);
  assert.equal(group, "Inbox", "Messages is the inbox tray");
  assert.equal(chats, "MessageCircle", "Chats keeps its speech bubble (the phone's bar and Ctrl+K use it too)");
  assert.equal(calls, "PhoneCall");
  assert.equal(new Set([group, chats, calls]).size, 3, "three different icons");
  const inChat = [...shell.slice(shell.indexOf("const allPages"), shell.indexOf("\n];", shell.indexOf("const allPages"))).matchAll(/label: "([^"]+)",(?: short: "[^"]*",)? href: "[^"]+", Icon: \w+, group: "chat"/g)].map((m) => m[1]);
  assert.deepEqual(inChat, ["Chats", "Calls"], "Chats first, then Calls");
  assert.match(read("../../../../packages/ui-shell/src/nav-catalog.ts"), /\{ key: "chat", label: "Messages",/);
  // No other icon library: the shell's icons all come from lucide-react.
  assert.doesNotMatch(shell + fold, /from "(react-icons|@heroicons|@tabler|@phosphor)/);
});

// NAV-CONNECT (owner, 17 Nov 2026: "Near the top of Home, hovering on Money opens its menu about halfway down the screen.
// It should open at the top, aligned to the item, be highlighted beautifully, and actually show what it needs to show").
const RAIL_RIGHT = 76; // the rail's right edge at 1440 (12 px gutter + 64 px rail)
test("the rail's flyout sits level with its icon, just right of the rail, its pointer at the icon's middle", () => {
  // Money's icon, near the top of a 900 px window: the flyout's head is level with it, never halfway down.
  const money = flyoutPlace({ top: 270, height: 40 }, RAIL_RIGHT, 900, 220);
  assert.deepEqual(money, { left: 86, top: 264, arrow: 26 });
  // The same at 1280 and 1024 (the rail does not move; the window's width plays no part).
  for (const h of [800, 720, 674]) assert.equal(flyoutPlace({ top: 270, height: 40 }, RAIL_RIGHT, h, 220).top, 264, `window ${h} px tall`);
});
test("near the window's foot the flyout moves up only as far as it must, and its pointer still finds the icon", () => {
  // Settings at the rail's foot of a 674 px window (the owner's laptop): a 300 px list ends level with the icon's foot.
  const s = flyoutPlace({ top: 610, height: 40 }, RAIL_RIGHT, 674, 300);
  assert.equal(s.top + 300, Math.min(610 + 40 + 6, 674 - FLYOUT_FOOT), "its foot is level with the icon, with room under it");
  assert.equal(s.top + s.arrow, 630, "the pointer is at the icon's middle");
  // An icon right at the window's foot: the list never runs past the window (12 px).
  assert.equal(flyoutPlace({ top: 640, height: 40 }, RAIL_RIGHT, 674, 300).top, 674 - FLYOUT_FOOT - 300);
  // A list taller than the window starts 12 px from the top (it scrolls inside), its pointer kept inside its corners.
  const tall = flyoutPlace({ top: 610, height: 40 }, RAIL_RIGHT, 674, 900);
  assert.equal(tall.top, FLYOUT_EDGE);
  assert.ok(tall.arrow >= 18 && tall.arrow <= 900 - 12);
  // The top icon: never above the window's edge.
  assert.equal(flyoutPlace({ top: 4, height: 40 }, RAIL_RIGHT, 900, 200).top, FLYOUT_EDGE);
});
test("the rail never unfolds a group inside the sidebar's list; it shows the flyout with the sidebar open or folded", () => {
  assert.match(shell, /const \[railIntent\] = useState\(\(\) => hoverIntent<NavGroupKey>\(\{ onChange: setRailPeeks/);
  assert.match(shell, /const which = from === "rail" \? railIntent : intent;/, "a rail icon's hover goes to its own intent");
  assert.doesNotMatch(shell, /scrollIntoView\(\{ block: "nearest", behavior: lessMotion/, "no more scrolling the sidebar to a group halfway down");
  assert.match(shell, /const flies = canHover;/, "every rail icon has its flyout, folded or not");
  assert.match(shell, /data-flyout-open=\{flyoutKey === g\.key \? "" : undefined\}/, "the icon whose group shows is lit");
  assert.match(css, /:global\(#pulse-rail\) \[data-flyout-open\]/);
  assert.match(css, /\.flyoutScrim \{ position: fixed;[^}]*pointer-events: none;/, "a light scrim right of the rail, never taking the pointer");
  assert.match(fold, /<i className=\{navCss\.flyoutScrim\} style=\{\{ left: at\.left - 10 \}\}/, "the scrim starts at the rail's edge");
  // It shows what it needs to: the group's icon and name, how many new things wait, and each page with its one line.
  assert.match(shell, /<span className=\{navCss\.flyoutText\}><b>\{p\.label\}<\/b>\{p\.blurb && shown\.every\(\(x\) => x\.blurb\) \? <small aria-hidden="true">\{p\.blurb\}<\/small> : null\}<\/span>/);
  assert.match(fold, /const rail = \(anchor\.closest\("#pulse-rail"\) \?\? anchor\.closest\("aside"\)\)/, "measured from the rail, not the open sidebar");
  assert.match(fold, /new ResizeObserver\(place\)/, "it follows its own height");
});
