// Reads AcroForm values of a PDF with pdf-lib (used to verify native form filling)
const fs = require('fs');
const PDFLib = require('pdf-lib');

async function readFields(file) {
  const doc = await PDFLib.PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true });
  const out = {};
  for (const f of doc.getForm().getFields()) {
    const n = f.getName();
    if (f instanceof PDFLib.PDFTextField) out[n] = f.getText();
    else if (f instanceof PDFLib.PDFCheckBox) out[n] = f.isChecked();
    else if (f instanceof PDFLib.PDFRadioGroup) out[n] = f.getSelected();
    else if (f instanceof PDFLib.PDFDropdown) out[n] = f.getSelected();
    else out[n] = '?';
  }
  return out;
}

module.exports = { readFields };
