const { describe, it, expect, expectAsync, beforeAll, afterAll, BigInt } = globalThis;
import { Conversation } from '../public/javascripts/conversation.js';

describe("Conversation", function () {
  let agent;
  let conversation;
  const tag = '123';
  const payload = 'cake';
  beforeAll(async function () {
    agent = {handle: 'alice'};
    conversation = await Conversation.ensure({tag, payload, agent});
  });
  describe("creation", function () {
    it("initializes properties.", function () {
      expect(conversation.agent).toBe(agent);
      expect(conversation.payload).toBe(payload);
    });
    it("remembers conversations with the same tag.", async function () {
      expect(await Conversation.ensure({tag, payload, agent})).toBe(conversation);
    });
    it("Properties can be ommitted for existing tag.", async function () {
      expect(await Conversation.ensure({tag, payload})).toBe(conversation);
    });
    it("rejects changes by default.", async function () {
      await expectAsync(Conversation.ensure({tag, payload: 'other', agent})).toBeRejected();
    });
    it("knows container is constructor.", function () {
      expect(conversation.container).toBe(Conversation);
    });
    describe("caching", function () {
      let keep = true;
      let tag = "caching";
      class CacheConversation extends Conversation {
	update() { return keep && this; }
	initialize() { return keep && this; }
      }
      it("ends with explicit removal.", async function () {
	let initial = await Conversation.ensure({tag, agent, payload});
	expect(initial).toBeTruthy();
	expect(Conversation.getItem(tag)).toBe(initial);
	expect(Conversation.removeItem(tag)).toBe(initial);
	expect(Conversation.getItem(tag)).toBeFalsy();
      });
      describe("deleting data", function () {
	it("keeps new if not deleting.", async function () {
	  tag = 'keep';
	  let initial = await Conversation.ensure({tag, agent, payload});
	  expect(initial).toBeTruthy();
	  expect(await Conversation.ensure({tag, agent, payload})).toBe(initial);
	  expect(Conversation.getItem(tag)).toBe(initial);
	});
	it("is skipped if delete data.", async function () {
	  tag = 'skip';	  
	  let initial = await Conversation.ensure({tag, agent});
	  expect(initial).toBeFalsy();
	  expect(Conversation.getItem(tag)).toBeFalsy();
	});
	it("is removed if delete data.", async function () {
	  tag = 'skip';	  
	  let initial = await Conversation.ensure({tag, agent, payload});
	  expect(initial).toBeTruthy();
	  expect(Conversation.getItem(tag)).toBeTruthy();
	  await Conversation.ensure({tag, agent});
	  expect(Conversation.getItem(tag)).toBeFalsy();
	});
      });
      describe("null/item caching convention", function () {
	// Do we really need/want this convetion?
	it("keeps if initialize answers conversation.", async function () {
	  keep = true;
	  tag = 'keepA';
	  let initial = await CacheConversation.ensure({tag, agent, payload});
	  expect(initial).toBeTruthy();
	  expect(await CacheConversation.ensure({tag, agent, payload})).toBe(initial);
	  expect(CacheConversation.getItem(tag)).toBe(initial);
	});
	it("is skipped if initialize answers falsy.", async function () {
	  keep = false;
	  tag = 'skipA';	  
	  let initial = await CacheConversation.ensure({tag, agent, payload});
	  expect(initial).toBeFalsy();
	  expect(CacheConversation.getItem(tag)).toBeFalsy();
	});
	it("keeps existing if update answers conversation.", async function () {
	  keep = true;
	  tag = 'keepB';
	  let initial = await CacheConversation.ensure({tag, agent, payload});
	  expect(await CacheConversation.ensure({tag, agent, payload})).toBe(initial);
	  expect(await CacheConversation.ensure({tag, agent, payload})).toBe(initial);
	  expect(await CacheConversation.getItem(tag)).toBe(initial);
	});
	it("destroys existing if update answers falsy.", async function () {
	  keep = true;
	  tag = 'skipB';
	  let initial = await CacheConversation.ensure({tag, agent, payload});
	  expect(await CacheConversation.ensure({tag, agent, payload})).toBe(initial);
	  keep = false;
	  expect(await CacheConversation.ensure({tag, agent, payload})).toBeFalsy();
	  expect(CacheConversation.getItem(tag)).toBeFalsy();
	});
      });
    });
  });

  describe("replies", function () {
    beforeAll(async function () {
      await conversation.ensure({payload: "second", issuedTime: 3, tag: 'z'});
      await conversation.ensure({payload: "deleted", issuedTime: 2, tag: 'y'});
      await conversation.ensure({payload: "first", issuedTime: 1, tag: 'x'});
      await conversation.ensure({payload: null, issuedTime: 4, tag: 'y'});
    });
    it("adds replies in timestamp order.", function () {
      expect(conversation.items.map(reply => reply.payload)).toEqual(["first", "second"]);
    });
    it("removes deleted replies.", function () { // fixme eachReply
      expect(conversation.items.find(reply => !reply.payload)).toBeFalsy();
    });
    it("knows container is conversation.", function () {
      expect(conversation.items[0].container).toBe(conversation);
    });
  });
});
