// @pulse/invoice-doc: GST arithmetic, the document model and its PDF and DOCX writers (ERP-INVOICE).
export * from './gst.js';
export * from './model.js';
export * from './qty-dims.js';
export * from './sample.js';
export { isEstimate, priceComparison } from './quote-compare.js';
export { renderPdf } from './pdf.js';
export * from './letter.js';
export { renderLetterDocx } from './letter-docx.js';
export { renderDocx } from './docx.js';
export * from './agreement-text.js';
export { renderAgreementPdf } from './agreement.js';
export * from './contract-source.js';
export { scriptSignature, scriptSignatureSvg } from './signature-script.js';
export { pngWithVector, vectorOfPng, tidyVector, pngBytesOf, pngDataUrl } from './signature-vector.js';
export { buildContractModel, longDate, renderContractPdf } from './contract-pdf.js';
export { docBlocks, docRuns, renderDocDocx, renderDocPdf, safeFileName } from './doc-export.js';

/** The two font files every rendering uses (Inter, subset to Latin and ₹; SIL Open Font License, fonts/OFL.txt).
 *  In a browser bundle these become asset URLs; on a server they are file: URLs. */
export const FONT_URLS = Object.freeze({
  regular: new URL('../fonts/Inter-Regular.ttf', import.meta.url),
  semibold: new URL('../fonts/Inter-SemiBold.ttf', import.meta.url),
});
