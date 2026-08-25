/*
  Renders the same generic report shape used by the WhatsApp report handlers
  into a PDF or Excel file, so "report stock as pdf" / "... as excel" can
  produce an actual attachment instead of a chat message.

  A report spec looks like:
    {
      title: 'Profit & Loss',
      subtitle: 'This month (01 Aug 2026 - 25 Aug 2026)',
      sections: [
        {
          heading: 'Ali Traders (CUST-0001)',   // optional
          lines: ['Opening balance: 0.00'],       // optional, plain label/value lines
          columns: ['Date', 'Type', 'Ref', 'Debit', 'Credit', 'Balance'], // optional table
          rows: [['22 Aug 2026', 'Invoice', 'INV-000002', '290,000.00', '', '290,000.00']],
          footerLines: ['Closing balance: 260,000.00'] // optional, shown after the table
        }
      ]
    }
  Every field besides title/sections is optional, and a section can mix a
  few summary lines with a table (the ledger report does exactly that).
*/

const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

function drawTable(doc, columns, rows) {
  const startX = doc.page.margins.left;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = pageWidth / columns.length;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  const drawHeader = () => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
    columns.forEach((col, i) => {
      doc.text(String(col), startX + i * colWidth, doc.y, { width: colWidth - 6 });
    });
    doc.moveDown(0.3);
    doc.moveTo(startX, doc.y).lineTo(startX + pageWidth, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9);
  };

  drawHeader();

  for (const row of rows) {
    const rowStartY = doc.y;
    let maxHeight = 0;
    row.forEach((cell, i) => {
      const height = doc.heightOfString(String(cell ?? ''), { width: colWidth - 6 });
      if (height > maxHeight) maxHeight = height;
    });

    if (rowStartY + maxHeight > bottomLimit) {
      doc.addPage();
      drawHeader();
    }

    const y = doc.y;
    row.forEach((cell, i) => {
      doc.text(String(cell ?? ''), startX + i * colWidth, y, { width: colWidth - 6 });
    });
    doc.y = y + Math.max(maxHeight, 12) + 4;
  }
}

function renderReportPdf(spec) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(18).fillColor('#000').text(spec.title);
    if (spec.subtitle) {
      doc.font('Helvetica').fontSize(10).fillColor('#555555').text(spec.subtitle);
    }
    doc.fillColor('#000');
    doc.moveDown(0.8);

    for (const section of spec.sections) {
      if (section.heading) {
        doc.font('Helvetica-Bold').fontSize(12).text(section.heading);
        doc.moveDown(0.2);
      }
      if (section.lines && section.lines.length) {
        doc.font('Helvetica').fontSize(10);
        for (const line of section.lines) doc.text(line);
        doc.moveDown(0.4);
      }
      if (section.columns && section.columns.length) {
        drawTable(doc, section.columns, section.rows || []);
        doc.moveDown(0.4);
      }
      if (section.footerLines && section.footerLines.length) {
        doc.font('Helvetica-Bold').fontSize(10);
        for (const line of section.footerLines) doc.text(line);
        doc.font('Helvetica');
      }
      doc.moveDown(0.8);
    }

    doc.end();
  });
}

async function renderReportExcel(spec) {
  const workbook = new ExcelJS.Workbook();
  const sheetName = (spec.title || 'Report').replace(/[[\]*?/\\:]/g, ' ').slice(0, 31) || 'Report';
  const sheet = workbook.addWorksheet(sheetName);

  sheet.addRow([spec.title]).font = { bold: true, size: 14 };
  if (spec.subtitle) {
    sheet.addRow([spec.subtitle]).font = { italic: true, color: { argb: 'FF666666' } };
  }
  sheet.addRow([]);

  for (const section of spec.sections) {
    if (section.heading) {
      const row = sheet.addRow([section.heading]);
      row.font = { bold: true, size: 12 };
    }
    if (section.lines && section.lines.length) {
      for (const line of section.lines) sheet.addRow([line]);
      sheet.addRow([]);
    }
    if (section.columns && section.columns.length) {
      const headerRow = sheet.addRow(section.columns);
      headerRow.font = { bold: true };
      headerRow.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
      });
      for (const row of section.rows || []) sheet.addRow(row);
      sheet.addRow([]);
    }
    if (section.footerLines && section.footerLines.length) {
      for (const line of section.footerLines) {
        sheet.addRow([line]).font = { bold: true };
      }
    }
    sheet.addRow([]);
  }

  sheet.columns.forEach((col) => {
    let maxLen = 10;
    col.eachCell({ includeEmpty: true }, (cell) => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(maxLen + 2, 45);
  });

  return workbook.xlsx.writeBuffer();
}

/* "YYYY-MM-DD" strings are parsed in local time (like the rest of the report
   code) rather than left to Date's UTC-midnight parsing of bare ISO dates,
   which would otherwise shift the displayed day depending on timezone. */
function humanDate(value) {
  if (!value) return '';
  let date;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    date = new Date(y, m - 1, d);
  } else {
    date = new Date(value);
  }
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

module.exports = { renderReportPdf, renderReportExcel, humanDate };
