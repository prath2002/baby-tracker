// Generates Web Push VAPID keys: node scripts/generate-vapid.mjs
import webpush from "web-push";
const k = webpush.generateVAPIDKeys();
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}`);
