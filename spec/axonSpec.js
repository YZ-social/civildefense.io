/*
  FIXME: Things that either don't pass, or require undocumented workarounds.
  TODO: Things that ought to be dealt with at some point, but can be deferred until later.

  To RUN, e.g., in NodeJS:
  - You may need to adjust the path to webTransport. See the first TODO entry.
  - To switch between them, don't forget to change the wss url a few lines down from here.
  - Have jasmine or the like installed and initialized, and then e.g., npx jasmine spec/axonSpec.js.

  It is worth running this several times. It sometimes works once, and then fails or has enormous connect times on another run.

  The logging tells the story.
  Alice, Bob, Carol, David, and Emma are Node instances. (Defined below, followed by the Jasmine test suite.)
  Alice and Bob will subscribe and publish to an open/since:'all' topic.
  Carol will join and subscribe between the previous subscriptions and their publications.
  After publications, Bob will politely disconnect, and then restart and subscribe again to get same results.
  Carol will restart without an explicit disconnect, and subscribe again after publications.
  David will join and subscribe after publications.
  Alice kills her publication and Emma joins.
*/
const { describe, it, expect, beforeAll, afterAll, BigInt } = globalThis;
import { createAuthorIdentity, regionCenter, geoCellId, geoCellCenter, WIRE_VERSION, KERNEL_VERSION, deriveTopicId, metricTopic } from '@axona/protocol';
import { connect } from '@axona/protocol/connect.js';
globalThis.RTCPeerConnection ||= await import('node-datachannel/polyfill').then(ndc => ndc.RTCPeerConnection);

class Node {  // Stuff we have to do every time.
  static version = KERNEL_VERSION;
  log(...rest) {
    console.log(new Date(), this.label, this.nodeIdentity.id.slice(0, 10), ...rest);
  }
  static async create({location, bridgeUrl = 'wss://testnet.axona.net',
		       label = 'network', authorIdentity, store,
		       ...rest} = {}) {
    // Promise a ready-to-use network peer.
    if (typeof(authorIdentity) === 'string') // TODO: this is pretty awkward.
      authorIdentity = createAuthorIdentity({persistAs: label, store: {get() { return authorIdentity; }}});
    authorIdentity ||= createAuthorIdentity({persistAs: label, store});
    authorIdentity = await authorIdentity;

    const { peer, nodeIdentity, status, disconnect } = await connect({
      bridge: bridgeUrl,
      location: await location,
      author: authorIdentity
    });

    const self = new this();
    Object.assign(self, {peer, label, authorIdentity, nodeIdentity, disconnector: disconnect, ...rest});
    self.log(`created with kernel version ${this.version}.`);
    const { peers, ms } = status;
    self.log(`connected ${peers} connections in ${ms.toLocaleString()} ms.`);

    return self;
  }
  async disconnect() { // Politely close network connection.
    const start = Date.now();
    const health = this.peer.health();
    await this.disconnector();
    this.log(`disconnected with ${health.peers.length} connections and ${health.axonRoles.length} axons in ${(Date.now() - start).toLocaleString()} ms.`);
  }
  async subscribe({eventName, region, owner, since = 'all', handler}) { // Assign handler for eventName, or remove any handler if falsy.
    const topic = {region, name: eventName};
    if (owner) topic.owner = owner;
    if (handler) {
      const callback = async ({...rest}) => handler({receiver: this, ...rest}); // Add receiver to envelope.
      await this.peer.sub(topic, callback, {since});
    } else {
      await this.peer.unsub(topic, {});
    }
  }
  async subscribeOpenMetrics({eventName, region, since = 'all', handler}) { // Assign handler for metrics about eventName, or remove any handler if falsy.
    const topic = {region, name: eventName};
    const id = await deriveTopicId(topic);
    const topicIdentifier = metricTopic(id);
    if (handler) {
      const callback = async ({message, ...rest}) => handler({receiver: this, message: JSON.parse(message), ...rest}); // Add receiver to envelope, and parse message string.
      await this.peer.sub(topicIdentifier, callback, {since});
    } else {
      await this.peer.unsub(topicIdentifier, {});
    }
  }
  async publish({eventName, region, owner, signWith = this.authorIdentity, killTag, message}) {
    // Publish data to subscribers of eventName.
    const topic = {region, name: eventName};
    if (owner) topic.owner = owner;
    const options = {signWith};
    if (message) return await this.peer.pub(topic, message, options);
    if (!killTag) return null;
    return await this.peer.kill(topic, killTag, options);
  }
  static regionCode(lat, lng) { // Answer containing region code.
    return geoCellId(lat, lng);
  }
  static canonicalizeRegion(lat, lng) {
    // Answer a {lat, lng} that is the center of a top-level Axona region containing the given {lat, lng}.
    // E.g., a precise location gets anonymized to containing top-level cell center.
    return geoCellCenter(this.regionCode(lat, lng));
  }
  static delay(ms, result) { // Promise result after ms milliseconds.
    return new Promise(resolve => setTimeout(resolve, ms, result));
  }
  host() { // through peer
    return this.peer.host();
  }
}

