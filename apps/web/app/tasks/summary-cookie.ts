// CI-GREEN-3 (layout-shift.spec /tasks: CLS 0.11 on a first visit): what Work's summary fold shows on the person's next page
// load, kept in a cookie so the server renders the same state the browser will choose (the fold's choice lives in
// localStorage, which the server cannot read). Plain module: the server page and the client fold both import it.
export const summaryCookie = (person: string) => `vitals_work_summary_${person.replace(/[^A-Za-z0-9-]/g, "")}`;
/** The server's guess: the cookie's state, or open on a device that has never shown the summary (its first sight). */
export const summaryOpenFromCookie = (value: string | undefined) => value === "closed" ? false : true;
