const { describe, it, expect, beforeAll, afterAll, BigInt } = globalThis;

class Conversation { // Maintains name, author, replies around a given tag.
  static conversations = {}; // Maps tag => conversation
  static ensure({tag, ...rest}) { // update conversation if it exists, else construct and remember it.
    let conversation = this.conversations[tag];
    if (conversation) return conversation.update(rest);
    return this.conversations[tag] = new this().initialize(rest);
  }
  initialize({...properties} = {}) { // First initialization of a new object.
    Object.assign(this, properties);
    return this;
  }
  update({...properties} = {}) { // Re-initialize an object with properties. This version gives error when specified values (if any) do not match existing.
    for (const key in properties) {
      const existing = this[key];
      const proposed = properties[key];
      if (existing != proposed) throw new Error(`Cannot update ${key} ${existing} to ${proposed}.`);
    }
    return this;
  }
}

describe("Conversation", function () {
  let author, other;
  beforeAll(function () {
    author = {handle: 'alice'};
    other = {handle: 'bob'};
  });
  describe("creation", function () {
    let conversation;
    const tag = '123';
    const label = 'cake';
    beforeAll(function () {
      conversation = Conversation.ensure({tag, label, author});
    });
    it("initializes properties.", function () {
      expect(conversation.author).toBe(author);
      expect(conversation.label).toBe(label);
    });
    it("remembers conversations with the same tag.", function () {
      expect(Conversation.ensure({tag, label, author})).toBe(conversation);
    });
    it("Properties can be ommitted for existing tag.", function () {
      expect(Conversation.ensure({tag})).toBe(conversation);
    });
    it("rejects changes by default.", function () {
      expect(() => Conversation.ensure({tag, label: 'other', author})).toThrow();
    });
  });
});
