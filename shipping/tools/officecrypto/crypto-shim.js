// 以 crypto-js 模擬 officecrypto-tool 用到的 node:crypto API（瀏覽器用）
const CryptoJS = require('crypto-js');
const { Buffer } = require('buffer');
const toWA = (buf) => { buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf); return CryptoJS.lib.WordArray.create(new Uint8Array(buf.buffer, buf.byteOffset, buf.length)); };
const fromWA = (wa) => { const out = Buffer.alloc(wa.sigBytes); for (let i = 0; i < wa.sigBytes; i++) out[i] = (wa.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff; return out; };
const HASHES = { md5: CryptoJS.algo.MD5, sha1: CryptoJS.algo.SHA1, sha256: CryptoJS.algo.SHA256, sha384: CryptoJS.algo.SHA384, sha512: CryptoJS.algo.SHA512 };
const norm = (a) => String(a).toLowerCase().replace(/[-_]/g, '');
function createHash(alg) { const H = HASHES[norm(alg)]; if (!H) throw new Error('Unsupported hash ' + alg); const h = H.create(); return { update(d) { h.update(toWA(d)); return this; }, digest() { return fromWA(h.finalize()); } }; }
function createHmac(alg, key) { const H = HASHES[norm(alg)]; if (!H) throw new Error('Unsupported hash ' + alg); const h = CryptoJS.algo.HMAC.create(H, toWA(key)); return { update(d) { h.update(toWA(d)); return this; }, digest() { return fromWA(h.finalize()); } }; }
function cipher(encrypt, algorithm, key, iv) {
  const m = /^aes-(128|192|256)-(cbc|ecb)$/i.exec(String(algorithm)); if (!m) throw new Error('Unsupported cipher ' + algorithm);
  const mode = m[2].toLowerCase() === 'cbc' ? CryptoJS.mode.CBC : CryptoJS.mode.ECB;
  let padding = CryptoJS.pad.Pkcs7; const chunks = [];
  return {
    setAutoPadding(v) { padding = v === false ? CryptoJS.pad.NoPadding : CryptoJS.pad.Pkcs7; return this; },
    update(d) { chunks.push(Buffer.from(d)); return Buffer.alloc(0); },
    final() {
      const input = Buffer.concat(chunks); const k = toWA(key);
      const cfg = { mode, padding }; if (iv && iv.length) cfg.iv = toWA(iv);
      if (encrypt) return fromWA(CryptoJS.AES.encrypt(toWA(input), k, cfg).ciphertext);
      return fromWA(CryptoJS.AES.decrypt({ ciphertext: toWA(input) }, k, cfg));
    },
  };
}
function randomBytes(n) { const b = Buffer.alloc(n); (globalThis.crypto || {}).getRandomValues ? globalThis.crypto.getRandomValues(b) : b.fill(0); return b; }
module.exports = { createHash, createHmac, createCipheriv: (a, k, iv) => cipher(true, a, k, iv), createDecipheriv: (a, k, iv) => cipher(false, a, k, iv), randomBytes };
