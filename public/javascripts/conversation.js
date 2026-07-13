export class Conversation { // Maintains name, agent, replies around a given tag.
  static conversations = {}; // Maps tag => conversation
  static getConversation(tag) {
    return this.conversations[tag];
  }
  destroy() { // Uncaches and returns falsy.
    delete this.constructor.conversations[this.tag];
  }
  static eachConversation(callback) {
    Object.values(this.conversation).forEach(callback);
  }
  static ensure({tag, ...rest}) { // update() or initialize() conversation and remember what those answer. (Falsy is deleted).
    let conversation = this.getConversation(tag);

    if (conversation) conversation = conversation.update(rest);
    else conversation = new this().initialize({tag, ...rest});

    if (!conversation) return delete this.conversations[tag] && null;
    return this.conversations[tag] = conversation;
  }
  initialize({...properties} = {}) { // First initialization of a new object. (Includes tag.) Must return this or null (to not cache).
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
