// 把 index.html、vendor 函式庫與範例檔打包成單一可離線使用的 HTML
const fs = require('fs'), path = require('path');
const here = __dirname;
let html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
const inline = (file) => {
  const js = fs.readFileSync(path.join(here, 'vendor', file), 'utf8');
  if (js.includes('</script')) throw new Error(file + ' contains </script');
  return `<script>/* ${file} (inlined) */\n${js}\n</script>`;
};
html = html.replace('<script src="vendor/xlsx.full.min.js"></script>', () => inline('xlsx.full.min.js'));
html = html.replace('<script src="vendor/exceljs.min.js"></script>', () => inline('exceljs.min.js'));
const sampleB64 = fs.readFileSync(path.join(here, 'sample', 'momo訂單匯出範例.xlsx')).toString('base64');
html = html.replace('<a class="btn sm" href="sample/momo訂單匯出範例.xlsx" download>下載範例檔</a>', '<button class="btn sm" id="btnDownloadSample" type="button">下載範例檔</button>');
const oldLoader = html.slice(html.indexOf("$('#btnLoadSample').addEventListener"), html.indexOf("$('#headerRow').addEventListener"));
const newLoader = `const SAMPLE_B64 = '${sampleB64}';
function sampleBytes(){ const bin = atob(SAMPLE_B64); const u8 = new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i); return u8; }
$('#btnLoadSample').addEventListener('click', ()=> loadWorkbook(sampleBytes(), 'array', 'momo訂單匯出範例.xlsx'));
$('#btnDownloadSample').addEventListener('click', ()=> downloadBlob(new Blob([sampleBytes()],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}), 'momo訂單匯出範例.xlsx'));
`;
html = html.replace(oldLoader, () => newLoader);
const out = path.join(here, 'MOMO出貨單產生器.html');
fs.writeFileSync(out, html);
console.log('written', out, (fs.statSync(out).size/1024/1024).toFixed(2) + ' MB');
