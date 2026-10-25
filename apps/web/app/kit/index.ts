// TASKS-4A: Pulse's shared controls (the "kit"). Import from "app/kit" (e.g. `import { Combobox, Tooltip } from "../kit"`).
// See /kit for every component in light and dark, and docs/ops/KIT.md for how to use them.
export { Layer, usePresence, useFloating, useOutside, placeFloating, type Placement } from "./layer";
export { Popover, usePopoverState, Tooltip, HelpHint, Keycap, KeyHint, ByDevice, useIsMac, type PopoverProps } from "./popover";
export { Segmented, SegmentedNav, type SegmentOption, type SegmentLink } from "./segmented";
export { AiBadge } from "./ai-badge";
export { Avatar, PersonChip, AvatarStack, type PersonLike } from "./person";
export { Combobox, Select, OptionList, PersonSelect, PeopleInput, personOptions, listKeys, type Option, type PickPerson } from "./combobox";
export { SelectField } from "./select-field";
export { Menu, type MenuItem } from "./menu";
export { DatePicker, Calendar, QUICK_DATES, dayLabel, timeLabel, addDays, weekday, nextWeekday, type DateTime, type QuickDate } from "./date-picker";
export { DateField, type DateFieldChange } from "./date-field";
export { MentionInput, type MentionHandle, type Segment } from "./mention-input";
export { Rating, type Level } from "./rating";
export { Drawer, DrawerSection, DrawerFooter, ContextChip, type DrawerProps, type DrawerSize } from "./drawer";
export { SaveBar } from "./save-bar";
