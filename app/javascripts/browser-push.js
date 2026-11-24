function bufferToBase64Url(buffer) { // Like it says.
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// These are the keys used by sender to authenticate itself to the push service.
// The pubkey is given by the application to the browser pushManager.subscribe() so that the push-service knows.
// Then the entity sending the push signs the request that it makes to the push-service.
//
// The browser only allows ONE current subscribe in the page, with one such pubkey.
// I.e., a page cannot have multiple subscriptions to different services simultaneously.
//
// In server-sovereign applications, the server makes the key pair only once (for at least the lifetime of an app version),
// and passes the pubkey to the app.
//
// In our client-sovereign applications, each Axon root is essentially its own appserver in that it makes the requests
// to the push-service. In order to have just one subscription per client, we have the client generate the keypair,
// use the pubkey in the normal way when makeing the pushManger.subscribe() call, and pass the keys to Axon node for
// use when pushing to this particular client. It will use other keys when pushing to other clients.
// (The client still authenticates the pushed envelope in the normal way, just as if it had been delivered directly
// through the connected Axona network.)

export async function generateVapidKeys() {
  // 1. Generate an ECDSA key pair on the P-256 curve
  const keyPair = await window.crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true, // extractable
    ['sign', 'verify']
  );

  // 2. Export public key in 'raw' format (65 bytes: 0x04 + 32-byte X + 32-byte Y)
  const rawPublicKey = await window.crypto.subtle.exportKey('raw', keyPair.publicKey);
  const publicKeyBase64Url = bufferToBase64Url(rawPublicKey);

  // 3. Export private key in 'jwk' format to extract the 32-byte 'd' parameter
  const jwkPrivateKey = await window.crypto.subtle.exportKey('jwk', keyPair.privateKey);
  
  // The 'd' field in JWK is base64url encoded already; decode it to bytes then re-encode safely
  const privateKeyBytes = Uint8Array.from(atob(jwkPrivateKey.d.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const privateKeyBase64Url = bufferToBase64Url(privateKeyBytes);

  return {
    publicKey: publicKeyBase64Url,   // 65 bytes decoded
    privateKey: privateKeyBase64Url  // 32 bytes decoded
  };
}
