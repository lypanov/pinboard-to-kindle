const crypto = require('crypto');
const baseX = require('base-x');
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const base62 = baseX(BASE62);

function base62encode(url) {
    const sha1 = crypto.createHash('sha1');
    sha1.update(url);
    const hash = sha1.digest();
    const base62Encoded = base62.encode(hash);
    return base62Encoded.slice(0, 3);
}

module.exports = {
    BASE62,
    base62encode
};