describe("CivilDefense", function () {
  // These two are not acceptance criteria for how long the operation should take, but are instead
  // how long we are willing to wait in in the test before assuming it is never going to happen.
  const connectAllowanceMS = 20e3;
  const deliveryAllowanceMS = 60e3;

  //const location = regionCenter('uscentlw');
  const location = regionCenter('uswest');  // TODO: pick one
  
  let alice, bob, carol, david, emma;
  let aliceKillTag, currentOperation;

  const version = Date.now(); // Each run gets a new topic.
  const eventName = `civilDefense.io:${version}:pubsub-test`;
  const regionCode = Node.regionCode(location.lat, location.lng);
  class TestNode extends Node { // Version of Node specific to these tests.
    async publish({message, killTag, ...rest}) { // Log publish, and default eventName/region for these tests.
      const published = await super.publish({eventName, region:regionCode, message, killTag, ...rest});
      this.log(killTag ? 'kill' : 'publish', currentOperation, message || killTag);
      return published;
    }
    resetExpectedPromise(expectedCount) {
      // Sets a current internal handler, without updating subscription, which records handled messages in this.events[currentOperation].
      // Returns a ready promise that resolves when the expectedCount has been received.
      return this.ready = new Promise(resolve => {
	const handlerTime = Date.now();
	this.handler = ({message, receiver, ts:pubTime}) => { // Ensure that the receiver's events[currentOperation] is a list, and push message on to it.
	  const start = Math.max(pubTime, handlerTime);
	  const elapsed = Date.now() - start;
	  const data = receiver.events[currentOperation] ||= [];
	  receiver.log(`received ${currentOperation} ${data.length} ${message} after ${elapsed.toLocaleString()} ms.`);
	  data.push(message || null);
	  if (data.length < expectedCount) return;
	  resolve();
	};
      });
    }
    async subscribe({expectedCount = 0, handler = (...rest) => this.handler?.(...rest), ...rest} = {}) {
      const ready = this.resetExpectedPromise(expectedCount);
      const subscribed = await super.subscribe({eventName, region:regionCode, handler});
      this.log('subscribed, expecting', expectedCount);
      return subscribed;
    }
    // subscribeOpenMetrics({eventName, region, since = 'all', handler}) { // resolves with first metrics to come through.
    //   //return new Promise(resolve => {
    //   //const callback = async ({message}) => {console.log('got metrics', message); resolve(message);}; // Add receiver to envelope.
    //   const callback = handler;
    // 	super.subscribeOpenMetrics({eventName, region, since, callback});
    //   //});
    // }
  }
  const inOrder = ['alice pub', '  bob pub'];

  beforeAll(async function () {
    [alice, bob] = await Promise.all([
      TestNode.create({location, events: {}, label: 'alice', authorIdentity: '{"kind":"author","pubkey":"b08988518013fabc5949353281d263cb7916f273f3f8badf0b16443a67d0b05c","privkey":"MC4CAQAwBQYDK2VwBCIEIC7ZrU8C2WSBdoBQW/JoE0ZYRkp/kFcCGf7H25DVqM17","createdAt":1782508727637}'}),
      TestNode.create({location, events: {}, label: '  bob', authorIdentity: '{"kind":"author","pubkey":"6447bae1e8f1d5c99243251b43b4d354fb4928c10b69076563617c06fff46ca3","privkey":"MC4CAQAwBQYDK2VwBCIEIGGHVqedJBPtzSDR3P03HHpWTPlyXteHJAPtABmdwujM","createdAt":1782508849433}'})
    ]);
    await Promise.all([alice.subscribe({expectedCount: 2}), bob.subscribe({expectedCount: 2})]);
    // Now carol joins and subscribes.
    carol = await TestNode.create({location, events: {}, label: 'carol', authorIdentity: '{"kind":"author","pubkey":"9fac71086211be29c685fc8aeab7725f4e78a0476482b817b9160273a40812e8","privkey":"MC4CAQAwBQYDK2VwBCIEILSc0paO923M0X8d8ux6JkjEFz65gk2BVBPlTtlZD6Q3","createdAt":1782508860832}'});
    await carol.subscribe({expectedCount: 2});
    
    currentOperation = 'initial';
    // 'alice pub' starts and completes before 'bob pub' starts.
    aliceKillTag = await alice.publish({message: 'alice pub'});
    console.log('alice published');
    await TestNode.delay(500); // FIXME: without this delay, subscription handlers are called in the wrong order.
    await   bob.publish({message: '  bob pub'});
    console.log('bob published');
    //alice.subscribeOpenMetrics({eventName, region:regionCode, handler: envelope => console.log('*** fixme got metrics', envelope)});
    await Promise.all([alice.ready, bob.ready, carol.ready]);
    //await TestNode.delay(4e3);
    //expect(await statsPromise).toBe(2);
    console.log('finished', currentOperation);
  }, 2 * connectAllowanceMS + deliveryAllowanceMS);
  describe("initial", function () {
    it("alice receives all pubs from herself and bob", function () { expect(alice.events.initial).toEqual(inOrder); });
    it("  bob receives all pubs from himself and bob", function () { expect(  bob.events.initial).toEqual(inOrder); });
    it("carol receives all pubs from   alice and bob", function () { expect(carol.events.initial).toEqual(inOrder); });
  });

  describe("restart", function () {
    beforeAll(async function () {
      await bob.disconnect();
      carol.handler = null; // We're not going to disconnect this instance of carol, but let's not get confused by subscription callbacks.
      [bob, carol, david] = await Promise.all([
	TestNode.create({location, events:   bob.events, label: '  bob', authorIdentity: bob.authorIdentity}),
	TestNode.create({location, events: carol.events, label: 'carol', authorIdentity: carol.authorIdentity}),
	TestNode.create({location, events:           {}, label: 'david', authorIdentity: '{"kind":"author","pubkey":"4071c632d8aedfeee7293c23a539b368211cf903722d12d521eeda226047e1ed","privkey":"MC4CAQAwBQYDK2VwBCIEIN/rAuWAlhP2blF3neaoXxLM727hQ1ZzR0hsg9yYS6hd","createdAt":1782508870567}'})
      ]);
      currentOperation = 'restart';
      await Promise.all([bob.subscribe({expectedCount: 2}), carol.subscribe({expectedCount: 2}), david.subscribe({expectedCount: 2})]);
      await Promise.all([bob.ready, carol.ready, david.ready]);
      console.log('finished', currentOperation);
    }, 1 * connectAllowanceMS + deliveryAllowanceMS);
    it("  bob receives all pubs from himself and bob", function () { expect(  bob.events.restart).toEqual(inOrder); });
    it("carol receives all pubs from   alice and bob", function () { expect(carol.events.restart).toEqual(inOrder); });
    it("david receives all pubs from   alice and bob", function () { expect(david.events.restart).toEqual(inOrder); });

    describe("after kill", function () {
      beforeAll(async function () {
	currentOperation = 'kill';
	alice.resetExpectedPromise(1);
	bob.resetExpectedPromise(1);
	carol.resetExpectedPromise(1);
	david.resetExpectedPromise(1);	
	await alice.publish({killTag: aliceKillTag});
	await TestNode.delay(500); // FIXME: without this delay, someone already subscribed (like Bob) sometimes (rarely) doesn't get the kill callback.
	emma = await TestNode.create({location, events: {}, label: ' emma', authorIdentity: '{"kind":"author","pubkey":"ddd028fe0436ce4d1eaf697b3be3971ff009fabcd4949028adf8305d5291e1f7","privkey":"MC4CAQAwBQYDK2VwBCIEIO0eoNtBvNuA84mFckAIR0ozuwFbMwJhR+FbMOq+ZALf","createdAt":1782509271005}'});

	await emma.subscribe({expectedCount: 1});
	await Promise.all([alice.ready, bob.ready, carol.ready, david.ready, emma.ready]);
	console.log('finished', currentOperation);
      }, connectAllowanceMS + deliveryAllowanceMS);
      it("alice receives kill", function () { expect(alice.events.kill).toEqual([null]); });
      it("  bob receives kill", function () { expect(  bob.events.kill).toEqual([null]); });
      it("carol receives kill", function () { expect(carol.events.kill).toEqual([null]); });
      it("david receives kill", function () { expect(david.events.kill).toEqual([null]); });      
      it(" emma only receives unkilled pub from bob", function () { expect( emma.events.kill).toEqual(inOrder.slice(1)); });
    });
  });
  afterAll(async function () {
    await alice.disconnect();
    await bob.disconnect();
    await carol?.disconnect();
    await david?.disconnect();
    await emma?.disconnect();
  });
});
