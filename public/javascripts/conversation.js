export class Conversation { // Maintains name, agent, replies around a given tag.

  // Multiton pattern, with each subclass getting its own dictionary.
  static _conversations = {}; // Maps tag => conversation
  static get conversations() {
    if (!Object.hasOwn(this, '_conversations')) this._conversations = {};
    return this._conversations;
  }
  static removeConversation(tag) {
    delete this._conversations[tag];
  }
  static getConversation(tag) {
    return this.conversations[tag];
  }

  destroy() { // Uncaches and returns falsy.
    this.constructor.removeConversation(this.tag);
  }
  static eachConversation(callback) { // Apply callback to each cached conversation.
    Object.values(this.conversation).forEach(callback);
  }
  static ensure({tag, ...rest}) { // update() or initialize() conversation and remember what those answer. (Falsy is deleted).
    let conversation = this.getConversation(tag);

    if (conversation) conversation = conversation.update(rest);
    else conversation = new this().initialize({tag, ...rest});

    if (!conversation) return this.removeConversation(tag);
    return this.conversations[tag] = conversation;
  }
  initialize({...properties} = {}) { // Initialization of a new object. (Includes tag.) Must return this, or null to not cache.
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
