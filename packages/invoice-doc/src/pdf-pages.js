// OFFICE-PRINT (2503): how many pages a PDF has (the print limits count pages), read with pdf-lib (MIT).
import { PDFDocument } from 'pdf-lib';

/** @param {Uint8Array} bytes @returns {Promise<number>} */
export async function pdfPageCount(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPageCount();
}
