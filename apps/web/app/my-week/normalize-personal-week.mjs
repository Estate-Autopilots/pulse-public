export const creativeTypeLabels = Object.freeze({
  model_video: "Model video",
  vov: "VOV",
  founder_video: "Founder video",
  testimonial: "Testimonial",
  walkthrough: "Walkthrough",
  other: "Other",
});

const creativeTypes = Object.keys(creativeTypeLabels);

export function currentIsoWeek(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const localDate = new Date(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day)));
  localDate.setUTCDate(localDate.getUTCDate() + 4 - (localDate.getUTCDay() || 7));
  const weekYear = localDate.getUTCFullYear();
  const yearStart = Date.UTC(weekYear, 0, 1);
  const week = Math.ceil(((localDate.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

export function normalizePersonalWeek(response) {
  const rawTypes = response.types ?? {};
  const types = creativeTypes.map(type => {
    const progress = rawTypes[type];
    const drafts = progress?.delivered?.drafts ?? null;
    const finals = progress?.delivered?.finals ?? null;
    return {
      type,
      label: creativeTypeLabels[type],
      target: progress?.target ?? null,
      delivered: drafts === null || finals === null ? null : drafts + finals,
      drafts,
      finals,
      claimed: progress?.claimed ?? { drafts: 0, finals: 0 },
      gap: progress?.gap ?? null,
      placeholder: progress?.placeholder ?? false,
    };
  });
  const completeTypeSet = types.every(progress => progress.delivered !== null);
  const openTasks = response.openTasks?.map(task => ({
    id: task.id,
    title: task.title,
    status: task.status,
    dueAt: task.dueAt,
    assets: task.assets.map(asset => ({ id: asset.id, url: asset.url })),
  }));

  return {
    week: response.week,
    types,
    ...(completeTypeSet ? {
      totalDeliveries: types.reduce((sum, progress) => sum + progress.delivered, 0),
      drafts: types.reduce((sum, progress) => sum + progress.drafts, 0),
      finals: types.reduce((sum, progress) => sum + progress.finals, 0),
    } : {}),
    ...(openTasks === undefined ? {} : { openTasks }),
  };
}
