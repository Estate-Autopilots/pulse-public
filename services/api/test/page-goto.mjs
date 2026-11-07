const crashed = error => /net::ERR_INSUFFICIENT_RESOURCES|Page crashed|Target crashed/i.test(String(error?.message ?? error));
const closeQuietly = async page => { try { await page.close(); } catch {} };

export async function openWithRetry(context, url, options, retries) {
  let page = await context.newPage();
  try {
    page.navigationResponse = await page.goto(url, options);
    return page;
  } catch (error) {
    if (!crashed(error)) { await closeQuietly(page); throw error; }
    retries.push(new URL(url).pathname);
    await closeQuietly(page);
    await new Promise(resolve => setTimeout(resolve, 2_000));
    page = await context.newPage();
    try {
      page.navigationResponse = await page.goto(url, options);
      return page;
    } catch (retryError) {
      await closeQuietly(page);
      throw retryError;
    }
  }
}
