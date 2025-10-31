# [Yz.social](https://yz.social) (wise social)

## The App

Yz.social lets you report an immediate concern to the public by tapping its location on the map.
The locations are shared over anonymous p2p with other users in your area, then fade away over 10 minutes. 
There is no login and no global tracking of your Internet address or physical location.

**_FIXME: The app is not ready public use just yet._**

## The Implementation

Some apps of this type have been removed from mobile app stores, while others remain. This is implemented as a Web page, so that it does not have to rely on an app store.

Additionally, the source code is available right here so that a mirror can be hosted by anyone.

The cool thing about the implementation, though, is that all the mirrors share the same data through peer-to-peer connections. There is no central database to be taken down. 
**_FIXME: Current version does not work this way yet._**

## The Bigger Project

YZ.social [is building](./docs/YZ-Brief.pdf) a totally free and open source, fully secure, peer-to-peer network for a new class of applications. The YZ network has no servers, no central database, no single point of failure. It is a true, fully decentralized network constructed, controlled and owned by its users. YZ Alert (Wise Alert) is the first application built on the YZ network.

## Running a Mirror

You can run a complete application server with:

```
npm install yz.social # Oops! FIXME Not published to npm yet!
# or
git clone https://github.com/YZ-social/Yz.social.git; cd Yz.social
# and then
npm start # Now visit http://localhost:3000
```

However, to visit the page on another device, the server must use `https`. This is usually done with a front end (aka reverse proxy server) such as nginx or OpenResty, and most commercial setups already operate this way.

The application server does a few things:
1. It serves the static client files.
2. It provides a means of connecting to the p2p network that is shared among all the mirrors.

This is done with a very minimal ExpressJS server. If you already have such a server set up, you can just:
1. Add or link public/ to the directory of static client files already being served. E.g., 
  - If you want to serve the static client files from an nginx front end, you can specify `root path_to_yz.social_directory/public;` in your nginx.conf.
  - If you want to serve the static client files from an existing ExpressJS app server, you can specify `app.use(express.static(path_to_yz.social_directory/public));`
2. Add the router FIXME.
