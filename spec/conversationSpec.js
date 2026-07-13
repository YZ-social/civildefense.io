const { describe, it, expect, beforeAll, afterAll, BigInt } = globalThis;
import { Conversation } from '../public/javascripts/conversation.js';

describe("Conversation", function () {
  let agent, other;
  beforeAll(function () {
    agent = {handle: 'alice'};
    other = {handle: 'bob'};
  });
  describe("creation", function () {
    let conversation;
    const tag = '123';
    const label = 'cake';
    beforeAll(function () {
      conversation = Conversation.ensure({tag, label, agent});
    });
    it("initializes properties.", function () {
      expect(conversation.agent).toBe(agent);
      expect(conversation.label).toBe(label);
    });
    it("remembers conversations with the same tag.", function () {
      expect(Conversation.ensure({tag, label, agent})).toBe(conversation);
    });
    it("Properties can be ommitted for existing tag.", function () {
      expect(Conversation.ensure({tag})).toBe(conversation);
    });
    it("rejects changes by default.", function () {
      expect(() => Conversation.ensure({tag, label: 'other', agent})).toThrow();
    });
    describe('caching', function () {
      let keep = true;
      let tag = "caching";
      class CacheConversation extends Conversation {
	update() { return keep && this; }
	initialize() { return keep && this; }
      }
      it("happens if initialize answers conversation.", function () {
	keep = true;
	let initial = CacheConversation.ensure({tag, agent});
	expect(initial).toBeTruthy();
	expect(CacheConversation.ensure({tag, agent})).toBe(initial);
	expect(CacheConversation.getConversation(tag)).toBe(initial);
      });
      it("is skipped if initialize answers falsy.", function () {
	keep = false;
	let initial = CacheConversation.ensure({tag, agent});
	expect(initial).toBeFalsy();
	expect(CacheConversation.getConversation(tag)).toBeFalsy();
      });
      it("keeps existing if update answers conversation.", function () {
	keep = true;
	let initial = CacheConversation.ensure({tag, agent});
	expect(CacheConversation.ensure({tag, agent})).toBe(initial);
	keep = true;
	expect(CacheConversation.ensure({tag, agent})).toBe(initial);
	expect(CacheConversation.getConversation(tag)).toBe(initial);
      });
      it("destroys existing if update answers falsy.", function () {
	keep = true;
	let initial = CacheConversation.ensure({tag, agent});
	expect(CacheConversation.ensure({tag, agent})).toBe(initial);
	keep = false;
	expect(CacheConversation.ensure({tag, agent})).toBeFalsy();
	expect(CacheConversation.getConversation(tag)).toBeFalsy();
      });
      it("ends with explicit destroy.", function () {
	let initial = Conversation.ensure({tag, agent});
	expect(initial).toBeTruthy();
	expect(Conversation.getConversation(tag)).toBe(initial);
	expect(initial.destroy()).toBeFalsy();
	expect(Conversation.getConversation(tag)).toBeFalsy();
      });
    });
  });
});
