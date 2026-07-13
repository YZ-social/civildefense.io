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
  });
});
