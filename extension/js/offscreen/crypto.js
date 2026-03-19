/**
 * Sovereign HLS & Crypto Utilities
 */
export async function decryptBuffer(data, key, ivStr, seq) {
    let iv;
    if (ivStr) {
        const hex = ivStr.startsWith('0x') ? ivStr.substring(2) : ivStr;
        iv = new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    } else {
        iv = new Uint8Array(16);
        const view = new DataView(iv.buffer);
        view.setUint32(12, seq, false);
    }
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
    try {
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, cryptoKey, data);
        return new Uint8Array(decrypted);
    } catch (e) {
        throw new Error('DECRYPT_FAILED: ' + e.message);
    }
}
