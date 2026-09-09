// 把 index.html、vendor 函式庫與範例檔打包成單一可離線使用的 HTML
const fs = require('fs'), path = require('path');
const here = __dirname;
let html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
const inline = (file) => {
  const js = fs.readFileSync(path.join(here, 'vendor', file), 'utf8');
  if (js.includes('</script')) throw new Error(file + ' contains </script');
  return `<script>/* ${file} (inlined) */\n${js}\n</script>`;
};
html = html.replace(/<script src="vendor\/([^"]+)"><\/script>/g, (m, file) => inline(file));
// 範例檔內嵌
const samples = {};
for (const f of fs.readdirSync(path.join(here, 'sample'))) samples[f] = fs.readFileSync(path.join(here, 'sample', f)).toString('base64');
html = html.replace('<script>\n/* ==================== 欄位定義', () => `<script>window.SAMPLE_B64 = ${JSON.stringify(samples)};</script>\n<script>\n/* ==================== 欄位定義`);
if (!html.includes('window.SAMPLE_B64 =')) throw new Error('sample injection failed');
if (/vendor\//.test(html)) throw new Error('vendor reference left');
const out = path.join(here, 'MOMO出貨單產生器.html');
fs.writeFileSync(out, html);
console.log('written', out, (fs.statSync(out).size/1024/1024).toFixed(2) + ' MB');
