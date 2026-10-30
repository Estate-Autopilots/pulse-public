// R41: a synthetic, nonpersonal policy as a Word (.docx) file, with everything the round-trip check looks at: a title
// and headings, bold text, a nested bulleted list and a numbered list, a page break, a table with a merged cell, a
// header, a footer with a page-number field, theme fonts (body and headings) and one explicitly chosen font. Options
// make the changes an editor could make by mistake, and `application` says which program "saved" it. It is generated:
// whatever it says, it is never evidence of Word or editor fidelity.
import { writeZip } from '../dist/policy-docx.js';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const run = (text, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (style, ...runs) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs.join('')}</w:p>`;
const item = (num, level, text) => `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${num}"/></w:numPr></w:pPr>${run(text)}</w:p>`;
const cell = (text, span = 1) => `<w:tc><w:tcPr><w:tcW w:w="${2400 * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}</w:tcPr>${para('', run(text))}</w:tc>`;

export function policyDocx({ application = 'Pulse fixture generator', text = 'how leave works', header = true, merged = true, font = 'Georgia', numbered = 'decimal', pageBreak = true, extra = {} } = {}) {
  const body = [
    para('Title', run('Synthetic leave policy')),
    para('Heading1', run('1. Purpose')),
    para('', run('This synthetic policy explains '), run(text, '<w:b/>'), run('.')),
    para('Heading1', run('2. Rules')),
    item(1, 0, 'Plan leave a week ahead'),
    item(1, 1, 'Two days for short leave'),
    `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run('Tell your pod head ')}${run('(confirm)', '<w:b/>')}</w:p>`,
    item(2, 0, 'Ask in Pulse'),
    item(2, 0, 'Wait for approval'),
    pageBreak ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : '',
    para('Heading1', run('3. Leave types')),
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="4800" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>`
      + `<w:tr>${cell('Type')}${cell('Days')}</w:tr><w:tr>${cell('Casual')}${cell('8')}</w:tr>`
      + `<w:tr>${merged ? cell('Ask HR for anything else', 2) : cell('Ask HR for anything else') + cell('')}</w:tr></w:tbl>`,
    para('', run('Signed copies are kept by HR in ', ''), run('Pulse', `<w:rFonts w:ascii="${font}" w:hAnsi="${font}"/>`), run('.')),
    `<w:sectPr>${header ? '<w:headerReference w:type="default" r:id="rId10"/>' : ''}<w:footerReference w:type="default" r:id="rId11"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`,
  ].join('');
  const lvl = (i, fmt, textFmt) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${textFmt}"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  return writeZip({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${application}</Application></Properties>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/><Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}</w:body></w:document>`,
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:sz w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>`,
    'word/numbering.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}><w:abstractNum w:abstractNumId="0">${lvl(0, 'bullet', '•')}${lvl(1, 'bullet', 'o')}</w:abstractNum><w:abstractNum w:abstractNumId="1">${lvl(0, numbered, '%1.')}${lvl(1, 'lowerLetter', '%2)')}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
    'word/header1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ${W}>${para('', run('Synthetic Company · Leave policy'))}</w:hdr>`,
    'word/footer1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${W}><w:p>${run('Page ')}<w:fldSimple w:instr=" PAGE ">${run('1')}</w:fldSimple></w:p></w:ftr>`,
    'word/theme/theme1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Synthetic"><a:themeElements><a:fontScheme name="Synthetic"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
    ...extra,
  });
}

/** The reader text the fixture must become (docxMarkdown). */
export const FIXTURE_MARKDOWN = `# Synthetic leave policy

## 1. Purpose

This synthetic policy explains **how leave works**.

## 2. Rules

- Plan leave a week ahead
  - Two days for short leave
- Tell your pod head **(confirm)**

1. Ask in Pulse
1. Wait for approval

## 3. Leave types

| Type | Days |
| --- | --- |
| Casual | 8 |
| Ask HR for anything else |   |

Signed copies are kept by HR in Pulse.`;
