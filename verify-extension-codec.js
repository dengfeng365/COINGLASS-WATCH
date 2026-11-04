// Run with Node.js 22+: node verify-codec.js
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const zlib = require('node:zlib');
require('./extension/lib/coinglass.js');

function ecbEncrypt(bytes, key) {
  const cipher = nodeCrypto.createCipheriv(`aes-${key.length * 8}-ecb`, Buffer.from(key), null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

function encryptGzip(text, key) {
  return ecbEncrypt(zlib.gzipSync(Buffer.from(text)), key).toString('base64');
}

async function main() {
  const key128 = Buffer.from('1234567890abcdef');
  const key256 = Buffer.from('1f68efd73f8d4921acc0dead41dd39bc');
  const plaintext = Buffer.from('CoinGlass crypto round trip ' + 'x'.repeat(3000));
  for (const key of [key128, key256]) {
    const encrypted = await CoinGlassCodec.encryptEcb(plaintext, key);
    assert.deepEqual(Buffer.from(encrypted), ecbEncrypt(plaintext, key));
    assert.deepEqual(Buffer.from(await CoinGlassCodec.decryptEcb(encrypted, key)), plaintext);
  }

  const fixedSeconds = 1793080223;
  const realDateNow = Date.now;
  Date.now = () => fixedSeconds * 1000;
  let token;
  try { token = await CoinGlassCodec.createLiqToken(); }
  finally { Date.now = realDateNow; }
  const decipher = nodeCrypto.createDecipheriv('aes-256-ecb', key256, null);
  const tokenText = Buffer.concat([decipher.update(Buffer.from(token, 'base64')), decipher.final()]).toString();
  assert.equal(tokenText, '1793080223,950763');

  const timestamp = '1793080559433';
  const dataKey = '8b0ea6078af14e43';
  const data = { list: [{ symbol: 'DOGE', price: 0.07754 }], padding: 'x'.repeat(3000) };
  const url = CoinGlassCodec.marketUrl(['DOGE']);
  for (const version of ['0', '1']) {
    const seedSource = version === '0' ? timestamp : new URL(url).pathname;
    const seed = Buffer.from(seedSource).toString('base64').slice(0, 16);
    const raw = {
      status: 200,
      headers: { encryption: 'true', v: version, user: encryptGzip(dataKey, seed) },
      body: JSON.stringify({ code: '0', success: true, data: encryptGzip(JSON.stringify(data), dataKey) }),
    };
    assert.deepEqual(await CoinGlassCodec.decodeResponse(raw, url, timestamp), data);
  }
  console.log('Codec verified: AES-ECB, gzip, v0/v1 response, liquidation token.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
