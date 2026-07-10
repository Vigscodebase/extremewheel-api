import crypto from "crypto"
import fs from "fs"

function generateRSAKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048, // Standard secure length
        publicKeyEncoding: {
            type: 'spki', // Recommended for public keys
            format: 'pem'
        },
        privateKeyEncoding: {
            type: 'pkcs8', // Recommended for private keys
            format: 'pem'
        }
    });

    fs.writeFileSync('private.pem', privateKey);
    fs.writeFileSync('public.pem', publicKey);

    console.log('Success: RSA Key Pair generated and saved as .pem files.');
}

generateRSAKeyPair();