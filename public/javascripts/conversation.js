export class Conversation { // Maintains name, agent, replies around a given tag.
  static conversations = {}; // Maps tag => conversation
  static getConversation(tag) {
    return this.conversations[tag];
  }
  destroy() {
    delete this.constructor.conversations[this.tag];
  }
  static eachConversation(callback) {
    Object.values(this.conversation).forEach(callback);
  }
  static ensure({tag, ...rest}) { // update conversation if it exists, else construct and remember it.
    let conversation = this.conversations[tag];
    if (conversation) return conversation.update(rest);
    return this.conversations[tag] = new this().initialize({tag, ...rest});
  }
  initialize({...properties} = {}) { // First initialization of a new object. (Includes tag.)
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
