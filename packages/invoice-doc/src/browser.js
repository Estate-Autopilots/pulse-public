// @pulse/invoice-doc for the browser's live preview: the GST arithmetic, the model and the PDF writer, without the DOCX
// writer (the API makes DOCX files), so pages do not carry the docx library.
export * from './gst.js';
export * from './model.js';
export * from './sample.js';
export { renderPdf } from './pdf.js';
export * from './letter.js';

/** The two font files every rendering uses; in a browser bundle these become asset URLs. */
export const FONT_URLS = Object.freeze({
  regular: new URL('../fonts/Inter-Regular.ttf', import.meta.url),
  semibold: new URL('../fonts/Inter-SemiBold.ttf', import.meta.url),
});
