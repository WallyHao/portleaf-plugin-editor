export function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 10 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 9 0 R >> >> /Contents 4 0 R >>',
    '',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 500] /Resources << /Font << /F1 9 0 R >> >> /Contents 6 0 R >>',
    '',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 9 0 R >> >> /Contents 8 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Outlines /First 11 0 R /Last 12 0 R /Count 2 >>',
    '<< /Title (First chapter) /Parent 10 0 R /Next 12 0 R /Dest [3 0 R /Fit] >>',
    '<< /Title (Second chapter) /Parent 10 0 R /Prev 11 0 R /Dest [5 0 R /Fit] >>',
  ];
  const padding = 'x'.repeat(160000);
  objects.push('<< /Length ' + padding.length + ' >>\nstream\n' + padding + '\nendstream');
  for (const [index, text, y] of [
    [3, 'Portleaf PDF first page', 700],
    [5, 'Search second page target', 400],
    [7, 'Last page', 700],
  ] as const) {
    const stream = 'BT /F1 24 Tf 40 ' + y + ' Td (' + text + ') Tj ET\n';
    objects[index] =
      '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream';
  }
  let file = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(file));
    file += index + 1 + ' 0 obj\n' + object + '\nendobj\n';
  });
  const xref = Buffer.byteLength(file);
  file += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n';
  file += offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n')
    .join('');
  return Buffer.from(
    file +
      'trailer\n<< /Size ' +
      offsets.length +
      ' /Root 1 0 R >>\nstartxref\n' +
      xref +
      '\n%%EOF\n',
  );
}
