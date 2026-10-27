// @pulse/companion: the shared core of every Pulse Companion surface (web widget, desktop panel, Chrome popup, phone).
export * from './time.js';
export * from './view.js';
export * from './reminders.js';
export * from './presence.js';
export * from './queue.js';
export * from './client.js';
export * from './pip.js';
export * from './demo.js';
export { surfaceState } from './surfaces.js';
export { triangulate, dwellDecision, PRESENCE_THRESHOLD, SIGNAL_TTL } from './triangulation.js';
