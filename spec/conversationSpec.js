const { describe, it, expect, beforeAll, afterAll, BigInt } = globalThis;
import { Conversation } from '../public/javascripts/conversation.js';

describe("Conversation", function () {
  let agent;
  let conversation;
  const tag = '123';
  const payload = 'cake';
  beforeAll(function () {
    agent = {handle: 'alice'};
    conversation = Conversation.ensure({tag, payload, agent});
  });
  describe("creation", function () {
    it("initializes properties.", function () {
      expect(conversation.agent).toBe(agent);
      expect(conversation.payload).toBe(payload);
    });
    it("remembers conversations with the same tag.", function () {
      expect(Conversation.ensure({tag, payload, agent})).toBe(conversation);
    });
    it("Properties can be ommitted for existing tag.", function () {
      expect(Conversation.ensure({tag, payload})).toBe(conversation);
    });
    it("rejects changes by default.", function () {
      expect(() => Conversation.ensure({tag, payload: 'other', agent})).toThrow();
    });
    describe("caching", function () {
      let keep = true;
      let tag = "caching";
      class CacheConversation extends Conversation {
	update() { return keep && this; }
	initialize() { return keep && this; }
      }
      it("ends with explicit removal.", function () {
	let initial = Conversation.ensure({tag, agent, payload});
	expect(initial).toBeTruthy();
	expect(Conversation.getItem(tag)).toBe(initial);
	expect(Conversation.removeItem(tag)).toBe(initial);
	expect(Conversation.getItem(tag)).toBeFalsy();
      });
      describe("deleting data", function () {
	it("keeps new if not deleting.", function () {
	  tag = 'keep';
	  let initial = Conversation.ensure({tag, agent, payload});
	  expect(initial).toBeTruthy();
	  expect(Conversation.ensure({tag, agent, payload})).toBe(initial);
	  expect(Conversation.getItem(tag)).toBe(initial);
	});
	it("is skipped if delete data.", function () {
	  tag = 'skip';	  
	  let initial = Conversation.ensure({tag, agent});
	  expect(initial).toBeFalsy();
	  expect(Conversation.getItem(tag)).toBeFalsy();
	});
	it("is removed if delete data.", function () {
	  tag = 'skip';	  
	  let initial = Conversation.ensure({tag, agent, payload});
	  expect(initial).toBeTruthy();
	  expect(Conversation.getItem(tag)).toBeTruthy();
	  Conversation.ensure({tag, agent});
	  expect(Conversation.getItem(tag)).toBeFalsy();
	});
      });
      describe("null/item caching convention", function () {
	// Do we really need/want this convetion?
	it("keeps if initialize answers conversation.", function () {
	  keep = true;
	  tag = 'keepA';
	  let initial = CacheConversation.ensure({tag, agent, payload});
	  expect(initial).toBeTruthy();
	  expect(CacheConversation.ensure({tag, agent, payload})).toBe(initial);
	  expect(CacheConversation.getItem(tag)).toBe(initial);
	});
	it("is skipped if initialize answers falsy.", function () {
	  keep = false;
	  tag = 'skipA';	  
	  let initial = CacheConversation.ensure({tag, agent, payload});
	  expect(initial).toBeFalsy();
	  expect(CacheConversation.getItem(tag)).toBeFalsy();
	});
	it("keeps existing if update answers conversation.", function () {
	  keep = true;
	  tag = 'keepB';
	  let initial = CacheConversation.ensure({tag, agent, payload});
	  expect(CacheConversation.ensure({tag, agent, payload})).toBe(initial);
	  expect(CacheConversation.ensure({tag, agent, payload})).toBe(initial);
	  expect(CacheConversation.getItem(tag)).toBe(initial);
	});
	it("destroys existing if update answers falsy.", function () {
	  keep = true;
	  tag = 'skipB';
	  let initial = CacheConversation.ensure({tag, agent, payload});
	  expect(CacheConversation.ensure({tag, agent, payload})).toBe(initial);
	  keep = false;
	  expect(CacheConversation.ensure({tag, agent, payload})).toBeFalsy();
	  expect(CacheConversation.getItem(tag)).toBeFalsy();
	});
      });
    });
  });

  describe("replies", function () {
    beforeAll(function () {
      conversation.ensure({payload: "second", issuedTime: 3, tag: 'z'});
      conversation.ensure({payload: "deleted", issuedTime: 2, tag: 'y'});
      conversation.ensure({payload: "first", issuedTime: 1, tag: 'x'});
      conversation.ensure({payload: null, issuedTime: 4, tag: 'y'});
    });
    it("adds replies in timestamp order.", function () {
      expect(conversation.items.map(reply => reply.payload)).toEqual(["first", "second"]);
    });
    it("removes deleted replies.", function () { // fixme eachReply
      expect(conversation.items.find(reply => !reply.payload)).toBeFalsy();
    });
  });
});
