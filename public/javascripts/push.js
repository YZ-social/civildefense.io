import webpush from 'web-push';
// const vapidKeys = generateVAPIDKeys?.() || {};
// console.log({vapidKeys});
// setVapidDetails?.(
//   'mailto:example@yourdomain.org',
//   vapidKeys.publicKey,
//   vapidKeys.privateKey
// );
export async function push(envelope, {applicationServerKey, applicationId, ...subscription}, TTLms) {
  // Prepare and post eneelope to the push-service specified in the subscription data.
  const options = {
    // It would be nice to include a topic tag, but that is application-specific.
    // Maybe it could be specified by pub options, but that's getting a bit weird.
    // Besides, I bet some services don't even use it.
    TTL: TTLms * 1e-3,
    vapidDetails: {
      subject: `mailto:${applicationId}@example.org`,
      publicKey: applicationServerKey,
      privateKey: applicationId
    }
  };
  const reply = await webpush.sendNotification?.(subscription, JSON.stringify(envelope), options);
  //console.log('push', {envelope, subscription, options, reply});
  return reply;
}


