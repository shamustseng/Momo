// 以 DOMParser 模擬 xml2js Parser({explicitArray:false, mergeAttrs:true})
class Parser {
  async parseStringPromise(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const conv = (el) => { const o = {}; for (const a of el.attributes) o[a.name] = a.value; for (const c of el.children) { const v = conv(c); if (o[c.tagName] === undefined) o[c.tagName] = v; else if (Array.isArray(o[c.tagName])) o[c.tagName].push(v); else o[c.tagName] = [o[c.tagName], v]; } return o; };
    return { [doc.documentElement.tagName]: conv(doc.documentElement) };
  }
}
class Builder { buildObject() { throw new Error('encrypt not supported in browser build'); } }
module.exports = { Parser, Builder };
