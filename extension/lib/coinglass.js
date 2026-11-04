/* global crypto, DecompressionStream, Response, Blob, URL, URLSearchParams */
const CoinGlassCodec = (() => {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const zeroIv = new Uint8Array(16);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  function concat(chunks) {
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function base32ToBytes(value) {
    let bits = 0;
    let accumulator = 0;
    const result = [];
    for (const char of value.toUpperCase().replace(/=+$/, "")) {
      const digit = alphabet.indexOf(char);
      if (digit < 0) throw new Error("无效的动态口令密钥");
      accumulator = (accumulator << 5) | digit;
      bits += 5;
      if (bits >= 8) result.push((accumulator >>> (bits -= 8)) & 255);
    }
    return new Uint8Array(result);
  }

  async function importAes(keyBytes) {
    return crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt", "decrypt"]);
  }

  // WebCrypto has CBC but no ECB. Encrypting one block at a time with a zero IV
  // gives the same AES block operation used by ECB.
  async function encryptEcb(plainBytes, keyBytes) {
    const paddingLength = 16 - (plainBytes.length % 16);
    const padded = new Uint8Array(plainBytes.length + paddingLength);
    padded.set(plainBytes);
    padded.fill(paddingLength, plainBytes.length);
    const key = await importAes(keyBytes);
    const blocks = await Promise.all(Array.from(
      { length: padded.length / 16 },
      async (_, index) => {
        const block = padded.subarray(index * 16, index * 16 + 16);
        const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: zeroIv }, key, block));
        return encrypted.subarray(0, 16);
      },
    ));
    return concat(blocks);
  }

  async function decryptEcb(cipherBytes, keyBytes) {
    if (cipherBytes.length % 16) throw new Error("无效的加密数据长度");
    const key = await importAes(keyBytes);
    const blocks = await Promise.all(Array.from(
      { length: cipherBytes.length / 16 },
      async (_, index) => {
        const cipherBlock = cipherBytes.subarray(index * 16, index * 16 + 16);
        const paddingInput = cipherBlock.map(byte => byte ^ 16);
        const encryptedPadding = new Uint8Array(await crypto.subtle.encrypt(
          { name: "AES-CBC", iv: zeroIv }, key, paddingInput,
        ));
        const twoBlocks = concat([cipherBlock, encryptedPadding.subarray(0, 16)]);
        // The second block decrypts to valid PKCS#7 padding, so WebCrypto
        // returns the first block unchanged after removing that padding.
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: zeroIv }, key, twoBlocks));
      },
    ));
    const padded = concat(blocks);
    const paddingLength = padded[padded.length - 1];
    if (paddingLength < 1 || paddingLength > 16 ||
        !padded.subarray(-paddingLength).every(byte => byte === paddingLength)) {
      throw new Error("AES 解密后的填充无效");
    }
    return padded.subarray(0, -paddingLength);
  }

  async function unzipGzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return textDecoder.decode(await new Response(stream).arrayBuffer());
  }

  async function decryptGzip(base64, key) {
    const plaintext = await unzipGzip(await decryptEcb(base64ToBytes(base64), textEncoder.encode(key)));
    return plaintext.replace(/^"|"$/g, "");
  }

  function encryptionSeed(version, headers, requestUrl, timestamp) {
    let source;
    if (version === "0") source = timestamp;
    else if (version === "1") source = new URL(requestUrl).pathname;
    else if (version === "2") source = headers.time;
    else if (version === "55") source = "170b070da9654622";
    else if (version === "66") source = "d6537d845a964081";
    else if (version === "77") source = "863f08689c97435b";
    if (!source) throw new Error(`暂不支持 CoinGlass 加密版本 ${version || "未知"}`);
    return bytesToBase64(textEncoder.encode(source)).slice(0, 16);
  }

  async function decodeResponse(raw, requestUrl, timestamp) {
    if (raw.status !== 200) throw new Error(`CoinGlass 返回 HTTP ${raw.status}`);
    let outer;
    try { outer = JSON.parse(raw.body); }
    catch { throw new Error("CoinGlass 返回的不是 JSON"); }
    if (outer.code !== "0" || !outer.success) {
      throw new Error(`CoinGlass 返回 ${outer.code || "未知错误"}`);
    }
    const headers = raw.headers;
    if (headers.encryption !== "true" || !headers.user || !outer.data) {
      throw new Error("CoinGlass 响应缺少加密数据");
    }
    const seed = encryptionSeed(headers.v, headers, requestUrl, timestamp);
    const dataKey = await decryptGzip(headers.user, seed);
    return JSON.parse(await decryptGzip(outer.data, dataKey));
  }

  async function createLiqToken() {
    const seconds = Math.floor(Date.now() / 1000);
    const counter = new Uint8Array(8);
    new DataView(counter.buffer).setBigUint64(0, BigInt(Math.floor(seconds / 30)));
    const key = await crypto.subtle.importKey(
      "raw", base32ToBytes("I65VU7K5ZQL7WB4E"),
      { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
    );
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
    const offset = digest[digest.length - 1] & 15;
    const otp = ((digest[offset] & 127) * 0x1000000 +
      digest[offset + 1] * 0x10000 + digest[offset + 2] * 0x100 + digest[offset + 3]) % 1_000_000;
    const plain = textEncoder.encode(`${seconds},${String(otp).padStart(6, "0")}`);
    const cipher = await encryptEcb(plain, textEncoder.encode("1f68efd73f8d4921acc0dead41dd39bc"));
    return bytesToBase64(cipher);
  }

  function marketUrl(symbols) {
    const query = new URLSearchParams({
      sort: "", order: "", keyword: "", pageNum: "1", pageSize: String(symbols.length),
      symbols: symbols.join(","), ex: "all",
    });
    return `https://capi.coinglass.com/api/home/v2/coinMarkets?${query}`;
  }

  async function liqUrl(symbol) {
    const query = new URLSearchParams({
      merge: "true", symbol, interval: "1", limit: "1500", data: await createLiqToken(),
    });
    return `https://capi.coinglass.com/api/index/5/liqMap?${query}`;
  }

  return { createLiqToken, decodeResponse, marketUrl, liqUrl, encryptEcb, decryptEcb };
})();

globalThis.CoinGlassCodec = CoinGlassCodec;
