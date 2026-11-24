/**
 * render-pdf.js — HTML → A4 PDF（Playwright）。
 * 頁首：無文字、無線。頁尾：只有置中頁碼、無文字、無線。（財務報告極簡慣例）
 * 用法：node render-pdf.js input.html [output.pdf]
 */
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const inp = process.argv[2];
  const out = process.argv[3] || inp.replace(/\.html?$/i, '.pdf');
  if (!inp) { console.error('用法: node render-pdf.js input.html [output.pdf]'); process.exit(1); }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(inp), { waitUntil: 'networkidle', timeout: 60000 });
  await page.emulateMedia({ media: 'print' });

  await page.pdf({
    path: out, format: 'A4', printBackground: true,
    margin: { top: '16mm', bottom: '15mm', left: '18mm', right: '18mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: '<div style="width:100%;text-align:center;font-size:8px;color:#000;font-family:Arial,sans-serif;"><span class="pageNumber"></span></div>',
  });
  await browser.close();
  console.log('PDF:', out);
})();
