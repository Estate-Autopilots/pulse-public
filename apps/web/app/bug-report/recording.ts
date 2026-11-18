// BUG-REPORT (owner, 27 Oct 2026): an optional short screen recording. The browser asks the person which screen, window
// or tab to share (nothing is recorded before they choose), records at most 30 seconds at a low frame rate while they
// show the problem, and the clip is attached for them to watch or remove before sending. Recording the seconds before
// the reporter opened would mean recording the screen all the time; Pulse does not do that. Not on phones (no screen
// sharing there); the screenshot and the app steps cover them.
export const MAX_SECONDS = 30;
export const MAX_BYTES = 6 * 1024 * 1024;

export function canRecord(): boolean {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return false;
  const md = navigator.mediaDevices as MediaDevices | undefined;
  return !!md?.getDisplayMedia && !window.matchMedia("(pointer: coarse)").matches;
}

export type Clip = { blob: Blob; seconds: number; url: string };
export type Recorder = { stop: () => void; done: Promise<Clip | null> };

/** Starts recording after the person picks what to share; `done` gives the clip (or null when nothing was recorded). */
export async function startRecording(onTick?: (seconds: number) => void): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 8 }, audio: false, preferCurrentTab: true } as DisplayMediaStreamOptions);
  const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 700_000 });
  const chunks: Blob[] = [];
  const start = Date.now();
  let timer = 0;
  const stop = () => { if (recorder.state !== "inactive") recorder.stop(); stream.getTracks().forEach((t) => t.stop()); window.clearInterval(timer); };
  const done = new Promise<Clip | null>((resolve) => {
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: (recorder.mimeType || type || "video/webm").split(";")[0] });
      const seconds = Math.max(1, Math.round((Date.now() - start) / 1000));
      resolve(blob.size && blob.size <= MAX_BYTES ? { blob, seconds, url: URL.createObjectURL(blob) } : null);
    };
  });
  stream.getVideoTracks()[0]?.addEventListener("ended", stop);
  recorder.start(1000);
  timer = window.setInterval(() => {
    const s = Math.round((Date.now() - start) / 1000);
    onTick?.(s);
    if (s >= MAX_SECONDS) stop();
  }, 500);
  return { stop, done };
}
