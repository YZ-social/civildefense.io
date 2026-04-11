# [CivilDefense.io](https://civildefense.io)

## The App

CivilDefense.io lets you report an immediate concern to the public by tapping its location on the map.
The locations are shared over anonymous p2p with other users in your area, then fade away over 24 hours.
There is no login and no global tracking of your Internet address or physical location.

See [here](https://yz.social/civildefense.html).

**_FIXME: The app is not ready public use just yet._**

## The Implementation

Some apps of this type have been removed from mobile app stores, while others remain. CivilDefense.io is implemented as a web page, so that it does not have to rely on an app store.

Additionally, the source code is available right here so that a mirror can be hosted by anyone.

Finally, all mirrors share the same data through peer-to-peer connections, so all reporting is automatically shared among all mirrors, regardless of which mirror the user entered through. There is no central database to be taken down. 


## The Bigger Project

[YZ.social](https://yz.social) ("wise social") is building a secure, free, and open source, peer-to-peer network for a new class of applications. The YZ network has no servers, no central database, no single point of failure. It is a true, fully decentralized network constructed, controlled and owned by its users. CivilDefense.io is the first application built on the YZ network.

## Running a Portal

Visitors enter network through a "portal", which serves the web pages and connects the user to other peers in the network. Anyone can run such a portal.

A local, private copy for development can be run with:

```
git clone https://github.com/YZ-social/civildefense.io.git; cd Yz.social
npm install
npm run local # Now visit http://localhost:3000
```

### Sharing

This network can only be reached through `http://localhost:3000`. To run a network that is connected to the world-wide YZ network, instead to
```
npm run shared
```

To allow people visit the page from another device, the server must use `https`. This is usually done with a front end (aka reverse proxy server) such as [nginx](https://nginx.org/) or [OpenResty](https://openresty.org), and most commercial setups already operate this way. For example, at [civildefense.io](https://civildefense.io/?dht=1) and our own mirror at [ki1r0y.com](https://ki1r0y.com/?dht=1), nginx handles https connection handshake and certificate (tcp inbound 443), and passes the request to NodeJS running on port 3000.

### What It Does

The application server does a few things:
1. It serves the static client files - i.e., the web page.
2. It launches 2 or more separate NodeJS processes, each with an a network node just like the one that is run in the browser when someone visits the site. These "portal nodes" allow web visitors to connect to the network. If the box has 6 logical cores or more, it lauches nCores/2 nodes. These will each make outgoing UDP [Webrtc](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API) connections for each node that connects to them on high-numbered ports. The only difference between `npm run local` and `npm run shared` is that with `shared`, the first portal node connects to a portal node at `https://civildefense.io`. All remaning portal nodes connect to that one.
3. It provides a means of connecting to the p2p network. Specifically, it provides `post` endpoints that deliver Webrtc connection information to the portal nodes. The server passes this info to the requested node process via NodeJS InterProcess Communication (IPC). 
4. It runs a [TURN](https://developer.mozilla.org/en-US/docs/Glossary/TURN) relay (within the web server process). The TURN server listens for setup requests incoming on udp or tcp on 3478. (We do not currently use (D)TLS, which would be 5349.) Additionally, the actual relay traffic happens on incoming udp ports 49152 - 65535.

### Building Your Own

This is all done with a very minimal ExpressJS server. The one we provide is in `app.js`. If you already have such a server set up, you can just:
1. Add or link public/ to the directory of static client files already being served. E.g., 
  - If you want to serve the static client files from an nginx front end, you can specify `root path_to_yz.social_directory/public;` in your nginx.conf.
  - If you want to serve the static client files from an existing ExpressJS app server, you can specify `app.use(express.static(path_to_yz.social_directory/public));`
2. Fork one or more portal nodes. Our `app.js` does this with:
```
import cluster from 'node:cluster';
if (cluster.isPrimary) {
  for (let i = 0; i < nPortals; i++) cluster.fork();
  ...
} else {
  const portalNode = await import('@yz-social/kdht/portal');
  portalNode.setup({});
}
```
3. Serve some endpoints so that visitors to your page can find and connect with one of the portal nodes you forked. Our `app.js` does this with:
```
if (cluster.isPrimary) {
  for (let i = 0; i < nPortals; i++) cluster.fork();
  const portalServer = await import('@yz-social/kdht/router');
  app.use('/kdht', portalServer.router);
  ...
}
```
4. Run a TURN relay. The portal nodes and visitors to your web page are automatically configured to expect a relay at the default STUN/TURN port (3478). The `@yz-social/kdht/router` imported in step 3 does this automatically.
