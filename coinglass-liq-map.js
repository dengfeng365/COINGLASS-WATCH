#!/usr/bin/env node
// Usage: node coinglass-liq-map.js Binance_BTCUSDT
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const symbol = process.argv[2] || 'Binance_BTCUSDT';
if (!/^[A-Za-z0-9_]{1,60}$/.test(symbol)) {
  console.error('Invalid symbol. Example: Binance_BTCUSDT');
  process.exit(1);
}
const obe = process.env.COINGLASS_OBE || 's_208d101f4cae4b619a511cb802f962c6';

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of input.toUpperCase().replace(/=+$/, '')) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('Invalid base32 input');
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) bytes.push((value >>> (bits -= 8)) & 255);
  }
  return Buffer.from(bytes);
}

function createDataToken() {
  const seconds = Math.floor(Date.now() / 1000);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const digest = crypto.createHmac('sha1', base32Decode('I65VU7K5ZQL7WB4E'))
    .update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const otp = String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000)
    .padStart(6, '0');
  const cipher = crypto.createCipheriv(
    'aes-256-ecb', Buffer.from('1f68efd73f8d4921acc0dead41dd39bc'), null,
  );
  return Buffer.concat([cipher.update(`${seconds},${otp}`), cipher.final()])
    .toString('base64');
}

function decryptGzip(base64, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  const compressed = Buffer.concat([
    decipher.update(Buffer.from(base64, 'base64')),
    decipher.final(),
  ]);
  return zlib.gunzipSync(compressed).toString('utf8').replace(/^"|"$/g, '');
}

function header(headers, name) {
  return new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(headers)?.[1].trim();
}

function main() {
  const timestamp = String(Date.now());
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinglass-liq-'));
  const headerFile = path.join(temporaryDirectory, 'headers.txt');
  const bodyFile = path.join(temporaryDirectory, 'body.txt');
  const query = new URLSearchParams({
    merge: 'true', symbol, interval: '1', limit: '1500', data: createDataToken(),
  });
  const url = `https://capi.coinglass.com/api/index/5/liqMap?${query}`;
  try {
    const request = spawnSync('curl', [
      '--silent', '--show-error', '--location', '--max-time', '20',
      '--dump-header', headerFile,
      '--output', bodyFile,
      '--write-out', '%{http_code}',
      '--url', url,
      '--header', 'accept: application/json',
      '--header', 'accept-language: zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
      '--header', 'cache-control: no-cache',
      '--header', `cache-ts-v2: ${timestamp}`,
      '--header', 'encryption: true',
      '--header', 'language: zh',
      '--header', `obe: ${obe}`,
      '--header', 'origin: https://www.coinglass.com',
      '--header', 'pragma: no-cache',
      '--header', 'referer: https://www.coinglass.com/',
      '--header', 'sec-ch-ua: "Microsoft Edge";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
      '--header', 'sec-ch-ua-mobile: ?0',
      '--header', 'sec-ch-ua-platform: "Windows"',
      '--header', 'sec-fetch-dest: empty',
      '--header', 'sec-fetch-mode: cors',
      '--header', 'sec-fetch-site: same-site',
      '--header', 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (request.error) throw request.error;
    if (request.status !== 0) throw new Error(request.stderr.trim() || `curl exited ${request.status}`);

    const headers = fs.readFileSync(headerFile, 'utf8');
    const httpStatus = Number(request.stdout.trim());
    const body = fs.readFileSync(bodyFile, 'utf8');
    if (httpStatus !== 200) {
      throw new Error(`CoinGlass returned HTTP ${httpStatus} (${header(headers, 'Content-Type') || 'unknown content type'}). The request was rejected before decryption.`);
    }
    if (!/application\/json/i.test(header(headers, 'Content-Type') || '')) {
      throw new Error(`CoinGlass returned ${header(headers, 'Content-Type') || 'non-JSON content'} instead of JSON.`);
    }
    const response = JSON.parse(body);
    if (response.code !== '0' || !response.success) {
      throw new Error(`CoinGlass returned ${response.code}: ${response.msg}. Check COINGLASS_OBE.`);
    }
    const encryptionVersion = header(headers, 'v');
    if (header(headers, 'encryption') !== 'true' || !['0', '1', '2'].includes(encryptionVersion)) {
      throw new Error(`Unsupported CoinGlass encryption response (encryption=${header(headers, 'encryption') || 'absent'}, v=${encryptionVersion || 'absent'}).`);
    }
    const encryptedKey = header(headers, 'user');
    if (!encryptedKey || !response.data) throw new Error('Missing encrypted response data');

    const seedSource = encryptionVersion === '0' ? timestamp
      : encryptionVersion === '1' ? new URL(url).pathname
        : header(headers, 'time');
    if (!seedSource) throw new Error('Missing encryption seed source');
    const seed = Buffer.from(seedSource).toString('base64').slice(0, 16);
    const dataKey = decryptGzip(encryptedKey, seed);
    const data = JSON.parse(decryptGzip(response.data, dataKey));
    console.log(JSON.stringify({
      fetchedAt: new Date().toISOString(),
      symbol,
      ...data,
    }, null, 2));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
